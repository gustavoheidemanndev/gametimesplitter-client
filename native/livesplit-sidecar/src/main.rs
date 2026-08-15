mod autosplit;
#[allow(dead_code)]
mod chapter_probe;
mod process_memory;

use autosplit::{AutosplitConfig, AutosplitState, Autosplitter};
use livesplit_core::{
    comparison::best_split_times,
    run::{parser::composite, saver::livesplit},
    Run, Segment, Time, TimeSpan, Timer, TimerPhase,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Deserialize)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoadPayload {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePayload {
    game_name: String,
    category_name: String,
    segments: Vec<CreateSegmentPayload>,
    save_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CreateSegmentPayload {
    Name(String),
    Details(CreateSegmentDetails),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSegmentDetails {
    name: String,
    personal_best_segment_time_ms: Option<f64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResetPayload {
    update_splits: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
struct SavePayload {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishPayload {
    action: FinishAction,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum FinishAction {
    Save,
    Discard,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SegmentState {
    name: String,
    split_time_ms: Option<f64>,
    personal_best_time_ms: Option<f64>,
    personal_best_segment_time_ms: Option<f64>,
    best_segment_time_ms: Option<f64>,
    /// Cumulative Best Split Times comparison: best pace ever at this split, not necessarily PB.
    best_split_time_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimerState {
    available: bool,
    phase: &'static str,
    current_time_ms: f64,
    game_time_ms: Option<f64>,
    current_split_index: Option<usize>,
    current_segment_name: Option<String>,
    game_name: String,
    category_name: String,
    attempt_count: u32,
    comparison: String,
    source_path: Option<String>,
    segments: Vec<SegmentState>,
    autosplit: AutosplitState,
}

impl TimerState {
    fn unavailable(autosplit: AutosplitState) -> Self {
        Self {
            available: false,
            phase: "notRunning",
            current_time_ms: 0.0,
            game_time_ms: None,
            current_split_index: None,
            current_segment_name: None,
            game_name: String::new(),
            category_name: String::new(),
            attempt_count: 0,
            comparison: "Personal Best".to_owned(),
            source_path: None,
            segments: Vec::new(),
            autosplit,
        }
    }
}

#[derive(Default)]
struct Engine {
    timer: Option<Timer>,
    source_path: Option<PathBuf>,
    attempt_baseline: Option<Timer>,
    autosplit: Autosplitter,
}

impl Engine {
    fn load(&mut self, path: &Path) -> Result<TimerState, String> {
        let bytes =
            fs::read(path).map_err(|error| format!("Não foi possível ler o .lss: {error}"))?;
        let parsed = composite::parse_and_fix(&bytes, Some(path))
            .map_err(|error| format!("O arquivo não é uma run compatível: {error}"))?;
        let timer = Timer::new(parsed.run)
            .map_err(|error| format!("A run precisa ter pelo menos um segmento: {error}"))?;
        self.timer = Some(timer);
        self.source_path = Some(path.to_owned());
        self.attempt_baseline = None;
        self.autosplit.reset_attempt_metrics();
        Ok(self.state())
    }

    fn create(&mut self, payload: CreatePayload) -> Result<TimerState, String> {
        let CreatePayload {
            game_name,
            category_name,
            segments,
            save_path,
        } = payload;
        if game_name.trim().is_empty() || category_name.trim().is_empty() {
            return Err("Jogo e categoria são obrigatórios.".to_owned());
        }
        if segments.is_empty() {
            return Err("A run precisa ter pelo menos um segmento.".to_owned());
        }

        let mut normalized_segments = Vec::with_capacity(segments.len());
        for segment in segments {
            let (name, personal_best_segment_time_ms) = match segment {
                CreateSegmentPayload::Name(name) => (name, None),
                CreateSegmentPayload::Details(details) => {
                    (details.name, details.personal_best_segment_time_ms)
                }
            };
            let name = name.trim().to_owned();
            if name.is_empty() {
                return Err("A run precisa ter segmentos com nomes válidos.".to_owned());
            }
            if personal_best_segment_time_ms.is_some_and(|time| !time.is_finite() || time <= 0.0) {
                return Err(
                    "O tempo de cada segmento no Personal Best deve ser maior que zero.".to_owned(),
                );
            }
            normalized_segments.push((name, personal_best_segment_time_ms));
        }

        let pb_time_count = normalized_segments
            .iter()
            .filter(|(_, time)| time.is_some())
            .count();
        if pb_time_count > 0 && pb_time_count != normalized_segments.len() {
            return Err(
                "Informe o tempo no Personal Best para todos os segmentos ou para nenhum."
                    .to_owned(),
            );
        }

        let mut run = Run::new();
        run.set_game_name(game_name.trim());
        run.set_category_name(category_name.trim());
        let mut cumulative_personal_best_ms = 0.0;
        for (name, personal_best_segment_time_ms) in normalized_segments {
            let mut segment = Segment::new(name);
            if let Some(segment_time_ms) = personal_best_segment_time_ms {
                cumulative_personal_best_ms += segment_time_ms;
                segment.set_personal_best_split_time(Time::new().with_real_time(Some(
                    TimeSpan::from_milliseconds(cumulative_personal_best_ms),
                )));
            }
            run.push_segment(segment);
        }
        let timer = Timer::new(run).map_err(|error| error.to_string())?;
        let previous_timer = self.timer.replace(timer);
        let previous_path = std::mem::replace(&mut self.source_path, save_path.map(PathBuf::from));
        if let Err(error) = self.persist_if_configured() {
            self.timer = previous_timer;
            self.source_path = previous_path;
            return Err(error);
        }
        self.attempt_baseline = None;
        self.autosplit.reset_attempt_metrics();
        Ok(self.state())
    }

    fn start(&mut self) -> Result<TimerState, String> {
        let was_not_running = self
            .timer
            .as_ref()
            .is_some_and(|timer| timer.current_phase() == TimerPhase::NotRunning);
        let baseline = was_not_running.then(|| self.timer.clone()).flatten();
        self.apply_and_persist(|timer| timer.start())?;
        if was_not_running
            && self
                .timer
                .as_ref()
                .is_some_and(|timer| timer.current_phase() == TimerPhase::Running)
        {
            self.attempt_baseline = baseline;
            self.autosplit.reset_attempt_metrics();
        }
        Ok(self.state())
    }

    fn split(&mut self) -> Result<TimerState, String> {
        self.apply_and_persist(|timer| timer.split())
    }

    fn toggle_pause(&mut self) -> Result<TimerState, String> {
        self.apply_and_persist(|timer| timer.toggle_pause())
    }

    fn reset(&mut self, update_splits: bool) -> Result<TimerState, String> {
        self.apply_and_persist(|timer| timer.reset(update_splits))?;
        self.attempt_baseline = None;
        self.autosplit.reset_attempt_metrics();
        Ok(self.state())
    }

    fn undo(&mut self) -> Result<TimerState, String> {
        self.apply_and_persist(|timer| timer.undo_split())
    }

    fn skip(&mut self) -> Result<TimerState, String> {
        self.apply_and_persist(|timer| timer.skip_split())
    }

    fn save(&mut self, path: Option<PathBuf>) -> Result<TimerState, String> {
        let previous_path = self.source_path.clone();
        if let Some(path) = path {
            self.source_path = Some(path);
        }
        if self.source_path.is_none() {
            return Err("Informe um caminho .lss para salvar a run.".to_owned());
        }
        if let Err(error) = self.persist_if_configured() {
            self.source_path = previous_path;
            return Err(error);
        }
        Ok(self.state())
    }

    fn finish(&mut self, payload: FinishPayload) -> Result<TimerState, String> {
        if !self
            .timer
            .as_ref()
            .is_some_and(|timer| timer.current_phase() == TimerPhase::Ended)
        {
            return Err("A run ainda não foi finalizada.".to_owned());
        }

        match payload.action {
            FinishAction::Save => self.commit_finished_run(payload.path.map(PathBuf::from)),
            FinishAction::Discard => self.discard_finished_run(),
        }
    }

    fn commit_finished_run(&mut self, path: Option<PathBuf>) -> Result<TimerState, String> {
        let previous_timer = self.timer.clone();
        let previous_path = self.source_path.clone();
        let destination = path
            .or_else(|| previous_path.clone())
            .ok_or_else(|| "Escolha um novo arquivo .lss para salvar esta run.".to_owned())?;

        self.timer_mut()?.reset(true);
        self.source_path = Some(destination);
        if let Err(error) = self.persist_if_configured() {
            self.timer = previous_timer;
            self.source_path = previous_path;
            return Err(error);
        }

        self.attempt_baseline = None;
        self.autosplit.reset_attempt_metrics();
        Ok(self.state())
    }

    fn discard_finished_run(&mut self) -> Result<TimerState, String> {
        let previous_timer = self.timer.clone();
        let previous_baseline = self.attempt_baseline.clone();
        if let Some(baseline) = self.attempt_baseline.take() {
            self.timer = Some(baseline);
        } else {
            self.timer_mut()?.reset(false);
        }
        if let Err(error) = self.persist_if_configured() {
            self.timer = previous_timer;
            self.attempt_baseline = previous_baseline;
            return Err(error);
        }
        self.autosplit.reset_attempt_metrics();
        Ok(self.state())
    }

    fn configure_autosplit(&mut self, config: AutosplitConfig) -> Result<TimerState, String> {
        self.autosplit.configure(config)?;
        Ok(self.state())
    }

    fn tick_autosplit(&mut self) {
        let best_segments_before = self.effective_best_segment_times();
        let phase_before = self.timer.as_ref().map(Timer::current_phase);
        let baseline = (phase_before == Some(TimerPhase::NotRunning))
            .then(|| self.timer.clone())
            .flatten();
        let changed = self.autosplit.tick(self.timer.as_mut());
        if !changed {
            return;
        }

        let phase_after = self.timer.as_ref().map(Timer::current_phase);
        if phase_before == Some(TimerPhase::NotRunning) && phase_after == Some(TimerPhase::Running)
        {
            self.attempt_baseline = baseline;
        }
        let best_segments_changed = best_segments_before != self.effective_best_segment_times();
        if best_segments_changed || !self.attempt_is_active() {
            if let Err(error) = self.persist_if_configured() {
                eprintln!("Falha ao salvar uma ação automática: {error}");
            }
            if phase_after == Some(TimerPhase::NotRunning) {
                self.attempt_baseline = None;
            }
        }
    }

    fn apply_and_persist(&mut self, action: impl FnOnce(&mut Timer)) -> Result<TimerState, String> {
        let previous_timer = self.timer.clone();
        let best_segments_before = self.effective_best_segment_times();
        action(self.timer_mut()?);
        let best_segments_changed = best_segments_before != self.effective_best_segment_times();
        if best_segments_changed || !self.attempt_is_active() {
            if let Err(error) = self.persist_if_configured() {
                self.timer = previous_timer;
                return Err(error);
            }
        }
        Ok(self.state())
    }

    fn attempt_is_active(&self) -> bool {
        self.timer.as_ref().is_some_and(|timer| {
            matches!(
                timer.current_phase(),
                TimerPhase::Running | TimerPhase::Paused | TimerPhase::Ended
            )
        })
    }

    fn run_with_live_best_segments(timer: &Timer) -> Run {
        let mut run = timer.run().clone();
        let mut previous_split_time_rta = Some(TimeSpan::zero());
        let mut previous_split_time_game_time = Some(TimeSpan::zero());

        for segment in run.segments_mut() {
            let split_time = segment.split_time();
            let mut best_segment = segment.best_segment_time();

            if let Some(split_time) = split_time.real_time {
                let current_segment = previous_split_time_rta.map(|previous| split_time - previous);
                previous_split_time_rta = Some(split_time);
                if best_segment.real_time.map_or(true, |best| {
                    current_segment.is_some_and(|current| current < best)
                }) {
                    best_segment.real_time = current_segment;
                }
            }
            if let Some(split_time) = split_time.game_time {
                let current_segment =
                    previous_split_time_game_time.map(|previous| split_time - previous);
                previous_split_time_game_time = Some(split_time);
                if best_segment.game_time.map_or(true, |best| {
                    current_segment.is_some_and(|current| current < best)
                }) {
                    best_segment.game_time = current_segment;
                }
            }

            segment.set_best_segment_time(best_segment);
        }

        run
    }

    fn effective_best_segment_times(&self) -> Vec<Time> {
        let Some(timer) = &self.timer else {
            return Vec::new();
        };
        if self.attempt_is_active() {
            Self::run_with_live_best_segments(timer)
                .segments()
                .iter()
                .map(|segment| segment.best_segment_time())
                .collect()
        } else {
            timer
                .run()
                .segments()
                .iter()
                .map(|segment| segment.best_segment_time())
                .collect()
        }
    }

    fn state(&self) -> TimerState {
        let autosplit = self.autosplit.state();
        let Some(timer) = &self.timer else {
            return TimerState::unavailable(autosplit);
        };
        let snapshot = timer.snapshot();
        let current_time = snapshot.current_time();
        let effective_run = self
            .attempt_is_active()
            .then(|| Self::run_with_live_best_segments(timer));
        let run = effective_run.as_ref().unwrap_or_else(|| timer.run());
        let phase = match timer.current_phase() {
            TimerPhase::NotRunning => "notRunning",
            TimerPhase::Running => "running",
            TimerPhase::Paused => "paused",
            TimerPhase::Ended => "ended",
        };
        let to_ms = |time: Option<TimeSpan>| time.map(|value| value.total_milliseconds());
        let use_game_time = autosplit.enabled && autosplit.remove_loads;
        let display_time = |real_time: Option<TimeSpan>, game_time: Option<TimeSpan>| {
            if use_game_time {
                game_time.or(real_time)
            } else {
                real_time
            }
        };

        TimerState {
            available: true,
            phase,
            current_time_ms: to_ms(display_time(current_time.real_time, current_time.game_time))
                .unwrap_or(0.0),
            game_time_ms: to_ms(current_time.game_time),
            current_split_index: timer.current_split_index(),
            current_segment_name: timer
                .current_split()
                .map(|segment| segment.name().to_owned()),
            game_name: run.game_name().to_owned(),
            category_name: run.category_name().to_owned(),
            attempt_count: run.attempt_count(),
            comparison: timer.current_comparison().to_owned(),
            source_path: self
                .source_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            segments: {
                let mut previous_personal_best: Option<Option<TimeSpan>> = None;
                run.segments()
                    .iter()
                    .map(|segment| {
                        let split = segment.split_time();
                        let personal_best = segment.personal_best_split_time();
                        let best_segment = segment.best_segment_time();
                        let best_split = segment.comparison(best_split_times::NAME);
                        let displayed_personal_best =
                            display_time(personal_best.real_time, personal_best.game_time);
                        let personal_best_segment =
                            match (displayed_personal_best, previous_personal_best) {
                                (Some(current), None) => Some(current),
                                (Some(current), Some(Some(previous))) if current >= previous => {
                                    Some(current - previous)
                                }
                                _ => None,
                            };
                        previous_personal_best = Some(displayed_personal_best);

                        SegmentState {
                            name: segment.name().to_owned(),
                            split_time_ms: to_ms(display_time(split.real_time, split.game_time)),
                            personal_best_time_ms: to_ms(displayed_personal_best),
                            personal_best_segment_time_ms: to_ms(personal_best_segment),
                            best_segment_time_ms: to_ms(display_time(
                                best_segment.real_time,
                                best_segment.game_time,
                            )),
                            best_split_time_ms: to_ms(display_time(
                                best_split.real_time,
                                best_split.game_time,
                            )),
                        }
                    })
                    .collect()
            },
            autosplit,
        }
    }

    fn timer_mut(&mut self) -> Result<&mut Timer, String> {
        self.timer
            .as_mut()
            .ok_or_else(|| "Carregue ou crie uma run antes de usar o timer.".to_owned())
    }

    fn persist_if_configured(&mut self) -> Result<(), String> {
        let Some(path) = self.source_path.clone() else {
            return Ok(());
        };
        let attempt_is_active = self.attempt_is_active();
        let timer = self
            .timer
            .as_mut()
            .ok_or_else(|| "Nenhuma run carregada.".to_owned())?;
        let mut xml = String::new();
        if attempt_is_active {
            let run = Self::run_with_live_best_segments(timer);
            livesplit::save_run(&run, &mut xml)
        } else {
            livesplit::save_timer(timer, &mut xml)
        }
        .map_err(|error| format!("Não foi possível serializar o .lss: {error}"))?;
        let temporary_path = path.with_extension("lss.tmp");
        fs::write(&temporary_path, xml.as_bytes())
            .map_err(|error| format!("Não foi possível gravar o backup do timer: {error}"))?;
        fs::rename(&temporary_path, &path)
            .map_err(|error| format!("Não foi possível concluir a gravação do timer: {error}"))?;
        if !attempt_is_active {
            timer.mark_as_unmodified();
        }
        Ok(())
    }
}

type SharedOutput = Arc<Mutex<BufWriter<io::Stdout>>>;

fn emit_json(output: &SharedOutput, value: &impl Serialize) -> io::Result<()> {
    let mut writer = output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn emit_state(output: &SharedOutput, state: TimerState) -> io::Result<()> {
    emit_json(output, &json!({ "event": "state", "data": state }))
}

fn payload<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("Payload inválido: {error}"))
}

fn process_request(engine: &mut Engine, request: &Request) -> Result<Value, String> {
    let state = match request.command.as_str() {
        "ping" | "state" => engine.state(),
        "load" => {
            let payload: LoadPayload = payload(request.payload.clone())?;
            engine.load(Path::new(&payload.path))?
        }
        "create" => engine.create(payload(request.payload.clone())?)?,
        "start" => engine.start()?,
        "split" => engine.split()?,
        "pause" => engine.toggle_pause()?,
        "reset" => {
            let payload: ResetPayload = if request.payload.is_null() {
                ResetPayload::default()
            } else {
                payload(request.payload.clone())?
            };
            engine.reset(payload.update_splits.unwrap_or(true))?
        }
        "undo" => engine.undo()?,
        "skip" => engine.skip()?,
        "save" => {
            let payload: SavePayload = if request.payload.is_null() {
                SavePayload::default()
            } else {
                payload(request.payload.clone())?
            };
            engine.save(payload.path.map(PathBuf::from))?
        }
        "finish" => engine.finish(payload(request.payload.clone())?)?,
        "autosplitConfigure" => engine.configure_autosplit(payload(request.payload.clone())?)?,
        "shutdown" => engine.state(),
        command => return Err(format!("Comando desconhecido: {command}")),
    };
    serde_json::to_value(state).map_err(|error| error.to_string())
}

fn enable_high_resolution_timer() {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::Media::timeBeginPeriod(1);
    }
}

fn main() -> io::Result<()> {
    enable_high_resolution_timer();
    let engine = Arc::new(Mutex::new(Engine::default()));
    let output = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let running = Arc::new(AtomicBool::new(true));

    emit_json(
        &output,
        &json!({
            "event": "ready",
            "data": { "version": env!("CARGO_PKG_VERSION"), "coreVersion": "0.13.0" }
        }),
    )?;

    let ticker_engine = Arc::clone(&engine);
    let ticker_output = Arc::clone(&output);
    let ticker_running = Arc::clone(&running);
    let ticker = thread::spawn(move || {
        let mut last_emit = Instant::now();
        // LiveSplit.ScriptableAutoSplit: `new Timer { Interval = 15 }` ("a little faster than
        // 60hz"). O ASL do RE4 não mexe em `refreshRate`, então fica nisto. Dormir 16 ms *antes*
        // da leitura fazia o período ser 16 ms + trabalho; na despausa o oficial soma o delta de
        // `totalFrames` (que continua subindo no menu) e cada pausa empurrava o GTS alguns ms.
        let period = Duration::from_millis(15);
        while ticker_running.load(Ordering::Relaxed) {
            let tick_started = Instant::now();
            let state = {
                let mut engine = ticker_engine
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                engine.tick_autosplit();
                if last_emit.elapsed() >= Duration::from_millis(100) {
                    last_emit = Instant::now();
                    Some(engine.state())
                } else {
                    None
                }
            };
            if let Some(state) = state {
                if emit_state(&ticker_output, state).is_err() {
                    break;
                }
            }
            let elapsed = tick_started.elapsed();
            if elapsed < period {
                thread::sleep(period - elapsed);
            }
        }
    });

    let stdin = BufReader::new(io::stdin());
    for line in stdin.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("Falha ao ler comando: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                emit_json(
                    &output,
                    &Response {
                        id: 0,
                        ok: false,
                        result: None,
                        error: Some(format!("JSON inválido: {error}")),
                    },
                )?;
                continue;
            }
        };
        let should_shutdown = request.command == "shutdown";
        let result = process_request(
            &mut engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            &request,
        );
        let response = match result {
            Ok(result) => Response {
                id: request.id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Response {
                id: request.id,
                ok: false,
                result: None,
                error: Some(error),
            },
        };
        emit_json(&output, &response)?;

        if should_shutdown {
            break;
        }
    }

    running.store(false, Ordering::Relaxed);
    let _ = ticker.join();
    Ok(())
}
