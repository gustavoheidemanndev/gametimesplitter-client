import { randomUUID } from 'node:crypto';
import type {
  RaceOverlayState,
  RaceSplitPayload,
  RaceStateResponse,
  ReportRaceSplitsPayload,
  RunSplitPayload,
} from '../../shared/types';
import type { TimerState } from '../../shared/timer-protocol';
import { ApiClient, ApiError } from './api-client';

/** Descoberta: fora de uma corrida o poll é raro, só para notar que uma sala foi armada. */
const IDLE_POLL_INTERVAL_MS = 15_000;
const LOBBY_POLL_INTERVAL_MS = 5_000;
const RUNNING_POLL_INTERVAL_MS = 2_000;

/**
 * Retry curto em memória, sem fila durável: um split de corrida entregue minutos depois é
 * inútil, e a sync-queue faria latest-revision-wins, descartando snapshots intermediários.
 */
const SPLIT_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

/** Status em que o campo da corrida deve aparecer na overlay. */
const VISIBLE_RACE_STATUSES = new Set(['armed', 'running', 'finished', 'abandoned']);

const LIVE_RACE_STATUSES = new Set(['armed', 'running']);

interface RaceSyncCallbacks {
  onRaceState: (state: RaceOverlayState | null) => void;
  onStatus: (message: string, isError: boolean) => void;
  getTimerState: () => TimerState;
}

interface RaceAttempt {
  clientAttemptId: string;
  revision: number;
  attemptCount: number;
  startedAt: string;
  reported: boolean;
}

/**
 * Snapshot aguardando entrega. Existe porque o payload é a lista completa de splits: se a API
 * está fora, guardar o último snapshot e reenviá-lo no próximo poll recupera a corrida sem
 * depender de um novo split acontecer — o que nunca aconteceria depois do split final.
 */
interface PendingRaceSplits {
  raceId: string;
  signature: string;
  payload: ReportRaceSplitsPayload;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const splitSignature = (splits: RaceSplitPayload[]): string =>
  splits.map((split) => `${split.order}:${split.cumulativeTime}`).join('|');

/**
 * Erro que não vai melhorar com retry. 401 fica de fora porque o ApiClient já renova o token
 * uma vez e, se o refresh falhar, a sessão é encerrada e o poll para sozinho.
 */
const isPermanentFailure = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![401, 408, 429].includes(error.status);

/**
 * Mantém o estado da corrida do usuário em sincronia por polling e reporta os splits do
 * attempt vinculado. Espelha a estrutura de OverlayThemeSync (poll + geração de sessão +
 * uma operação em voo por vez), mas não compartilha nada com o caminho de progresso da run:
 * `PUT /runs/progress` e a sync-queue continuam intocados.
 */
export class RaceSync {
  private pollTimer?: NodeJS.Timeout;
  private pollIntervalMs = IDLE_POLL_INTERVAL_MS;
  private race?: RaceStateResponse;
  private attempt?: RaceAttempt;
  /** Escopado por corrida: um 409 numa corrida não pode travar o reporte da próxima. */
  private invalidatedRaceId?: string;
  private pendingSplits?: PendingRaceSplits;
  private flushInFlight?: Promise<void>;
  /** Assinatura do último snapshot que a API confirmou, não do último que foi montado. */
  private deliveredSignature?: string;
  private checkedSegmentSignature?: string;
  private publishedSignature?: string;
  private settledRaceId?: string;
  private sessionGeneration = 0;
  private inFlight?: Promise<void>;
  private timerChain: Promise<void> = Promise.resolve();
  private lastError?: string;
  private participantMode = true;

  constructor(
    private readonly api: ApiClient,
    private readonly callbacks: RaceSyncCallbacks
  ) {}

  start(): void {
    if (this.pollTimer) return;
    this.schedulePoll(this.pollIntervalMs);
    void this.refresh();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.sessionGeneration += 1;
  }

  /**
   * O papel `viewer` não participa de corridas: desligar o modo participante para a conta zera
   * o poll de `/races/active` e o campo da corrida na overlay do runner.
   */
  setParticipantMode(enabled: boolean): void {
    if (this.participantMode === enabled) return;
    this.participantMode = enabled;
    this.handleSessionChange(enabled && Boolean(this.api.getSession()));
  }

  handleSessionChange(authenticated: boolean): void {
    this.sessionGeneration += 1;
    this.race = undefined;
    this.attempt = undefined;
    this.invalidatedRaceId = undefined;
    this.pendingSplits = undefined;
    this.deliveredSignature = undefined;
    this.checkedSegmentSignature = undefined;
    this.settledRaceId = undefined;
    this.lastError = undefined;
    this.publish();
    if (authenticated && this.participantMode) void this.refresh();
  }

  getOverlayState(): RaceOverlayState | null {
    return this.buildOverlayState();
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pull().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * Chamado de publishTimerState, ao lado de scheduleTimerProgress. Recebe os splits já
   * convertidos por completedSplitTimes para não duplicar essa conversão.
   */
  handleTimerState(previous: TimerState, state: TimerState, splits: RunSplitPayload[]): void {
    this.timerChain = this.timerChain
      .then(() => this.processTimerState(previous, state, splits))
      .catch((error: unknown) => this.report(this.describe(error), true));
  }

  private schedulePoll(intervalMs: number): void {
    this.pollIntervalMs = intervalMs;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.refresh(), intervalMs);
    this.pollTimer.unref();
  }

  private intervalForRace(race?: RaceStateResponse): number {
    if (!race) return IDLE_POLL_INTERVAL_MS;
    if (race.status === 'running') return RUNNING_POLL_INTERVAL_MS;
    return LIVE_RACE_STATUSES.has(race.status) ? LOBBY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
  }

  private sessionIsCurrent(generation: number, userId: string): boolean {
    return this.sessionGeneration === generation && this.api.getSession()?.user.id === userId;
  }

  private async pull(): Promise<void> {
    const session = this.api.getSession();
    if (!session || !this.participantMode) {
      this.applyRace(undefined);
      return;
    }
    const generation = this.sessionGeneration;
    const userId = session.user.id;

    try {
      const active = await this.api.getActiveRace();
      if (!this.sessionIsCurrent(generation, userId)) return;

      if (active) {
        this.settledRaceId = undefined;
        this.applyRace(active);
        await this.ensureClientCheck(active, generation, userId);
        // A API respondeu: se algum snapshot ficou pendente numa indisponibilidade, é aqui que
        // ele finalmente sai. Sem isso o delta do oponente congelaria no último split entregue.
        await this.flushPendingSplits();
        this.clearError();
        return;
      }

      // A corrida saiu de "ativa" porque terminou. Busca o resultado final uma única vez para
      // o campo da overlay congelar com o último delta e o vencedor, em vez de desaparecer.
      const previous = this.race;
      if (previous && this.settledRaceId !== previous.id) {
        const finalState = await this.api.getRace(previous.id);
        if (!this.sessionIsCurrent(generation, userId)) return;
        this.settledRaceId = previous.id;
        this.applyRace(finalState);
        this.attempt = undefined;
        this.deliveredSignature = undefined;
        this.checkedSegmentSignature = undefined;
      } else if (!previous) {
        this.applyRace(undefined);
      }
      this.clearError();
    } catch (error) {
      if (!this.sessionIsCurrent(generation, userId)) return;
      this.report(this.describe(error), true);
    }
  }

  /**
   * Publica automaticamente os segmentos do .lss carregado. É o que permite ao backend definir
   * a lista canônica da sala e recusar um oponente com segmentos diferentes antes da largada.
   */
  private async ensureClientCheck(
    race: RaceStateResponse,
    generation: number,
    userId: string
  ): Promise<void> {
    if (race.status !== 'open' && race.status !== 'armed') return;

    const timer = this.callbacks.getTimerState();
    if (!timer.available || timer.segments.length === 0) return;

    const segmentNames = timer.segments.map((segment) => segment.name);
    const signature = `${race.id}\u0000${segmentNames.join('\u0000')}`;
    if (this.checkedSegmentSignature === signature) return;

    try {
      const updated = await this.api.raceClientCheck(race.id, segmentNames);
      if (!this.sessionIsCurrent(generation, userId)) return;
      this.checkedSegmentSignature = signature;
      this.applyRace(updated);
    } catch (error) {
      if (!isPermanentFailure(error)) throw error;
      // Segmentos incompatíveis são acionáveis pelo usuário: marca a assinatura para não
      // reenviar em loop e mostra a mensagem do servidor.
      this.checkedSegmentSignature = signature;
      this.report(this.describe(error), true);
    }
  }

  private async processTimerState(
    previous: TimerState,
    state: TimerState,
    splits: RunSplitPayload[]
  ): Promise<void> {
    const race = this.race;
    if (!race || !this.participantMode) return;

    // Corrida encerrada: o campo fica congelado com o delta final até o jogador começar outra
    // run sozinho, quando ele sai da overlay para não virar sujeira permanente.
    if (!LIVE_RACE_STATUSES.has(race.status)) {
      const startedAnotherRun = state.available && state.phase === 'running' &&
        (previous.phase === 'notRunning' || previous.attemptCount !== state.attemptCount);
      if (startedAnotherRun) this.applyRace(undefined);
      return;
    }

    if (!state.available) return;
    if (!this.api.getSession()) return;

    const activePhase = state.phase === 'running' || state.phase === 'paused' || state.phase === 'ended';
    const startsNewAttempt = activePhase && (
      !this.attempt ||
      this.attempt.attemptCount !== state.attemptCount ||
      (previous.phase === 'ended' && state.phase === 'running')
    );

    if (startsNewAttempt) {
      // Um attempt novo depois de já ter reportado splits significa reset no meio da corrida.
      // O backend recusaria de qualquer forma; parar aqui evita retry inútil e deixa o estado
      // explícito para o overlay e para a web.
      if (this.attempt?.reported) {
        this.invalidatedRaceId = race.id;
        this.pendingSplits = undefined;
        this.publish();
        return;
      }
      this.attempt = {
        clientAttemptId: randomUUID(),
        revision: 0,
        attemptCount: state.attemptCount,
        startedAt: new Date(Date.now() - Math.max(0, Math.round(state.currentTimeMs))).toISOString(),
        reported: false,
      };
      this.deliveredSignature = undefined;
      this.pendingSplits = undefined;
    }

    if (!this.attempt || this.invalidatedRaceId === race.id) return;

    const racePhase = state.phase === 'ended' ? 'ended' : 'running';
    const raceSplits: RaceSplitPayload[] = splits.map((split) => ({
      order: split.order,
      splitTime: split.splitTime,
      cumulativeTime: split.cumulativeTime,
    }));

    const signature = `${racePhase}\u0000${splitSignature(raceSplits)}`;
    if (signature === this.deliveredSignature || signature === this.pendingSplits?.signature) return;
    if (raceSplits.length === 0) return;

    // A revisão é atribuída aqui e reaproveitada nas retentativas: o payload é um snapshot
    // completo, então reenviar a mesma revisão é idempotente no backend.
    this.attempt.revision += 1;
    this.pendingSplits = {
      raceId: race.id,
      signature,
      payload: {
        clientAttemptId: this.attempt.clientAttemptId,
        revision: this.attempt.revision,
        startedAt: this.attempt.startedAt,
        phase: racePhase,
        splits: raceSplits,
      },
    };
    await this.flushPendingSplits();
  }

  /** Uma entrega em voo por vez: o poll e o evento de timer chamam isso concorrentemente. */
  private flushPendingSplits(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = this.deliverPendingSplits().finally(() => {
      this.flushInFlight = undefined;
    });
    return this.flushInFlight;
  }

  private async deliverPendingSplits(): Promise<void> {
    const pending = this.pendingSplits;
    const session = this.api.getSession();
    if (!pending || !session) return;

    // A corrida precisa continuar viva e ser a mesma: um snapshot órfão só tomaria 409.
    if (
      this.invalidatedRaceId === pending.raceId ||
      this.race?.id !== pending.raceId ||
      !LIVE_RACE_STATUSES.has(this.race.status)
    ) {
      this.pendingSplits = undefined;
      return;
    }

    const generation = this.sessionGeneration;
    const userId = session.user.id;

    for (let retry = 0; retry <= SPLIT_RETRY_DELAYS_MS.length; retry += 1) {
      try {
        const updated = await this.api.reportRaceSplits(pending.raceId, pending.payload);
        if (!this.sessionIsCurrent(generation, userId)) return;
        if (this.pendingSplits === pending) {
          this.pendingSplits = undefined;
          this.deliveredSignature = pending.signature;
        }
        if (this.attempt?.clientAttemptId === pending.payload.clientAttemptId) {
          this.attempt.reported = true;
        }
        this.applyRace(updated);
        this.clearError();
        return;
      } catch (error) {
        if (!this.sessionIsCurrent(generation, userId)) return;
        // Um snapshot mais novo assumiu a fila: descartar esta tentativa evita regredir splits.
        if (this.pendingSplits !== pending) return;
        if (isPermanentFailure(error)) {
          // 409 aqui é terminal para o attempt (reset, tempo impossível ou largada anterior ao
          // armamento da sala) e vale só para esta corrida.
          if (error instanceof ApiError && error.status === 409) {
            this.invalidatedRaceId = pending.raceId;
          }
          this.pendingSplits = undefined;
          this.report(this.describe(error), true);
          this.publish();
          return;
        }
        const delay = SPLIT_RETRY_DELAYS_MS[retry];
        if (delay === undefined) {
          // Segue pendente de propósito: o próximo tick do poll reenvia quando a API voltar.
          this.report(this.describe(error), true);
          return;
        }
        await sleep(delay);
        if (!this.sessionIsCurrent(generation, userId)) return;
      }
    }
  }

  private applyRace(race?: RaceStateResponse): void {
    const previousRaceId = this.race?.id;
    this.race = race;
    // Sem corrida, ou de volta ao lobby, o attempt vinculado não vale mais nada.
    if (!race || !VISIBLE_RACE_STATUSES.has(race.status)) this.attempt = undefined;
    // Corrida encerrada ou trocada: um snapshot pendente não tem mais para onde ir.
    if (!race || race.id !== previousRaceId || !LIVE_RACE_STATUSES.has(race.status)) {
      this.pendingSplits = undefined;
    }
    const nextInterval = this.intervalForRace(race);
    if (this.pollTimer && nextInterval !== this.pollIntervalMs) this.schedulePoll(nextInterval);
    else this.pollIntervalMs = nextInterval;
    this.publish();
  }

  private buildOverlayState(): RaceOverlayState | null {
    const race = this.race;
    if (!race || !VISIBLE_RACE_STATUSES.has(race.status)) return null;
    return {
      raceId: race.id,
      status: race.status,
      opponentUsername: race.opponent?.username ?? null,
      deltaMs: race.deltaMs,
      commonSplitOrder: race.commonSplitOrder,
      splitCount: race.splitCount,
      attemptInvalidated: this.invalidatedRaceId === race.id,
      isWinner: race.isWinner,
    };
  }

  private publish(): void {
    const next = this.buildOverlayState();
    const signature = JSON.stringify(next);
    if (signature === this.publishedSignature) return;
    this.publishedSignature = signature;
    this.callbacks.onRaceState(next);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'Falha desconhecida na corrida.';
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
