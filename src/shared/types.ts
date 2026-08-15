import type { OverlayTheme } from './overlay-theme';

export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
}

export interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface ActiveOverlayLayout {
  id: string | null;
  layoutName: string;
  contractVersion: 1;
  theme: OverlayTheme;
  revision: string | null;
  updatedAt: string | null;
}

export interface Game {
  id: string;
  name: string;
  category: string;
  platform: string;
}

export interface CloudLssFileSegment {
  id: string;
  name: string;
  order: number;
  personalBestTime: number | null;
  bestSegmentTime: number | null;
}

export interface CloudLssFile {
  id: string;
  gameId: string;
  originalName: string;
  sha256: string;
  size: number;
  gameName: string;
  categoryName: string;
  platform: string;
  attemptCount: number;
  personalBestTime: number | null;
  isPrimary?: boolean;
  createdAt: string;
  updatedAt: string;
  segments: CloudLssFileSegment[];
}

export type RunStatus = 'completed' | 'reset' | 'dnf';

export interface RunSplitPayload {
  name: string;
  order: number;
  splitTime: number;
  cumulativeTime: number;
}

export interface RunPayload {
  clientRunId: string;
  gameId: string;
  gameName?: string;
  categoryName?: string;
  configName: string;
  configSplits: string[];
  totalTime: number;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  splitTimes: RunSplitPayload[];
}

export type RunProgressPhase = 'running' | 'ended' | 'reset';

export interface RunProgressPayload {
  clientAttemptId: string;
  revision: number;
  gameId?: string;
  gameName: string;
  categoryName: string;
  configName: string;
  configSplits: string[];
  startedAt: string;
  phase: RunProgressPhase;
  elapsedTime: number;
  splitTimes: RunSplitPayload[];
}

export type RaceRoomStatus = 'open' | 'armed' | 'running' | 'finished' | 'abandoned';

export type RaceParticipantStatus =
  | 'joined'
  | 'ready'
  | 'running'
  | 'finished'
  | 'surrendered'
  | 'abandoned';

export interface RaceParticipantView {
  participantId: string;
  userId: string;
  username: string;
  status: RaceParticipantStatus;
  clientConnected: boolean;
  /** O client reportou segmentos, mas eles não correspondem aos da sala. */
  clientSegmentMismatch: boolean;
  isReady: boolean;
  completedSplits: number;
  finalTime: number | null;
}

/** Resposta de GET /races/active, GET /races/:id e das mutações de corrida. */
export interface RaceStateResponse {
  id: string;
  name: string | null;
  status: RaceRoomStatus;
  revision: number;
  game: { id: string; name: string; category: string };
  splitCount: number | null;
  configSplits: string[] | null;
  maxParticipants: number;
  me: RaceParticipantView;
  opponent: RaceParticipantView | null;
  commonSplitOrder: number;
  deltaMs: number | null;
  winnerId: string | null;
  isWinner: boolean | null;
  canClaimVictory: boolean;
  armedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  serverTime: string;
}

export interface RaceSplitPayload {
  order: number;
  splitTime: number;
  cumulativeTime: number;
}

/** Snapshot completo dos splits concluídos: uma requisição perdida se autocorrige na próxima. */
export interface ReportRaceSplitsPayload {
  clientAttemptId: string;
  revision: number;
  startedAt: string;
  phase: RunProgressPhase;
  splits: RaceSplitPayload[];
}

/**
 * Estado da corrida já reduzido para a perspectiva do jogador local. É o que o overlay
 * consome: o renderer não deve conter regra de negócio de corrida.
 */
export interface RaceOverlayState {
  raceId: string;
  status: RaceRoomStatus;
  opponentUsername: string | null;
  /** Negativo = o jogador local está na frente. null enquanto não houver split comum. */
  deltaMs: number | null;
  commonSplitOrder: number;
  splitCount: number | null;
  /** O timer foi resetado no meio da corrida e ela não pode mais ser concluída. */
  attemptInvalidated: boolean;
  isWinner: boolean | null;
}

export interface ParsedLss {
  gameName: string;
  categoryName: string;
  platform: string;
  segmentNames: string[];
  attempts: Omit<RunPayload, 'gameId'>[];
  warnings: string[];
}

export interface QueueStatus {
  pending: number;
  synchronized: number;
  failed: number;
  lastError?: string;
}

/**
 * `unsupported` é build de desenvolvimento (sem feed empacotado) e `unreachable` cobre
 * servidor fora do ar ou usuário offline. Atualizar é opcional: nenhuma fase bloqueia o app.
 */
export type AppUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'unreachable';

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  currentVersion: string;
  /** Versão publicada no servidor quando há atualização em andamento ou pronta. */
  targetVersion?: string;
  /** 0-100 durante o download. */
  percent?: number;
  lastCheckedAt?: string;
  /** Só falhas reais (checksum, disco, permissão). Indisponibilidade vira `unreachable`. */
  lastError?: string;
}

import type { AutosplitConfig, TimerState } from './timer-protocol';

export interface AppState {
  authenticated: boolean;
  offlineMode: boolean;
  user?: User;
  selectedFile?: string;
  selectedGameId?: string;
  monitoring: boolean;
  queue: QueueStatus;
  sidecarReady: boolean;
  timer: TimerState;
  /** Config persistida do autosplit. Separada de `timer.autosplit`, que volta aos padrões quando o
   * sidecar está indisponível. */
  autosplit: AutosplitConfig;
  overlayOpen: boolean;
  overlayClickThrough: boolean;
  /** A overlay pode ser aberta no meio de uma corrida, então o estado vem também no boot. */
  race: RaceOverlayState | null;
  update: AppUpdateStatus;
}

export interface MonitorRequest {
  filePath: string;
  gameId: string;
}

export interface LoginRequest {
  identifier: string;
  password: string;
  remember: boolean;
}

export interface DesktopEvent {
  type: 'state' | 'file-read' | 'sync' | 'error' | 'auth-expired' | 'timer-state' | 'sidecar' | 'overlay-theme' | 'overlay-click-through' | 'race-state' | 'update';
  message: string;
  data?: unknown;
}

export type { TimerState } from './timer-protocol';
