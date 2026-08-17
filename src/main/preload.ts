import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopEvent, LoginRequest, MonitorRequest } from '../shared/types';
import type {
  FinishTimerRequest,
  ResetTimerRequest,
} from '../shared/timer-protocol';

contextBridge.exposeInMainWorld('gameTimeSpliter', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  login: (request: LoginRequest) => ipcRenderer.invoke('auth:login', request),
  continueOffline: () => ipcRenderer.invoke('auth:continue-offline'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  listGames: () => ipcRenderer.invoke('games:list'),
  selectGame: (gameId: string) => ipcRenderer.invoke('games:select', gameId),
  selectLss: () => ipcRenderer.invoke('lss:select'),
  listCloudLss: () => ipcRenderer.invoke('lss:list-cloud'),
  loadCloudLss: (id: string) => ipcRenderer.invoke('lss:load-cloud', id),
  startMonitoring: (request: MonitorRequest) => ipcRenderer.invoke('lss:start-monitoring', request),
  stopMonitoring: () => ipcRenderer.invoke('lss:stop-monitoring'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  notifyOnline: () => ipcRenderer.send('network:online'),
  loadTimer: (filePath: string) => ipcRenderer.invoke('timer:load', filePath),
  startTimer: () => ipcRenderer.invoke('timer:start'),
  splitTimer: () => ipcRenderer.invoke('timer:split'),
  pauseTimer: () => ipcRenderer.invoke('timer:pause'),
  resetTimer: (request: ResetTimerRequest = {}) => ipcRenderer.invoke('timer:reset', request),
  undoTimer: () => ipcRenderer.invoke('timer:undo'),
  skipTimer: () => ipcRenderer.invoke('timer:skip'),
  finishTimer: (request: FinishTimerRequest) => ipcRenderer.invoke('timer:finish', request),
  getTimerState: () => ipcRenderer.invoke('timer:state'),
  setAutosplitStartOnlyOnNewGame: (startOnlyOnNewGame: boolean) =>
    ipcRenderer.invoke('timer:autosplit-configure', { startOnlyOnNewGame }),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  openOverlay: () => ipcRenderer.invoke('overlay:open'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  isOverlayOpen: () => ipcRenderer.invoke('overlay:is-open'),
  setOverlayClickThrough: (enabled: boolean) => ipcRenderer.invoke('overlay:click-through', enabled),
  setOverlayDragControlsVisible: (visible: boolean) =>
    ipcRenderer.invoke('overlay:set-drag-controls-visible', visible),
  setOverlayAlwaysOnTop: (enabled: boolean) => ipcRenderer.invoke('overlay:always-on-top', enabled),
  beginOverlayThemeEdit: (draftId: string) => ipcRenderer.invoke('overlay:theme-edit-start', draftId),
  endOverlayThemeEdit: (draftId: string) => ipcRenderer.invoke('overlay:theme-edit-end', draftId),
  getOverlayTheme: () => ipcRenderer.invoke('overlay:get-theme'),
  updateOverlayTheme: (partial: Record<string, unknown>, draftId: string) =>
    ipcRenderer.invoke('overlay:update-theme', { partial, draftId }),
  resetOverlayTheme: (draftId: string) => ipcRenderer.invoke('overlay:reset-theme', { draftId }),
  applyOverlayPreset: (name: string, draftId: string) =>
    ipcRenderer.invoke('overlay:apply-preset', { name, draftId }),
  listOverlayPresets: () => ipcRenderer.invoke('overlay:list-presets'),
  listViewerRooms: () => ipcRenderer.invoke('viewer:get-rooms'),
  refreshViewerRooms: () => ipcRenderer.invoke('viewer:refresh-rooms'),
  watchViewerRace: (raceId: string) => ipcRenderer.invoke('viewer:watch', raceId),
  stopWatchingViewerRace: () => ipcRenderer.invoke('viewer:stop-watch'),
  getViewerOverlayState: () => ipcRenderer.invoke('viewer:get-overlay-state'),
  openViewerOverlay: () => ipcRenderer.invoke('viewer:overlay-open'),
  closeViewerOverlay: () => ipcRenderer.invoke('viewer:overlay-close'),
  toggleViewerOverlay: () => ipcRenderer.invoke('viewer:overlay-toggle'),
  getViewerOverlayTheme: () => ipcRenderer.invoke('viewer:get-theme'),
  updateViewerOverlayTheme: (partial: Record<string, unknown>) =>
    ipcRenderer.invoke('viewer:update-theme', partial),
  resetViewerOverlayTheme: () => ipcRenderer.invoke('viewer:reset-theme'),
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onEvent: (listener: (event: DesktopEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on('desktop:event', wrapped);
    return () => ipcRenderer.removeListener('desktop:event', wrapped);
  },
});
