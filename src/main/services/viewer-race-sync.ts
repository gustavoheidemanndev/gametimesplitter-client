import type {
  RaceRoomSummaryResponse,
  RaceSpectatorStateResponse,
  ViewerOverlayState,
  ViewerRoomView,
} from '../../shared/types';
import { ApiClient } from './api-client';

/** Mesma cadência das corridas em andamento no client de runner. */
const VIEWER_POLL_INTERVAL_MS = 2_000;

interface ViewerRaceSyncCallbacks {
  onRooms: (rooms: ViewerRoomView[]) => void;
  onOverlayState: (state: ViewerOverlayState | null) => void;
  onStatus: (message: string, isError: boolean) => void;
}

const toViewerRoom = (room: RaceRoomSummaryResponse): ViewerRoomView => {
  const participants = Array.isArray(room.participants) ? room.participants : [];
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    gameName: room.game?.name ?? '',
    gameCategory: room.game?.category ?? '',
    hostUsername: room.host?.username ?? '',
    participantUsernames: participants.map((participant) => participant.username),
    participantCount: Number.isFinite(room.participantCount)
      ? room.participantCount
      : participants.length,
    maxParticipants: room.maxParticipants,
    canWatch: room.status === 'running',
  };
};

/**
 * Lista as salas vivas e acompanha a sala assistida para o papel `viewer`.
 *
 * Espelha a estrutura de `RaceSync` (poll + geração de sessão + uma requisição em voo por vez),
 * mas nunca escreve nada: viewer não cria sala, não dá ready e não reporta splits. Uma sala
 * assistida por vez, como definido na v1 da feature.
 */
export class ViewerRaceSync {
  private pollTimer?: NodeJS.Timeout;
  private active = false;
  private rooms: ViewerRoomView[] = [];
  private watchingRaceId?: string;
  private overlay: ViewerOverlayState | null = null;
  private publishedRoomsSignature?: string;
  private publishedOverlaySignature?: string;
  private sessionGeneration = 0;
  private inFlight?: Promise<void>;
  private lastError?: string;

  constructor(
    private readonly api: ApiClient,
    private readonly callbacks: ViewerRaceSyncCallbacks
  ) {}

  /**
   * Liga ou desliga o modo espectador. Chamado no boot, no login e no logout: sair do papel
   * `viewer` derruba o poll e limpa a sala assistida.
   */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.sessionGeneration += 1;
    this.rooms = [];
    this.watchingRaceId = undefined;
    this.overlay = null;
    this.lastError = undefined;
    this.publishRooms();
    this.publishOverlay();
    if (active) {
      this.startPolling();
      void this.refresh();
    } else {
      this.stopPolling();
    }
  }

  stop(): void {
    this.stopPolling();
    this.sessionGeneration += 1;
  }

  isActive(): boolean {
    return this.active;
  }

  getRooms(): ViewerRoomView[] {
    return this.rooms;
  }

  getWatchingRaceId(): string | null {
    return this.watchingRaceId ?? null;
  }

  getOverlayState(): ViewerOverlayState | null {
    return this.overlay;
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pull().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Assistir a uma sala substitui a anterior: a v1 não acompanha duas corridas em paralelo. */
  async watch(raceId: string): Promise<ViewerOverlayState | null> {
    if (!this.active) throw new Error('O modo espectador não está ativo.');
    const session = this.api.getSession();
    if (!session) throw new Error('Faça login para assistir a uma corrida.');

    const generation = this.sessionGeneration;
    const state = await this.api.getSpectatorRace(raceId);
    if (!this.isCurrent(generation)) return this.overlay;
    if (state.status !== 'running') {
      throw new Error(
        state.status === 'open' || state.status === 'armed'
          ? 'A corrida ainda não começou.'
          : 'A corrida não está mais em andamento.'
      );
    }

    this.watchingRaceId = raceId;
    this.applySpectatorState(state);
    this.clearError();
    return this.overlay;
  }

  stopWatching(): void {
    if (!this.watchingRaceId) return;
    this.watchingRaceId = undefined;
    this.overlay = null;
    this.publishOverlay();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), VIEWER_POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.sessionGeneration === generation && Boolean(this.api.getSession());
  }

  private async pull(): Promise<void> {
    if (!this.active) return;
    if (!this.api.getSession()) {
      this.rooms = [];
      this.publishRooms();
      return;
    }
    const generation = this.sessionGeneration;

    try {
      const overview = await this.api.getRaces();
      if (!this.isCurrent(generation)) return;
      this.rooms = (Array.isArray(overview?.rooms) ? overview.rooms : []).map(toViewerRoom);
      this.publishRooms();

      const watchingRaceId = this.watchingRaceId;
      if (!watchingRaceId) {
        this.clearError();
        return;
      }

      // A sala assistida some da lista quando termina ou é abandonada: nesse caso não há o que
      // buscar, o campo volta para o traço e a lista já refletiu a ausência do botão Watch.
      const room = this.rooms.find((candidate) => candidate.id === watchingRaceId);
      if (!room || room.status !== 'running') {
        this.stopWatching();
        this.report('A corrida assistida foi encerrada.', false);
        return;
      }

      const state = await this.api.getSpectatorRace(watchingRaceId);
      if (!this.isCurrent(generation) || this.watchingRaceId !== watchingRaceId) return;
      this.applySpectatorState(state);
      this.clearError();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.report(this.describe(error), true);
    }
  }

  private applySpectatorState(state: RaceSpectatorStateResponse): void {
    if (state.status !== 'running') {
      this.stopWatching();
      return;
    }
    this.overlay = {
      raceId: state.id,
      status: state.status,
      leaderUsername: state.spectator?.leaderUsername ?? null,
      deltaMs: state.spectator?.deltaMs ?? null,
      commonSplitOrder: state.spectator?.commonSplitOrder ?? 0,
    };
    this.publishOverlay();
  }

  private publishRooms(): void {
    const signature = JSON.stringify(this.rooms);
    if (signature === this.publishedRoomsSignature) return;
    this.publishedRoomsSignature = signature;
    this.callbacks.onRooms(this.rooms);
  }

  private publishOverlay(): void {
    const signature = JSON.stringify(this.overlay);
    if (signature === this.publishedOverlaySignature) return;
    this.publishedOverlaySignature = signature;
    this.callbacks.onOverlayState(this.overlay);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'Falha desconhecida ao carregar as salas.';
  }

  private report(message: string, isError: boolean): void {
    if (isError && message === this.lastError) return;
    this.lastError = isError ? message : undefined;
    this.callbacks.onStatus(message, isError);
  }

  private clearError(): void {
    this.lastError = undefined;
  }
}
