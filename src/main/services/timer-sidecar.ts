import { app } from 'electron';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline, { type Interface as ReadLineInterface } from 'node:readline';
import { DEFAULT_AUTOSPLIT_CONFIG } from '../../shared/timer-protocol';
import type {
  SidecarEvent,
  SidecarResponse,
  TimerCommand,
  TimerState,
} from '../../shared/timer-protocol';

interface PendingRequest {
  resolve: (state: TimerState) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface TimerSidecarHandlers {
  onReady: (details: unknown) => void;
  onState: (state: TimerState) => void;
  onLog: (message: string, isError: boolean) => void;
  onExit: (error?: Error) => void;
}

const REQUEST_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;

export const unavailableTimerState = (): TimerState => ({
  available: false,
  phase: 'notRunning',
  currentTimeMs: 0,
  gameTimeMs: null,
  currentSplitIndex: null,
  currentSegmentName: null,
  gameName: '',
  categoryName: '',
  attemptCount: 0,
  comparison: 'Personal Best',
  sourcePath: null,
  segments: [],
  autosplit: {
    ...DEFAULT_AUTOSPLIT_CONFIG,
    status: 'error',
    message: 'Modo automático temporariamente indisponível.',
    processName: 'bio4.exe',
    processId: null,
    detectedVersion: null,
    currentRoom: null,
    loading: false,
    money: null,
    chapterKills: null,
    igtMs: null,
    pauseBuffers: null,
  },
});

export class TimerSidecar {
  private child?: ChildProcessWithoutNullStreams;
  private output?: ReadLineInterface;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private ready = false;
  private shuttingDown = false;
  private startPromise?: Promise<void>;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private startTimeout?: NodeJS.Timeout;
  private state = unavailableTimerState();

  constructor(
    private readonly handlers: TimerSidecarHandlers,
    private readonly executableOverride?: string
  ) {}

  isReady(): boolean {
    return this.ready;
  }

  getState(): TimerState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.launch();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = undefined;
      throw error;
    }
  }

  async command(command: Exclude<TimerCommand, 'shutdown'>, payload?: unknown): Promise<TimerState> {
    await this.start();
    return this.sendRequest(command, payload);
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    this.shuttingDown = true;
    const child = this.child;

    try {
      if (this.ready) await this.sendRequest('shutdown');
    } catch (error) {
      this.handlers.onLog(
        `O sidecar não confirmou o encerramento: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }

    if (this.child === child) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        child.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    if (this.child === child && !child.killed) child.kill();
  }

  private async launch(): Promise<void> {
    const executable = this.resolveExecutable();
    if (!existsSync(executable)) {
      throw new Error(`Executável do timer não encontrado em: ${executable}. Execute npm run build:sidecar.`);
    }

    this.shuttingDown = false;
    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.output = readline.createInterface({ input: child.stdout });
    this.output.on('line', (line) => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) this.handlers.onLog(message, true);
    });
    child.once('error', (error) => this.handleProcessError(error));
    child.once('close', (code, signal) => this.handleClose(child, code, signal));

    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      this.startTimeout = setTimeout(() => {
        const error = new Error('O sidecar não ficou pronto dentro do tempo esperado.');
        this.rejectStart?.(error);
        this.clearStartWaiter();
        if (this.child === child) child.kill();
      }, START_TIMEOUT_MS);
    });
  }

  private resolveExecutable(): string {
    if (this.executableOverride) return path.resolve(this.executableOverride);
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'native', 'gametimespliter-sidecar.exe');
    }
    return path.join(
      app.getAppPath(),
      'native',
      'livesplit-sidecar',
      'target',
      'release',
      'gametimespliter-sidecar.exe'
    );
  }

  private sendRequest(command: TimerCommand, payload?: unknown): Promise<TimerState> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error('O motor de timer não está disponível.'));
    }

    const id = this.nextRequestId++;
    return new Promise<TimerState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`O comando ${command} excedeu o tempo limite.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });

      child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    let message: SidecarResponse<TimerState> | SidecarEvent;
    try {
      message = JSON.parse(line) as SidecarResponse<TimerState> | SidecarEvent;
    } catch {
      this.handlers.onLog(`Saída inválida do sidecar: ${line}`, true);
      return;
    }

    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (!message.ok || !message.result) {
        pending.reject(new Error(message.error || 'O sidecar recusou o comando.'));
        return;
      }
      this.updateState(message.result);
      pending.resolve(message.result);
      return;
    }

    if (message.event === 'ready') {
      this.ready = true;
      this.resolveStart?.();
      this.clearStartWaiter();
      this.handlers.onReady(message.data);
      return;
    }
    if (message.event === 'state') {
      this.updateState(message.data as TimerState);
      return;
    }
    this.handlers.onLog(String(message.data), false);
  }

  private updateState(state: TimerState): void {
    this.state = state;
    this.handlers.onState(state);
  }

  private handleProcessError(error: Error): void {
    this.rejectStart?.(error);
    this.clearStartWaiter();
    this.handlers.onLog(`Falha no processo do sidecar: ${error.message}`, true);
  }

  private handleClose(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child !== child) return;
    const wasShuttingDown = this.shuttingDown;
    this.output?.close();
    this.output = undefined;
    this.child = undefined;
    this.ready = false;
    this.startPromise = undefined;
    this.state = unavailableTimerState();

    const error = wasShuttingDown
      ? undefined
      : new Error(`O sidecar foi encerrado inesperadamente (código ${code ?? 'n/a'}, sinal ${signal ?? 'n/a'}).`);
    this.rejectStart?.(error || new Error('O sidecar foi encerrado antes de ficar pronto.'));
    this.clearStartWaiter();
    this.rejectPending(error || new Error('O sidecar foi encerrado.'));
    this.handlers.onExit(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearStartWaiter(): void {
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.startTimeout = undefined;
    this.resolveStart = undefined;
    this.rejectStart = undefined;
  }
}
