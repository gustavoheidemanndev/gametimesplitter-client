import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Game, QueueStatus, RunPayload, RunProgressPayload } from '../../shared/types';
import { ApiClient, ApiError } from './api-client';

type FailureReason = 'game-unavailable';

class QueueResolutionError extends Error {
  readonly reason: FailureReason = 'game-unavailable';
}

interface FailedEntry {
  run: RunPayload;
  error: string;
  failedAt: string;
  status?: number;
  reason?: FailureReason;
}

interface FailedProgressEntry {
  progress: RunProgressPayload;
  error: string;
  failedAt: string;
  status?: number;
  reason?: FailureReason;
}

interface PersistedQueue {
  entries: RunPayload[];
  progressEntries: RunProgressPayload[];
  synchronizedIds: string[];
  synchronizedProgressIds: string[];
  failedEntries: FailedEntry[];
  failedProgressEntries: FailedProgressEntry[];
  lastError?: string;
}

const emptyQueue = (): PersistedQueue => ({
  entries: [],
  progressEntries: [],
  synchronizedIds: [],
  synchronizedProgressIds: [],
  failedEntries: [],
  failedProgressEntries: [],
});

const progressId = (progress: RunProgressPayload): string => {
  const lastSplit = progress.splitTimes.at(-1);
  return [
    progress.clientAttemptId,
    progress.revision,
    progress.phase,
    lastSplit?.order ?? 0,
    lastSplit?.cumulativeTime ?? 0,
  ].join(':');
};

const MAX_SYNCHRONIZED_IDS = 5_000;
const GAME_FAILURE_RETRY_INTERVAL_MS = 60_000;
export const OFFLINE_QUEUE_OWNER_ID = 'offline';

export class SyncQueue {
  private state: PersistedQueue = emptyQueue();
  private activeOwnerId?: string;
  private filePath?: string;
  private flushing = false;
  private generation = 0;
  private persistSequence = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private offlineOperationChain: Promise<void> = Promise.resolve();
  private activeLoad?: { ownerId: string; promise: Promise<void> };

  constructor(
    private readonly api: ApiClient,
    private readonly onStatus: (status: QueueStatus) => void
  ) {}

  loadForUser(userId: string): Promise<void> {
    if (!userId.trim()) throw new Error('Não é possível carregar uma fila sem usuário.');
    return this.loadForOwner(userId);
  }

  loadOffline(): Promise<void> {
    return this.loadForOwner(OFFLINE_QUEUE_OWNER_ID);
  }

  async getOfflinePendingCount(): Promise<number> {
    if (this.activeOwnerId === OFFLINE_QUEUE_OWNER_ID) {
      return this.transferableCount(this.state);
    }
    return this.transferableCount(await this.readState(this.filePathForOwner(OFFLINE_QUEUE_OWNER_ID)));
  }

  async adoptOfflineEntries(): Promise<number> {
    const sessionUserId = this.api.getSession()?.user.id;
    if (!sessionUserId || this.activeOwnerId !== sessionUserId || !this.filePath) {
      throw new Error('Faça login antes de sincronizar os dados salvos offline.');
    }

    return this.runOfflineOperation(async () => {
      const generation = this.generation;
      const state = this.state;
      const userFilePath = this.filePath!;
      const offlineFilePath = this.filePathForOwner(OFFLINE_QUEUE_OWNER_ID);
      await this.persistChain.catch(() => undefined);
      const offlineState = await this.readState(offlineFilePath);
      const offlineRuns = [
        ...offlineState.entries,
        ...offlineState.failedEntries.map((entry) => entry.run),
      ];
      const offlineProgressSnapshots = [
        ...offlineState.progressEntries,
        ...offlineState.failedProgressEntries.map((entry) => entry.progress),
      ];
      const latestOfflineProgress = new Map<string, RunProgressPayload>();
      offlineProgressSnapshots.forEach((progress) => {
        const current = latestOfflineProgress.get(progress.clientAttemptId);
        if (!current || progress.revision > current.revision) {
          latestOfflineProgress.set(progress.clientAttemptId, progress);
        }
      });
      const offlineProgress = [...latestOfflineProgress.values()];

      const knownRuns = new Set([
        ...state.synchronizedIds,
        ...state.entries.map((entry) => entry.clientRunId),
        ...state.failedEntries.map((entry) => entry.run.clientRunId),
      ]);
      const knownProgress = new Set([
        ...state.synchronizedProgressIds,
        ...state.progressEntries.map(progressId),
        ...state.failedProgressEntries.map((entry) => progressId(entry.progress)),
      ]);
      const runAdditions = offlineRuns.filter((run) => !knownRuns.has(run.clientRunId));
      const progressAdditions = offlineProgress.filter((progress) => !knownProgress.has(progressId(progress)));

      state.entries.push(...runAdditions);
      state.progressEntries.push(...progressAdditions);
      await this.persistSnapshot(state, userFilePath);
      if (!this.isCurrent(generation, state, userFilePath, sessionUserId)) {
        throw new Error('A conta ativa mudou durante a importação dos dados offline.');
      }

      // A fila autenticada é persistida primeiro. Em caso de interrupção, uma repetição é segura
      // porque clientRunId e progressId eliminam duplicatas antes de limpar a origem offline.
      await this.persistSnapshot(emptyQueue(), offlineFilePath);
      this.emitStatus();
      return runAdditions.length + progressAdditions.length;
    });
  }

  deactivate(): void {
    this.generation += 1;
    this.activeOwnerId = undefined;
    this.filePath = undefined;
    this.state = emptyQueue();
    this.emitStatus();
  }

  getStatus(): QueueStatus {
    return this.statusFor(this.state);
  }

  async enqueue(runs: RunPayload[]): Promise<number> {
    this.assertActiveQueue();
    const generation = this.generation;
    const state = this.state;
    const filePath = this.filePath!;
    const incomingById = new Map(runs.map((run) => [run.clientRunId, run]));
    const recovered: RunPayload[] = [];
    state.failedEntries = state.failedEntries.filter((entry) => {
      const replacement = incomingById.get(entry.run.clientRunId);
      if (!replacement || !this.isGameUnavailableFailure(entry)) return true;
      const metadataChanged = replacement.gameId !== entry.run.gameId ||
        replacement.gameName !== entry.run.gameName ||
        replacement.categoryName !== entry.run.categoryName;
      const retryDue = Date.parse(entry.failedAt) + GAME_FAILURE_RETRY_INTERVAL_MS <= Date.now();
      if (!metadataChanged && !retryDue) return true;
      recovered.push({ ...entry.run, ...replacement });
      return false;
    });

    const known = new Set([
      ...state.synchronizedIds,
      ...state.entries.map((entry) => entry.clientRunId),
      ...state.failedEntries.map((entry) => entry.run.clientRunId),
    ]);
    const additions = [...recovered, ...runs].filter((run, index, candidates) =>
      !known.has(run.clientRunId) &&
      candidates.findIndex((candidate) => candidate.clientRunId === run.clientRunId) === index
    );
    state.entries.push(...additions);
    if (additions.length > 0) {
      delete state.lastError;
      await this.persistSnapshot(state, filePath);
      if (this.isCurrent(generation, state, filePath)) this.emitStatus();
    }
    return additions.length;
  }

  async enqueueProgress(progress: RunProgressPayload): Promise<boolean> {
    this.assertActiveQueue();
    const generation = this.generation;
    const state = this.state;
    const filePath = this.filePath!;
    const id = progressId(progress);
    const known = new Set([
      ...state.synchronizedProgressIds,
      ...state.progressEntries.map(progressId),
      ...state.failedProgressEntries.map((entry) => progressId(entry.progress)),
    ]);
    if (known.has(id)) return false;
    const newerSnapshotExists = [
      ...state.progressEntries.filter((entry) => entry.clientAttemptId === progress.clientAttemptId),
      ...state.failedProgressEntries
        .map((entry) => entry.progress)
        .filter((entry) => entry.clientAttemptId === progress.clientAttemptId),
    ].some((entry) => entry.revision >= progress.revision);
    if (newerSnapshotExists) return false;

    state.progressEntries = state.progressEntries.filter((entry) =>
      entry.clientAttemptId !== progress.clientAttemptId
    );
    state.failedProgressEntries = state.failedProgressEntries.filter((entry) =>
      entry.progress.clientAttemptId !== progress.clientAttemptId
    );
    state.progressEntries.push(progress);
    delete state.lastError;
    await this.persistSnapshot(state, filePath);
    if (this.isCurrent(generation, state, filePath)) this.emitStatus();
    return true;
  }

  async enqueueOfflineProgress(progress: RunProgressPayload): Promise<boolean> {
    if (this.activeOwnerId === OFFLINE_QUEUE_OWNER_ID) {
      return this.enqueueProgress(progress);
    }

    return this.runOfflineOperation(async () => {
      await this.persistChain.catch(() => undefined);
      const offlineFilePath = this.filePathForOwner(OFFLINE_QUEUE_OWNER_ID);
      const offlineState = await this.readState(offlineFilePath);
      const id = progressId(progress);
      const known = new Set([
        ...offlineState.synchronizedProgressIds,
        ...offlineState.progressEntries.map(progressId),
        ...offlineState.failedProgressEntries.map((entry) => progressId(entry.progress)),
      ]);
      if (known.has(id)) return false;
      const newerSnapshotExists = [
        ...offlineState.progressEntries.filter((entry) =>
          entry.clientAttemptId === progress.clientAttemptId
        ),
        ...offlineState.failedProgressEntries
          .map((entry) => entry.progress)
          .filter((entry) => entry.clientAttemptId === progress.clientAttemptId),
      ].some((entry) => entry.revision >= progress.revision);
      if (newerSnapshotExists) return false;

      offlineState.progressEntries = offlineState.progressEntries.filter((entry) =>
        entry.clientAttemptId !== progress.clientAttemptId
      );
      offlineState.failedProgressEntries = offlineState.failedProgressEntries.filter((entry) =>
        entry.progress.clientAttemptId !== progress.clientAttemptId
      );
      offlineState.progressEntries.push(progress);
      delete offlineState.lastError;
      await this.persistSnapshot(offlineState, offlineFilePath);
      return true;
    });
  }

  async flush(): Promise<void> {
    const session = this.api.getSession();
    if (this.flushing || !session || session.user.id !== this.activeOwnerId || !this.filePath) return;

    const generation = this.generation;
    const ownerId = this.activeOwnerId;
    const state = this.state;
    const filePath = this.filePath;
    let activeGames: Game[] | undefined;
    const rejectedGameIds = new Set<string>();
    const getAvailableGames = async (): Promise<Game[]> => {
      activeGames ??= await this.api.getGames();
      return activeGames.filter((game) => !rejectedGameIds.has(game.id));
    };

    this.flushing = true;
    try {
      while (state.progressEntries.length > 0 && this.isCurrent(generation, state, filePath, ownerId)) {
        const next = state.progressEntries[0];
        try {
          await this.resolveProgressGame(next, await getAvailableGames(), state, filePath);
          await this.api.syncRunProgress(next);
          if (!this.isCurrent(generation, state, filePath, ownerId)) break;
          state.progressEntries.shift();
          this.recordSynchronized(state.synchronizedProgressIds, progressId(next));
          if (state.failedEntries.length === 0 && state.failedProgressEntries.length === 0) {
            delete state.lastError;
          }
        } catch (error) {
          if (!this.isCurrent(generation, state, filePath, ownerId)) break;
          const message = error instanceof Error ? error.message : 'Falha desconhecida ao sincronizar progresso.';
          if (this.isGameUnavailableError(error) && next.gameId) rejectedGameIds.add(next.gameId);
          if (this.isPermanentFailure(error)) {
            state.progressEntries.shift();
            state.failedProgressEntries.push({
              progress: next,
              error: message,
              failedAt: new Date().toISOString(),
              ...this.failureDetails(error),
            });
            state.lastError = `Um split foi rejeitado pelo servidor: ${message}`;
          } else {
            state.lastError = message;
            await this.persistSnapshot(state, filePath);
            if (this.isCurrent(generation, state, filePath, ownerId)) this.emitStatus();
            return;
          }
        }
        await this.persistSnapshot(state, filePath);
      }

      while (state.entries.length > 0 && this.isCurrent(generation, state, filePath, ownerId)) {
        const next = state.entries[0];
        try {
          await this.resolveRunGame(next, await getAvailableGames(), state, filePath);
          await this.api.createRun(next);
          if (!this.isCurrent(generation, state, filePath, ownerId)) break;
          state.entries.shift();
          this.recordSynchronized(state.synchronizedIds, next.clientRunId);
          if (state.failedEntries.length === 0 && state.failedProgressEntries.length === 0) {
            delete state.lastError;
          }
        } catch (error) {
          if (!this.isCurrent(generation, state, filePath, ownerId)) break;
          const message = error instanceof Error ? error.message : 'Falha desconhecida ao sincronizar.';
          if (this.isGameUnavailableError(error)) rejectedGameIds.add(next.gameId);
          if (this.isPermanentFailure(error)) {
            state.entries.shift();
            state.failedEntries.push({
              run: next,
              error: message,
              failedAt: new Date().toISOString(),
              ...this.failureDetails(error),
            });
            state.lastError = `Uma run foi rejeitada pelo servidor: ${message}`;
          } else {
            state.lastError = message;
            await this.persistSnapshot(state, filePath);
            if (this.isCurrent(generation, state, filePath, ownerId)) this.emitStatus();
            return;
          }
        }
        await this.persistSnapshot(state, filePath);
      }

      if (this.isCurrent(generation, state, filePath, ownerId)) this.emitStatus();
    } finally {
      this.flushing = false;
      const currentSession = this.api.getSession();
      if (generation !== this.generation && currentSession?.user.id === this.activeOwnerId) {
        void this.flush();
      }
    }
  }

  private loadForOwner(ownerId: string): Promise<void> {
    if (this.activeOwnerId === ownerId) {
      return this.activeLoad?.ownerId === ownerId
        ? this.activeLoad.promise
        : Promise.resolve();
    }

    const generation = ++this.generation;
    const filePath = this.filePathForOwner(ownerId);
    this.activeOwnerId = ownerId;
    this.filePath = filePath;
    this.state = emptyQueue();

    const readOperation = ownerId === OFFLINE_QUEUE_OWNER_ID
      ? this.runOfflineOperation(() => this.readState(filePath))
      : this.readState(filePath);
    const promise = readOperation.then((loadedState) => {
      if (generation !== this.generation) return;
      this.state = loadedState;
      this.emitStatus();
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.activeOwnerId = undefined;
        this.filePath = undefined;
        this.state = emptyQueue();
        this.emitStatus();
      }
      throw error;
    }).finally(() => {
      if (this.activeLoad?.promise === promise) this.activeLoad = undefined;
    });
    this.activeLoad = { ownerId, promise };
    return promise;
  }

  private async readState(filePath: string): Promise<PersistedQueue> {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<PersistedQueue>;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        progressEntries: Array.isArray(parsed.progressEntries) ? parsed.progressEntries : [],
        synchronizedIds: Array.isArray(parsed.synchronizedIds) ? parsed.synchronizedIds : [],
        synchronizedProgressIds: Array.isArray(parsed.synchronizedProgressIds)
          ? parsed.synchronizedProgressIds : [],
        failedEntries: Array.isArray(parsed.failedEntries) ? parsed.failedEntries : [],
        failedProgressEntries: Array.isArray(parsed.failedProgressEntries)
          ? parsed.failedProgressEntries : [],
        ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyQueue();
      throw new Error(
        `Não foi possível ler a fila local ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private filePathForOwner(ownerId: string): string {
    const safeOwnerId = ownerId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(app.getPath('userData'), `sync-queue-${safeOwnerId}.json`);
  }

  private transferableCount(state: PersistedQueue): number {
    return state.entries.length + state.progressEntries.length +
      state.failedEntries.length + state.failedProgressEntries.length;
  }

  private async resolveProgressGame(
    progress: RunProgressPayload,
    games: Game[],
    state: PersistedQueue,
    filePath: string
  ): Promise<void> {
    const gameId = this.resolveGameId(
      progress.gameId,
      progress.gameName,
      progress.categoryName,
      games
    );
    if (progress.gameId === gameId) return;
    progress.gameId = gameId;
    await this.persistSnapshot(state, filePath);
  }

  private async resolveRunGame(
    run: RunPayload,
    games: Game[],
    state: PersistedQueue,
    filePath: string
  ): Promise<void> {
    const gameId = this.resolveGameId(run.gameId, run.gameName, run.categoryName, games);
    if (run.gameId === gameId) return;
    run.gameId = gameId;
    await this.persistSnapshot(state, filePath);
  }

  private resolveGameId(
    currentGameId: string | undefined,
    gameName: string | undefined,
    categoryName: string | undefined,
    games: Game[]
  ): string {
    if (gameName && categoryName) {
      const matches = games.filter((game) =>
        game.name.localeCompare(gameName, undefined, { sensitivity: 'accent' }) === 0 &&
        game.category.localeCompare(categoryName, undefined, { sensitivity: 'accent' }) === 0
      );
      const currentMatch = matches.find((game) => game.id === currentGameId);
      if (currentMatch) return currentMatch.id;
      if (matches.length === 1) return matches[0].id;
      if (matches.length > 1) {
        throw new QueueResolutionError(
          `Há mais de um jogo ativo compatível com “${gameName} — ${categoryName}”.`
        );
      }
      throw new QueueResolutionError(
        `O jogo “${gameName} — ${categoryName}” não foi encontrado ou está inativo no servidor.`
      );
    }

    if (currentGameId && games.some((game) => game.id === currentGameId)) return currentGameId;
    throw new QueueResolutionError(
      'O jogo associado à run não foi encontrado ou está inativo no servidor.'
    );
  }

  private recordSynchronized(ids: string[], id: string): void {
    ids.push(id);
    if (ids.length > MAX_SYNCHRONIZED_IDS) {
      ids.splice(0, ids.length - MAX_SYNCHRONIZED_IDS);
    }
  }

  private assertActiveQueue(): void {
    if (!this.activeOwnerId || !this.filePath) {
      throw new Error('A fila local ainda não está pronta.');
    }
  }

  private isCurrent(
    generation: number,
    state: PersistedQueue,
    filePath: string,
    ownerId = this.activeOwnerId
  ): boolean {
    return generation === this.generation &&
      state === this.state &&
      filePath === this.filePath &&
      ownerId === this.activeOwnerId;
  }

  private isGameUnavailableError(error: unknown): boolean {
    return error instanceof QueueResolutionError ||
      (error instanceof ApiError &&
        error.status === 404 &&
        error.message === 'Jogo não encontrado ou inativo.');
  }

  private isGameUnavailableFailure(entry: FailedEntry | FailedProgressEntry): boolean {
    return entry.reason === 'game-unavailable' ||
      entry.error === 'Jogo não encontrado ou inativo.';
  }

  private failureDetails(error: unknown): Pick<FailedEntry, 'status' | 'reason'> {
    return {
      ...(error instanceof ApiError ? { status: error.status } : {}),
      ...(this.isGameUnavailableError(error) ? { reason: 'game-unavailable' as const } : {}),
    };
  }

  private isPermanentFailure(error: unknown): boolean {
    if (error instanceof QueueResolutionError) return true;
    return error instanceof ApiError &&
      error.status >= 400 && error.status < 500 &&
      ![401, 408, 429].includes(error.status);
  }

  private emitStatus(): void {
    this.onStatus(this.getStatus());
  }

  private statusFor(state: PersistedQueue): QueueStatus {
    return {
      pending: state.entries.length + state.progressEntries.length,
      synchronized: state.synchronizedIds.length + state.synchronizedProgressIds.length,
      failed: state.failedEntries.length + state.failedProgressEntries.length,
      lastError: state.lastError,
    };
  }

  private runOfflineOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.offlineOperationChain.catch(() => undefined).then(operation);
    this.offlineOperationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private persistSnapshot(state: PersistedQueue, filePath: string): Promise<void> {
    const serialized = JSON.stringify(state, null, 2);
    const sequence = this.persistSequence++;
    const operation = this.persistChain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${sequence}.tmp`;
      await writeFile(temporaryPath, serialized, 'utf8');
      await rename(temporaryPath, filePath);
    });
    this.persistChain = operation;
    return operation;
  }
}
