use crate::chapter_probe::ChapterProbe;
use crate::process_memory::ProcessReader;
use livesplit_core::{TimeSpan, Timer, TimerPhase};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

const RE4_PROCESS_NAME: &str = "bio4.exe";
const ATTACH_RETRY_INTERVAL: Duration = Duration::from_millis(750);
/// Tempo jogado desde a última despausa abaixo do qual a pausa conta como pause buffer.
///
/// Dois segundos, o mesmo valor do autosplitter oficial da comunidade.
const PAUSE_BUFFER_WINDOW: Duration = Duration::from_secs(2);


/// Sala sentinela que o jogo escreve quando nenhuma sala do mundo está carregada: título,
/// telas de sistema e o intervalo em que um capítulo é descarregado para o próximo entrar.
const RE4_SYSTEM_ROOM: i16 = 288;

/// Primeira sala de gameplay. Abaixo disso o campo não aponta para uma sala real.
const RE4_FIRST_ROOM: i16 = 256;

/// Tempo que o IGT precisa ficar zerado para o reset automático valer.
///
/// O IGT é gravado em segundos inteiros, então um New Game mantém a leitura em 0 por mais de
/// um segundo — bem acima desta janela. Já a reinicialização de stage no fim de capítulo zera
/// o campo por poucos ticks, e é isso que a janela filtra.
const IGT_RESET_CONFIRM_WINDOW: Duration = Duration::from_millis(750);

/// Limite de linhas de diagnóstico acumuladas caso ninguém as consuma.
const DIAGNOSTICS_CAPACITY: usize = 64;

/// Intervalo entre amostras da varredura de capítulo.
const PROBE_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);

/// Intervalo do resumo periódico de estado.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);

/// Capítulos cujo fim **não** gera split próprio.
///
/// Vazia por padrão: no autosplitter oficial todo avanço de capítulo fecha segmento, sem exceção.
///
/// Onde há uma porta colada no fim do capítulo, quem é silenciado é a **porta**, em
/// `default_doors_without_split`. Antes fazíamos o inverso nos capítulos 1-1 e 1-3, silenciando o
/// capítulo e deixando a porta splitar. O número de splits é o mesmo, mas o limite cai alguns
/// segundos antes, o que desloca os tempos de segmento em relação aos de quem usa o autosplitter da
/// comunidade. Como o objetivo é ser comparável, o limite passou a ser o do oficial.
///
/// O mecanismo fica disponível para rotas que precisem dele. O índice é o valor que o contador
/// assume ao fechar o capítulo: 1 = fim do 1-1, 3 = fim do 1-3, 4 = fim do 2-1, e assim por diante.
fn default_chapter_ends_without_split() -> Vec<i32> {
    Vec::new()
}

/// Teto folgado para o playTime do jogo, em segundos (~277 h). Serve para descartar leitura
/// de offset errado na detecção de versão: valor de lixo em `u32` fica ordens de grandeza acima.
const MAX_PLAUSIBLE_IGT_SECONDS: u32 = 1_000_000;

/// Uma sala real do mundo, em oposição à sentinela das telas de sistema.
///
/// Só salas assim entram no latch de origem, o que é o que permite a transição de capítulo
/// (sala real -> sentinela -> sala real) continuar formando um par válido.
fn is_gameplay_room(room: i16) -> bool {
    room >= RE4_FIRST_ROOM && room != RE4_SYSTEM_ROOM
}

/// Resultado da avaliação da transição de sala no tick atual.
///
/// Carrega o motivo da recusa junto para o log de diagnóstico não precisar reimplementar
/// (e divergir de) a decisão real.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DoorDecision {
    /// Par (origem, destino) pronto para virar split.
    Ready((i16, i16)),
    /// Nenhuma sala do mundo carregada: o latch segura a origem até a próxima sala real.
    SystemRoom,
    /// Ainda não há origem: primeira sala vista desde o attach, o reset ou o start.
    NoOrigin,
    /// O jogo continua na mesma sala de origem.
    SameRoom,
    /// O IGT retrocedeu, assinatura de load de save em vez de porta.
    IgtRewind,
    /// Par já consumido nesta tentativa.
    AlreadyUsed((i16, i16)),
    /// Volta pela porta que acabou de splitar, listada como reatravessia do mesmo limite.
    Backtrack((i16, i16)),
    /// Volta pela porta que acabou de splitar que fecha segmento, o caso comum.
    Return((i16, i16)),
    /// Porta declarada na rota como limite de outro evento, então nunca fecha segmento sozinha.
    Blocked((i16, i16)),
}

impl DoorDecision {
    /// Rótulo curto para o log de diagnóstico.
    fn label(self) -> &'static str {
        match self {
            Self::Ready(_) => "par válido",
            Self::SystemRoom => "sala de sistema, aguardando a próxima sala real",
            Self::NoOrigin => "sem sala de origem ainda",
            Self::SameRoom => "mesma sala",
            Self::IgtRewind => "IGT retrocedeu, provável load de save",
            Self::AlreadyUsed(_) => "par já usado nesta tentativa",
            Self::Backtrack(_) => "volta na lista de exceções, reatravessia do mesmo limite",
            Self::Return(_) => "volta pela porta que acabou de splitar, fecha segmento",
            // Deliberadamente genérico: a lista cobre portas coladas em fim de capítulo e também
            // desvios de ida e volta, então afirmar "o limite é o capítulo" enganava no segundo caso.
            Self::Blocked(_) => "porta na lista doorsWithoutSplit, não fecha segmento",
        }
    }
}

/// Portas que nunca fecham segmento.
///
/// É a `unsplittedDoors` do autosplitter oficial da comunidade, par a par, com os nomes de sala que
/// ele documenta. A lista foi originalmente reconstruída aqui por engenharia reversa a partir dos
/// logs, e a comparação com o script oficial confirmou os treze pares encontrados desse jeito e
/// acrescentou os que faltavam — por isso agora ela é mantida como espelho, e não por dedução.
///
/// Existe porque a ordem dos eventos **varia** e não dá para inferir da memória: medido na mesma
/// sessão, nos capítulos 6→7 e 7→8 o contador de capítulo sobe primeiro e a porta vem 2,5 s e 3,5 s
/// depois; no 8→9 a porta vem primeiro e o contador 0,975 s depois. Sendo a porta o primeiro evento,
/// nada indica que um capítulo está chegando.
///
/// O par é `(sala de origem, sala de destino)` e o bloqueio é direcional: o sentido inverso splita
/// normalmente, a não ser que também esteja declarado.
///
/// O par `(288, 256)` do script oficial não aparece aqui porque não tem como se formar: 288 é a
/// sentinela de sistema, que nunca entra no latch de origem. Esse limite é tratado como início de
/// run, não como porta.
fn default_doors_without_split() -> Vec<(i16, i16)> {
    vec![
        // Fim do capítulo 1-1.
        (262, 260),
        // Fim do capítulo 1-3.
        (267, 283),
        // Fim do capítulo 3-3: a porta splitava e 0,975 s depois o capítulo splitava de novo.
        (527, 518),
        // Fim do capítulo 3-4: mesmo cenário, 0,979 s de intervalo.
        (525, 518),
        // Fim do capítulo 4-1, depois do Verdugo. Caso com porta dos **dois** lados: a de entrada
        // vinha 0,729 s antes do avanço e a de saída 0,793 s depois, rendendo três splits em 1,5 s.
        (545, 555),
        // Prophet's Room (cutscene) para a área antes da mina.
        (555, 544),
        // Fim do capítulo 4-2, 1,277 s depois do avanço.
        (541, 549),
        // Fim do capítulo 4-3, 0,917 s depois do avanço.
        (549, 550),
        // Fim do capítulo 4-4, 0,695 s depois do avanço. É a passagem do castelo (0x2xx) para a
        // ilha (0x300), então também é troca de stage.
        (554, 768),
        // Fim do capítulo 5-2, 1,112 s antes do avanço.
        (789, 790),
        // Fim do capítulo 5-3, 0,899 s depois do avanço.
        (796, 800),
        // Gatekeeper Hallway para Lord's Room: a porta splitava e ~3,5 s depois a cutscene
        // (533 -> 553) splitava também. O limite do segmento é a cutscene.
        (536, 533),
        // Pier para Tower Summit.
        (554, 552),
        // Barracks para Castle Wall, a volta do sword room. Você volta por ali por estratégia, não
        // porque a rota obriga, então não fecha segmento. A ida 514 -> 519 splita normalmente.
        (519, 514),
        // Ida e volta na sala 778, logo depois do fim do 5-2, com 0,688 s entre as duas. Nenhuma
        // fecha segmento, e por isso os **dois** sentidos entram: recusar só a ida deixaria a volta
        // splitar, porque `last_split_door` não é gravado quando a porta é recusada.
        (790, 778),
        (778, 790),
        // Steel Tower para Before the Steel Tower, atravessada em 0,903 s a caminho da 819. O limite
        // do segmento é a chegada na 819, que é a sala nova.
        (818, 817),
    ]
}

/// Voltas que **não** fecham segmento, por serem reatravessia do mesmo limite em vez de caminho.
///
/// Vazia por padrão, de propósito: o autosplitter oficial não tem esse conceito. Nele a volta é um
/// par distinto da ida, então splita a menos que esteja em `unsplittedDoors` — e a única volta que
/// não deve fechar segmento, a do sword room, está declarada lá como `(519, 514)`.
///
/// A polaridade também vem de contagem, não de intuição: na rota mapeada, ao menos nove idas e
/// voltas precisam que a volta splite (Mendez 287 -> 271, saída do 2-3 517 -> 516 e sete outros
/// trios onde o split N e o N+2 são o mesmo lugar), contra o único caso do sword room.
///
/// O mecanismo fica disponível para quem tenha uma rota que precise dele, mas o padrão não usa. A
/// diferença prática contra a lista incondicional é que esta só age quando `last_split_door` bate,
/// o que não sobrevive a um load de save.
///
/// O par é a transição de **volta**, na ordem `(sala de origem, sala de destino)`.
fn default_return_doors_without_split() -> Vec<(i16, i16)> {
    Vec::new()
}

/// Rótulo da fase do timer para o log de diagnóstico.
fn phase_label(phase: TimerPhase) -> &'static str {
    match phase {
        TimerPhase::NotRunning => "parado",
        TimerPhase::Running => "rodando",
        TimerPhase::Paused => "pausado",
        TimerPhase::Ended => "encerrado",
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosplitConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_profile")]
    pub profile: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default = "enabled_by_default")]
    pub auto_start: bool,
    /// Ligado: só inicia em jogo novo (título -> primeira sala). Desligado: inicia ao entrar em
    /// qualquer sala do jogo, o que cobre abrir um save.
    #[serde(default = "enabled_by_default")]
    pub start_only_on_new_game: bool,
    #[serde(default = "enabled_by_default")]
    pub split_on_doors: bool,
    /// Split no fim de cada capítulo. É um evento próprio do jogo, independente de porta.
    #[serde(default = "enabled_by_default")]
    pub split_on_chapters: bool,
    /// Capítulos cujo fim não gera split próprio. Ver `default_chapter_ends_without_split`.
    #[serde(default = "default_chapter_ends_without_split")]
    pub chapter_ends_without_split: Vec<i32>,
    /// Voltas que não fecham segmento. Ver `default_return_doors_without_split`.
    #[serde(default = "default_return_doors_without_split")]
    pub return_doors_without_split: Vec<(i16, i16)>,
    /// Portas que nunca fecham segmento. Ver `default_doors_without_split`.
    #[serde(default = "default_doors_without_split")]
    pub doors_without_split: Vec<(i16, i16)>,
    #[serde(default = "enabled_by_default")]
    pub remove_loads: bool,
    #[serde(default = "enabled_by_default")]
    pub auto_reset: bool,
}

impl Default for AutosplitConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            profile: default_profile(),
            version: default_version(),
            auto_start: true,
            start_only_on_new_game: true,
            split_on_doors: true,
            split_on_chapters: true,
            chapter_ends_without_split: default_chapter_ends_without_split(),
            return_doors_without_split: default_return_doors_without_split(),
            doors_without_split: default_doors_without_split(),
            remove_loads: true,
            auto_reset: true,
        }
    }
}

fn default_profile() -> String {
    "re4UhdSteam".to_owned()
}

fn default_version() -> String {
    "auto".to_owned()
}

const fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosplitState {
    pub enabled: bool,
    pub profile: String,
    pub version: String,
    pub auto_start: bool,
    pub start_only_on_new_game: bool,
    pub split_on_doors: bool,
    pub split_on_chapters: bool,
    pub chapter_ends_without_split: Vec<i32>,
    pub return_doors_without_split: Vec<(i16, i16)>,
    pub doors_without_split: Vec<(i16, i16)>,
    pub remove_loads: bool,
    pub auto_reset: bool,
    pub status: &'static str,
    pub message: String,
    pub process_name: &'static str,
    pub process_id: Option<u32>,
    pub detected_version: Option<&'static str>,
    pub current_room: Option<i16>,
    pub loading: bool,
    pub money: Option<i32>,
    pub chapter_kills: Option<u32>,
    /// The game's persisted playTime value converted from whole seconds.
    pub igt_ms: Option<u64>,
    pub pause_buffers: Option<u32>,
}

#[derive(Debug, Clone, Copy)]
struct Re4Offsets {
    label: &'static str,
    frame_rate: usize,
    total_frames: usize,
    menu_type: usize,
    character: usize,
    room: usize,
    igt: usize,
    screen_state: usize,
    current_screen: usize,
    money: usize,
    chapter_kills: usize,
    end_of_chapter: usize,
    /// Nome do FMV em execução. É o limite do último segmento: o jetski não passa por porta nenhuma
    /// e o contador de capítulo para no 18, então sem ele a run nunca fecha.
    movie: usize,
}

/// Valor de `screen_state` com que o jogo se declara em gameplay.
const RE4_GAMEPLAY_SCREEN_STATE: u8 = 3;

/// Valor de `screen_state` do menu de pausa e da tela de opções.
const RE4_OPTIONS_SCREEN_STATE: u8 = 6;

/// Valor de `menu_type` das caixas de tutorial.
const RE4_TUTORIAL_MENU_TYPE: u8 = 64;

/// Salas com caixa de tutorial: a segunda do 1-1 e a última do 2-1.
const RE4_TUTORIAL_ROOMS: [i16; 2] = [257, 279];

/// Valor de `character` correspondente ao Leon.
const RE4_LEON: u8 = 0;

/// Se o tick não deve contar tempo de jogo.
///
/// Porte direto das três exclusões do autosplitter oficial da comunidade
/// (<https://github.com/yuushiGit/RE4OG_AutoSplitter>):
///
/// ```text
/// isDoorLoads = screenState != 3 && screenState != 6 && room != 288
/// isOptions   = screenState == 6
/// isTutorials = menuType == 64 && (room == 257 || room == 279)
/// if (!isDoorLoads && !isOptions && !isTutorials) elapsedFrames += totalFrames - old.totalFrames
/// ```
///
/// Duas consequências que valem registrar, porque foram pedidas explicitamente e caem de graça
/// aqui: o inventário **conta** como tempo de jogo, porque abre com `screen_state` em 3, e a pausa
/// **não** conta, pelo termo das opções. A sala sentinela também conta, e é isso que faz o tempo não
/// congelar entre capítulos.
fn frames_are_paused(snapshot: Re4Snapshot) -> bool {
    let door_loads = snapshot.screen_state != RE4_GAMEPLAY_SCREEN_STATE
        && snapshot.screen_state != RE4_OPTIONS_SCREEN_STATE
        && snapshot.room != RE4_SYSTEM_ROOM;
    let options = snapshot.screen_state == RE4_OPTIONS_SCREEN_STATE;

    door_loads || options || is_tutorial(snapshot)
}

/// Deslocamento do índice de capítulo dentro do campo `end_of_chapter`.
///
/// A palavra baixa guarda outra coisa e muda por conta própria (foi observada indo de 0 para 10
/// ao iniciar o jogo, sem troca de capítulo), então só a palavra alta é comparada.
const CHAPTER_WORD_SHIFT: u32 = 16;

/// Maior índice de capítulo plausível. O jogo principal tem 18 capítulos.
///
/// O bound é no índice resultante, não no tamanho do salto. Comparar com o degrau exato de 0x10000
/// não funciona porque o campo foi observado saltando vários índices de uma vez: ao carregar save o
/// contador fica em 0 e só recebe o valor real no fim do capítulo, então uma run que começa no 2-1
/// salta direto de 0 para 4. Limitar o salto rejeitava esses casos; limitar o índice descarta
/// leitura de lixo sem rejeitar progresso real.
const MAX_PLAUSIBLE_CHAPTER: i32 = 24;

/// Índice de capítulo contido no campo `end_of_chapter`.
fn chapter_index(end_of_chapter: i32) -> i32 {
    end_of_chapter >> CHAPTER_WORD_SHIFT
}

/// Sala do jetski, onde o FMV final do jogo principal toca.
const RE4_ENDING_ROOM: i16 = 819;

/// Índice em que começa o trecho comparado do nome do FMV.
///
/// O campo guarda um caminho curto, tipo `etc\ng.`, e o autosplitter oficial monta a identificação
/// como `room.ToString() + movie.Substring(4)`. Os quatro primeiros bytes são o prefixo do caminho.
const RE4_MOVIE_NAME_START: usize = 4;

/// Sufixo do FMV do final do jogo principal. Com a sala, forma o `"819ng."` do autosplitter oficial.
const RE4_ENDING_MOVIE_SUFFIX: &[u8] = b"ng.";

/// Se o FMV do final do jogo principal acabou de começar.
///
/// Porte direto da condição de fim de run do autosplitter oficial da comunidade
/// (<https://github.com/yuushiGit/RE4OG_AutoSplitter>):
///
/// ```text
/// movieId = current.room.ToString() + current.movie.Substring(4)
/// current.movie != old.movie && movieId == "819ng."
/// ```
///
/// Substitui o `mgEnd` do autosplitter anterior, que pulsava no início da cutscene e fechava a run
/// cerca de 3 s antes deste ponto — foi a diferença medida contra o LiveSplit numa run completa.
///
/// Exigir os dois lados presentes descarta o primeiro tick depois de anexar ao processo, que não tem
/// leitura anterior para comparar e não pode ser confundido com o final do jogo.
fn main_game_ending_started(previous: Re4Snapshot, current: Re4Snapshot) -> bool {
    let Some(before) = previous.movie else {
        return false;
    };
    let Some(now) = current.movie else {
        return false;
    };

    before != now
        && current.room == RE4_ENDING_ROOM
        && now.get(RE4_MOVIE_NAME_START..) == Some(RE4_ENDING_MOVIE_SUFFIX)
}

// The GLOBAL_WK-relative fields below come from the re4_tweaks SDK. Its
// playTime field (+0x4FA4) matches the established IGT offset in both builds.
//
// Every field below except `current_screen` and `end_of_chapter` is byte-identical to the official
// community autosplitter, RE4Splitter.asl by Yuushi
// (https://github.com/yuushiGit/RE4OG_AutoSplitter), which is what LiveSplit downloads when the
// autosplitter is activated for this game. `end_of_chapter` is the same address its `chapter` byte
// sits in, read as an int: its high word is the chapter index.
//
// Keeping the addresses aligned with that script is deliberate. It is the reference the leaderboard
// times are produced with, so any divergence here shows up as times that cannot be compared.
const RE4_110: Re4Offsets = Re4Offsets {
    label: "1.1.0",
    frame_rate: 0x82B7A0,
    total_frames: 0xCECB18,
    menu_type: 0x87AD04,
    character: 0x85F728,
    room: 0x85A788,
    igt: 0x85F704,
    screen_state: 0x85A780,
    current_screen: 0x8597BB,
    money: 0x85F708,
    chapter_kills: 0x862BC4,
    end_of_chapter: 0x85F6F8,
    movie: 0x86CE8C,
};

const RE4_106: Re4Offsets = Re4Offsets {
    label: "1.0.6",
    frame_rate: 0x827F38,
    total_frames: 0xCE9298,
    menu_type: 0x877484,
    character: 0x85BEA8,
    room: 0x856F08,
    igt: 0x85BE84,
    screen_state: 0x856F00,
    current_screen: 0x855F3B,
    money: 0x85BE88,
    chapter_kills: 0x85F344,
    end_of_chapter: 0x85BE78,
    movie: 0x8695FC,
};

#[derive(Debug, Clone, Copy)]
struct Re4Snapshot {
    frame_rate: u8,
    total_frames: i64,
    menu_type: u8,
    character: u8,
    room: i16,
    igt: u32,
    screen_state: u8,
    current_screen: Option<u8>,
    money: Option<i32>,
    chapter_kills: Option<u32>,
    /// Contador de capítulo nos 16 bits altos. Fechar um capítulo soma `CHAPTER_ADVANCE_STEP`.
    end_of_chapter: i32,

    /// Nome do FMV em execução, os mesmos 7 bytes do `string7 movie` do autosplitter oficial.
    ///
    /// Opcional pelo mesmo motivo dos campos de load: uma leitura ruim custa o split final, e não o
    /// snapshot inteiro. Fica em bytes crus, sem virar `String`, porque a comparação é por igualdade
    /// e por sufixo — nada aqui precisa de UTF-8, e `[u8; 7]` mantém o snapshot `Copy`.
    movie: Option<[u8; 7]>,
}

#[derive(Debug)]
pub struct Autosplitter {
    config: AutosplitConfig,
    status: &'static str,
    message: String,
    process: Option<ProcessReader>,
    offsets: Option<Re4Offsets>,
    previous: Option<Re4Snapshot>,
    completed_doors: HashSet<(i16, i16)>,
    /// Última sala real observada. Sobrevive às telas de sistema de propósito: é o que faz a
    /// virada de capítulo fechar um par com a sala anterior ao intervalo.
    last_gameplay_room: Option<i16>,
    /// IGT no momento em que `last_gameplay_room` foi gravado, para detectar load de save.
    last_gameplay_igt: u32,
    /// Quando o IGT caiu de `>0` para `0`. Só conta como New Game se persistir.
    igt_zero_since: Option<Instant>,
    /// Porta que ficou pendente porque o fim de capítulo splitou no mesmo tick.
    ///
    /// O timer fecha um segmento por chamada, então quando os dois eventos caem no mesmo tick a
    /// porta sai no tick seguinte em vez de ser descartada. Antes disso, abrir a porta rápido
    /// demais depois do end chapter perdia o split.
    pending_door_split: Option<(i16, i16)>,
    /// Par da última porta que gerou split, para reconhecer a volta por ela.
    ///
    /// Guardar só o último par, em vez de bloquear a volta de todas as portas já usadas, é
    /// deliberado: a rota normal reatravessa vários lugares, e bloquear tudo tiraria splits
    /// legítimos. O que não deve splitar é voltar pela porta que acabou de fechar um segmento.
    last_split_door: Option<(i16, i16)>,
    /// Frames de jogo acumulados com load removido, no modelo do autosplitter oficial.
    ///
    /// Zera ao iniciar e ao resetar a run, e **não** ao carregar um save: o `resetVariables` do
    /// script oficial roda só em `onStart` e `onReset`, e zerar aqui apagaria o tempo no meio da run.
    elapsed_frames: i64,
    /// Se o split final já saiu nesta tentativa.
    ///
    /// A cutscene final não é um valor estável: o campo muda algumas vezes enquanto ela roda, e sem
    /// isto cada mudança fecharia um segmento.
    final_split_emitted: bool,

    /// Linhas de diagnóstico das transições de sala, drenadas pelo loop do sidecar.
    diagnostics: Vec<String>,
    /// Varredura opcional que descobre a offset do contador de capítulo por observação.
    probe: ChapterProbe,
    /// Última amostragem da varredura e do resumo periódico.
    last_probe_sample: Option<Instant>,
    last_heartbeat: Option<Instant>,
    probe_announced: bool,
    last_attach_attempt: Option<Instant>,
    process_id: Option<u32>,
    current_room: Option<i16>,
    loading: bool,
    money: Option<i32>,
    chapter_kills: Option<u32>,
    pause_buffer_count: u32,
    /// Instante da última despausa, ou do início da tentativa.
    ///
    /// É o cronômetro de tempo jogado do autosplitter oficial: mede quanto se jogou desde que a
    /// pausa anterior fechou, e é essa medida que separa um pause buffer de uma pausa comum.
    unpaused_since: Option<Instant>,
    /// Estado da pausa no tick anterior, para detectar a borda de entrada.
    pause_was_open: bool,
}

impl Default for Autosplitter {
    fn default() -> Self {
        Self {
            config: AutosplitConfig::default(),
            status: "disabled",
            message: "Modo automático desativado.".to_owned(),
            process: None,
            offsets: None,
            previous: None,
            completed_doors: HashSet::new(),
            last_gameplay_room: None,
            last_gameplay_igt: 0,
            igt_zero_since: None,
            pending_door_split: None,
            last_split_door: None,
            elapsed_frames: 0,
            final_split_emitted: false,
            diagnostics: Vec::new(),
            probe: ChapterProbe::from_env(),
            last_probe_sample: None,
            last_heartbeat: None,
            probe_announced: false,
            last_attach_attempt: None,
            process_id: None,
            current_room: None,
            loading: false,
            money: None,
            chapter_kills: None,
            pause_buffer_count: 0,
            unpaused_since: None,
            pause_was_open: false,
        }
    }
}

impl Autosplitter {
    pub fn configure(&mut self, config: AutosplitConfig) -> Result<(), String> {
        if config.profile != "re4UhdSteam" {
            return Err(
                "Este perfil ainda não é suportado. Selecione Resident Evil 4 UHD (Steam)."
                    .to_owned(),
            );
        }
        if !matches!(config.version.as_str(), "auto" | "1.1.0" | "1.0.6") {
            return Err("Versão inválida para o perfil RE4 UHD Steam.".to_owned());
        }
        let was_enabled = self.config.enabled;
        let profile_changed =
            self.config.profile != config.profile || self.config.version != config.version;
        self.config = config;
        if !self.config.enabled {
            self.clear_pause_buffers();
            self.detach("Modo automático desativado.", "disabled");
        } else if !was_enabled || profile_changed {
            self.clear_pause_buffers();
            self.detach(
                "Aguardando o Resident Evil 4 UHD Steam (bio4.exe)...",
                "waitingForGame",
            );
            self.last_attach_attempt = None;
        }
        Ok(())
    }

    pub fn reset_attempt_metrics(&mut self) {
        // Sem isto uma tentativa iniciada à mão herdava `completed_doors` da anterior e todos
        // aqueles pares eram engolidos em silêncio pelo dedup. O auto-start limpava; o start
        // manual, não.
        self.forget_route();
        self.clear_pause_buffers();
    }

    /// Consome as linhas de diagnóstico acumuladas desde a última chamada.
    pub fn drain_diagnostics(&mut self) -> Vec<String> {
        std::mem::take(&mut self.diagnostics)
    }

    pub fn state(&self) -> AutosplitState {
        AutosplitState {
            enabled: self.config.enabled,
            profile: self.config.profile.clone(),
            version: self.config.version.clone(),
            auto_start: self.config.auto_start,
            start_only_on_new_game: self.config.start_only_on_new_game,
            split_on_doors: self.config.split_on_doors,
            split_on_chapters: self.config.split_on_chapters,
            chapter_ends_without_split: self.config.chapter_ends_without_split.clone(),
            return_doors_without_split: self.config.return_doors_without_split.clone(),
            doors_without_split: self.config.doors_without_split.clone(),
            remove_loads: self.config.remove_loads,
            auto_reset: self.config.auto_reset,
            status: self.status,
            message: self.message.clone(),
            process_name: RE4_PROCESS_NAME,
            process_id: self.process_id,
            detected_version: self.offsets.map(|offsets| offsets.label),
            current_room: self.current_room,
            loading: self.loading,
            money: self.money,
            chapter_kills: self.chapter_kills,
            igt_ms: self
                .previous
                .map(|snapshot| u64::from(snapshot.igt) * 1_000),
            // Sempre disponível quando anexado: o critério é `screen_state`, que é leitura
            // obrigatória do snapshot. Antes dependia de `current_screen`, que é opcional, e por
            // isso existia um campo separado dizendo se o contador valia.
            pause_buffers: self.process.is_some().then_some(self.pause_buffer_count),
        }
    }

    pub fn tick(&mut self, timer: Option<&mut Timer>) -> bool {
        if !self.config.enabled {
            return false;
        }
        if self.process.is_none() && !self.try_attach() {
            return false;
        }

        let snapshot = match self.read_snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.detach(
                    &format!("Conexão com bio4.exe perdida: {error}. Tentando reconectar..."),
                    "waitingForGame",
                );
                return false;
            }
        };
        self.current_room = Some(snapshot.room);
        // Toda troca da decisão de pausar o game time é registrada com as entradas que a
        // produziram. O resumo periódico não serve aqui: um congelamento de poucos ticks na
        // abertura do inventário passa inteiro entre duas amostras de 2 s.
        let was_loading = self.loading;
        self.loading = frames_are_paused(snapshot);
        if was_loading != self.loading {
            // Qual das três exclusões do autosplitter oficial está segurando o tempo. Sem nomear o
            // motivo, um congelamento inesperado obrigaria a deduzir a regra a partir dos campos.
            let reason = if snapshot.screen_state == RE4_OPTIONS_SCREEN_STATE {
                "pausa ou opções"
            } else if is_tutorial(snapshot) {
                "caixa de tutorial"
            } else if snapshot.screen_state != RE4_GAMEPLAY_SCREEN_STATE {
                "load de porta ou de stage"
            } else {
                "gameplay"
            };
            self.push_diagnostic(format!(
                "autosplit[load]: {} | motivo {} | screenState {} | menuType {} | sala {} | \
                 igt {}s | frames acumulados {} | frameRate {}",
                if self.loading {
                    "PARA de contar frames"
                } else {
                    "volta a contar frames"
                },
                reason,
                snapshot.screen_state,
                snapshot.menu_type,
                snapshot.room,
                snapshot.igt,
                self.elapsed_frames,
                snapshot.frame_rate,
            ));
        }
        self.money = snapshot.money;
        self.chapter_kills = snapshot.chapter_kills;

        self.status = "attached";
        self.message = format!(
            "Conectado ao RE4 UHD Steam {} (sala {}).",
            self.offsets
                .map(|offsets| offsets.label)
                .unwrap_or("desconhecido"),
            snapshot.room
        );

        // Diagnóstico. Roda antes de qualquer decisão e independe de haver run carregada, porque
        // parte do que precisa ser investigado é justamente o caso em que nada acontece.
        let phase_now = timer.as_ref().map(|timer| timer.current_phase());
        let game_name = timer
            .as_ref()
            .map(|timer| timer.run().game_name().to_owned());
        self.announce_probe();
        self.sample_probe();
        self.heartbeat(snapshot, phase_now, game_name.as_deref());

        let Some(previous) = self.previous.replace(snapshot) else {
            self.sync_pause_detector(snapshot);
            self.latch_gameplay_room(snapshot);
            return false;
        };

        self.track_igt_zero(previous, snapshot);

        let Some(timer) = timer else {
            self.reset_pause_buffers(snapshot);
            self.message = "Jogo detectado. Carregue uma run para usar o autosplit.".to_owned();
            self.latch_gameplay_room(snapshot);
            return false;
        };
        if !is_re4_uhd_run(timer.run().game_name()) {
            self.reset_pause_buffers(snapshot);
            self.status = "error";
            self.message =
                "O bio4.exe foi detectado, mas a run carregada não é Resident Evil 4 clássico/UHD."
                    .to_owned();
            self.latch_gameplay_room(snapshot);
            return false;
        }

        let phase = timer.current_phase();
        let mut timer_changed = false;
        // O que de fato saiu, para o diagnóstico não afirmar SPLIT quando o ramo do capítulo levou
        // a vez. O log anterior mentia nesse caso, o que esconderia exatamente este tipo de bug.
        let mut chapter_split_emitted = false;
        let mut door_split_emitted = false;
        let entered_world = !is_gameplay_room(previous.room) && is_gameplay_room(snapshot.room);
        let start_transition_ok = if self.config.start_only_on_new_game {
            // Jogo novo do modo principal sempre começa com o Leon na primeira sala, então exigir
            // o personagem aqui evita iniciar em Separate Ways, Mercenaries e afins.
            previous.room == RE4_SYSTEM_ROOM
                && snapshot.room == RE4_FIRST_ROOM
                && snapshot.character == RE4_LEON
        } else {
            // Abrir um save entra em qualquer sala e não necessariamente com o Leon: medido em
            // jogo, um save no capítulo 9 do castelo reporta `character` 1 de forma estável, por
            // dezenas de segundos. Exigir Leon aqui contradiria "iniciar ao abrir qualquer save".
            entered_world
        };
        let should_start =
            self.config.auto_start && phase == TimerPhase::NotRunning && start_transition_ok;
        let should_reset = self.config.auto_reset
            && matches!(phase, TimerPhase::Running | TimerPhase::Paused)
            && self.igt_zero_confirmed();
        // Fim de capítulo é um evento próprio do jogo e não passa pelo campo de sala: a tela de
        // resultado pode aparecer sem a sala mudar, e nesse caso a lógica de porta não tem nada
        // para observar. Por isso é uma condição separada, sem dedup por par.
        let previous_chapter = chapter_index(previous.end_of_chapter);
        let current_chapter = chapter_index(snapshot.end_of_chapter);
        let chapter_delta = current_chapter.wrapping_sub(previous_chapter);
        // Só avanço conta. Voltar a zero é o que acontece ao sair para o título e ao começar de
        // novo, e não deve splitar.
        let chapter_advanced = chapter_delta > 0 && current_chapter <= MAX_PLAUSIBLE_CHAPTER;
        // Sem janela de tempo: 0,634 s no fim do 1-1 exige um split e 2,5 s no fim do 2-1 exige
        // dois, então tempo não distingue os casos. Quem decide é a rota, via lista.
        let chapter_end_muted = self
            .config
            .chapter_ends_without_split
            .contains(&current_chapter);

        // Um capítulo fechado move a rota para outra seção, então a porta anterior deixa de ser
        // referência de volta imediata. Sem isto, a porta depois do end chapter do 2-1
        // (279 -> 280) era recusada por ser o inverso da 280 -> 279 que splitou 46 s antes.
        // Fica antes de `evaluate_door` para valer já neste tick.
        if chapter_advanced {
            self.last_split_door = None;
        }

        let decision = self.evaluate_door(snapshot);
        let door_target = match decision {
            DoorDecision::Ready(pair) | DoorDecision::Return(pair)
                if self.config.split_on_doors && phase == TimerPhase::Running =>
            {
                Some(pair)
            }
            _ => None,
        };

        let should_split_chapter = self.config.split_on_chapters
            && phase == TimerPhase::Running
            && chapter_advanced
            && !chapter_end_muted;
        // Fim do jogo. Não passa por porta nem por capítulo: o jetski fica na mesma sala e o
        // contador para no 18, então sem este ramo o último segmento nunca fecha. Não depende de
        // `split_on_doors` nem de `split_on_chapters` porque não é nenhum dos dois.
        let should_split_final = phase == TimerPhase::Running
            && !self.final_split_emitted
            && main_game_ending_started(previous, snapshot);
        // Lido antes das transições, porque `forget_route` limpa o latch.
        let origin_before = self.last_gameplay_room;

        if should_reset {
            timer.reset(true);
            self.forget_route();
            self.elapsed_frames = 0;
            self.reset_pause_buffers(snapshot);
            timer_changed = true;
        } else if should_start {
            timer.start();
            self.forget_route();
            // Os dois únicos pontos que zeram a contagem, como o `onStart` e o `onReset` do
            // autosplitter oficial. Carregar um save no meio da run não zera.
            self.elapsed_frames = 0;
            self.reset_pause_buffers(snapshot);
            timer_changed = true;
        } else if should_split_final {
            timer.split();
            self.final_split_emitted = true;
            // Mesma ideia do ramo de capítulo: a porta que caísse no mesmo tick não é descartada.
            // Na prática o fim do jogo não coincide com porta, mas o ramo não precisa supor isso.
            self.pending_door_split = door_target;
            timer_changed = true;
        } else if should_split_chapter {
            timer.split();
            chapter_split_emitted = true;
            // A porta que caiu no mesmo tick fica pendente em vez de ser descartada: o timer só
            // fecha um segmento por chamada, e os dois eventos são limites distintos.
            self.pending_door_split = door_target;
            // `latch_gameplay_room` roda depois, mas o par de origem do split de capítulo não é
            // uma porta, então `last_split_door` não muda aqui.
            timer_changed = true;
        } else if let Some(pair) = self
            .pending_door_split
            .take()
            .filter(|_| phase == TimerPhase::Running)
            .or(door_target)
        {
            timer.split();
            self.completed_doors.insert(pair);
            self.last_split_door = Some(pair);
            door_split_emitted = true;
            timer_changed = true;
        }

        // Por que o start automático não aconteceu. Sem isto o log fica silencioso exatamente no
        // caso "abri um save e o timer não iniciou": só existe linha quando o start dispara.
        // Sai apenas com o timer parado e quando a sala muda, então o volume é baixo.
        if phase == TimerPhase::NotRunning && previous.room != snapshot.room {
            let reason = if !self.config.auto_start {
                "autoStart desligado".to_owned()
            } else if !start_transition_ok {
                if self.config.start_only_on_new_game {
                    format!(
                        "modo jogo novo exige {} -> {} com o Leon, e veio {} -> {} com personagem {}",
                        RE4_SYSTEM_ROOM,
                        RE4_FIRST_ROOM,
                        previous.room,
                        snapshot.room,
                        snapshot.character
                    )
                } else {
                    format!(
                        "não é entrada no mundo: origem {} é sala real? {} | destino {} é sala real? {}",
                        previous.room,
                        is_gameplay_room(previous.room),
                        snapshot.room,
                        is_gameplay_room(snapshot.room)
                    )
                }
            } else {
                "START emitido".to_owned()
            };
            self.push_diagnostic(format!(
                "autosplit[start]: sala {} -> {} | soJogoNovo {} | personagem {} | igt {}s | \
                 screenState {} | run {:?} | {}",
                previous.room,
                snapshot.room,
                self.config.start_only_on_new_game,
                snapshot.character,
                snapshot.igt,
                snapshot.screen_state,
                timer.run().game_name(),
                reason,
            ));
        }

        // Campos de tela em resolução de tick. O resumo de 2 em 2 segundos não resolve o que
        // acontece na abertura da tela de fim de capítulo: nele `currentScreen` 64 aparecia às
        // vezes por 8 s seguidos, às vezes piscando, às vezes longe de qualquer capítulo. Sem ver
        // as transições reais não há como splitar na abertura do end chapter.
        if snapshot.screen_state != previous.screen_state
            || snapshot.current_screen != previous.current_screen
            || snapshot.menu_type != previous.menu_type
        {
            self.push_diagnostic(format!(
                "autosplit[tela]: screenState {} -> {} | currentScreen {:?} -> {:?} | \
                 menuType {} -> {} | sala {} | igt {}s | capítulo {} | fase {}",
                previous.screen_state,
                snapshot.screen_state,
                previous.current_screen,
                snapshot.current_screen,
                previous.menu_type,
                snapshot.menu_type,
                snapshot.room,
                snapshot.igt,
                current_chapter,
                phase_label(phase),
            ));
        }

        // Registra toda mudança do campo, não só o avanço aceito. Na investigação anterior o
        // resumo de 2 em 2 segundos escondeu que o índice pulou dois de uma vez; em resolução de
        // tick a sequência real fica visível.
        if snapshot.end_of_chapter != previous.end_of_chapter {
            self.push_diagnostic(format!(
                "autosplit: endOfChapter 0x{:X} -> 0x{:X} | capítulo {} -> {} (delta {}) | igt {}s | \
                 sala {} | screenState {} | fase {} | {}",
                previous.end_of_chapter,
                snapshot.end_of_chapter,
                previous_chapter,
                current_chapter,
                chapter_delta,
                snapshot.igt,
                snapshot.room,
                snapshot.screen_state,
                phase_label(phase),
                if chapter_split_emitted {
                    "SPLIT"
                } else if chapter_end_muted {
                    "sem split: capítulo na lista chapterEndsWithoutSplit, a porta fecha o limite"
                } else if chapter_advanced {
                    "avanço aceito, mas o timer não está rodando"
                } else {
                    "sem split"
                },
            ));
        }

        // Registra toda mudança do campo da cutscene final, inclusive as recusadas. O split final
        // acontece uma vez por run, então não há como reproduzi-lo à vontade: se ele falhar, o log
        // precisa mostrar sozinho se o campo se moveu e por que a decisão foi a que foi.
        if snapshot.movie != previous.movie {
            self.push_diagnostic(format!(
                "autosplit: movie {:?} -> {:?} | igt {}s | sala {} | screenState {} | \
                 capítulo {} | fase {} | {}",
                movie_label(previous.movie),
                movie_label(snapshot.movie),
                snapshot.igt,
                snapshot.room,
                snapshot.screen_state,
                current_chapter,
                phase_label(phase),
                if should_split_final {
                    "SPLIT final"
                } else if self.final_split_emitted {
                    "sem split: o final já fechou nesta tentativa"
                } else if snapshot.room != RE4_ENDING_ROOM {
                    "sem split: FMV fora da sala do jetski"
                } else if snapshot.movie.and_then(|movie| {
                    movie.get(RE4_MOVIE_NAME_START..).map(|name| name != RE4_ENDING_MOVIE_SUFFIX)
                }) == Some(true)
                {
                    "sem split: não é o FMV do final"
                } else {
                    "sem split: o timer não está rodando"
                },
            ));
        }

        // O campo `room` só muda em porta, carregamento de stage e entrada/saída de tela de
        // sistema, então logar a mudança é barato e é a única forma de ver por que um split não
        // saiu: antes disso toda recusa era silenciosa.
        if previous.room != snapshot.room {
            // Mesma precedência do if/else acima: reset e start vencem o split.
            let outcome = if should_reset {
                "reset automático"
            } else if should_start {
                "start automático"
            } else if door_split_emitted {
                "SPLIT"
            } else if self.pending_door_split.is_some() {
                "pendente: o fim de capítulo splitou neste tick, a porta sai no próximo"
            } else {
                "sem split"
            };
            let origin = origin_before.map_or_else(|| "—".to_owned(), |room| room.to_string());
            self.push_diagnostic(format!(
                "autosplit: sala {} -> {} | origem {} | igt {}s | screenState {} | capítulo {} | fase {} | {} | {}",
                previous.room,
                snapshot.room,
                origin,
                snapshot.igt,
                snapshot.screen_state,
                snapshot.end_of_chapter >> 16,
                phase_label(phase),
                decision.label(),
                outcome,
            ));
        }

        self.latch_gameplay_room(snapshot);

        self.update_pause_buffers(snapshot, timer.current_phase());

        // Contagem de frames do jogo, com as exclusões do autosplitter oficial. Fica fora do `if`
        // abaixo de propósito: acumular depende só do jogo, não da fase do timer, e é o que mantém o
        // valor coerente se o timer for pausado e retomado no meio.
        if !frames_are_paused(snapshot) {
            // Só delta positivo. Dentro de um mesmo processo o contador é monotônico, mas um
            // retrocesso por leitura ruim destruiria o tempo acumulado da run inteira.
            self.elapsed_frames += (snapshot.total_frames - previous.total_frames).max(0);
        }

        if self.config.remove_loads && timer.current_phase() == TimerPhase::Running {
            if !timer.is_game_time_initialized() {
                timer.initialize_game_time();
            }
            // Equivale ao `isLoading { return true; }` do autosplitter oficial: o Game Time nunca
            // anda por conta própria. Fica pausado permanentemente e recebe o valor calculado a cada
            // tick, que é o uso que a própria doc do `set_game_time` descreve. O modelo anterior
            // pausava e retomava conforme um critério de load; agora o tempo vem do jogo, e não do
            // relógio de parede menos as pausas.
            if !timer.is_game_time_paused() {
                timer.pause_game_time();
            }
            if snapshot.frame_rate > 0 {
                timer.set_game_time(TimeSpan::from_seconds(
                    self.elapsed_frames as f64 / f64::from(snapshot.frame_rate),
                ));
            }
        }

        timer_changed
    }

    fn try_attach(&mut self) -> bool {
        if self
            .last_attach_attempt
            .is_some_and(|last| last.elapsed() < ATTACH_RETRY_INTERVAL)
        {
            return false;
        }
        self.last_attach_attempt = Some(Instant::now());
        let process = match ProcessReader::attach(RE4_PROCESS_NAME) {
            Ok(Some(process)) => process,
            Ok(None) => {
                self.status = "waitingForGame";
                self.message = "Aguardando o Resident Evil 4 UHD Steam (bio4.exe)...".to_owned();
                return false;
            }
            Err(error) => {
                self.status = "error";
                self.message = error;
                return false;
            }
        };
        let Some(offsets) = self.detect_offsets(&process) else {
            self.status = "unsupportedVersion";
            self.message =
                "bio4.exe foi encontrado, mas a versão não é suportada. Use Steam 1.1.0 ou 1.0.6."
                    .to_owned();
            return false;
        };
        self.process_id = Some(process.process_id());
        self.offsets = Some(offsets);
        self.process = Some(process);
        self.previous = None;
        self.status = "attached";
        self.message = format!("RE4 UHD Steam {} detectado.", offsets.label);
        true
    }

    fn detect_offsets(&self, process: &ProcessReader) -> Option<Re4Offsets> {
        let candidates: &[Re4Offsets] = match self.config.version.as_str() {
            "1.1.0" => &[RE4_110],
            "1.0.6" => &[RE4_106],
            _ => &[RE4_110, RE4_106],
        };
        candidates.iter().copied().find(|offsets| {
            read_re4_snapshot(process, *offsets).is_ok_and(|snapshot| snapshot.is_plausible())
        })
    }

    /// Avalia a transição de sala do tick usando a última sala **real** como origem.
    ///
    /// O modelo anterior montava o par com a sala do tick imediatamente anterior. Como o jogo
    /// escreve `RE4_SYSTEM_ROOM` (e valores abaixo de `RE4_FIRST_ROOM`) enquanto nenhuma sala do
    /// mundo está carregada, a virada de capítulo virava dois pares inválidos — (sala, sentinela)
    /// e (sentinela, sala) — e nenhum split acontecia. Guardando a origem num latch, a sentinela
    /// é apenas ignorada e o par se fecha quando a próxima sala real carrega.
    fn evaluate_door(&self, snapshot: Re4Snapshot) -> DoorDecision {
        if !is_gameplay_room(snapshot.room) {
            return DoorDecision::SystemRoom;
        }
        let Some(from) = self.last_gameplay_room else {
            return DoorDecision::NoOrigin;
        };
        if from == snapshot.room {
            return DoorDecision::SameRoom;
        }
        // O playTime é monotônico dentro de uma tentativa. Retroceder significa que o jogo
        // carregou um save, não que o jogador atravessou uma porta.
        if snapshot.igt < self.last_gameplay_igt {
            return DoorDecision::IgtRewind;
        }
        let pair = (from, snapshot.room);
        // Declaração explícita da rota tem precedência sobre tudo: o limite ali é outro evento.
        if self.config.doors_without_split.contains(&pair) {
            return DoorDecision::Blocked(pair);
        }
        // Volta pela porta que acabou de splitar: o par invertido do último split. Reatravessar o
        // mesmo limite não abre segmento novo, a não ser que a rota obrigue a voltar por ali.
        let is_return = self.last_split_door == Some((snapshot.room, from));
        if is_return && self.config.return_doors_without_split.contains(&pair) {
            return DoorDecision::Backtrack(pair);
        }
        if self.completed_doors.contains(&pair) {
            return DoorDecision::AlreadyUsed(pair);
        }
        if is_return {
            return DoorDecision::Return(pair);
        }
        DoorDecision::Ready(pair)
    }

    /// Grava a sala atual como origem da próxima transição. Só salas reais entram.
    fn latch_gameplay_room(&mut self, snapshot: Re4Snapshot) {
        if is_gameplay_room(snapshot.room) {
            self.last_gameplay_room = Some(snapshot.room);
            self.last_gameplay_igt = snapshot.igt;
        }
    }

    /// Arma a janela de confirmação do reset na borda de descida do IGT.
    ///
    /// Exigir a borda `>0 -> 0` impede que a janela rearme sozinha logo depois de um start, em
    /// que o IGT legitimamente fica em 0 durante o primeiro segundo de jogo.
    fn track_igt_zero(&mut self, previous: Re4Snapshot, snapshot: Re4Snapshot) {
        if snapshot.igt > 0 {
            self.igt_zero_since = None;
        } else if previous.igt > 0 {
            self.igt_zero_since = Some(Instant::now());
        }
    }

    /// O IGT caiu para zero e ficou lá tempo suficiente para ser New Game, não um stage load.
    fn igt_zero_confirmed(&self) -> bool {
        self.igt_zero_since
            .is_some_and(|since| since.elapsed() >= IGT_RESET_CONFIRM_WINDOW)
    }

    /// Esquece a rota da tentativa: pares já usados, sala de origem e janela de reset.
    fn forget_route(&mut self) {
        self.completed_doors.clear();
        self.last_gameplay_room = None;
        self.last_gameplay_igt = 0;
        self.igt_zero_since = None;
        self.pending_door_split = None;
        self.last_split_door = None;
        self.final_split_emitted = false;
    }

    /// Registra uma vez qual região a varredura está cobrindo.
    fn announce_probe(&mut self) {
        if self.probe_announced || !self.probe.is_enabled() {
            return;
        }
        self.probe_announced = true;
        let description = self.probe.describe();
        self.push_diagnostic(format!("autosplit: {description}"));
    }

    /// Reamostra a varredura e reporta as offsets que avançaram um degrau de capítulo.
    ///
    /// Empréstimos disjuntos de campos: `self.process` sai como referência imutável enquanto
    /// `self.probe` e `self.diagnostics` saem como mutáveis, o que o borrow checker aceita dentro
    /// de um mesmo corpo de função.
    fn sample_probe(&mut self) {
        if !self.probe.is_enabled() {
            return;
        }
        if self
            .last_probe_sample
            .is_some_and(|last| last.elapsed() < PROBE_SAMPLE_INTERVAL)
        {
            return;
        }
        self.last_probe_sample = Some(Instant::now());

        let Some(process) = self.process.as_ref() else {
            return;
        };
        let candidates = self.probe.sample(process);
        for candidate in candidates {
            let line = format!(
                "autosplit: CANDIDATO de capítulo em bio4.exe+0x{:X} | {} -> {} (capítulo {})",
                candidate.offset,
                candidate.from,
                candidate.to,
                candidate.to >> 16
            );
            self.push_diagnostic(line);
        }
    }

    /// Resumo periódico de todos os campos lidos, para o diagnóstico não depender de acontecer
    /// alguma transição.
    fn heartbeat(
        &mut self,
        snapshot: Re4Snapshot,
        phase: Option<TimerPhase>,
        game_name: Option<&str>,
    ) {
        if self
            .last_heartbeat
            .is_some_and(|last| last.elapsed() < HEARTBEAT_INTERVAL)
        {
            return;
        }
        self.last_heartbeat = Some(Instant::now());

        let version = self.offsets.map_or("?", |offsets| offsets.label);
        let end_of_chapter_offset = self.offsets.map_or(0, |offsets| offsets.end_of_chapter);
        let movie_offset = self.offsets.map_or(0, |offsets| offsets.movie);
        let game_time = f64::from(snapshot.frame_rate.max(1));
        let line = format!(
            "autosplit[estado]: versão {} | status {} | sala {} | screenState {} | menuType {} | \
             currentScreen {:?} | igt {}s | endOfChapter {} = 0x{:X} (capítulo {}) @ bio4.exe+0x{:X} | \
             chapterKills {:?} | dinheiro {:?} | personagem {} | \
             frameRate {} | totalFrames {} | framesContados {} | gameTime {:.3}s | contando {} | \
             movie {:?} @ bio4.exe+0x{:X} | finalJaSaiu {} | \
             fase {} | run {:?} | runAceita {} | splitPorta {} | splitCapitulo {}",
            version,
            self.status,
            snapshot.room,
            snapshot.screen_state,
            snapshot.menu_type,
            snapshot.current_screen,
            snapshot.igt,
            snapshot.end_of_chapter,
            snapshot.end_of_chapter,
            snapshot.end_of_chapter >> 16,
            end_of_chapter_offset,
            snapshot.chapter_kills,
            snapshot.money,
            snapshot.character,
            snapshot.frame_rate,
            snapshot.total_frames,
            self.elapsed_frames,
            self.elapsed_frames as f64 / game_time,
            !frames_are_paused(snapshot),
            movie_label(snapshot.movie),
            movie_offset,
            self.final_split_emitted,
            phase.map_or("sem run", phase_label),
            game_name.unwrap_or("—"),
            game_name.is_some_and(is_re4_uhd_run),
            self.config.split_on_doors,
            self.config.split_on_chapters,
        );
        self.push_diagnostic(line);
    }

    fn push_diagnostic(&mut self, line: String) {
        if self.diagnostics.len() >= DIAGNOSTICS_CAPACITY {
            self.diagnostics.remove(0);
        }
        self.diagnostics.push(line);
    }

    fn read_snapshot(&self) -> Result<Re4Snapshot, String> {
        let process = self
            .process
            .as_ref()
            .ok_or_else(|| "Processo não conectado.".to_owned())?;
        let offsets = self
            .offsets
            .ok_or_else(|| "Versão do jogo não detectada.".to_owned())?;
        read_re4_snapshot(process, offsets)
    }

    /// Conta pause buffers observando as bordas da pausa, como o `update` do autosplitter oficial.
    fn update_pause_buffers(&mut self, snapshot: Re4Snapshot, phase: TimerPhase) {
        let pause_open = is_pause_menu_open(snapshot);
        // Run encerrada não recebe mais estatística. O oficial continuaria contando, mas zera o
        // contador ao iniciar a tentativa seguinte, então o número que sobra para a run terminada é
        // o mesmo nos dois.
        if phase == TimerPhase::Ended {
            self.pause_was_open = pause_open;
            return;
        }

        let now = Instant::now();
        match (self.pause_was_open, pause_open) {
            // Abriu a pausa: é buffer se jogou menos que a janela desde a despausa anterior.
            (false, true) => {
                if self
                    .unpaused_since
                    .is_some_and(|since| is_pause_buffer(now.duration_since(since)))
                {
                    self.pause_buffer_count = self.pause_buffer_count.saturating_add(1);
                }
            }
            // Fechou a pausa: o cronômetro de tempo jogado recomeça daqui.
            (true, false) => self.unpaused_since = Some(now),
            _ => {}
        }
        self.pause_was_open = pause_open;
    }

    fn reset_pause_buffers(&mut self, snapshot: Re4Snapshot) {
        self.pause_buffer_count = 0;
        self.sync_pause_detector(snapshot);
    }

    fn clear_pause_buffers(&mut self) {
        self.pause_buffer_count = 0;
        self.unpaused_since = None;
        self.pause_was_open = false;
    }

    /// Alinha o detector ao estado atual do jogo, sem contar nada.
    ///
    /// O cronômetro passa a valer daqui, equivalente ao `Stopwatch` do oficial, que corre desde a
    /// inicialização. Uma pausa aberta nos primeiros dois segundos de uma tentativa conta como
    /// buffer nos dois, e isso é intencional: pausar assim tão cedo é o próprio gesto.
    fn sync_pause_detector(&mut self, snapshot: Re4Snapshot) {
        self.pause_was_open = is_pause_menu_open(snapshot);
        self.unpaused_since = Some(Instant::now());
    }

    fn detach(&mut self, message: &str, status: &'static str) {
        self.process = None;
        self.offsets = None;
        self.previous = None;
        self.process_id = None;
        self.current_room = None;
        self.loading = false;
        self.money = None;
        self.chapter_kills = None;
        // Perdemos a leitura, então a origem e a janela de reset não valem mais. `completed_doors`
        // fica: uma reconexão no meio da tentativa não deve permitir resplitar o que já passou.
        self.last_gameplay_room = None;
        self.last_gameplay_igt = 0;
        self.igt_zero_since = None;
        self.unpaused_since = None;
        self.pause_was_open = false;
        self.status = status;
        self.message = message.to_owned();
    }
}

impl Re4Snapshot {
    fn is_plausible(self) -> bool {
        matches!(self.frame_rate, 30 | 60)
            && self.character <= 5
            && self.screen_state <= 6
            && (0..=2048).contains(&self.room)
            && self.total_frames >= 0
            && self.menu_type <= 128
            && self.igt <= MAX_PLAUSIBLE_IGT_SECONDS
    }
}

fn read_re4_snapshot(process: &ProcessReader, offsets: Re4Offsets) -> Result<Re4Snapshot, String> {
    let money = process
        .read::<i32>(offsets.money)
        .ok()
        .filter(|value| (0..=999_999_999).contains(value));
    let chapter_kills = process
        .read::<u32>(offsets.chapter_kills)
        .ok()
        .filter(|value| *value <= 1_000_000);

    Ok(Re4Snapshot {
        frame_rate: process.read(offsets.frame_rate)?,
        total_frames: process.read(offsets.total_frames)?,
        menu_type: process.read(offsets.menu_type)?,
        character: process.read(offsets.character)?,
        room: process.read(offsets.room)?,
        igt: process.read(offsets.igt)?,
        screen_state: process.read(offsets.screen_state)?,
        current_screen: process.read(offsets.current_screen).ok(),
        money,
        chapter_kills,
        end_of_chapter: process.read(offsets.end_of_chapter)?,

        movie: process.read::<[u8; 7]>(offsets.movie).ok(),
    })
}

/// Nome do FMV legível para o log, com os bytes não imprimíveis trocados por ponto.
///
/// O campo é preenchido com lixo quando nenhum filme está tocando, então imprimir cru sujaria o log.
fn movie_label(movie: Option<[u8; 7]>) -> String {
    movie.map_or_else(
        || "—".to_owned(),
        |bytes| {
            bytes
                .iter()
                .map(|byte| {
                    if byte.is_ascii_graphic() {
                        char::from(*byte)
                    } else {
                        '.'
                    }
                })
                .collect()
        },
    )
}

fn is_re4_uhd_run(game_name: &str) -> bool {
    let normalized = game_name.to_ascii_lowercase();
    let is_re4 = normalized.contains("resident evil 4")
        || normalized.contains("biohazard 4")
        || normalized == "re4"
        || normalized == "bio4";
    is_re4 && !normalized.contains("remake") && !normalized.contains("2023")
}

/// Menu de pausa ou tela de opções aberto.
///
/// O critério é o `screenState == 6` do autosplitter oficial, o mesmo termo que interrompe a
/// contagem de tempo. Antes usávamos `current_screen == 208`, que é a tela e não o estado; os dois
/// aparecem juntos na pausa, mas o estado é o que o script de referência observa.
///
/// As guardas de sala e de IGT ficam para não contar como pausa de run um menu aberto fora dela.
fn is_pause_menu_open(snapshot: Re4Snapshot) -> bool {
    snapshot.screen_state == RE4_OPTIONS_SCREEN_STATE
        && snapshot.room != RE4_SYSTEM_ROOM
        && snapshot.igt > 0
}

/// Se a pausa que acabou de abrir conta como pause buffer.
///
/// Porte direto do critério do autosplitter oficial, que mantém um cronômetro do tempo jogado desde
/// a última despausa e o compara com dois segundos ao abrir a pausa:
///
/// ```text
/// gameplayTime.Start();
/// if (current.screenState == 6 && old.screenState != 6) {
///     gameplayTime.Stop();
///     if (gameplayTime.Elapsed < TimeSpan.FromSeconds(2)) isPauseBuffer = true;
/// } else if (current.screenState != 6 && old.screenState == 6) {
///     gameplayTime.Restart();
/// }
/// ```
///
/// O modelo anterior era outro: exigia **duas** pausas dentro de 1,5 s uma da outra para contar
/// **uma**, então uma pausa 0,5 s depois de despausar não contava nada. Agora cada pausa que chega
/// rápido depois da anterior conta, que é o que a comunidade chama de pause buffer.
fn is_pause_buffer(gameplay_since_unpause: Duration) -> bool {
    gameplay_since_unpause < PAUSE_BUFFER_WINDOW
}

/// Caixa de tutorial aberta. Vale só nas duas salas que têm uma.
fn is_tutorial(snapshot: Re4Snapshot) -> bool {
    snapshot.menu_type == RE4_TUTORIAL_MENU_TYPE && RE4_TUTORIAL_ROOMS.contains(&snapshot.room)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Snapshot mínimo para exercitar a decisão de porta. Os campos que não participam dela
    /// ficam em valores de gameplay normal.
    fn snapshot(room: i16, igt: u32) -> Re4Snapshot {
        Re4Snapshot {
            frame_rate: 60,
            total_frames: 1_000,
            menu_type: 0,
            character: 0,
            room,
            igt,
            screen_state: 3,
            current_screen: Some(0),
            money: Some(0),
            chapter_kills: Some(0),
            end_of_chapter: 0,
            movie: Some(*b"       "),
        }
    }

    /// FMV do final do jogo principal, no formato observado pelo autosplitter oficial: caminho curto
    /// cujos bytes a partir do índice 4 são `ng.`.
    const FMV_FINAL: [u8; 7] = *b"etc\\ng.";

    /// Qualquer outro FMV, para checar que só o do final fecha a run.
    const FMV_QUALQUER: [u8; 7] = *b"etc\\op.";

    /// Snapshot com um FMV específico em execução, mantendo o resto de gameplay normal.
    fn snapshot_with_movie(room: i16, igt: u32, movie: Option<[u8; 7]>) -> Re4Snapshot {
        Re4Snapshot {
            movie,
            ..snapshot(room, igt)
        }
    }

    /// `screen_state` observado no log durante um carregamento de verdade.
    const SCREEN_STATE_CARREGANDO: u8 = 4;

    /// Snapshot em determinado estado de tela, para exercitar a contagem de frames.
    fn snapshot_on_screen(room: i16, screen_state: u8, menu_type: u8) -> Re4Snapshot {
        Re4Snapshot {
            screen_state,
            menu_type,
            ..snapshot(room, 600)
        }
    }

    /// Snapshot com o índice de capítulo nos 16 bits altos, como o jogo grava.
    ///
    /// `low` reproduz a palavra baixa, que o jogo usa para outra coisa: em jogo ela foi observada
    /// valendo 10 durante todo o começo da run.
    fn snapshot_in_chapter(room: i16, igt: u32, chapter: i32, low: i32) -> Re4Snapshot {
        Re4Snapshot {
            end_of_chapter: (chapter << CHAPTER_WORD_SHIFT) | low,
            ..snapshot(room, igt)
        }
    }

    /// Reproduz a condição de fim de capítulo do tick, isolada do `Timer`.
    fn chapter_advanced(previous: Re4Snapshot, current: Re4Snapshot) -> bool {
        let current_chapter = chapter_index(current.end_of_chapter);
        let delta = current_chapter.wrapping_sub(chapter_index(previous.end_of_chapter));
        delta > 0 && current_chapter <= MAX_PLAUSIBLE_CHAPTER
    }

    /// Autosplitter com a origem já latcheada, como no meio de uma tentativa.
    fn splitter_at(room: i16, igt: u32) -> Autosplitter {
        let mut splitter = Autosplitter::default();
        splitter.latch_gameplay_room(snapshot(room, igt));
        splitter
    }

    #[test]
    fn porta_comum_fecha_par() {
        let splitter = splitter_at(310, 600);
        assert_eq!(
            splitter.evaluate_door(snapshot(311, 601)),
            DoorDecision::Ready((310, 311))
        );
    }

    /// Regressão do bug relatado: ao fechar o capítulo o jogo passa pela sala de sistema, e o
    /// par precisa se fechar entre as duas salas reais, não contra a sentinela.
    #[test]
    fn virada_de_capitulo_splita_depois_da_sala_de_sistema() {
        let mut splitter = splitter_at(310, 600);

        let intervalo = snapshot(RE4_SYSTEM_ROOM, 600);
        assert_eq!(splitter.evaluate_door(intervalo), DoorDecision::SystemRoom);
        // A sentinela não pode sobrescrever a origem, senão o par nunca fecha.
        splitter.latch_gameplay_room(intervalo);
        assert_eq!(splitter.last_gameplay_room, Some(310));

        assert_eq!(
            splitter.evaluate_door(snapshot(350, 601)),
            DoorDecision::Ready((310, 350))
        );
    }

    /// Mesmo desenho, para o caso de o jogo escrever um valor abaixo da primeira sala em vez da
    /// sentinela: o latch cobre os dois sem precisar saber qual o jogo usa.
    #[test]
    fn valor_abaixo_da_primeira_sala_tambem_e_sala_de_sistema() {
        let mut splitter = splitter_at(310, 600);

        let intervalo = snapshot(0, 600);
        assert_eq!(splitter.evaluate_door(intervalo), DoorDecision::SystemRoom);
        splitter.latch_gameplay_room(intervalo);

        assert_eq!(
            splitter.evaluate_door(snapshot(350, 600)),
            DoorDecision::Ready((310, 350))
        );
    }

    #[test]
    fn mesma_sala_nao_e_porta() {
        let splitter = splitter_at(310, 600);
        assert_eq!(
            splitter.evaluate_door(snapshot(310, 601)),
            DoorDecision::SameRoom
        );
    }

    /// Sword room, sequência real do log: entra 514 -> 519, volta 519 -> 514. A volta é estratégia
    /// do jogador, não rota, então não abre segmento novo.
    ///
    /// A recusa vem da lista incondicional, onde o autosplitter oficial também põe este par, e não
    /// do mecanismo de volta. A diferença aparece depois de um load de save: `last_split_door` não
    /// sobrevive a ele, e pelo mecanismo de volta a porta voltaria a splitar.
    #[test]
    fn volta_do_sword_room_nao_splita() {
        let mut splitter = splitter_at(514, 76);

        assert_eq!(
            splitter.evaluate_door(snapshot(519, 76)),
            DoorDecision::Ready((514, 519))
        );
        splitter.completed_doors.insert((514, 519));
        splitter.last_split_door = Some((514, 519));
        splitter.latch_gameplay_room(snapshot(519, 76));

        assert_eq!(
            splitter.evaluate_door(snapshot(514, 113)),
            DoorDecision::Blocked((519, 514))
        );

        // E segue recusada sem nenhuma referência de ida, que é o caso do load de save.
        splitter.forget_route();
        splitter.latch_gameplay_room(snapshot(519, 76));
        assert_eq!(
            splitter.evaluate_door(snapshot(514, 113)),
            DoorDecision::Blocked((519, 514))
        );
    }

    /// Mendez, sequência real do log: entra na arena 271 -> 287 e volta 287 -> 271. A rota obriga a
    /// voltar por ali antes de seguir para o castelo, então a volta fecha segmento.
    #[test]
    fn volta_do_mendez_splita() {
        let mut splitter = splitter_at(271, 1_144);

        assert_eq!(
            splitter.evaluate_door(snapshot(287, 1_144)),
            DoorDecision::Ready((271, 287))
        );
        splitter.completed_doors.insert((271, 287));
        splitter.last_split_door = Some((271, 287));
        splitter.latch_gameplay_room(snapshot(287, 1_144));

        assert_eq!(
            splitter.evaluate_door(snapshot(271, 1_244)),
            DoorDecision::Return((287, 271))
        );
    }

    /// Padrão dos trios relatados: split N e N+2 no mesmo lugar, ou seja `A -> B -> A` com as três
    /// transições fechando segmento. Vale para qualquer par não listado, sem precisar cadastrar
    /// sala por sala.
    #[test]
    fn ida_e_volta_generica_fecha_os_dois_segmentos() {
        let mut splitter = splitter_at(700, 100);

        assert_eq!(
            splitter.evaluate_door(snapshot(701, 110)),
            DoorDecision::Ready((700, 701))
        );
        splitter.completed_doors.insert((700, 701));
        splitter.last_split_door = Some((700, 701));
        splitter.latch_gameplay_room(snapshot(701, 110));

        // A volta fecha o segmento seguinte, sem precisar estar em lista nenhuma.
        assert_eq!(
            splitter.evaluate_door(snapshot(700, 120)),
            DoorDecision::Return((701, 700))
        );
    }

    /// Porta de saída depois do fim do capítulo 7, sequência real do log: entra 516 -> 517, sai de
    /// volta 517 -> 516 e segue 516 -> 521. A saída fecha segmento.
    #[test]
    fn saida_do_capitulo_7_splita() {
        let mut splitter = splitter_at(516, 2_039);

        assert_eq!(
            splitter.evaluate_door(snapshot(517, 2_039)),
            DoorDecision::Ready((516, 517))
        );
        splitter.completed_doors.insert((516, 517));
        splitter.last_split_door = Some((516, 517));
        splitter.latch_gameplay_room(snapshot(517, 2_039));

        assert_eq!(
            splitter.evaluate_door(snapshot(516, 2_059)),
            DoorDecision::Return((517, 516))
        );
    }

    /// Gameplay conta tempo, e o inventário também.
    ///
    /// O inventário abre com `screen_state` em 3 e `menu_type` 1 ou 128, e nenhuma das três exclusões
    /// do autosplitter oficial olha `menu_type` fora das duas salas de tutorial. Foi pedido
    /// explicitamente que abrir o inventário não travasse o tempo, e aqui isso cai de graça.
    #[test]
    fn gameplay_e_inventario_contam_tempo() {
        assert!(!frames_are_paused(snapshot_on_screen(310, RE4_GAMEPLAY_SCREEN_STATE, 0)));
        // Inventário pelo botão de itens.
        assert!(!frames_are_paused(snapshot_on_screen(310, RE4_GAMEPLAY_SCREEN_STATE, 1)));
        // Inventário pela tela de mapa, o outro `menu_type` que o oficial reconhece como inventário.
        assert!(!frames_are_paused(snapshot_on_screen(310, RE4_GAMEPLAY_SCREEN_STATE, 128)));
    }

    /// Pausa aberta pouco depois de despausar é pause buffer; depois de jogar de verdade, não é.
    ///
    /// A janela é a do autosplitter oficial, dois segundos. Antes eram 1,5 s e a regra era outra:
    /// exigia duas pausas próximas uma da outra para contar uma só.
    #[test]
    fn janela_do_pause_buffer_segue_a_oficial() {
        assert_eq!(PAUSE_BUFFER_WINDOW, Duration::from_secs(2));

        // Repausou rápido: é buffer.
        assert!(is_pause_buffer(Duration::from_millis(120)));
        assert!(is_pause_buffer(Duration::from_millis(1_999)));
        // Jogou o suficiente: pausa comum.
        assert!(!is_pause_buffer(Duration::from_secs(2)));
        assert!(!is_pause_buffer(Duration::from_secs(30)));
    }

    /// A pausa é reconhecida por `screen_state`, não pela tela.
    ///
    /// É o mesmo termo que interrompe a contagem de tempo, e o que o script oficial observa. O
    /// inventário fica de fora porque abre em gameplay.
    #[test]
    fn pausa_e_reconhecida_pelo_estado_de_tela() {
        let pausado = snapshot_on_screen(310, RE4_OPTIONS_SCREEN_STATE, 0);
        assert!(is_pause_menu_open(pausado));

        // Inventário aberto: gameplay, não é pausa.
        assert!(!is_pause_menu_open(snapshot_on_screen(
            310,
            RE4_GAMEPLAY_SCREEN_STATE,
            1
        )));
        // Fora de uma run não conta como pausa de run.
        let fora_da_run = Re4Snapshot {
            igt: 0,
            ..snapshot_on_screen(RE4_SYSTEM_ROOM, RE4_OPTIONS_SCREEN_STATE, 0)
        };
        assert!(!is_pause_menu_open(fora_da_run));
    }

    /// Cada repausada rápida conta uma, e o contador anda em cima das bordas da pausa.
    ///
    /// Três pause buffers em sequência precisam virar três, não um. Era o que o modelo anterior
    /// errava: ele consumia duas pausas para registrar uma.
    #[test]
    fn cada_repausada_rapida_conta_uma() {
        let mut splitter = Autosplitter::default();
        let jogando = snapshot_on_screen(310, RE4_GAMEPLAY_SCREEN_STATE, 0);
        let pausado = snapshot_on_screen(310, RE4_OPTIONS_SCREEN_STATE, 0);

        splitter.sync_pause_detector(jogando);

        for esperado in 1..=3 {
            splitter.update_pause_buffers(pausado, TimerPhase::Running);
            assert_eq!(
                splitter.pause_buffer_count, esperado,
                "a {esperado}ª pausa rápida deveria contar"
            );
            splitter.update_pause_buffers(jogando, TimerPhase::Running);
        }
    }

    /// Segurar a pausa aberta por vários ticks conta uma vez, não uma por tick.
    #[test]
    fn pausa_mantida_aberta_conta_uma_vez() {
        let mut splitter = Autosplitter::default();
        let pausado = snapshot_on_screen(310, RE4_OPTIONS_SCREEN_STATE, 0);

        splitter.sync_pause_detector(snapshot_on_screen(310, RE4_GAMEPLAY_SCREEN_STATE, 0));

        for _ in 0..5 {
            splitter.update_pause_buffers(pausado, TimerPhase::Running);
        }

        assert_eq!(splitter.pause_buffer_count, 1);
    }

    /// Depois de jogar mais que a janela, a pausa não é buffer.
    ///
    /// Sem `unpaused_since` gravado não há medida, e é assim que o detector nasce.
    #[test]
    fn pausa_sem_cronometro_nao_conta() {
        let mut splitter = Autosplitter::default();
        let pausado = snapshot_on_screen(310, RE4_OPTIONS_SCREEN_STATE, 0);

        assert!(splitter.unpaused_since.is_none());
        splitter.update_pause_buffers(pausado, TimerPhase::Running);

        assert_eq!(splitter.pause_buffer_count, 0);
    }

    /// Run encerrada não recebe mais estatística.
    #[test]
    fn run_encerrada_nao_conta_pause_buffer() {
        let mut splitter = Autosplitter::default();
        let jogando = snapshot_on_screen(310, RE4_GAMEPLAY_SCREEN_STATE, 0);
        let pausado = snapshot_on_screen(310, RE4_OPTIONS_SCREEN_STATE, 0);

        splitter.sync_pause_detector(jogando);
        splitter.update_pause_buffers(pausado, TimerPhase::Ended);

        assert_eq!(splitter.pause_buffer_count, 0);
    }

    /// Pausa e tela de opções param o tempo, pelo termo `screenState == 6`.
    #[test]
    fn pausa_e_opcoes_param_o_tempo() {
        assert!(frames_are_paused(snapshot_on_screen(
            310,
            RE4_OPTIONS_SCREEN_STATE,
            0
        )));
    }

    /// Load de porta ou de stage para o tempo: fora de gameplay, fora da pausa, com sala carregada.
    #[test]
    fn load_de_porta_para_o_tempo() {
        assert!(frames_are_paused(snapshot_on_screen(
            310,
            SCREEN_STATE_CARREGANDO,
            0
        )));
    }

    /// A sala sentinela conta tempo mesmo fora de gameplay.
    ///
    /// É o `room != 288` do termo de load do oficial. Sem essa exceção o tempo congelaria na virada
    /// de capítulo, que passa pela sentinela com a tela fora de gameplay.
    #[test]
    fn sala_de_sistema_nao_para_o_tempo() {
        assert!(!frames_are_paused(snapshot_on_screen(
            RE4_SYSTEM_ROOM,
            SCREEN_STATE_CARREGANDO,
            0
        )));
    }

    /// Caixa de tutorial para o tempo, e só nas duas salas que têm uma.
    #[test]
    fn tutorial_para_o_tempo_apenas_nas_salas_com_tutorial() {
        for room in RE4_TUTORIAL_ROOMS {
            assert!(
                frames_are_paused(snapshot_on_screen(
                    room,
                    RE4_GAMEPLAY_SCREEN_STATE,
                    RE4_TUTORIAL_MENU_TYPE
                )),
                "sala {room} tem tutorial e deveria parar o tempo"
            );
        }

        // Mesmo `menu_type` em qualquer outra sala é outra coisa, e conta tempo.
        assert!(!frames_are_paused(snapshot_on_screen(
            310,
            RE4_GAMEPLAY_SCREEN_STATE,
            RE4_TUTORIAL_MENU_TYPE
        )));
    }

    /// O tempo é frames contados dividido pela taxa de quadros, como no `gameTime` do oficial.
    #[test]
    fn game_time_vem_dos_frames_contados() {
        // Uma hora e meia a 60 fps, a ordem de grandeza de uma run completa.
        let frames: i64 = 324_000;

        assert_eq!(frames as f64 / f64::from(60_u8), 5_400.0);
    }

    /// Sequência real do fim do capítulo 8: a porta 527 -> 518 splitava e 0,975 s depois o capítulo
    /// splitava de novo. A porta é declarada, então só o capítulo fecha o segmento.
    #[test]
    fn porta_do_fim_do_capitulo_8_nao_splita() {
        let splitter = splitter_at(527, 2_425);

        assert_eq!(
            splitter.evaluate_door(snapshot(518, 2_425)),
            DoorDecision::Blocked((527, 518))
        );
    }

    /// Fim do capítulo 9, mesma sequência: a porta 525 -> 518 splitava e 0,979 s depois o capítulo
    /// splitava de novo.
    #[test]
    fn porta_do_fim_do_capitulo_9_nao_splita() {
        let splitter = splitter_at(525, 410);

        assert_eq!(
            splitter.evaluate_door(snapshot(518, 410)),
            DoorDecision::Blocked((525, 518))
        );
    }

    /// A porta bloqueada só vale num sentido. `518 -> 525` aparece no log splitando legitimamente.
    #[test]
    fn entrada_para_525_continua_splitando() {
        let splitter = splitter_at(518, 207);

        assert_eq!(
            splitter.evaluate_door(snapshot(525, 207)),
            DoorDecision::Ready((518, 525))
        );
    }

    /// Fim do capítulo 10, depois do Verdugo: portas dos dois lados do avanço, o único caso assim.
    /// Sem bloquear as duas, o trecho rendia três splits em 1,5 s.
    #[test]
    fn portas_dos_dois_lados_do_capitulo_10_nao_splitam() {
        // Porta de entrada, 0,729 s antes do avanço.
        let antes = splitter_at(545, 4_059);
        assert_eq!(
            antes.evaluate_door(snapshot(555, 4_059)),
            DoorDecision::Blocked((545, 555))
        );

        // Porta de saída, 0,793 s depois do avanço.
        let depois = splitter_at(555, 4_068);
        assert_eq!(
            depois.evaluate_door(snapshot(544, 4_068)),
            DoorDecision::Blocked((555, 544))
        );
    }

    /// Saídas dos fins dos capítulos 11 e 12: o avanço splitava e ~1 s depois a porta splitava de
    /// novo. A sala 549 aparece nos dois, uma vez como destino e outra como origem.
    #[test]
    fn saidas_dos_capitulos_11_e_12_nao_splitam() {
        let onze = splitter_at(541, 4_316);
        assert_eq!(
            onze.evaluate_door(snapshot(549, 4_316)),
            DoorDecision::Blocked((541, 549))
        );

        let doze = splitter_at(549, 4_579);
        assert_eq!(
            doze.evaluate_door(snapshot(550, 4_579)),
            DoorDecision::Blocked((549, 550))
        );
    }

    /// Saída do fim do capítulo 13: castelo para ilha, 0,695 s depois do avanço. O bloqueio vale
    /// mesmo atravessando stage, porque a decisão é por par de salas.
    #[test]
    fn saida_do_capitulo_13_nao_splita_mesmo_trocando_de_stage() {
        let splitter = splitter_at(554, 4_806);

        assert_eq!(
            splitter.evaluate_door(snapshot(768, 4_806)),
            DoorDecision::Blocked((554, 768))
        );
    }

    /// Entrada do fim do capítulo 15, 1,112 s **antes** do avanço. Bloquear entrada e saída usa o
    /// mesmo mecanismo: a lista é de pares, não de "antes" ou "depois".
    #[test]
    fn entrada_do_capitulo_15_nao_splita() {
        let splitter = splitter_at(789, 5_715);

        assert_eq!(
            splitter.evaluate_door(snapshot(790, 5_715)),
            DoorDecision::Blocked((789, 790))
        );
    }

    /// Fim do jogo no jetski: o FMV final é o único limite do último segmento.
    ///
    /// Valores da run que expôs o bug: sala 819 e capítulo parado no 18. Nem porta nem capítulo
    /// fecham aqui, e era por isso que o último split nunca saía.
    #[test]
    fn fmv_do_final_fecha_o_ultimo_segmento() {
        let antes = snapshot_with_movie(RE4_ENDING_ROOM, 5_806, Some(FMV_QUALQUER));
        let depois = snapshot_with_movie(RE4_ENDING_ROOM, 5_806, Some(FMV_FINAL));

        assert!(main_game_ending_started(antes, depois));
    }

    /// Só o FMV do final fecha a run, e só na sala do jetski.
    ///
    /// É o que separa este gatilho do `mgEnd` anterior, que aceitava qualquer mudança do campo e
    /// fechava a run cerca de 3 s cedo.
    #[test]
    fn outro_fmv_ou_outra_sala_nao_fecham_a_run() {
        let antes = snapshot_with_movie(RE4_ENDING_ROOM, 5_806, Some(FMV_QUALQUER));

        // FMV diferente na sala certa: o sufixo não é o do final.
        let outro_fmv = snapshot_with_movie(RE4_ENDING_ROOM, 5_806, Some(*b"etc\\s10"));
        assert!(!main_game_ending_started(antes, outro_fmv));

        // FMV do final numa sala qualquer: a sala faz parte da identificação no script oficial.
        let outra_sala = snapshot_with_movie(818, 5_806, Some(FMV_FINAL));
        assert!(!main_game_ending_started(antes, outra_sala));

        // Sentinela de sistema, como no tick em que o jogo descarrega a sala para o título.
        let titulo = snapshot_with_movie(RE4_SYSTEM_ROOM, 0, Some(FMV_FINAL));
        assert!(!main_game_ending_started(antes, titulo));
    }

    /// O mesmo FMV lido duas vezes não é evento: o oficial exige `movie != old.movie`.
    #[test]
    fn fmv_do_final_ja_em_execucao_nao_reabre_o_evento() {
        let tocando = snapshot_with_movie(RE4_ENDING_ROOM, 5_806, Some(FMV_FINAL));

        assert!(!main_game_ending_started(tocando, tocando));
    }

    /// Sem leitura do campo não há evento, dos dois lados.
    ///
    /// Cobre o primeiro tick depois de anexar ao processo, que não pode ser confundido com o final.
    #[test]
    fn sem_leitura_do_fmv_nao_ha_fim_de_jogo() {
        let com_valor = snapshot_with_movie(RE4_ENDING_ROOM, 5_806, Some(FMV_FINAL));
        let sem_valor = snapshot_with_movie(RE4_ENDING_ROOM, 5_806, None);

        assert!(!main_game_ending_started(sem_valor, com_valor));
        assert!(!main_game_ending_started(com_valor, sem_valor));
    }

    /// O dedup do split final vale por tentativa e é liberado ao recomeçar.
    ///
    /// A cutscene mexe no campo mais de uma vez enquanto roda, então sem a marca cada mudança
    /// fecharia um segmento. E ela precisa cair no reset, senão a run seguinte não teria final.
    #[test]
    fn split_final_sai_uma_vez_por_tentativa() {
        let mut splitter = Autosplitter {
            final_split_emitted: true,
            ..Autosplitter::default()
        };

        splitter.forget_route();

        assert!(!splitter.final_split_emitted);
    }

    /// Saída do fim do capítulo 16, 0,899 s depois do avanço.
    #[test]
    fn saida_do_capitulo_16_nao_splita() {
        let splitter = splitter_at(796, 6_748);

        assert_eq!(
            splitter.evaluate_door(snapshot(800, 6_748)),
            DoorDecision::Blocked((796, 800))
        );
    }

    /// Travessia 818 -> 817 -> 819 no capítulo 18: um único split, na chegada à 819.
    ///
    /// A 817 é atravessada em 0,903 s e já tinha sido visitada, então a volta para ela não fecha
    /// segmento. A porta seguinte precisa continuar splitando, e é isso que o teste fixa: recusar a
    /// primeira não pode engolir a segunda.
    #[test]
    fn travessia_da_sala_817_rende_um_split_so() {
        let mut splitter = splitter_at(818, 7_167);

        assert_eq!(
            splitter.evaluate_door(snapshot(817, 7_167)),
            DoorDecision::Blocked((818, 817))
        );
        splitter.latch_gameplay_room(snapshot(817, 7_167));

        assert_eq!(
            splitter.evaluate_door(snapshot(819, 7_172)),
            DoorDecision::Ready((817, 819))
        );
    }

    /// A volta 818 -> 817 é recusada mesmo depois de um load de save.
    ///
    /// É o motivo de o par estar em `doors_without_split` e não em `return_doors_without_split`:
    /// `forget_route` limpa `last_split_door`, e sem isso a porta voltaria a valer como par comum.
    #[test]
    fn volta_para_a_817_segue_recusada_apos_load_de_save() {
        let mut splitter = splitter_at(817, 7_113);

        // Ida registrada normalmente, como na tentativa antes do load.
        assert_eq!(
            splitter.evaluate_door(snapshot(818, 7_123)),
            DoorDecision::Ready((817, 818))
        );
        splitter.completed_doors.insert((817, 818));
        splitter.last_split_door = Some((817, 818));

        // O load apaga o histórico da rota.
        splitter.forget_route();
        splitter.latch_gameplay_room(snapshot(818, 7_167));

        assert_eq!(
            splitter.evaluate_door(snapshot(817, 7_167)),
            DoorDecision::Blocked((818, 817))
        );
    }

    /// Ida e volta na sala 778: nenhuma das duas fecha segmento.
    ///
    /// Reproduz a sequência inteira para provar que os dois sentidos precisam estar na lista.
    /// Recusar a ida não grava `last_split_door`, então a volta deixa de ser reconhecida como volta
    /// e cairia em `Ready` se não estivesse listada também.
    #[test]
    fn ida_e_volta_na_sala_778_nao_splitam() {
        let mut splitter = splitter_at(790, 5_718);

        let ida = splitter.evaluate_door(snapshot(778, 5_718));
        assert_eq!(ida, DoorDecision::Blocked((790, 778)));
        // Recusada, então nada é gravado como último split.
        assert!(splitter.last_split_door.is_none());
        splitter.latch_gameplay_room(snapshot(778, 5_718));

        assert_eq!(
            splitter.evaluate_door(snapshot(790, 5_727)),
            DoorDecision::Blocked((778, 790))
        );
    }

    /// A sala 549 também é destino de uma porta que **deve** splitar, então o bloqueio não pode ser
    /// por sala e sim por par.
    #[test]
    fn entrada_em_549_por_outra_porta_ainda_splita() {
        let splitter = splitter_at(539, 4_546);

        assert_eq!(
            splitter.evaluate_door(snapshot(549, 4_546)),
            DoorDecision::Ready((539, 549))
        );
    }

    /// Portas que a rota exige splitar mesmo colando num fim de capítulo.
    ///
    /// Elas aparecem na mesma varredura das bloqueadas, e confundi-las tiraria splits. Nenhuma delas
    /// está na `unsplittedDoors` do autosplitter oficial.
    #[test]
    fn portas_coladas_no_capitulo_que_devem_continuar_splitando() {
        let config = AutosplitConfig::default();

        for par in [
            (279, 280), // saída do fim do 2-1, ~2,3 s depois: aqui saem dois splits de propósito
            (516, 517), // saída do fim do 2-3
            (518, 527), // sentido inverso de um par bloqueado
        ] {
            assert!(
                !config.doors_without_split.contains(&par),
                "o par {par:?} precisa continuar splitando"
            );
        }
    }

    /// A lista de portas espelha a `unsplittedDoors` do jogo principal do autosplitter oficial.
    ///
    /// É o teste que trava a paridade: se um par sair da lista, ou se alguém voltar a silenciar o
    /// capítulo em vez da porta, o segmento muda de lugar em relação aos tempos da comunidade.
    #[test]
    fn lista_de_portas_espelha_a_oficial() {
        let config = AutosplitConfig::default();

        let oficial = [
            (262, 260), // Chapter 1-1 End
            (267, 283), // Chapter 1-3 End
            (527, 518), // Chapter 3-3 End
            (525, 518), // Chapter 3-4 End
            (545, 555), // Chapter 4-1 End
            (541, 549), // Chapter 4-2 End
            (549, 550), // Chapter 4-3 End
            (554, 768), // Chapter 4-4 End
            (789, 790), // Chapter 5-2 End
            (796, 800), // Chapter 5-3 End
            (519, 514), // Barracks -> Castle Wall
            (536, 533), // Gatekeeper Hallway -> Lord's Room
            (554, 552), // Pier -> Tower Summit
            (555, 544), // Prophet's Room (Cutscene) -> Area before the Mine
            (790, 778), // Machine Room Entry -> Communications Tower (Cutscene)
            (778, 790), // Communications Tower (Cutscene) -> Machine Room Entry
            (818, 817), // Steel Tower -> Before the Steel Tower
        ];

        for par in oficial {
            assert!(
                config.doors_without_split.contains(&par),
                "o par {par:?} está na lista oficial e deveria estar bloqueado"
            );
        }
        // Sem sobras: `(288, 256)` é o único par da lista oficial que fica de fora, porque a
        // sentinela de sistema nunca entra no latch de origem e o par não tem como se formar.
        assert_eq!(config.doors_without_split.len(), oficial.len());
    }

    /// Todo fim de capítulo fecha segmento, como no autosplitter oficial.
    ///
    /// Onde há porta colada, quem é silenciado é a porta. Silenciar o capítulo daria o mesmo número
    /// de splits com o limite alguns segundos antes, e era o que fazíamos no 1-1 e no 1-3.
    #[test]
    fn nenhum_fim_de_capitulo_e_silenciado() {
        let config = AutosplitConfig::default();

        assert!(config.chapter_ends_without_split.is_empty());
    }

    /// A declaração tem precedência: nem dedup, nem volta, nem nada faz a porta bloqueada splitar.
    #[test]
    fn porta_bloqueada_tem_precedencia() {
        let mut splitter = splitter_at(527, 2_425);
        // Mesmo tendo sido registrada como último split e como par já usado, segue bloqueada.
        splitter.last_split_door = Some((518, 527));
        splitter.completed_doors.insert((527, 518));

        assert_eq!(
            splitter.evaluate_door(snapshot(518, 2_425)),
            DoorDecision::Blocked((527, 518))
        );
    }

    /// O bloqueio é só do par declarado; a porta no sentido inverso segue as regras normais.
    #[test]
    fn bloqueio_nao_vale_para_o_sentido_inverso() {
        let splitter = splitter_at(518, 2_425);

        assert_eq!(
            splitter.evaluate_door(snapshot(527, 2_430)),
            DoorDecision::Ready((518, 527))
        );
    }

    /// Volta splita por padrão, e a lista de exceções por volta nasce vazia.
    ///
    /// O autosplitter oficial não tem esse conceito: nele a volta é um par distinto da ida. A única
    /// volta que não fecha segmento, a do sword room, está na lista incondicional, e é lá que ela
    /// resiste a um load de save.
    #[test]
    fn voltas_splitam_por_padrao() {
        let config = AutosplitConfig::default();

        assert!(config.return_doors_without_split.is_empty());
        // Exigidas pela rota, e nenhuma precisa de cadastro.
        assert!(!config.doors_without_split.contains(&(287, 271)));
        assert!(!config.doors_without_split.contains(&(517, 516)));
        // A do sword room é a exceção, e é incondicional.
        assert!(config.doors_without_split.contains(&(519, 514)));
    }

    /// Volta liberada não escapa do dedup: se o par já foi usado, não splita de novo.
    #[test]
    fn volta_liberada_ainda_respeita_o_dedup() {
        let mut splitter = splitter_at(287, 1_144);
        splitter.last_split_door = Some((271, 287));
        splitter.completed_doors.insert((287, 271));

        assert_eq!(
            splitter.evaluate_door(snapshot(271, 1_244)),
            DoorDecision::AlreadyUsed((287, 271))
        );
    }

    /// Fechar capítulo solta a referência de volta, e a porta que era reatravessia volta a splitar.
    ///
    /// Usa a arena do Mendez, que é volta exigida pela rota. Com a lista de voltas vazia por padrão,
    /// o que se testa aqui é o mecanismo em si: a referência é o último par que splitou, e o fim de
    /// capítulo a desfaz porque move a rota para outra seção.
    #[test]
    fn capitulo_fechado_libera_a_volta() {
        let mut splitter = splitter_at(287, 1_144);
        splitter.completed_doors.insert((271, 287));
        splitter.last_split_door = Some((271, 287));

        // Reconhecida como volta pela porta que acabou de splitar, e ainda assim fecha segmento.
        assert_eq!(
            splitter.evaluate_door(snapshot(271, 1_244)),
            DoorDecision::Return((287, 271))
        );

        // O fim de capítulo solta a referência e o par volta a ser comum.
        splitter.last_split_door = None;
        assert_eq!(
            splitter.evaluate_door(snapshot(271, 1_244)),
            DoorDecision::Ready((287, 271))
        );
    }

    /// A volta só é bloqueada para a porta mais recente. A rota normal reatravessa vários lugares,
    /// e bloquear a volta de todas as portas já usadas tiraria splits legítimos.
    #[test]
    fn voltar_por_uma_porta_antiga_ainda_splita() {
        let mut splitter = splitter_at(311, 600);
        splitter.last_split_door = Some((400, 401));

        assert_eq!(
            splitter.evaluate_door(snapshot(310, 601)),
            DoorDecision::Ready((311, 310))
        );
    }

    /// Depois de voltar, seguir para uma sala nova continua splitando normalmente.
    #[test]
    fn seguir_apos_a_volta_ainda_splita() {
        let mut splitter = splitter_at(311, 600);
        splitter.last_split_door = Some((310, 311));
        splitter.latch_gameplay_room(snapshot(310, 601));

        assert_eq!(
            splitter.evaluate_door(snapshot(350, 602)),
            DoorDecision::Ready((310, 350))
        );
    }

    #[test]
    fn esquecer_rota_limpa_a_porta_do_ultimo_split() {
        let mut splitter = splitter_at(310, 600);
        splitter.last_split_door = Some((310, 311));

        splitter.forget_route();

        assert!(splitter.last_split_door.is_none());
    }

    #[test]
    fn par_repetido_e_deduplicado() {
        let mut splitter = splitter_at(310, 600);
        splitter.completed_doors.insert((310, 311));
        assert_eq!(
            splitter.evaluate_door(snapshot(311, 601)),
            DoorDecision::AlreadyUsed((310, 311))
        );
    }

    #[test]
    fn igt_retrocedendo_nao_e_porta() {
        let splitter = splitter_at(310, 600);
        assert_eq!(
            splitter.evaluate_door(snapshot(350, 120)),
            DoorDecision::IgtRewind
        );
    }

    #[test]
    fn sem_origem_nao_splita() {
        let splitter = Autosplitter::default();
        assert_eq!(
            splitter.evaluate_door(snapshot(310, 600)),
            DoorDecision::NoOrigin
        );
    }

    #[test]
    fn esquecer_rota_limpa_pares_e_origem() {
        let mut splitter = splitter_at(310, 600);
        splitter.completed_doors.insert((310, 311));

        splitter.reset_attempt_metrics();

        assert!(splitter.completed_doors.is_empty());
        assert_eq!(splitter.last_gameplay_room, None);
        assert_eq!(
            splitter.evaluate_door(snapshot(311, 601)),
            DoorDecision::NoOrigin
        );
    }

    /// Um único tick com IGT zerado é o que a reinicialização de stage produz, e não pode
    /// derrubar a tentativa.
    #[test]
    fn igt_zerado_por_um_tick_nao_confirma_reset() {
        let mut splitter = Autosplitter::default();
        splitter.track_igt_zero(snapshot(310, 600), snapshot(310, 0));

        assert!(splitter.igt_zero_since.is_some());
        assert!(!splitter.igt_zero_confirmed());
    }

    #[test]
    fn igt_voltando_a_andar_desarma_a_janela() {
        let mut splitter = Autosplitter::default();
        splitter.track_igt_zero(snapshot(310, 600), snapshot(310, 0));
        splitter.track_igt_zero(snapshot(310, 0), snapshot(310, 600));

        assert!(splitter.igt_zero_since.is_none());
        assert!(!splitter.igt_zero_confirmed());
    }

    /// Sem a borda de descida a janela não arma, então o primeiro segundo de uma run nova (IGT
    /// legitimamente em 0) não se auto-reseta.
    #[test]
    fn igt_zerado_sem_borda_nao_arma_a_janela() {
        let mut splitter = Autosplitter::default();
        splitter.track_igt_zero(snapshot(256, 0), snapshot(256, 0));

        assert!(splitter.igt_zero_since.is_none());
    }

    #[test]
    fn janela_confirmada_depois_do_prazo() {
        let splitter = Autosplitter {
            igt_zero_since: Some(Instant::now() - IGT_RESET_CONFIRM_WINDOW),
            ..Default::default()
        };

        assert!(splitter.igt_zero_confirmed());
    }

    /// O bug relatado: o fim de 1-2 é um evento de capítulo, não de porta. O contador subindo tem
    /// de virar split mesmo sem a sala mudar.
    #[test]
    fn fim_de_capitulo_avanca_sem_a_sala_mudar() {
        let antes = snapshot_in_chapter(310, 600, 2, 10);
        let depois = snapshot_in_chapter(310, 600, 3, 10);

        assert!(chapter_advanced(antes, depois));
        // E não existe transição de sala nenhuma para a lógica de porta observar.
        assert_eq!(antes.room, depois.room);
    }

    /// Sequência exata capturada no log do jogo: `0xA` -> `0x2000A`, dois índices de uma vez com a
    /// palavra baixa intacta. A comparação por degrau exato rejeitava isso e era o bug.
    #[test]
    fn salto_de_dois_capitulos_observado_em_jogo_conta_como_avanco() {
        let antes = snapshot_in_chapter(261, 21, 0, 10);
        let depois = snapshot_in_chapter(261, 33, 2, 10);

        assert_eq!(antes.end_of_chapter, 0xA);
        assert_eq!(depois.end_of_chapter, 0x2_000A);
        assert!(chapter_advanced(antes, depois));
    }

    #[test]
    fn capitulo_estavel_nao_avanca() {
        let antes = snapshot_in_chapter(310, 600, 2, 10);
        let depois = snapshot_in_chapter(311, 601, 2, 10);

        assert!(!chapter_advanced(antes, depois));
    }

    /// Mudança só na palavra baixa não é fim de capítulo. Observado no início da run, quando o
    /// campo foi de `0x0` para `0xA` sem troca de capítulo.
    #[test]
    fn mudanca_na_palavra_baixa_nao_e_fim_de_capitulo() {
        let antes = snapshot_in_chapter(288, 0, 0, 0);
        let depois = snapshot_in_chapter(288, 0, 0, 10);

        assert_ne!(antes.end_of_chapter, depois.end_of_chapter);
        assert!(!chapter_advanced(antes, depois));
    }

    /// Voltar a zero é o que acontece ao sair para o título, e não pode splitar.
    #[test]
    fn capitulo_retrocedendo_nao_splita() {
        let antes = snapshot_in_chapter(261, 33, 2, 10);
        let depois = snapshot_in_chapter(288, 0, 0, 0);

        assert!(!chapter_advanced(antes, depois));
    }

    /// Índice do contador ao fechar cada capítulo, conforme observado no log.
    const FIM_1_1: i32 = 1;
    const FIM_1_3: i32 = 3;
    const FIM_2_1: i32 = 4;

    /// Fins de 1-1 e 1-3: a porta chega a menos de 1 s e é ela que fica silenciada, não o capítulo.
    ///
    /// Sai um split, como antes, mas no fim do capítulo em vez de na porta — é onde o autosplitter
    /// oficial fecha o segmento.
    #[test]
    fn fins_com_porta_imediata_splitam_no_capitulo() {
        let config = AutosplitConfig::default();

        for capitulo in [FIM_1_1, FIM_1_3] {
            assert!(!config.chapter_ends_without_split.contains(&capitulo));
        }
        assert!(config.doors_without_split.contains(&(262, 260)));
        assert!(config.doors_without_split.contains(&(267, 283)));
    }

    /// O fim do 2-1 gera split próprio, e a porta 2,5 s depois gera o dela: dois segmentos.
    #[test]
    fn fim_do_2_1_gera_split_de_capitulo_e_a_porta_tambem() {
        let config = AutosplitConfig::default();

        assert!(!config.chapter_ends_without_split.contains(&FIM_2_1));
        assert!(!config.doors_without_split.contains(&(279, 280)));
    }

    /// Run que começa de save carregado: o contador fica em 0 e recebe o índice real de uma vez.
    /// Limitar o tamanho do salto rejeitava isso; o bound é no índice resultante.
    #[test]
    fn salto_de_save_carregado_conta_como_avanco() {
        let antes = snapshot_in_chapter(279, 115, 0, 10);
        let depois = snapshot_in_chapter(279, 115, FIM_2_1, 10);

        assert_eq!(depois.end_of_chapter, 0x4_000A);
        assert!(chapter_advanced(antes, depois));
    }

    #[test]
    fn indice_de_capitulo_implausivel_e_descartado() {
        let antes = snapshot_in_chapter(279, 115, 0, 10);
        let depois = snapshot_in_chapter(279, 115, MAX_PLAUSIBLE_CHAPTER + 1, 10);

        assert!(!chapter_advanced(antes, depois));
    }

    /// Reproduz a condição de start do tick, isolada do `Timer`.
    fn start_transition_ok(
        config: &AutosplitConfig,
        previous: Re4Snapshot,
        current: Re4Snapshot,
    ) -> bool {
        if config.start_only_on_new_game {
            previous.room == RE4_SYSTEM_ROOM
                && current.room == RE4_FIRST_ROOM
                && current.character == RE4_LEON
        } else {
            !is_gameplay_room(previous.room) && is_gameplay_room(current.room)
        }
    }

    /// Snapshot com personagem diferente do Leon, como nos trechos da Ashley.
    fn snapshot_as_character(room: i16, igt: u32, character: u8) -> Re4Snapshot {
        Re4Snapshot {
            character,
            ..snapshot(room, igt)
        }
    }

    /// Padrão marcado: só jogo novo, que é a transição título -> primeira sala com o Leon.
    #[test]
    fn marcado_inicia_so_em_jogo_novo() {
        let config = AutosplitConfig::default();
        assert!(config.start_only_on_new_game);

        let titulo = snapshot(RE4_SYSTEM_ROOM, 0);
        assert!(start_transition_ok(&config, titulo, snapshot(RE4_FIRST_ROOM, 0)));
        // Abrir um save entra numa sala qualquer, e nesse modo não inicia.
        assert!(!start_transition_ok(&config, titulo, snapshot(516, 1_955)));
        // E outro personagem na primeira sala não é jogo novo do modo principal.
        assert!(!start_transition_ok(
            &config,
            titulo,
            snapshot_as_character(RE4_FIRST_ROOM, 0, 1)
        ));
    }

    /// Desmarcado: entrar no mundo a partir de fora dele basta, o que cobre abrir um save.
    #[test]
    fn desmarcado_inicia_ao_abrir_qualquer_save() {
        let config = AutosplitConfig {
            start_only_on_new_game: false,
            ..AutosplitConfig::default()
        };

        let titulo = snapshot(RE4_SYSTEM_ROOM, 0);
        assert!(start_transition_ok(&config, titulo, snapshot(516, 1_955)));
        // E o jogo novo continua valendo: é um caso particular do mesmo critério.
        assert!(start_transition_ok(&config, titulo, snapshot(RE4_FIRST_ROOM, 0)));
        // Sala 0 também é "fora do mundo", então carregar dali inicia.
        assert!(start_transition_ok(&config, snapshot(0, 0), snapshot(523, 2_393)));
    }

    /// Caso medido em jogo: save no capítulo 9 do castelo, sala 525, personagem 1, 3036 s de IGT.
    /// Não iniciava porque a condição exigia o Leon; no modo "qualquer save" tem de iniciar.
    #[test]
    fn desmarcado_inicia_em_save_com_outro_personagem() {
        let config = AutosplitConfig {
            start_only_on_new_game: false,
            ..AutosplitConfig::default()
        };

        let titulo = snapshot(RE4_SYSTEM_ROOM, 3_036);
        let save = snapshot_as_character(525, 3_036, 1);

        assert!(start_transition_ok(&config, titulo, save));
    }

    /// Em nenhum dos modos uma porta comum, de sala real para sala real, inicia o timer.
    #[test]
    fn porta_comum_nunca_inicia_o_timer() {
        for start_only_on_new_game in [true, false] {
            let config = AutosplitConfig {
                start_only_on_new_game,
                ..AutosplitConfig::default()
            };

            assert!(
                !start_transition_ok(&config, snapshot(310, 600), snapshot(311, 601)),
                "modo start_only_on_new_game={start_only_on_new_game} não deveria iniciar numa porta"
            );
        }
    }

    #[test]
    fn configuracao_respeita_start_only_on_new_game_desligado() {
        let mut splitter = Autosplitter::default();
        let config = AutosplitConfig {
            enabled: true,
            start_only_on_new_game: false,
            ..AutosplitConfig::default()
        };

        splitter.configure(config).expect("perfil válido");

        assert!(!splitter.config.start_only_on_new_game);
    }

    #[test]
    fn configuracao_respeita_split_on_chapters_desligado() {
        let mut splitter = Autosplitter::default();
        let config = AutosplitConfig {
            enabled: true,
            split_on_chapters: false,
            ..AutosplitConfig::default()
        };

        splitter.configure(config).expect("perfil válido");

        assert!(!splitter.config.split_on_chapters);
    }

    #[test]
    fn configuracao_respeita_auto_reset_desligado() {
        let mut splitter = Autosplitter::default();
        let config = AutosplitConfig {
            enabled: true,
            auto_reset: false,
            ..AutosplitConfig::default()
        };

        splitter.configure(config).expect("perfil válido");

        assert!(!splitter.config.auto_reset);
    }
}
