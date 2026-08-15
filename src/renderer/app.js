const bridge = window.gameTimeSpliter;
const i18n = window.gtsI18n;
const t = (key, params) => i18n.t(key, params);
const byId = (id) => document.getElementById(id);

let state;
let selectedFile;
let parsedFile;
let games = [];
let cloudLssFiles = [];
let timerState;
let cloudStatus = { key: 'file.cloudHint', params: {} };
let lastLogSignature = '';
let lastLogAt = 0;
let lastUpdatePhase = '';

const setCloudStatus = (key, params = {}, raw = null) => {
  cloudStatus = { key, params, raw };
  byId('cloud-lss-status').textContent = raw ?? t(key, params);
};

const addLog = (message, isError = false) => {
  const now = Date.now();
  const signature = `${isError ? 'error' : 'info'}:${message}`;
  if (signature === lastLogSignature && now - lastLogAt < 1_000) return;
  lastLogSignature = signature;
  lastLogAt = now;

  const item = document.createElement('li');
  const timestamp = i18n.formatTime(new Date(now), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  item.textContent = `${timestamp} — ${message}`;
  if (isError) item.className = 'error';
  const activityLog = byId('activity-log');
  activityLog.prepend(item);
  while (activityLog.children.length > 200) activityLog.lastElementChild?.remove();
};

const applicationMessageKeys = new Map([
  ['Estado atualizado.', 'event.stateUpdated'],
  ['Aplicativo iniciado.', 'event.appStarted'],
  ['Sincronização automática aguardando arquivo, jogo ou conexão válidos.', 'event.syncWaiting'],
  ['O monitor anterior foi interrompido porque a run selecionada mudou.', 'event.previousMonitorStopped'],
  ['Motor de timer nativo reiniciado.', 'event.nativeTimerRestarted'],
  ['Run salva; a tentativa concluída foi adicionada à sincronização automática.', 'event.runSaved'],
  ['Run finalizada descartada sem alterar o arquivo .lss.', 'event.runDiscarded'],
  ['Tema da overlay atualizado.', 'event.themeUpdated'],
  ['Modo offline ativado. Os splits serão salvos neste computador.', 'event.offlineEnabled'],
  ['Sessão encerrada.', 'event.sessionEnded'],
  ['Tela de login aberta; dados offline preservados.', 'event.loginOpened'],
  ['Selecione um jogo para completar a sincronização automática.', 'event.selectGame'],
  ['Arquivo .lss carregado no timer nativo.', 'event.localFileLoaded'],
  ['Arquivo .lss da nuvem carregado no timer nativo.', 'event.cloudFileLoaded'],
  ['A sincronização automática permanece ativa.', 'event.syncPermanent'],
  ['Conexão restabelecida; sincronização automática da fila iniciada.', 'event.networkQueueStarted'],
  ['Overlay aberta.', 'event.overlayOpened'],
  ['O .lss não informa o nome do jogo.', 'warning.lssNoGame'],
  ['O .lss não informa a categoria.', 'warning.lssNoCategory'],
  ['O .lss não possui segmentos.', 'warning.lssNoSegments'],
  ['Nenhuma tentativa finalizada foi encontrada em <AttemptHistory>.', 'warning.lssNoAttempts'],
  ['Escolha de finalização inválida.', 'error.finishInvalid'],
  ['A run ainda não foi finalizada.', 'error.runNotFinished'],
  ['Esta run ainda não possui um arquivo para sobrescrever. Salve em um novo arquivo.', 'error.noOverwriteFile'],
  ['Selecione um arquivo de splits do LiveSplit com extensão .lss.', 'error.lssExtension'],
  ['O arquivo .lss contém XML inválido ou está sendo gravado pelo LiveSplit.', 'error.lssInvalidXml'],
  ['O arquivo selecionado é um layout .lsl, não uma run .lss.', 'error.lssIsLayout'],
  ['Formato incompatível: a raiz XML <Run> não foi encontrada.', 'error.lssMissingRun'],
]);

const localizeApplicationMessage = (value) => {
  const message = String(value ?? '');
  const directKey = applicationMessageKeys.get(message);
  if (directKey) return t(directKey);

  let match = /^(\d+) tentativa\(s\) encontrada\(s\)\.$/.exec(message);
  if (match) return t('event.attemptsFound', { count: Number(match[1]) });
  if (/^Sincronização automática ativa \(.+\)\.$/.test(message)) return t('event.syncActive');

  match = /^Sincronização automática associada a (.+) — (.+)\.$/.exec(message);
  if (match) return t('event.gameAssociated', { game: match[1], category: match[2] });
  match = /^Arquivo “(.+)” baixado da nuvem e carregado no timer\.$/.exec(message);
  if (match) return t('event.cloudFileDownloaded', { name: match[1] });
  match = /^A sincronização automática aguardará uma nova tentativa: (.+)$/.exec(message);
  if (match) return t('event.syncRetry', { error: localizeApplicationMessage(match[1]) });
  match = /^O sidecar reiniciou, mas não restaurou o \.lss: (.+)$/.exec(message);
  if (match) return t('event.sidecarLssRestore', { error: localizeApplicationMessage(match[1]) });
  match = /^O sidecar reiniciou sem restaurar o autosplit: (.+)$/.exec(message);
  if (match) return t('event.sidecarAutosplitRestore', { error: localizeApplicationMessage(match[1]) });
  match = /^Login concluído, mas uma etapa local falhou: (.+)$/.exec(message);
  if (match) return t('event.loginLocalFailure', { error: localizeApplicationMessage(match[1]) });
  return message;
};

const errorMessage = (error) => localizeApplicationMessage(error instanceof Error ? error.message : String(error));
const isQueueStatus = (value) => value && typeof value.pending === 'number' && typeof value.synchronized === 'number';
const decimalSeparator = () => new Intl.NumberFormat(i18n.locale).formatToParts(1.1)
  .find((part) => part.type === 'decimal')?.value || '.';

const formatTime = (milliseconds) => {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '—';
  const negative = milliseconds < 0;
  const absolute = Math.abs(milliseconds);
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  const millis = Math.floor(absolute % 1_000);
  const prefix = negative ? '-' : '';
  const hourPart = hours ? `${String(hours).padStart(2, '0')}:` : '';
  return `${prefix}${hourPart}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${decimalSeparator()}${String(millis).padStart(3, '0')}`;
};

const formatDelta = (milliseconds) => {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '—';
  const absolute = Math.abs(milliseconds);
  const minutes = Math.floor(absolute / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  const centiseconds = Math.floor((absolute % 1_000) / 10);
  const value = minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}${decimalSeparator()}${String(centiseconds).padStart(2, '0')}`
    : `${seconds}${decimalSeparator()}${String(centiseconds).padStart(2, '0')}`;
  return `${milliseconds < 0 ? '-' : '+'}${value}`;
};

/**
 * Tempo cumulativo em que o segmento `index` começou.
 *
 * Procura o último split concluído em vez de olhar só `index - 1`, porque um split pulado fica com
 * `splitTimeMs` nulo e o segmento atual passa a englobar os pulados.
 */
const segmentStartMs = (segments, index) => {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const splitTime = segments[previous]?.splitTimeMs;
    if (splitTime !== null && splitTime !== undefined) return splitTime;
  }
  return 0;
};

/**
 * Delta ao vivo do split em andamento, contra o PB, assim que o gold daquele segmento é perdido.
 *
 * O valor é o delta **do total**: parte de onde a run está em relação ao PB e cresce enquanto o
 * segmento se estende, podendo virar timeloss. Enquanto o segmento ainda cabe no gold não há nada a
 * mostrar, porque o acumulado ainda pode melhorar.
 *
 * Espelha `liveTotalDeltaMs` de overlay.js. São dois renderers separados, sem módulo compartilhado
 * entre eles hoje.
 */
const liveTotalDeltaMs = (timer, index) => {
  if (!timer?.available) return null;
  if (timer.phase !== 'running' && timer.phase !== 'paused') return null;
  if (timer.currentSplitIndex !== index) return null;
  const segment = timer.segments[index];
  const gold = segment?.bestSegmentTimeMs;
  const personalBest = segment?.personalBestTimeMs;
  if (gold === null || gold === undefined) return null;
  if (personalBest === null || personalBest === undefined) return null;
  const elapsed = Math.max(0, (timer.currentTimeMs || 0) - segmentStartMs(timer.segments, index));
  if (elapsed <= gold) return null;
  return (timer.currentTimeMs || 0) - personalBest;
};

const latestPersonalBestDelta = (timer) => {
  if (!timer?.available) return null;
  for (let index = timer.segments.length - 1; index >= 0; index -= 1) {
    const segment = timer.segments[index];
    if (segment.splitTimeMs !== null && segment.personalBestTimeMs !== null) {
      return segment.splitTimeMs - segment.personalBestTimeMs;
    }
  }
  return null;
};

const phaseLabel = (phase) => ['notRunning', 'running', 'paused', 'ended'].includes(phase)
  ? t(`timer.phase.${phase}`)
  : t('timer.phase.unavailable');

const renderTimer = (nextTimerState) => {
  const segments = byId('timer-segments');
  const previousScrollTop = segments.scrollTop;
  const activeSplitChanged = timerState?.currentSplitIndex !== nextTimerState?.currentSplitIndex;
  timerState = nextTimerState;
  const available = Boolean(timerState?.available);
  const sidecarAvailable = Boolean(state?.sidecarReady);
  byId('sidecar-badge').textContent = sidecarAvailable ? t('timer.ready') : t('timer.unavailable');
  byId('sidecar-badge').className = `badge ${sidecarAvailable ? 'online' : 'offline'}`;

  byId('timer-game').textContent = available ? timerState.gameName : t('timer.noRun');
  byId('timer-category').textContent = available ? timerState.categoryName : t('timer.selectLss');
  byId('timer-phase').textContent = available ? phaseLabel(timerState.phase) : t('timer.phase.notRunning');
  const attemptCount = timerState?.attemptCount || 0;
  byId('timer-attempts').textContent = t('timer.attempts', { count: attemptCount });
  const timerClock = byId('timer-clock');
  timerClock.textContent = formatTime(timerState?.currentTimeMs || 0);
  timerClock.classList.toggle('ended', available && timerState.phase === 'ended');
  const deltaValue = latestPersonalBestDelta(timerState);
  timerClock.classList.toggle('ahead', deltaValue !== null && deltaValue < 0);
  timerClock.classList.toggle('behind', deltaValue !== null && deltaValue > 0);
  const finalPersonalBest = available && timerState.segments.length > 0
    ? timerState.segments[timerState.segments.length - 1].personalBestTimeMs
    : null;
  byId('timer-pb-final').textContent = formatTime(finalPersonalBest);

  segments.replaceChildren();
  if (!available || timerState.segments.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('timer.emptySegments');
    segments.append(empty);
  } else {
    const header = document.createElement('li');
    header.className = 'timer-segments-header';
    const headerPosition = document.createElement('span');
    headerPosition.textContent = '#';
    const headerName = document.createElement('span');
    headerName.textContent = t('timer.segment');
    const headerPbSegment = document.createElement('span');
    headerPbSegment.textContent = t('timer.segmentPb');
    const headerDelta = document.createElement('span');
    headerDelta.textContent = t('timer.difference');
    const headerSplit = document.createElement('span');
    headerSplit.textContent = t('timer.split');
    header.append(headerPosition, headerName, headerPbSegment, headerDelta, headerSplit);
    segments.append(header);

    timerState.segments.forEach((segment, index) => {
      const item = document.createElement('li');
      if (index === timerState.currentSplitIndex) item.classList.add('active');
      if (segment.splitTimeMs !== null || timerState.phase === 'ended') item.classList.add('completed');
      const position = document.createElement('span');
      position.className = 'segment-position';
      position.textContent = String(index + 1);
      const name = document.createElement('strong');
      name.textContent = segment.name;
      const personalBestSegmentTime = document.createElement('span');
      personalBestSegmentTime.className = 'segment-pb-time';
      personalBestSegmentTime.textContent = formatTime(segment.personalBestSegmentTimeMs);
      personalBestSegmentTime.title = t('timer.pbSegmentTitle');
      // No split em andamento que já passou do gold, a coluna mostra o delta do total correndo em
      // vez do travessão que ficaria ali até o split fechar.
      const liveDelta = liveTotalDeltaMs(timerState, index);
      const segmentDeltaValue = liveDelta !== null
        ? liveDelta
        : segment.splitTimeMs !== null && segment.personalBestTimeMs !== null
          ? segment.splitTimeMs - segment.personalBestTimeMs
          : null;
      const segmentDelta = document.createElement('span');
      segmentDelta.className = 'segment-delta';
      segmentDelta.textContent = formatDelta(segmentDeltaValue);
      segmentDelta.title = liveDelta !== null ? t('timer.liveDeltaTitle') : t('timer.deltaTitle');
      if (liveDelta !== null) segmentDelta.classList.add('live');
      if (segmentDeltaValue !== null && segmentDeltaValue < 0) segmentDelta.classList.add('ahead');
      if (segmentDeltaValue !== null && segmentDeltaValue > 0) segmentDelta.classList.add('behind');
      const time = document.createElement('span');
      time.className = 'segment-time';
      time.textContent = formatTime(segment.splitTimeMs ?? segment.personalBestTimeMs);
      time.title = segment.splitTimeMs !== null ? t('timer.currentSplitTitle') : t('timer.pbSplitTitle');
      item.append(position, name, personalBestSegmentTime, segmentDelta, time);
      segments.append(item);
    });
  }

  if (!activeSplitChanged) {
    segments.scrollTop = previousScrollTop;
  } else {
    requestAnimationFrame(() => {
      const active = segments.querySelector('li.active');
      if (!active) return;
      const listRect = segments.getBoundingClientRect();
      const rowRect = active.getBoundingClientRect();
      if (rowRect.top < listRect.top) segments.scrollTop -= listRect.top - rowRect.top;
      else if (rowRect.bottom > listRect.bottom) segments.scrollTop += rowRect.bottom - listRect.bottom;
    });
  }

  const phase = timerState?.phase;
  const running = available && phase === 'running';
  const paused = available && phase === 'paused';
  const ended = available && phase === 'ended';
  const startSplit = byId('timer-start-split');
  startSplit.textContent = running ? t('timer.splitAction') : ended ? t('timer.finished') : t('timer.start');
  startSplit.disabled = !sidecarAvailable || !available || paused || ended;
  byId('timer-pause').textContent = paused ? t('timer.resume') : t('timer.pause');
  byId('timer-pause').disabled = !sidecarAvailable || (!running && !paused);
  byId('timer-undo').disabled = !sidecarAvailable || !available || phase === 'notRunning';
  byId('timer-skip').disabled = !sidecarAvailable || !running;
  byId('timer-reset').disabled = !sidecarAvailable || !available || phase === 'notRunning';
};

const updateState = (nextState) => {
  state = nextState;
  const appAvailable = state.authenticated || state.offlineMode;
  byId('login-view').classList.toggle('hidden', appAvailable);
  byId('app-view').classList.toggle('hidden', !appAvailable);
  byId('connection-badge').textContent = state.authenticated
    ? t('connection.authenticated')
    : state.offlineMode ? t('connection.offline') : t('connection.disconnected');
  byId('connection-badge').className = `badge ${state.authenticated ? 'online' : 'offline'}`;
  byId('pending-count').textContent = i18n.formatNumber(state.queue.pending);
  byId('synced-count').textContent = i18n.formatNumber(state.queue.synchronized);
  byId('monitor-status').textContent = t('sync.automatic');
  byId('start-monitor').disabled = !state.authenticated || state.monitoring;
  byId('stop-monitor').disabled = !state.monitoring;
  byId('sync-now').disabled = !state.authenticated;
  const gameSelect = byId('game-select');
  gameSelect.disabled = !state.authenticated;
  if (state.selectedGameId && gameSelect.querySelector(`option[value="${CSS.escape(state.selectedGameId)}"]`)) {
    gameSelect.value = state.selectedGameId;
  }
  const cloudSelect = byId('cloud-lss-select');
  cloudSelect.disabled = !state.authenticated;
  byId('load-cloud-lss').disabled = !state.authenticated || !cloudSelect.value;
  if (!state.authenticated) {
    cloudLssFiles = [];
    cloudSelect.replaceChildren(new Option(t('file.loginCloud'), ''));
    setCloudStatus('file.cloudHint');
  }
  byId('logout').textContent = state.offlineMode ? t('user.signInToSync') : t('user.logout');
  const overlayButton = byId('toggle-overlay');
  if (overlayButton) overlayButton.textContent = state.overlayOpen ? t('overlay.close') : t('overlay.open');
  const restoreOverlayButton = byId('restore-overlay-interaction');
  if (restoreOverlayButton) restoreOverlayButton.disabled = !state.overlayOpen || !state.overlayClickThrough;
  if (state.user) {
    byId('user-name').textContent = state.user.username;
    byId('user-email').textContent = state.user.email;
  } else {
    byId('user-name').textContent = t('user.offline');
    byId('user-email').textContent = t('user.offlineData');
  }
  if (!selectedFile && state.selectedFile) {
    selectedFile = state.selectedFile;
    const filePath = byId('file-path');
    filePath.removeAttribute('data-i18n');
    filePath.textContent = selectedFile;
  }
  // Só aqui, e não em renderTimer: aquele roda a cada push do sidecar, várias vezes por segundo,
  // e sobrescreveria o clique do usuário no meio da interação.
  const startOnlyOnNewGame = byId('autosplit-startOnlyOnNewGame');
  if (startOnlyOnNewGame && state.autosplit) {
    startOnlyOnNewGame.checked = Boolean(state.autosplit.startOnlyOnNewGame);
  }
  renderTimer(state.timer);
  renderUpdate(state.update);
};

const setVisible = (element, visible) => {
  if (!element) return;
  element.classList.toggle('hidden', !visible);
  element.toggleAttribute('hidden', !visible);
  element.setAttribute('aria-hidden', String(!visible));
};

/**
 * O painel só aparece quando há algo acionável. Fases silenciosas — build de
 * desenvolvimento, já atualizado, checando ou servidor inalcançável — não mostram nada,
 * então ficar offline não gera ruído na interface.
 */
const renderUpdate = (status) => {
  const panel = byId('update-panel');
  if (!panel) return;

  const version = status?.targetVersion ?? '';
  const percent = Math.max(0, Math.min(100, Math.round(Number(status?.percent) || 0)));
  let title = '';
  let detail = '';
  let showInstall = false;
  let showProgress = false;

  if (status?.phase === 'available') {
    title = t('update.availableTitle');
    detail = t('update.availableDetail', { version });
    showProgress = true;
  } else if (status?.phase === 'downloading') {
    title = t('update.downloadingTitle');
    detail = t('update.downloadingDetail', { version, percent: i18n.formatNumber(percent) });
    showProgress = true;
  } else if (status?.phase === 'ready') {
    title = t('update.readyTitle');
    detail = t('update.readyDetail', { version });
    showInstall = true;
  } else if (status?.lastError) {
    title = t('update.errorTitle');
    detail = status.lastError;
  }

  setVisible(panel, Boolean(title));
  byId('update-title').textContent = title;
  byId('update-detail').textContent = detail;

  const installButton = byId('update-install');
  setVisible(installButton, showInstall);
  if (installButton) installButton.disabled = !showInstall;

  const progress = byId('update-progress');
  setVisible(progress, showProgress);
  if (progress) progress.setAttribute('aria-valuenow', String(percent));
  const bar = byId('update-progress-bar');
  if (bar) bar.style.width = `${percent}%`;
};

const logUpdateTransition = (status) => {
  if (status?.lastError) {
    addLog(t('log.update.failed', { error: status.lastError }), true);
    return;
  }
  const phase = status?.phase ?? '';
  if (phase === lastUpdatePhase) return;
  lastUpdatePhase = phase;
  const version = status?.targetVersion ?? '';
  if (phase === 'available') addLog(t('log.update.available', { version }));
  if (phase === 'ready') addLog(t('log.update.ready', { version }));
};

const showFile = (result) => {
  if (!result) return;
  selectedFile = result.filePath;
  parsedFile = result.parsed;
  const filePath = byId('file-path');
  filePath.removeAttribute('data-i18n');
  filePath.textContent = selectedFile;
  const summary = byId('file-summary');
  summary.classList.remove('hidden');
  summary.replaceChildren();
  const values = [
    [t('file.game'), parsedFile.gameName || t('file.notProvided')],
    [t('file.category'), parsedFile.categoryName || t('file.notProvidedF')],
    [t('file.segments'), i18n.formatNumber(parsedFile.segmentNames.length)],
    [t('file.attemptsDetected'), i18n.formatNumber(parsedFile.attempts.length)],
  ];
  values.forEach(([label, value]) => {
    const box = document.createElement('div');
    const strong = document.createElement('strong');
    const span = document.createElement('span');
    strong.textContent = value;
    span.textContent = label;
    box.append(strong, span);
    summary.append(box);
  });

  const exact = games.find((game) =>
    game.name.localeCompare(parsedFile.gameName, undefined, { sensitivity: 'accent' }) === 0 &&
    game.category.localeCompare(parsedFile.categoryName, undefined, { sensitivity: 'accent' }) === 0
  );
  if (exact) byId('game-select').value = exact.id;
  parsedFile.warnings.forEach((warning) => addLog(localizeApplicationMessage(warning)));
};

const loadGames = async () => {
  try {
    games = await bridge.listGames();
    const select = byId('game-select');
    select.replaceChildren(new Option(t('game.select'), ''));
    games.forEach((game) => select.add(new Option(`${game.name} — ${game.category} (${game.platform})`, game.id)));
    if (state?.selectedGameId && games.some((game) => game.id === state.selectedGameId)) {
      select.value = state.selectedGameId;
    }
    if (games.length === 0) addLog(t('log.games.none'), true);
  } catch (error) {
    addLog(t('log.games.failed', { error: errorMessage(error) }), true);
  }
};

const loadCloudLssFiles = async () => {
  const select = byId('cloud-lss-select');
  select.disabled = true;
  byId('load-cloud-lss').disabled = true;
  setCloudStatus('cloud.loading');
  try {
    cloudLssFiles = await bridge.listCloudLss();
    select.replaceChildren(new Option(t('cloud.select'), ''));
    cloudLssFiles.forEach((file) => {
      const pb = file.personalBestTime == null ? t('cloud.withoutPb') : `${t('cloud.pb')} ${formatTime(file.personalBestTime)}`;
      const primary = file.isPrimary ? ` — ${t('cloud.primary')}` : '';
      select.add(new Option(`${file.originalName} — ${file.gameName} / ${file.categoryName} — ${pb}${primary}`, file.id));
    });
    const selectedGameId = byId('game-select').value;
    const preferred = cloudLssFiles.find((file) => file.gameId === selectedGameId && file.isPrimary)
      ?? cloudLssFiles.find((file) => file.isPrimary);
    if (preferred) {
      select.value = preferred.id;
      byId('load-cloud-lss').disabled = !state?.authenticated;
    }
    if (cloudLssFiles.length) setCloudStatus('cloud.available', { count: cloudLssFiles.length });
    else setCloudStatus('cloud.none');
  } catch (error) {
    cloudLssFiles = [];
    select.replaceChildren(new Option(t('cloud.loadFailedOption'), ''));
    setCloudStatus('', {}, errorMessage(error));
    addLog(t('log.cloud.failed', { error: errorMessage(error) }), true);
  } finally {
    select.disabled = !state?.authenticated;
  }
};

const runTimerAction = async (action, successKey) => {
  try {
    const result = await action();
    if (result) renderTimer(result);
    if (successKey && result) addLog(t(successKey));
    return result;
  } catch (error) {
    addLog(t('log.timer.commandFailed', { error: errorMessage(error) }), true);
    return null;
  }
};

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await bridge.login({
      identifier: byId('identifier').value,
      password: byId('password').value,
      remember: byId('remember').checked,
    });
    if (!result.success) throw new Error(result.message);
    byId('password').value = '';
    updateState(await bridge.getState());
    await Promise.all([loadGames(), loadCloudLssFiles()]);
    addLog(t('log.login.success'));
    if (result.warning) addLog(localizeApplicationMessage(result.warning), true);
    if (result.offlineSyncConfirmed) {
      addLog(t('log.login.offlineImported', { count: result.offlineImportedCount }));
    } else if (result.offlinePendingCount > 0) {
      addLog(t('log.login.offlinePending', { count: result.offlinePendingCount }));
    }
  } catch (error) {
    addLog(t('log.login.failed', { error: errorMessage(error) }), true);
  } finally {
    button.disabled = false;
  }
});

byId('continue-offline').addEventListener('click', async () => {
  try {
    updateState(await bridge.continueOffline());
    addLog(t('log.offline.enabled'));
  } catch (error) {
    addLog(t('log.offline.failed', { error: errorMessage(error) }), true);
  }
});

byId('logout').addEventListener('click', async () => {
  const wasOffline = Boolean(state?.offlineMode);
  cancelScheduledThemeUpdate();
  await bridge.logout();
  updateState(await bridge.getState());
  addLog(t(wasOffline ? 'log.logout.offline' : 'log.logout.done'));
});

byId('select-file').addEventListener('click', async () => {
  try {
    showFile(await bridge.selectLss());
  } catch (error) {
    addLog(t('log.file.failed', { error: errorMessage(error) }), true);
  }
});

byId('game-select').addEventListener('change', async (event) => {
  if (!state?.authenticated) return;
  const select = event.target;
  select.disabled = true;
  try {
    updateState(await bridge.selectGame(select.value));
    if (select.value) await loadCloudLssFiles();
    addLog(t(select.value ? 'log.game.linked' : 'log.game.select'));
  } catch (error) {
    addLog(t('log.game.failed', { error: errorMessage(error) }), true);
  } finally {
    select.disabled = !state?.authenticated;
  }
});

byId('cloud-lss-select').addEventListener('change', (event) => {
  byId('load-cloud-lss').disabled = !state?.authenticated || !event.target.value;
});

byId('load-cloud-lss').addEventListener('click', async () => {
  const id = byId('cloud-lss-select').value;
  if (!id) return addLog(t('log.cloud.selectFirst'), true);
  const button = byId('load-cloud-lss');
  button.disabled = true;
  try {
    const result = await bridge.loadCloudLss(id);
    showFile(result);
    if (result.cloudFile?.gameId) byId('game-select').value = result.cloudFile.gameId;
    updateState(await bridge.getState());
    addLog(t('log.cloud.loaded', { name: result.cloudFile?.originalName || 'LiveSplit' }));
  } catch (error) {
    addLog(t('log.cloud.loadFailed', { error: errorMessage(error) }), true);
  } finally {
    button.disabled = !state?.authenticated || !byId('cloud-lss-select').value;
  }
});

byId('timer-start-split').addEventListener('click', () => {
  if (timerState?.phase === 'running') {
    void runTimerAction(() => bridge.splitTimer());
  } else {
    void runTimerAction(() => bridge.startTimer(), 'log.timer.started');
  }
});
byId('timer-pause').addEventListener('click', () => void runTimerAction(() => bridge.pauseTimer()));
byId('timer-undo').addEventListener('click', () => void runTimerAction(() => bridge.undoTimer()));
byId('timer-skip').addEventListener('click', () => void runTimerAction(() => bridge.skipTimer()));
byId('timer-reset').addEventListener('click', () => {
  if (window.confirm(t('confirm.reset'))) {
    void runTimerAction(() => bridge.resetTimer({ updateSplits: true }), 'log.timer.reset');
  }
});

byId('toggle-overlay').addEventListener('click', async () => {
  try {
    const isOpen = await bridge.toggleOverlay();
    addLog(t(isOpen ? 'log.overlay.opened' : 'log.overlay.closed'));
    updateState(await bridge.getState());
  } catch (error) {
    addLog(t('log.overlay.toggleFailed', { error: errorMessage(error) }), true);
  }
});

byId('autosplit-startOnlyOnNewGame').addEventListener('change', async (event) => {
  const input = event.target;
  const desired = input.checked;
  input.disabled = true;
  try {
    updateState(await bridge.setAutosplitStartOnlyOnNewGame(desired));
    addLog(t(desired ? 'log.autosplit.startNewGameOnly' : 'log.autosplit.startAnySave'));
  } catch (error) {
    // Nada mais desfaz o DOM, então a caixa volta ao valor anterior.
    input.checked = !desired;
    addLog(t('log.autosplit.startFailed', { error: errorMessage(error) }), true);
  } finally {
    input.disabled = false;
  }
});

byId('restore-overlay-interaction').addEventListener('click', async () => {
  try {
    await bridge.setOverlayClickThrough(false);
    updateState(await bridge.getState());
    addLog(t('log.overlay.clicksRestored'));
  } catch (error) {
    addLog(t('log.overlay.restoreFailed', { error: errorMessage(error) }), true);
  }
});

const themeState = {
  current: null,
  applying: false,
  timer: null,
  revision: 0,
  currentDraft: null,
  savingDrafts: new Set(),
};
let themeDraftSequence = 0;

const createThemeDraft = () => {
  const draftId = globalThis.crypto?.randomUUID?.()
    ?? `draft-${Date.now().toString(36)}-${(++themeDraftSequence).toString(36)}`;
  return {
    id: draftId,
    beginPromise: bridge.beginOverlayThemeEdit(draftId),
  };
};

const closeThemeDraft = async (draft) => {
  try {
    await draft.beginPromise;
  } catch {
    // O update exibirá a falha; ainda tentamos encerrar um begin parcialmente processado.
  }
  try {
    await bridge.endOverlayThemeEdit(draft.id);
  } catch {
    // A troca de conta já invalida o draft no processo principal.
  }
};
const FONT_STYLE_CHOICES = ['normal', 'italic'];
const overlayFontCatalog = window.overlayFonts;

const populateFontSelect = (id, current) => {
  const select = byId(id);
  if (!select || !overlayFontCatalog) return;
  select.replaceChildren();
  const options = overlayFontCatalog.options.slice();
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: current.replace(/["']/g, ''), group: 'sans' });
  }
  overlayFontCatalog.groups.forEach((group) => {
    const items = options.filter((option) => option.group === group);
    if (!items.length) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = t(`theme.fontGroup.${group}`);
    items.forEach((item) => {
      const option = new Option(item.label, item.value);
      option.style.fontFamily = item.value;
      optgroup.append(option);
    });
    select.append(optgroup);
  });
  if (current) select.value = current;
  select.style.fontFamily = current || '';
};

const readFontStyleValue = (select) => {
  const raw = select?.selectedOptions?.[0]?.getAttribute('value') || select?.value;
  if (typeof raw !== 'string') return 'normal';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'italic' || normalized === 'oblique' || normalized === 'itálico' || normalized === 'italico' || normalized === 'cursiva') {
    return 'italic';
  }
  return 'normal';
};

const populateFontStyleSelect = (id, current) => {
  const select = byId(id);
  if (!select) return;
  Array.from(select.options).forEach((option) => {
    const value = option.getAttribute('value') || option.value;
    if (FONT_STYLE_CHOICES.includes(value)) option.textContent = t(`theme.fontStyle.${value}`);
  });
  select.value = current === 'italic' ? 'italic' : 'normal';
};

const numericFields = [
  'fontWeight', 'timeFontWeight',
  'baseFontSize', 'segmentFontSize', 'timeFontSize', 'gameFontSize',
  'categoryFontSize', 'footerFontSize',
  'padding', 'segmentPadding', 'segmentGap', 'sectionGap', 'borderRadius',
  'backgroundBlur', 'borderWidth', 'timeLetterSpacing',
];
const colorFields = [
  'backgroundColor', 'borderColor', 'textColor', 'mutedColor',
  'accentColor', 'aheadColor', 'behindColor', 'goldColor', 'completedTimerColor', 'activeRowColor',
];
const booleanFields = [
  'showGame', 'showCategory', 'showSegments', 'showDeltas',
  'showSegmentTime', 'showSegmentTimer', 'showPhase', 'showFooter', 'compactTime', 'uppercaseCategory',
];
const updateLayoutComponents = (change) => {
  if (!themeState.current) return;
  const components = themeState.current.components.map((component) => ({ ...component }));
  change(components);
  themeState.current = { ...themeState.current, components };
  renderLayoutEditor();
  scheduleThemeUpdate();
};

const renderLayoutEditor = () => {
  const list = byId('layout-components');
  if (!list) return;
  list.replaceChildren();
  const components = themeState.current?.components || [];
  const addButton = byId('layout-add-component');
  if (addButton) {
    addButton.disabled = components.length >= 32;
    addButton.title = components.length >= 32 ? t('theme.maxComponents') : '';
  }
  components.forEach((component, index) => {
    const row = document.createElement('li');
    row.className = 'layout-component-row';
    const position = document.createElement('span');
    position.className = 'component-index';
    position.textContent = i18n.formatNumber(index + 1, { minimumIntegerDigits: 2, useGrouping: false });
    const kind = document.createElement('span');
    kind.className = 'component-kind';
    kind.textContent = i18n.componentLabel(component.type);
    const label = document.createElement('input');
    label.value = i18n.componentLabel(component.type, component.label);
    label.placeholder = t('theme.componentPlaceholder');
    label.disabled = ['title', 'splits', 'timer', 'separator'].includes(component.type);
    label.addEventListener('input', () => {
      const current = themeState.current;
      if (!current?.components[index]) return;
      const components = current.components.map((item, itemIndex) =>
        itemIndex === index ? { ...item, label: label.value } : item);
      themeState.current = { ...current, components };
    });
    label.addEventListener('change', () => updateLayoutComponents((items) => { items[index].label = label.value.trim() || kind.textContent; }));
    const makeButton = (text, titleKey, action, disabled = false, className = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.title = t(titleKey);
      button.disabled = disabled;
      button.className = className;
      button.addEventListener('click', action);
      return button;
    };
    const up = makeButton('↑', 'theme.moveUp', () => updateLayoutComponents((items) => items.splice(index - 1, 0, items.splice(index, 1)[0])), index === 0);
    const down = makeButton('↓', 'theme.moveDown', () => updateLayoutComponents((items) => items.splice(index + 1, 0, items.splice(index, 1)[0])), index === components.length - 1);
    const duplicate = makeButton('⧉', 'theme.duplicate', () => updateLayoutComponents((items) => {
      const copy = { ...items[index], id: `${items[index].type}-${Date.now()}` };
      items.splice(index + 1, 0, copy);
    }), components.length >= 32);
    const remove = makeButton('×', 'theme.remove', () => updateLayoutComponents((items) => items.splice(index, 1)), false, 'remove');
    row.append(position, kind, label, up, down, duplicate, remove);
    list.append(row);
  });
};

const applyThemeToInputs = (theme) => {
  document.documentElement.style.setProperty(
    '--completed-timer-color',
    theme.completedTimerColor || '#ffd700'
  );
  themeState.applying = true;
  try {
    overlayFontCatalog?.ensure();
    populateFontSelect('theme-fontFamily', theme.fontFamily);
    populateFontSelect('theme-timeFontFamily', theme.timeFontFamily);
    populateFontStyleSelect('theme-fontStyle', theme.fontStyle);
    populateFontStyleSelect('theme-timeFontStyle', theme.timeFontStyle);
    numericFields.forEach((field) => {
      const input = byId(`theme-${field}`);
      if (input) input.value = String(theme[field]);
    });
    const opacity = byId('theme-backgroundOpacity');
    if (opacity) opacity.value = String(Math.round(theme.backgroundOpacity * 100));
    colorFields.forEach((field) => {
      const input = byId(`theme-${field}`);
      if (input) input.value = theme[field];
    });
    booleanFields.forEach((field) => {
      const input = byId(`theme-${field}`);
      if (input) input.checked = Boolean(theme[field]);
    });
    const language = byId('theme-language');
    if (language) language.value = theme.language || 'en';
    i18n.setLanguage(theme.language || 'en');
    const alignment = byId('theme-timeAlignment');
    if (alignment) alignment.value = theme.timeAlignment;
    const orientation = byId('theme-layoutOrientation');
    if (orientation) orientation.value = theme.layoutOrientation || 'vertical';
    document.querySelectorAll('[data-value-for]').forEach((element) => {
      const source = byId(element.dataset.valueFor);
      if (source) element.textContent = source.value;
    });
    renderLayoutEditor();
  } finally {
    themeState.applying = false;
  }
};

const collectThemeFromInputs = () => {
  const partial = {};
  numericFields.forEach((field) => {
    const input = byId(`theme-${field}`);
    if (input) partial[field] = Number(input.value);
  });
  colorFields.forEach((field) => {
    const input = byId(`theme-${field}`);
    if (input) partial[field] = input.value;
  });
  booleanFields.forEach((field) => {
    const input = byId(`theme-${field}`);
    if (input) partial[field] = input.checked;
  });
  const opacity = byId('theme-backgroundOpacity');
  if (opacity) partial.backgroundOpacity = Number(opacity.value) / 100;
  const alignment = byId('theme-timeAlignment');
  if (alignment) partial.timeAlignment = alignment.value;
  const fontFamily = byId('theme-fontFamily');
  if (fontFamily) partial.fontFamily = fontFamily.value;
  const timeFontFamily = byId('theme-timeFontFamily');
  if (timeFontFamily) partial.timeFontFamily = timeFontFamily.value;
  const fontStyle = byId('theme-fontStyle');
  if (fontStyle) partial.fontStyle = readFontStyleValue(fontStyle);
  const timeFontStyle = byId('theme-timeFontStyle');
  if (timeFontStyle) partial.timeFontStyle = readFontStyleValue(timeFontStyle);
  const orientation = byId('theme-layoutOrientation');
  if (orientation) partial.layoutOrientation = orientation.value;
  const language = byId('theme-language');
  if (language) partial.language = language.value;
  partial.components = (themeState.current?.components || []).map((component) => ({ ...component }));
  return partial;
};

const scheduleThemeUpdate = () => {
  if (themeState.applying) return;
  let draft = themeState.currentDraft;
  if (!draft) {
    draft = createThemeDraft();
    themeState.currentDraft = draft;
  }
  document.querySelectorAll('[data-value-for]').forEach((element) => {
    const source = byId(element.dataset.valueFor);
    if (source) element.textContent = source.value;
  });
  const preset = byId('theme-preset');
  if (preset) preset.value = '';
  if (themeState.timer) clearTimeout(themeState.timer);
  const revision = ++themeState.revision;
  themeState.timer = setTimeout(async () => {
    themeState.timer = null;
    if (themeState.currentDraft?.id === draft.id) themeState.currentDraft = null;
    const partial = collectThemeFromInputs();
    themeState.savingDrafts.add(draft.id);
    try {
      try {
        await draft.beginPromise;
      } catch {
        // Local save must not depend on a live API session or draft registration.
      }
      const updated = await bridge.updateOverlayTheme(partial, draft.id);
      if (revision === themeState.revision) {
        themeState.current = updated;
        renderLayoutEditor();
      }
    } catch (error) {
      addLog(t('log.theme.saveFailed', { error: errorMessage(error) }), true);
    } finally {
      themeState.savingDrafts.delete(draft.id);
      await closeThemeDraft(draft);
    }
  }, 150);
};

const cancelScheduledThemeUpdate = () => {
  themeState.revision += 1;
  if (themeState.timer) clearTimeout(themeState.timer);
  themeState.timer = null;
  const draft = themeState.currentDraft;
  themeState.currentDraft = null;
  if (draft) void closeThemeDraft(draft);
};

const runImmediateThemeMutation = async (mutation) => {
  const draft = createThemeDraft();
  themeState.savingDrafts.add(draft.id);
  try {
    try {
      await draft.beginPromise;
    } catch {
      // Presets/reset still save locally if the sync draft could not start.
    }
    return await mutation(draft.id);
  } finally {
    themeState.savingDrafts.delete(draft.id);
    await closeThemeDraft(draft);
  }
};

const bindThemeControls = () => {
  document.querySelectorAll('.theme-grid input, .theme-grid select:not(#theme-preset), .theme-toggles input')
    .forEach((element) => {
      const type = element.type;
      const eventName = (type === 'range' || type === 'color') ? 'input' : 'change';
      element.addEventListener(eventName, scheduleThemeUpdate);
    });
  byId('theme-layoutOrientation').addEventListener('change', scheduleThemeUpdate);
  byId('theme-language').addEventListener('change', (event) => {
    if (themeState.current) themeState.current = { ...themeState.current, language: event.target.value };
    i18n.setLanguage(event.target.value);
  });
  byId('layout-add-component').addEventListener('click', () => {
    const type = byId('layout-component-type').value;
    updateLayoutComponents((items) => items.push({
      id: `${type}-${Date.now()}`,
      type,
      label: i18n.componentLabel(type),
    }));
  });
  byId('theme-reset').addEventListener('click', async () => {
    cancelScheduledThemeUpdate();
    const revision = themeState.revision;
    try {
      const theme = await runImmediateThemeMutation((draftId) =>
        bridge.resetOverlayTheme(draftId));
      if (revision === themeState.revision) {
        themeState.current = theme;
        applyThemeToInputs(theme);
      }
      addLog(t('log.theme.reset'));
    } catch (error) {
      addLog(t('log.theme.resetFailed', { error: errorMessage(error) }), true);
    }
  });
  byId('theme-preset').addEventListener('change', async (event) => {
    const name = event.target.value;
    if (!name) return;
    cancelScheduledThemeUpdate();
    const revision = themeState.revision;
    try {
      const theme = await runImmediateThemeMutation((draftId) =>
        bridge.applyOverlayPreset(name, draftId));
      if (revision === themeState.revision) {
        themeState.current = theme;
        applyThemeToInputs(theme);
      }
      addLog(t('log.theme.preset', { name: i18n.presetLabel(name) }));
    } catch (error) {
      addLog(t('log.theme.presetFailed', { error: errorMessage(error) }), true);
    }
  });
};

const initTheme = async () => {
  try {
    const [theme, presets] = await Promise.all([
      bridge.getOverlayTheme(),
      bridge.listOverlayPresets(),
    ]);
    themeState.current = theme;
    const presetSelect = byId('theme-preset');
    if (presetSelect) {
      presetSelect.replaceChildren(new Option(t('theme.custom'), ''));
      presets.forEach((name) => presetSelect.add(new Option(i18n.presetLabel(name), name)));
    }
    applyThemeToInputs(theme);
    bindThemeControls();
  } catch (error) {
    addLog(t('log.theme.loadFailed', { error: errorMessage(error) }), true);
  }
};

byId('start-monitor').addEventListener('click', async () => {
  const gameId = byId('game-select').value;
  if (!selectedFile) return addLog(t('log.monitor.fileFirst'), true);
  if (!gameId) return addLog(t('log.monitor.gameFirst'), true);
  try {
    const parsed = await bridge.startMonitoring({ filePath: selectedFile, gameId });
    showFile({ filePath: selectedFile, parsed });
    updateState(await bridge.getState());
    addLog(t('log.monitor.started'));
  } catch (error) {
    addLog(t('log.monitor.startFailed', { error: errorMessage(error) }), true);
  }
});

byId('stop-monitor').addEventListener('click', async () => {
  await bridge.stopMonitoring();
  updateState(await bridge.getState());
  addLog(t('log.monitor.stopped'));
});

byId('sync-now').addEventListener('click', async () => {
  try {
    const queue = await bridge.syncNow();
    state.queue = queue;
    updateState(state);
    addLog(queue.pending ? t('log.sync.pending', { count: queue.pending }) : t('log.sync.done'));
  } catch (error) {
    addLog(t('log.sync.failed', { error: errorMessage(error) }), true);
  }
});

byId('update-install').addEventListener('click', async () => {
  const button = byId('update-install');
  button.disabled = true;
  try {
    // O main encerra o app pelo fluxo normal: run pendente é salva antes do instalador.
    if (await bridge.installUpdate()) byId('update-detail').textContent = t('update.installing');
    else button.disabled = false;
  } catch (error) {
    button.disabled = false;
    addLog(t('log.update.failed', { error: errorMessage(error) }), true);
  }
});

bridge.onEvent((event) => {
  if (event.type === 'timer-state' && event.data) {
    if (state) state.timer = event.data;
    renderTimer(event.data);
    return;
  }
  if (event.type === 'overlay-theme' && event.data) {
    if (themeState.currentDraft || themeState.savingDrafts.size > 0) return;
    themeState.current = event.data;
    applyThemeToInputs(event.data);
    return;
  }
  if (event.type === 'update') {
    // O progresso do download é frequente: renderiza no painel sem inundar a atividade.
    if (state) state.update = event.data;
    renderUpdate(event.data);
    logUpdateTransition(event.data);
    return;
  }
  if (event.type === 'state' && event.data) updateState(event.data);
  if (event.type === 'file-read' && event.data) showFile(event.data);
  if ((event.type === 'sync' || event.type === 'error') && isQueueStatus(event.data) && state) {
    state.queue = event.data;
    updateState(state);
  }
  addLog(localizeApplicationMessage(event.message), event.type === 'error' || event.type === 'auth-expired' || event.data?.isError);
});

window.addEventListener('offline', () => {
  addLog(t('log.network.offline'));
});

window.addEventListener('online', () => {
  bridge.notifyOnline();
  if (state?.authenticated) void Promise.allSettled([loadGames(), loadCloudLssFiles()]);
  addLog(t('log.network.online'));
});

window.addEventListener('gts-language-change', () => {
  if (state) updateState(state);
  else if (timerState) renderTimer(timerState);
  renderLayoutEditor();
  if (cloudStatus.raw) byId('cloud-lss-status').textContent = cloudStatus.raw;
  else setCloudStatus(cloudStatus.key, cloudStatus.params);

  const preset = byId('theme-preset');
  if (preset?.options.length) {
    Array.from(preset.options).forEach((option) => {
      option.textContent = option.value ? i18n.presetLabel(option.value) : t('theme.custom');
    });
  }
  if (themeState.current) {
    const applying = themeState.applying;
    themeState.applying = true;
    try {
      populateFontSelect('theme-fontFamily', themeState.current.fontFamily);
      populateFontSelect('theme-timeFontFamily', themeState.current.timeFontFamily);
      populateFontStyleSelect('theme-fontStyle', themeState.current.fontStyle);
      populateFontStyleSelect('theme-timeFontStyle', themeState.current.timeFontStyle);
    } finally {
      themeState.applying = applying;
    }
  }
  const gameSelect = byId('game-select');
  if (gameSelect?.options.length) gameSelect.options[0].textContent = t('game.select');

  if (parsedFile) {
    const values = [
      [t('file.game'), parsedFile.gameName || t('file.notProvided')],
      [t('file.category'), parsedFile.categoryName || t('file.notProvidedF')],
      [t('file.segments'), i18n.formatNumber(parsedFile.segmentNames.length)],
      [t('file.attemptsDetected'), i18n.formatNumber(parsedFile.attempts.length)],
    ];
    byId('file-summary').querySelectorAll(':scope > div').forEach((box, index) => {
      const [label, value] = values[index] || [];
      if (label === undefined) return;
      box.querySelector('strong').textContent = value;
      box.querySelector('span').textContent = label;
    });
  }

  if (state?.authenticated) {
    const cloudSelect = byId('cloud-lss-select');
    const selected = cloudSelect.value;
    cloudSelect.replaceChildren(new Option(t('cloud.select'), ''));
    cloudLssFiles.forEach((file) => {
      const pb = file.personalBestTime == null ? t('cloud.withoutPb') : `${t('cloud.pb')} ${formatTime(file.personalBestTime)}`;
      cloudSelect.add(new Option(`${file.originalName} — ${file.gameName} / ${file.categoryName} — ${pb}`, file.id));
    });
    cloudSelect.value = selected;
  }
});

(async () => {
  try {
    i18n.applyToDocument();
    updateState(await bridge.getState());
    await initTheme();
    if (state.authenticated) await Promise.all([loadGames(), loadCloudLssFiles()]);
  } catch (error) {
    addLog(t('log.app.failed', { error: errorMessage(error) }), true);
  }
})();
