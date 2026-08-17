import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AppState,
  DesktopEvent,
  Game,
  LoginRequest,
  MonitorRequest,
  QueueStatus,
  RaceOverlayState,
  RunProgressPayload,
  RunSplitPayload,
  ViewerOverlayState,
  ViewerRoomView,
} from '../shared/types';
import type {
  FinishTimerRequest,
  ResetTimerRequest,
  TimerCommand,
  TimerState,
} from '../shared/timer-protocol';
import { ApiClient } from './services/api-client';
import { AppUpdater } from './services/app-updater';
import { CloudLssStore } from './services/cloud-lss-store';
import { LssMonitor } from './services/lss-monitor';
import { parseLssFile } from './services/lss-parser';
import {
  OverlayThemeStore,
  type MissingThemeFallback,
  type OverlayThemeOwnerContext,
} from './services/overlay-theme-store';
import { OverlayThemeSync } from './services/overlay-theme-sync';
import { RaceSync } from './services/race-sync';
import { SessionStore } from './services/session-store';
import { OFFLINE_QUEUE_OWNER_ID, SyncQueue } from './services/sync-queue';
import { TimerSidecar, unavailableTimerState } from './services/timer-sidecar';
import { ViewerOverlayThemeStore } from './services/viewer-overlay-theme-store';
import { ViewerRaceSync } from './services/viewer-race-sync';
import {
  applyOverlayThemePreset,
  defaultOverlayTheme,
  overlayThemePresets,
  type OverlayTheme,
} from '../shared/overlay-theme';
import type { ViewerOverlayTheme } from '../shared/viewer-overlay-theme';

let mainWindow: BrowserWindow | undefined;
let overlayWindow: BrowserWindow | undefined;
let viewerOverlayWindow: BrowserWindow | undefined;
let store: SessionStore;
let cloudLssStore: CloudLssStore;
let overlayThemeStore: OverlayThemeStore;
let overlayThemeSync: OverlayThemeSync;
let viewerOverlayThemeStore: ViewerOverlayThemeStore;
let raceSync: RaceSync | undefined;
let viewerRaceSync: ViewerRaceSync | undefined;
let api: ApiClient;
let queue: SyncQueue;
let monitor: LssMonitor;
let timerSidecar: TimerSidecar;
let queueStatus: QueueStatus = { pending: 0, synchronized: 0, failed: 0 };
let selectedFile: string | undefined;
let sidecarReady = false;
let offlineMode = false;
let overlayClickThrough = false;
let timerState = unavailableTimerState();
let shutdownInProgress = false;
let quitAllowed = false;
let overlayThemeOwnerId: string | undefined;
let overlayThemeOwnerGeneration = 0;
let monitoredFile: string | undefined;
let monitoredGameId: string | undefined;
let automaticMonitoringChain: Promise<void> = Promise.resolve();

interface ActiveAttemptContext {
  clientAttemptId: string;
  revision: number;
  ownerId: string;
  gameId?: string;
  attemptCount: number;
  startedAt: string;
  hasPersistedSnapshot: boolean;
}

interface DeferredTimerTransition {
  previous: TimerState;
  state: TimerState;
}

let activeAttempt: ActiveAttemptContext | undefined;
let timerProgressChain: Promise<void> = Promise.resolve();
let progressQueueOwnerId: string | undefined;
let deferredTimerTransition: DeferredTimerTransition | undefined;

interface OverlayThemeDraftContext {
  ownerId?: string;
  ownerGeneration: number;
  storeOwnerGeneration: number;
}

const overlayThemeDrafts = new Map<string, OverlayThemeDraftContext>();

const getAppIconPath = (): string => app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'build', 'icon.png');

const sendEvent = (event: DesktopEvent): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:event', event);
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('desktop:event', event);
  if (viewerOverlayWindow && !viewerOverlayWindow.isDestroyed()) {
    viewerOverlayWindow.webContents.send('desktop:event', event);
  }
};

/** O modo espectador é exclusivo do papel `viewer`: staff e runner seguem na interface normal. */
const isViewerSession = (): boolean => api?.getSession()?.user.role === 'viewer';

// Não depende de sessão nem de arquivo local, então pode existir desde a carga do módulo.
const appUpdater = new AppUpdater({
  onStatus: (status, message) => sendEvent({ type: 'update', message, data: status }),
});

const getState = (): AppState => ({
  authenticated: Boolean(api.getSession()),
  offlineMode,
  user: api.getSession()?.user,
  selectedFile,
  selectedGameId: store.getSelectedGameId(),
  monitoring: monitor.isMonitoring(),
  queue: queueStatus,
  sidecarReady,
  timer: timerState,
  // Vem da store, não de `timerState.autosplit`: quando o sidecar cai, `unavailableTimerState()`
  // devolve os padrões e a interface voltaria a mostrar valores que o usuário não escolheu.
  autosplit: store.getAutosplitConfig(),
  overlayOpen: Boolean(overlayWindow && !overlayWindow.isDestroyed()),
  overlayClickThrough,
  race: raceSync?.getOverlayState() ?? null,
  viewer: {
    active: isViewerSession(),
    rooms: viewerRaceSync?.getRooms() ?? [],
    watchingRaceId: viewerRaceSync?.getWatchingRaceId() ?? null,
    overlay: viewerRaceSync?.getOverlayState() ?? null,
    overlayOpen: Boolean(viewerOverlayWindow && !viewerOverlayWindow.isDestroyed()),
  },
  update: appUpdater.getStatus(),
});

const sendState = (message = 'Estado atualizado.'): void => {
  sendEvent({ type: 'state', message, data: getState() });
};

const completedSplitTimes = (state: TimerState): RunSplitPayload[] => {
  const splitTimes: RunSplitPayload[] = [];
  let previousCumulative = 0;
  state.segments.forEach((segment, index) => {
    if (segment.splitTimeMs === null || !Number.isFinite(segment.splitTimeMs)) return;
    const cumulativeTime = Math.max(0, Math.round(segment.splitTimeMs));
    const splitTime = cumulativeTime - previousCumulative;
    if (splitTime < 0) return;
    splitTimes.push({
      name: segment.name,
      order: index + 1,
      splitTime,
      cumulativeTime,
    });
    previousCumulative = cumulativeTime;
  });
  return splitTimes;
};

const splitSnapshotKey = (state: TimerState): string =>
  completedSplitTimes(state)
    .map((split) => `${split.order}:${split.cumulativeTime}`)
    .join('|');

const findGameForTimer = (
  games: Game[],
  state: TimerState,
  preferredGameId?: string
): Game | undefined => {
  const matches = games.filter((game) =>
    game.name.localeCompare(state.gameName, undefined, { sensitivity: 'accent' }) === 0 &&
    game.category.localeCompare(state.categoryName, undefined, { sensitivity: 'accent' }) === 0
  );
  const preferred = matches.find((game) => game.id === preferredGameId);
  return preferred ?? (matches.length === 1 ? matches[0] : undefined);
};

const resolveTimerGameId = async (state: TimerState): Promise<string | undefined> => {
  try {
    const games = await api.getGames();
    const match = findGameForTimer(games, state, store.getSelectedGameId());
    if (!match) return undefined;
    await store.savePreferences(selectedFile, match.id);
    return match.id;
  } catch {
    return undefined;
  }
};

const createAttemptContext = async (state: TimerState): Promise<ActiveAttemptContext> => {
  const initialSessionUserId = api.getSession()?.user.id;
  const resolvedGameId = initialSessionUserId ? await resolveTimerGameId(state) : undefined;
  const currentSessionUserId = api.getSession()?.user.id;
  return {
    clientAttemptId: randomUUID(),
    revision: 0,
    ownerId: currentSessionUserId ?? OFFLINE_QUEUE_OWNER_ID,
    gameId: currentSessionUserId === initialSessionUserId ? resolvedGameId : undefined,
    attemptCount: state.attemptCount,
    startedAt: new Date(Date.now() - Math.max(0, Math.round(state.currentTimeMs))).toISOString(),
    hasPersistedSnapshot: false,
  };
};

const captureTimerProgress = async (previous: TimerState, state: TimerState): Promise<void> => {
  if (!state.available) return;
  const sessionOwnerId = api.getSession()?.user.id ?? OFFLINE_QUEUE_OWNER_ID;
  const ownerId = activeAttempt?.ownerId ?? sessionOwnerId;
  const detachedOfflineAttempt = ownerId === OFFLINE_QUEUE_OWNER_ID &&
    sessionOwnerId !== OFFLINE_QUEUE_OWNER_ID;
  if (!detachedOfflineAttempt && progressQueueOwnerId !== ownerId) {
    deferredTimerTransition = deferredTimerTransition
      ? { previous: deferredTimerTransition.previous, state }
      : { previous, state };
    return;
  }

  const activePhase = state.phase === 'running' || state.phase === 'paused' || state.phase === 'ended';
  const newAttemptStarted = activePhase && (
    !activeAttempt ||
    activeAttempt.attemptCount !== state.attemptCount ||
    (previous.phase === 'ended' && state.phase === 'running')
  );
  if (newAttemptStarted) activeAttempt = await createAttemptContext(state);

  const resetTransition = state.phase === 'notRunning' &&
    (previous.phase === 'running' || previous.phase === 'paused' || previous.phase === 'ended');
  if (!activeAttempt) {
    if (resetTransition) activeAttempt = undefined;
    return;
  }

  const snapshotChanged = splitSnapshotKey(previous) !== splitSnapshotKey(state);
  if (!snapshotChanged && !resetTransition) return;

  const snapshotState = resetTransition ? previous : state;
  const splitTimes = completedSplitTimes(snapshotState);
  if (
    splitTimes.length === 0 &&
    completedSplitTimes(previous).length === 0 &&
    !activeAttempt.hasPersistedSnapshot
  ) {
    if (resetTransition) activeAttempt = undefined;
    return;
  }

  const lastSplit = splitTimes.at(-1);
  const revision = ++activeAttempt.revision;
  const progress: RunProgressPayload = {
    clientAttemptId: activeAttempt.clientAttemptId,
    revision,
    gameId: activeAttempt.gameId,
    gameName: snapshotState.gameName,
    categoryName: snapshotState.categoryName,
    configName: `Desktop - ${snapshotState.categoryName || 'Categoria'}`.slice(0, 100),
    configSplits: snapshotState.segments.map((segment) => segment.name),
    startedAt: activeAttempt.startedAt,
    phase: resetTransition ? 'reset' : snapshotState.phase === 'ended' ? 'ended' : 'running',
    elapsedTime: Math.max(
      Math.max(0, Math.round(snapshotState.currentTimeMs)),
      lastSplit?.cumulativeTime ?? 0
    ),
    splitTimes,
  };

  const progressOwnerId = activeAttempt.ownerId;
  const added = progressOwnerId === OFFLINE_QUEUE_OWNER_ID && api.getSession()
    ? await queue.enqueueOfflineProgress(progress)
    : await queue.enqueueProgress(progress);
  activeAttempt.hasPersistedSnapshot = true;
  if (added) {
    sendEvent({
      type: 'sync',
      message: progressOwnerId === OFFLINE_QUEUE_OWNER_ID
        ? `Split ${lastSplit?.order ?? 0} salvo no modo offline; aguardando login para sincronizar.`
        : `Split ${lastSplit?.order ?? 0} salvo localmente; sincronização iniciada.`,
      data: queue.getStatus(),
    });
  }
  await queue.flush();
  if (resetTransition) activeAttempt = undefined;
};

const reportProgressError = (error: unknown): void => {
  sendEvent({
    type: 'error',
    message: `Não foi possível salvar o progresso do split: ${error instanceof Error ? error.message : String(error)}`,
  });
};

const scheduleTimerProgress = (previous: TimerState, state: TimerState): void => {
  timerProgressChain = timerProgressChain
    .then(() => captureTimerProgress(previous, state))
    .catch(reportProgressError);
};

const markProgressQueueReady = (ownerId: string): void => {
  progressQueueOwnerId = ownerId;
  const deferred = deferredTimerTransition;
  deferredTimerTransition = undefined;
  if (deferred) scheduleTimerProgress(deferred.previous, deferred.state);
};

const publishTimerState = (state: TimerState, message = 'Timer atualizado.'): void => {
  const previous = timerState;
  timerState = state;
  sendEvent({ type: 'timer-state', message, data: state });
  scheduleTimerProgress(previous, state);
  // Trilha paralela: a corrida precisa dos splits em tempo quase real, enquanto o progresso
  // acima é o histórico durável. Reaproveita a conversão já feita por completedSplitTimes.
  raceSync?.handleTimerState(previous, state, completedSplitTimes(state));
};

const broadcastRaceState = (race: RaceOverlayState | null): void => {
  sendEvent({
    type: 'race-state',
    message: race ? 'Estado da corrida atualizado.' : 'Nenhuma corrida ativa.',
    data: race,
  });
};

const broadcastViewerRooms = (rooms: ViewerRoomView[]): void => {
  sendEvent({
    type: 'viewer-rooms',
    message: 'Lista de salas de corrida atualizada.',
    data: rooms,
  });
};

const broadcastViewerOverlayState = (state: ViewerOverlayState | null): void => {
  sendEvent({
    type: 'viewer-overlay-state',
    message: state ? 'Corrida assistida atualizada.' : 'Nenhuma corrida sendo assistida.',
    data: state,
  });
};

const broadcastViewerTheme = (theme: ViewerOverlayTheme): void => {
  sendEvent({
    type: 'viewer-overlay-theme',
    message: 'Tema da overlay de espectador atualizado.',
    data: theme,
  });
};

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 900,
    minWidth: 760,
    minHeight: 680,
    title: 'Game Time Splitter',
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void mainWindow.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => sendState('Aplicativo iniciado.'));
  mainWindow.on('closed', () => { mainWindow = undefined; });
};

const sameFilePath = (left: string, right: string): boolean =>
  path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();

const stopAutomaticMonitoring = (): void => {
  monitor?.stop();
  monitoredFile = undefined;
  monitoredGameId = undefined;
};

const ensureAutomaticMonitoring = async (reason: string): Promise<void> => {
  const sessionUserId = api.getSession()?.user.id;
  const filePath = selectedFile;
  if (!sessionUserId || !filePath) {
    stopAutomaticMonitoring();
    return;
  }

  const storedGameId = store.getSelectedGameId();
  let gameId: string | undefined;
  if (timerState.available) {
    gameId = await resolveTimerGameId(timerState);
  } else if (storedGameId) {
    try {
      const games = await api.getGames();
      gameId = games.some((game) => game.id === storedGameId) ? storedGameId : undefined;
    } catch {
      stopAutomaticMonitoring();
      return;
    }
  }
  if (!gameId) {
    if (storedGameId) await store.savePreferences(filePath, undefined);
    stopAutomaticMonitoring();
    return;
  }
  if (
    monitor.isMonitoring() &&
    monitoredFile &&
    sameFilePath(monitoredFile, filePath) &&
    monitoredGameId === gameId
  ) return;

  stopAutomaticMonitoring();
  try {
    await monitor.start(filePath, gameId);
    if (
      api.getSession()?.user.id !== sessionUserId ||
      !selectedFile ||
      !sameFilePath(selectedFile, filePath) ||
      store.getSelectedGameId() !== gameId
    ) {
      stopAutomaticMonitoring();
      return;
    }
    monitoredFile = filePath;
    monitoredGameId = gameId;
    sendState(`Sincronização automática ativa (${reason}).`);
  } catch (error) {
    stopAutomaticMonitoring();
    sendEvent({
      type: 'error',
      message: `A sincronização automática aguardará uma nova tentativa: ${error instanceof Error ? error.message : String(error)}`,
    });
    sendState('Sincronização automática aguardando arquivo, jogo ou conexão válidos.');
  }
};

const scheduleAutomaticMonitoring = (reason: string): Promise<void> => {
  const operation = automaticMonitoringChain
    .catch(() => undefined)
    .then(() => ensureAutomaticMonitoring(reason));
  automaticMonitoringChain = operation;
  return operation;
};

const adoptSelectedFile = async (filePath: string): Promise<void> => {
  const fileChanged = Boolean(selectedFile && !sameFilePath(selectedFile, filePath));
  if (monitor.isMonitoring() && fileChanged) {
    stopAutomaticMonitoring();
    sendEvent({
      type: 'sidecar',
      message: 'O monitor anterior foi interrompido porque a run selecionada mudou.',
    });
  }
  selectedFile = filePath;
  await store.savePreferences(filePath, fileChanged ? undefined : store.getSelectedGameId());
};

const executeTimerCommand = async (
  command: Exclude<TimerCommand, 'shutdown'>,
  payload?: unknown
): Promise<TimerState> => {
  if (command === 'load' || command === 'create') activeAttempt = undefined;
  if (!timerSidecar.isReady()) {
    await timerSidecar.start();
    sidecarReady = true;
    if (selectedFile && command !== 'load') {
      try {
        timerState = await timerSidecar.command('load', { path: selectedFile });
      } catch (error) {
        timerState = unavailableTimerState();
        sendEvent({
          type: 'error',
          message: `O sidecar reiniciou, mas não restaurou o .lss: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    try {
      timerState = await timerSidecar.command('autosplitConfigure', store.getAutosplitConfig());
    } catch (error) {
      sendEvent({
        type: 'error',
        message: `O sidecar reiniciou sem restaurar o autosplit: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    sendState('Motor de timer nativo reiniciado.');
  }

  const state = await timerSidecar.command(command, payload);
  publishTimerState(state, `Comando do timer executado: ${command}.`);
  return state;
};

const publishSelectedFile = async (filePath: string): Promise<void> => {
  const parsed = await parseLssFile(filePath);
  sendEvent({
    type: 'file-read',
    message: `${parsed.attempts.length} tentativa(s) encontrada(s).`,
    data: { filePath, parsed },
  });
};

const registerTimerIpcHandlers = (): void => {
  ipcMain.handle('timer:load', (_event, filePath: string) => executeTimerCommand('load', { path: filePath }));
  ipcMain.handle('timer:start', () => executeTimerCommand('start'));
  ipcMain.handle('timer:split', () => executeTimerCommand('split'));
  ipcMain.handle('timer:pause', () => executeTimerCommand('pause'));
  ipcMain.handle('timer:reset', (_event, request: ResetTimerRequest = {}) => executeTimerCommand('reset', request));
  ipcMain.handle('timer:undo', () => executeTimerCommand('undo'));
  ipcMain.handle('timer:skip', () => executeTimerCommand('skip'));
  ipcMain.handle('timer:state', () => executeTimerCommand('state'));
  ipcMain.handle('timer:autosplit-configure', async (_event, request: unknown) => {
    const partial = request as { startOnlyOnNewGame?: unknown } | null;
    if (!partial || typeof partial.startOnlyOnNewGame !== 'boolean') {
      throw new Error('Configuração de autosplit inválida.');
    }
    // Persiste antes de enviar: se o sidecar recusar, a escolha não se perde no reinício.
    await store.saveAutosplitConfig({ startOnlyOnNewGame: partial.startOnlyOnNewGame });
    await executeTimerCommand('autosplitConfigure', store.getAutosplitConfig());
    sendState(partial.startOnlyOnNewGame
      ? 'O timer passa a iniciar somente em um jogo novo.'
      : 'O timer passa a iniciar ao abrir qualquer save.');
    return getState();
  });
  ipcMain.handle('timer:finish', async (_event, request: FinishTimerRequest) => {
    if (!request || !['overwrite', 'saveAs', 'discard'].includes(request.action)) {
      throw new Error('Escolha de finalização inválida.');
    }
    if (timerState.phase !== 'ended') {
      throw new Error('A run ainda não foi finalizada.');
    }
    if (request.action === 'overwrite' && !timerState.sourcePath) {
      throw new Error('Esta run ainda não possui um arquivo para sobrescrever. Salve em um novo arquivo.');
    }

    let savePath: string | undefined;
    if (request.action === 'saveAs') {
      const suggestedName = `${timerState.gameName || 'run'}-${timerState.categoryName || 'categoria'}`
        .replace(/[<>:"/\\|?*]+/g, '-')
        .trim();
      const options = {
        title: 'Salvar run finalizada em novo arquivo',
        defaultPath: `${suggestedName}.lss`,
        filters: [{ name: 'LiveSplit Run', extensions: ['lss'] }],
      };
      const owner = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : mainWindow;
      const result = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      savePath = result.filePath;
    }

    const shouldSave = request.action !== 'discard';
    const state = await executeTimerCommand('finish', {
      action: shouldSave ? 'save' : 'discard',
      ...(savePath ? { path: savePath } : {}),
    });
    if (shouldSave && state.sourcePath) {
      await adoptSelectedFile(state.sourcePath);
      await resolveTimerGameId(state);
      await publishSelectedFile(state.sourcePath);
      stopAutomaticMonitoring();
      await scheduleAutomaticMonitoring('run finalizada e salva');
      sendState('Run salva; a tentativa concluída foi adicionada à sincronização automática.');
    } else {
      sendState('Run finalizada descartada sem alterar o arquivo .lss.');
    }
    return state;
  });
};

const broadcastTheme = (theme: OverlayTheme): void => {
  const event: DesktopEvent = { type: 'overlay-theme', message: 'Tema da overlay atualizado.', data: theme };
  sendEvent(event);
};

const normalizeDraftId = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(value)
  ) {
    throw new Error('Identificador de edição do tema inválido.');
  }
  return value;
};

const overlayThemeDraftIsCurrent = (context: OverlayThemeDraftContext): boolean => {
  const storeOwner = overlayThemeStore.getOwnerContext();
  return context.storeOwnerGeneration === storeOwner.generation &&
    context.ownerId === storeOwner.ownerId;
};

const beginOverlayThemeDraft = (rawDraftId: unknown): boolean => {
  const draftId = normalizeDraftId(rawDraftId);
  const existing = overlayThemeDrafts.get(draftId);
  if (existing) {
    if (!overlayThemeDraftIsCurrent(existing)) {
      throw new Error('A conta ativa mudou durante a edição do tema.');
    }
    return true;
  }

  const storeOwner = overlayThemeStore.getOwnerContext();
  overlayThemeDrafts.set(draftId, {
    ownerId: storeOwner.ownerId,
    ownerGeneration: overlayThemeOwnerGeneration,
    storeOwnerGeneration: storeOwner.generation,
  });
  overlayThemeSync.beginLocalDraft(draftId);
  return true;
};

const getOverlayThemeDraft = (rawDraftId: unknown): OverlayThemeDraftContext => {
  const draftId = normalizeDraftId(rawDraftId);
  const context = overlayThemeDrafts.get(draftId);
  if (!context || !overlayThemeDraftIsCurrent(context)) {
    throw new Error('Esta edição foi cancelada porque a conta ativa mudou.');
  }
  return context;
};

const resolveThemeMutationOwner = (rawDraftId: unknown): OverlayThemeOwnerContext => {
  const storeOwner = overlayThemeStore.getOwnerContext();
  const current = { ownerId: storeOwner.ownerId, generation: storeOwner.generation };
  if (rawDraftId === undefined || rawDraftId === null || rawDraftId === '') return current;
  try {
    const context = getOverlayThemeDraft(rawDraftId);
    return { ownerId: context.ownerId, generation: context.storeOwnerGeneration };
  } catch {
    return current;
  }
};

const endOverlayThemeDraft = (rawDraftId: unknown): boolean => {
  const draftId = normalizeDraftId(rawDraftId);
  if (!overlayThemeDrafts.delete(draftId)) return false;
  overlayThemeSync.endLocalDraft(draftId);
  return true;
};

const switchOverlayThemeOwner = async (
  userId?: string,
  missingFallback: MissingThemeFallback = 'last-known'
): Promise<OverlayTheme> => {
  const generation = ++overlayThemeOwnerGeneration;
  overlayThemeOwnerId = userId;
  overlayThemeDrafts.clear();
  overlayThemeSync?.clearLocalDrafts();

  const theme = await overlayThemeStore.load(userId, missingFallback);
  if (generation === overlayThemeOwnerGeneration && userId === overlayThemeOwnerId) {
    broadcastTheme(theme);
  }
  return theme;
};

const createOverlayWindow = (): BrowserWindow => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
    return overlayWindow;
  }

  overlayWindow = new BrowserWindow({
    width: 320,
    height: 460,
    minWidth: 220,
    minHeight: 220,
    title: 'Game Time Splitter - Overlay',
    icon: getAppIconPath(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.once('ready-to-show', () => overlayWindow?.show());
  overlayWindow.on('closed', () => {
    overlayWindow = undefined;
    overlayClickThrough = false;
    sendState('Overlay fechada.');
  });
  void overlayWindow.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'overlay.html'));
  return overlayWindow;
};

/**
 * Janela dedicada ao espectador. Separada da overlay do runner de propósito: ela não tem timer,
 * splits nem painel de finalização, e o tema dela vive em outro arquivo local.
 */
const createViewerOverlayWindow = (): BrowserWindow => {
  if (viewerOverlayWindow && !viewerOverlayWindow.isDestroyed()) {
    viewerOverlayWindow.show();
    viewerOverlayWindow.focus();
    return viewerOverlayWindow;
  }

  viewerOverlayWindow = new BrowserWindow({
    width: 420,
    height: 96,
    minWidth: 200,
    minHeight: 64,
    title: 'Game Time Splitter - Viewer Overlay',
    icon: getAppIconPath(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  viewerOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  viewerOverlayWindow.setMenuBarVisibility(false);
  viewerOverlayWindow.once('ready-to-show', () => viewerOverlayWindow?.show());
  viewerOverlayWindow.on('closed', () => {
    viewerOverlayWindow = undefined;
    sendState('Overlay de espectador fechada.');
  });
  void viewerOverlayWindow.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'viewer-overlay.html'));
  return viewerOverlayWindow;
};

const closeViewerOverlayWindow = (): void => {
  if (viewerOverlayWindow && !viewerOverlayWindow.isDestroyed()) viewerOverlayWindow.close();
};

/**
 * Aplica o papel da sessão às duas sincronizações de corrida. Como só existe um poll de cada
 * lado, sair do papel `viewer` (logout ou troca de conta) também fecha a overlay de espectador.
 */
const applySessionRole = (): void => {
  const viewer = isViewerSession();
  raceSync?.setParticipantMode(!viewer);
  viewerRaceSync?.setActive(viewer);
  if (!viewer) closeViewerOverlayWindow();
};

const requireViewerSession = (): ViewerRaceSync => {
  if (!isViewerSession() || !viewerRaceSync) {
    throw new Error('Esta ação está disponível apenas para contas espectadoras.');
  }
  return viewerRaceSync;
};

const normalizeRaceId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new Error('Identificador da sala de corrida inválido.');
  }
  return value;
};

const timerPreventsFileSwap = (): boolean =>
  timerState.available && (timerState.phase === 'running' || timerState.phase === 'paused' || timerState.phase === 'ended');

const cloudFileAlreadyLoaded = (fileId: string): boolean =>
  Boolean(selectedFile && selectedFile.toLocaleLowerCase().includes(`-${fileId.toLocaleLowerCase()}.lss`));

const loadCloudFileIntoTimer = async (rawId: string) => {
  const session = api.getSession();
  if (!session) throw new Error('Faça login para baixar um arquivo .lss da nuvem.');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(rawId)) {
    throw new Error('Identificador do arquivo .lss inválido.');
  }

  const cloudFile = await api.getLssFile(rawId);
  const content = await api.downloadLssFile(rawId);
  if (api.getSession()?.user.id !== session.user.id) {
    throw new Error('A conta ativa mudou durante o download do arquivo .lss.');
  }
  const filePath = await cloudLssStore.save(session.user.id, cloudFile, content);
  const parsed = await parseLssFile(filePath);
  await executeTimerCommand('load', { path: filePath });
  await adoptSelectedFile(filePath);
  await store.savePreferences(filePath, cloudFile.gameId);
  await scheduleAutomaticMonitoring('arquivo da nuvem carregado');
  sendEvent({
    type: 'file-read',
    message: `Arquivo “${cloudFile.originalName}” baixado da nuvem e carregado no timer.`,
    data: { filePath, parsed, cloudFile },
  });
  sendState('Arquivo .lss da nuvem carregado no timer nativo.');
  return { filePath, parsed, cloudFile };
};

const registerIpcHandlers = (): void => {
  ipcMain.handle('app:get-state', () => getState());

  ipcMain.handle('auth:login', async (_event, request: LoginRequest) => {
    try {
      const offlinePendingCount = await queue.getOfflinePendingCount();
      progressQueueOwnerId = undefined;
      const session = await api.login(request.identifier, request.password);
      offlineMode = false;
      await queue.loadForUser(session.user.id);
      await switchOverlayThemeOwner(session.user.id);
      if (
        api.getSession()?.user.id !== session.user.id ||
        overlayThemeOwnerId !== session.user.id
      ) {
        throw new Error('A sessão mudou antes de concluir o carregamento do tema.');
      }
      overlayThemeSync.handleSessionChange(true);
      // Antes do handleSessionChange do participante: uma conta viewer não deve chegar a
      // consultar /races/active nem uma vez.
      applySessionRole();
      raceSync?.handleSessionChange(true);
      await store.saveSession(session, request.remember);
      await store.savePreferences(selectedFile, store.getSelectedGameId());

      let offlineImportedCount = 0;
      let offlineSyncConfirmed = false;
      if (offlinePendingCount > 0) {
        const options = {
          type: 'question' as const,
          title: 'Sincronizar dados salvos offline',
          message: `${offlinePendingCount} registro(s) do timer foram salvos enquanto você estava offline.`,
          detail: 'Deseja associar esses dados à conta atual e tentar enviá-los para a nuvem agora?',
          buttons: ['Sincronizar agora', 'Manter offline'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        };
        const confirmation = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        if (confirmation.response === 0) {
          offlineImportedCount = await queue.adoptOfflineEntries();
          offlineSyncConfirmed = true;
          if (activeAttempt?.ownerId === OFFLINE_QUEUE_OWNER_ID) {
            activeAttempt.ownerId = session.user.id;
          }
        }
      }

      markProgressQueueReady(session.user.id);
      await scheduleAutomaticMonitoring('login concluído');
      sendState(`Login realizado como ${session.user.username}; sincronização automática ativa.`);
      void queue.flush();
      return {
        success: true,
        user: session.user,
        offlinePendingCount,
        offlineImportedCount,
        offlineSyncConfirmed,
      };
    } catch (error) {
      const authenticatedSession = api.getSession();
      if (authenticatedSession) {
        offlineMode = false;
        await queue.loadForUser(authenticatedSession.user.id);
        markProgressQueueReady(authenticatedSession.user.id);
        await scheduleAutomaticMonitoring('sessão restaurada após login');
        const warning = `Login concluído, mas uma etapa local falhou: ${error instanceof Error ? error.message : String(error)}`;
        sendState(warning);
        return {
          success: true,
          user: authenticatedSession.user,
          offlinePendingCount: await queue.getOfflinePendingCount(),
          offlineImportedCount: 0,
          offlineSyncConfirmed: false,
          warning,
        };
      }
      await queue.loadOffline();
      markProgressQueueReady(OFFLINE_QUEUE_OWNER_ID);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Não foi possível realizar o login.',
      };
    }
  });

  ipcMain.handle('auth:continue-offline', async () => {
    if (api.getSession()) return getState();
    await queue.loadOffline();
    markProgressQueueReady(OFFLINE_QUEUE_OWNER_ID);
    offlineMode = true;
    sendState('Modo offline ativado. Os splits serão salvos neste computador.');
    return getState();
  });

  ipcMain.handle('auth:logout', async () => {
    const hadSession = Boolean(api.getSession());
    if (hadSession) {
      stopAutomaticMonitoring();
      raceSync?.handleSessionChange(false);
      viewerRaceSync?.setActive(false);
      closeViewerOverlayWindow();
      await timerProgressChain;
      await api.logout();
      await queue.loadOffline();
      markProgressQueueReady(OFFLINE_QUEUE_OWNER_ID);
      await store.clearSession();
    }
    offlineMode = false;
    sendState(hadSession ? 'Sessão encerrada.' : 'Tela de login aberta; dados offline preservados.');
  });

  ipcMain.handle('games:list', () => api.getGames());

  ipcMain.handle('games:select', async (_event, rawGameId: unknown) => {
    const session = api.getSession();
    if (!session) throw new Error('Faça login para associar um jogo à sincronização.');
    if (typeof rawGameId !== 'string') throw new Error('Identificador do jogo inválido.');
    const gameId = rawGameId.trim();
    if (!gameId) {
      await store.savePreferences(selectedFile, undefined);
      await scheduleAutomaticMonitoring('jogo removido');
      sendState('Selecione um jogo para completar a sincronização automática.');
      return getState();
    }

    const game = (await api.getGames()).find((candidate) => candidate.id === gameId);
    if (!game) throw new Error('O jogo selecionado não está disponível no servidor.');
    await store.savePreferences(selectedFile, game.id);
    if (activeAttempt?.ownerId === session.user.id) activeAttempt.gameId = game.id;
    if (!timerPreventsFileSwap()) {
      try {
        const files = await api.getLssFiles();
        const primary = files.find((file) => file.gameId === game.id && file.isPrimary)
          ?? files.find((file) => file.gameId === game.id);
        if (primary && !cloudFileAlreadyLoaded(primary.id)) {
          await loadCloudFileIntoTimer(primary.id);
        }
      } catch (error) {
        sendEvent({
          type: 'error',
          message: `Não foi possível carregar o .lss principal da overlay: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    await scheduleAutomaticMonitoring('jogo associado');
    sendState(`Sincronização automática associada a ${game.name} — ${game.category}.`);
    return getState();
  });

  ipcMain.handle('lss:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Selecione uma run do LiveSplit',
      properties: ['openFile'],
      filters: [{ name: 'LiveSplit Run', extensions: ['lss'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const filePath = result.filePaths[0];
    const parsed = await parseLssFile(filePath);
    await executeTimerCommand('load', { path: filePath });
    await adoptSelectedFile(filePath);
    await resolveTimerGameId(timerState);
    await scheduleAutomaticMonitoring('arquivo local selecionado');
    sendEvent({
      type: 'file-read',
      message: `${parsed.attempts.length} tentativa(s) encontrada(s).`,
      data: { filePath, parsed },
    });
    sendState('Arquivo .lss carregado no timer nativo.');
    return { filePath, parsed };
  });

  ipcMain.handle('lss:list-cloud', async () => {
    if (!api.getSession()) throw new Error('Faça login para acessar arquivos .lss da nuvem.');
    return api.getLssFiles();
  });

  ipcMain.handle('lss:load-cloud', async (_event, rawId: unknown) => {
    const session = api.getSession();
    if (!session) throw new Error('Faça login para baixar um arquivo .lss da nuvem.');
    if (typeof rawId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(rawId)) {
      throw new Error('Identificador do arquivo .lss inválido.');
    }
    return loadCloudFileIntoTimer(rawId);
  });

  ipcMain.handle('lss:start-monitoring', async (_event, request: MonitorRequest) => {
    if (!api.getSession()) throw new Error('Faça login antes de associar a sincronização.');
    if (timerState.sourcePath !== request.filePath) {
      await executeTimerCommand('load', { path: request.filePath });
    }
    selectedFile = request.filePath;
    await store.savePreferences(request.filePath, request.gameId);
    await scheduleAutomaticMonitoring('preferências atualizadas');
    return parseLssFile(request.filePath);
  });

  ipcMain.handle('lss:stop-monitoring', async () => {
    await scheduleAutomaticMonitoring('sincronização permanente');
    sendState('A sincronização automática permanece ativa.');
  });

  ipcMain.handle('sync:now', async () => {
    await queue.flush();
    return queue.getStatus();
  });

  ipcMain.on('network:online', () => {
    sendEvent({ type: 'sync', message: 'Conexão restabelecida; sincronização automática da fila iniciada.' });
    void scheduleAutomaticMonitoring('conexão restabelecida');
    void queue.flush();
    // Voltou a rede: não espera o próximo ciclo para retomar a atualização.
    void appUpdater.checkNow();
  });

  ipcMain.handle('overlay:open', () => {
    createOverlayWindow();
    sendState('Overlay aberta.');
    return true;
  });
  ipcMain.handle('overlay:close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    return true;
  });
  ipcMain.handle('overlay:toggle', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
      return false;
    }
    createOverlayWindow();
    sendState('Overlay aberta.');
    return true;
  });
  ipcMain.handle('overlay:is-open', () => Boolean(overlayWindow && !overlayWindow.isDestroyed()));
  ipcMain.handle('overlay:theme-edit-start', (_event, draftId: unknown) =>
    beginOverlayThemeDraft(draftId));
  ipcMain.handle('overlay:theme-edit-end', (_event, draftId: unknown) =>
    endOverlayThemeDraft(draftId));
  ipcMain.handle('overlay:get-theme', () => overlayThemeStore.get());
  ipcMain.handle('overlay:update-theme', async (
    _event,
    request: { partial?: Partial<OverlayTheme>; draftId?: unknown } | null
  ) => {
    const theme = await overlayThemeStore.update(
      request?.partial ?? {},
      resolveThemeMutationOwner(request?.draftId)
    );
    broadcastTheme(theme);
    overlayThemeSync.queueUpload(theme);
    return theme;
  });
  ipcMain.handle('overlay:reset-theme', async (
    _event,
    request: { draftId?: unknown } | null
  ) => {
    const theme = await overlayThemeStore.reset(resolveThemeMutationOwner(request?.draftId));
    broadcastTheme(theme);
    overlayThemeSync.queueUpload(theme);
    return theme;
  });
  ipcMain.handle('overlay:apply-preset', async (
    _event,
    request: { name?: unknown; draftId?: unknown } | null
  ) => {
    const presetName = typeof request?.name === 'string' ? request.name : '';
    const current = overlayThemeStore.get();
    const preset = overlayThemePresets[presetName] ?? defaultOverlayTheme;
    const theme = await overlayThemeStore.replace(
      applyOverlayThemePreset(preset, current),
      resolveThemeMutationOwner(request?.draftId)
    );
    broadcastTheme(theme);
    overlayThemeSync.queueUpload(theme);
    return theme;
  });
  ipcMain.handle('overlay:list-presets', () => Object.keys(overlayThemePresets));
  ipcMain.handle('viewer:get-rooms', () => viewerRaceSync?.getRooms() ?? []);
  ipcMain.handle('viewer:refresh-rooms', async () => {
    const sync = requireViewerSession();
    await sync.refresh();
    return sync.getRooms();
  });
  ipcMain.handle('viewer:watch', async (_event, rawRaceId: unknown) => {
    const sync = requireViewerSession();
    const raceId = normalizeRaceId(rawRaceId);
    await sync.watch(raceId);
    createViewerOverlayWindow();
    sendState('Assistindo à corrida selecionada.');
    return getState();
  });
  ipcMain.handle('viewer:stop-watch', () => {
    requireViewerSession().stopWatching();
    sendState('Você parou de assistir à corrida.');
    return getState();
  });
  ipcMain.handle('viewer:get-overlay-state', () => viewerRaceSync?.getOverlayState() ?? null);
  ipcMain.handle('viewer:overlay-open', () => {
    requireViewerSession();
    createViewerOverlayWindow();
    sendState('Overlay de espectador aberta.');
    return true;
  });
  ipcMain.handle('viewer:overlay-close', () => {
    closeViewerOverlayWindow();
    return true;
  });
  ipcMain.handle('viewer:overlay-toggle', () => {
    if (viewerOverlayWindow && !viewerOverlayWindow.isDestroyed()) {
      closeViewerOverlayWindow();
      return false;
    }
    requireViewerSession();
    createViewerOverlayWindow();
    sendState('Overlay de espectador aberta.');
    return true;
  });
  ipcMain.handle('viewer:get-theme', () => viewerOverlayThemeStore.get());
  ipcMain.handle('viewer:update-theme', async (_event, partial: Partial<ViewerOverlayTheme> | null) => {
    const theme = await viewerOverlayThemeStore.update(partial ?? {});
    broadcastViewerTheme(theme);
    return theme;
  });
  ipcMain.handle('viewer:reset-theme', async () => {
    const theme = await viewerOverlayThemeStore.reset();
    broadcastViewerTheme(theme);
    return theme;
  });
  ipcMain.handle('update:get-status', () => appUpdater.getStatus());
  ipcMain.handle('update:check', () => appUpdater.checkNow());
  ipcMain.handle('update:install', () => {
    if (!appUpdater.requestInstall()) return false;
    // Encerramento normal: salva a run pendente e desliga o sidecar antes do instalador.
    app.quit();
    return true;
  });
  ipcMain.handle('overlay:set-drag-controls-visible', (event, visible: boolean) => {
    const window = overlayWindow;
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;

    const nextVisible = Boolean(visible);
    const [minWidth, currentMinHeight] = window.getMinimumSize();
    const currentlyVisible = currentMinHeight === 220;
    if (nextVisible === currentlyVisible) return nextVisible;

    const bounds = window.getBounds();
    if (nextVisible) {
      window.setBounds({ ...bounds, height: bounds.height + 22 });
      window.setMinimumSize(minWidth, 220);
    } else {
      window.setMinimumSize(minWidth, 198);
      window.setBounds({ ...bounds, height: Math.max(198, bounds.height - 22) });
    }
    return nextVisible;
  });
  ipcMain.handle('overlay:click-through', (_event, enabled: boolean) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    overlayClickThrough = Boolean(enabled);
    overlayWindow.setIgnoreMouseEvents(overlayClickThrough, { forward: true });
    const message = overlayClickThrough
      ? 'A overlay está ignorando cliques. Use “Restaurar cliques da overlay” na janela principal para reativá-los.'
      : 'Os cliques da overlay foram restaurados.';
    sendEvent({
      type: 'overlay-click-through',
      message,
      data: { enabled: overlayClickThrough },
    });
    sendState(message);
    return overlayClickThrough;
  });
  ipcMain.handle('overlay:always-on-top', (_event, enabled: boolean) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    overlayWindow.setAlwaysOnTop(Boolean(enabled), enabled ? 'screen-saver' : 'normal');
    return Boolean(enabled);
  });

  registerTimerIpcHandlers();
};

const initializeSidecar = async (): Promise<void> => {
  try {
    await timerSidecar.start();
    sidecarReady = true;
  } catch (error) {
    sidecarReady = false;
    sendEvent({
      type: 'error',
      message: `Não foi possível iniciar o timer nativo: ${error instanceof Error ? error.message : String(error)}`,
    });
    sendState('O aplicativo iniciou sem o motor de timer nativo.');
    return;
  }

  if (selectedFile) {
    try {
      timerState = await timerSidecar.command('load', { path: selectedFile });
    } catch (error) {
      timerState = unavailableTimerState();
      sendEvent({
        type: 'error',
        message: `O timer está pronto, mas o .lss anterior não pôde ser restaurado: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  try {
    timerState = await timerSidecar.command('autosplitConfigure', store.getAutosplitConfig());
  } catch (error) {
    sendEvent({
      type: 'error',
      message: `Não foi possível restaurar o autosplit: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  sendState('Motor de timer nativo pronto.');
};

const initialize = async (): Promise<void> => {
  store = new SessionStore();
  cloudLssStore = new CloudLssStore();
  await store.load();
  selectedFile = store.getSelectedFile();
  const restoredSession = store.restoreSession();
  overlayThemeStore = new OverlayThemeStore();
  await switchOverlayThemeOwner(restoredSession?.user.id);
  viewerOverlayThemeStore = new ViewerOverlayThemeStore();
  await viewerOverlayThemeStore.load();

  api = new ApiClient((session, reason) => {
    if (session) {
      if (overlayThemeOwnerId !== session.user.id) {
        overlayThemeDrafts.clear();
        overlayThemeSync?.handleSessionChange(false);
      }
      void store.updateSession(session);
      applySessionRole();
    } else {
      offlineMode = true;
      progressQueueOwnerId = undefined;
      if (activeAttempt) activeAttempt.ownerId = OFFLINE_QUEUE_OWNER_ID;
      stopAutomaticMonitoring();
      overlayThemeSync?.handleSessionChange(false);
      // Sem sessão viva não existe corrida: o campo da overlay desaparece.
      raceSync?.handleSessionChange(false);
      applySessionRole();
      // Perder a sessão não pode mudar o visual da overlay no meio de uma live:
      // o tema da conta continua aplicado e só o logout explícito volta ao padrão.
      if (reason === 'logout') void switchOverlayThemeOwner(undefined, 'default');
      void store.clearSession();
      if (queue) {
        void queue.loadOffline().then(() => {
          markProgressQueueReady(OFFLINE_QUEUE_OWNER_ID);
          if (monitor) sendState('A sessão terminou; o timer continua disponível no modo offline.');
        }).catch((error: unknown) => sendEvent({
          type: 'error',
          message: `A fila offline não pôde ser carregada: ${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    }
    if (session && monitor) sendState('Sessão renovada.');
  });

  raceSync = new RaceSync(api, {
    onRaceState: (race) => broadcastRaceState(race),
    onStatus: (message, isError) => sendEvent({
      type: isError ? 'error' : 'sync',
      message,
      data: { scope: 'race', isError },
    }),
    getTimerState: () => timerState,
  });

  viewerRaceSync = new ViewerRaceSync(api, {
    // Eventos próprios em vez de sendState: a lista muda a cada poll e inundaria a atividade.
    onRooms: (rooms) => broadcastViewerRooms(rooms),
    onOverlayState: (viewerState) => broadcastViewerOverlayState(viewerState),
    onStatus: (message, isError) => sendEvent({
      type: isError ? 'error' : 'sync',
      message,
      data: { scope: 'viewer', isError },
    }),
  });

  overlayThemeSync = new OverlayThemeSync(api, overlayThemeStore, {
    onRemoteTheme: (theme) => broadcastTheme(theme),
    onStatus: (message, isError) => sendEvent({
      type: isError ? 'error' : 'sync',
      message,
      data: { scope: 'layout', isError },
    }),
  });

  if (restoredSession) api.setSession(restoredSession);

  queue = new SyncQueue(api, (status) => {
    queueStatus = status;
    sendEvent({
      type: status.lastError ? 'error' : 'sync',
      message: status.lastError || `${status.pending} run(s) aguardando sincronização.`,
      data: status,
    });
  });
  if (restoredSession) {
    await queue.loadForUser(restoredSession.user.id);
    markProgressQueueReady(restoredSession.user.id);
  } else {
    await queue.loadOffline();
    markProgressQueueReady(OFFLINE_QUEUE_OWNER_ID);
  }

  monitor = new LssMonitor(
    async (filePath, parsed, runs) => {
      const added = await queue.enqueue(runs);
      sendEvent({
        type: 'file-read',
        message: `LiveSplit atualizado: ${added} nova(s) tentativa(s) adicionada(s) à fila.`,
        data: { filePath, parsed },
      });
      await queue.flush();
    },
    (error) => sendEvent({ type: 'error', message: `Monitor do LiveSplit: ${error.message}` })
  );

  timerSidecar = new TimerSidecar({
    onReady: (details) => {
      sidecarReady = true;
      sendEvent({ type: 'sidecar', message: 'Sidecar Rust conectado.', data: details });
      sendState('Motor de timer nativo conectado.');
    },
    onState: (state) => publishTimerState(state),
    onLog: (message, isError) => sendEvent({
      type: 'sidecar',
      message: `${isError ? 'Sidecar: ' : ''}${message}`,
      data: { isError },
    }),
    onExit: (error) => {
      sidecarReady = false;
      publishTimerState(unavailableTimerState(), 'Motor de timer indisponível.');
      if (error) sendEvent({ type: 'error', message: error.message });
      sendState(error ? 'O sidecar foi encerrado inesperadamente.' : 'Motor de timer encerrado.');
    },
  });

  registerIpcHandlers();
  createWindow();
  appUpdater.start();
  overlayThemeSync.handleSessionChange(Boolean(restoredSession));
  overlayThemeSync.start();
  // Antes de ligar o poll de participante: uma sessão de viewer restaurada não deve chegar a
  // consultar /races/active nenhuma vez.
  applySessionRole();
  raceSync.handleSessionChange(Boolean(restoredSession));
  raceSync.start();
  await initializeSidecar();
  await scheduleAutomaticMonitoring('preferências restauradas');
  void queue.flush();

  const syncTimer = setInterval(() => {
    void scheduleAutomaticMonitoring('verificação periódica');
    void queue.flush();
  }, 30_000);
  syncTimer.unref();
};

const cancelShutdown = (): void => {
  shutdownInProgress = false;
  appUpdater.cancelInstall();
  if (BrowserWindow.getAllWindows().length === 0 && api) createWindow();
};

const saveUnsavedTimerBeforeQuit = async (): Promise<boolean> => {
  if (!timerState.available || timerState.sourcePath) return true;

  const options = {
    type: 'warning' as const,
    title: 'Run ainda não salva',
    message: 'A run atual ainda não foi salva em um arquivo .lss.',
    detail: 'Salve antes de sair para não perder a tentativa e os segmentos.',
    buttons: ['Salvar .lss', 'Descartar', 'Cancelar'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const choice = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (choice.response === 2) return false;
  if (choice.response === 1) return true;

  const saveOptions = {
    title: 'Salvar run LiveSplit',
    defaultPath: `${timerState.gameName || 'run'}-${timerState.categoryName || 'categoria'}`
      .replace(/[<>:"/\\|?*]+/g, '-') + '.lss',
    filters: [{ name: 'LiveSplit Run', extensions: ['lss'] }],
  };
  const saveResult = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (saveResult.canceled || !saveResult.filePath) return false;

  try {
    const state = await executeTimerCommand('save', { path: saveResult.filePath });
    if (state.sourcePath) await adoptSelectedFile(state.sourcePath);
    return true;
  } catch (error) {
    dialog.showErrorBox(
      'Não foi possível salvar a run',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
};

const reconcileMonitoredFile = async (): Promise<void> => {
  if (!monitor?.isMonitoring() || !selectedFile) return;
  const gameId = store.getSelectedGameId();
  if (!gameId) return;
  const parsed = await parseLssFile(selectedFile);
  await queue.enqueue(parsed.attempts.map((attempt) => ({
    ...attempt,
    gameId,
    gameName: parsed.gameName,
    categoryName: parsed.categoryName,
  })));
};

const prepareShutdown = async (): Promise<void> => {
  if (!await saveUnsavedTimerBeforeQuit()) {
    cancelShutdown();
    return;
  }

  try {
    await timerProgressChain;
  } catch (error) {
    sendEvent({
      type: 'error',
      message: `A persistência final dos splits falhou: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    await reconcileMonitoredFile();
  } catch (error) {
    sendEvent({
      type: 'error',
      message: `A reconciliação final do .lss falhou: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  overlayThemeSync?.stop();
  raceSync?.stop();
  viewerRaceSync?.stop();
  monitor?.stop();
  await timerSidecar?.shutdown();
  appUpdater.stop();
  quitAllowed = true;
  // Com a run salva e o sidecar encerrado é seguro subir o instalador, que fecha o app.
  if (appUpdater.installIfRequested()) return;
  app.quit();
};

if (process.platform === 'win32') {
  app.setAppUserModelId('com.gametimespliter.desktop');
}

app.whenReady().then(initialize).catch((error: unknown) => {
  dialog.showErrorBox('Falha ao iniciar', error instanceof Error ? error.message : 'Erro desconhecido.');
  quitAllowed = true;
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitAllowed) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  void prepareShutdown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && api) createWindow();
});
