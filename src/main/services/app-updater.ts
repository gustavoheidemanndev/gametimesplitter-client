import { app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { AppUpdateStatus } from '../../shared/types';

/** O boot já disputa CPU com o sidecar e a primeira sincronização; a atualização pode esperar. */
const INITIAL_CHECK_DELAY_MS = 15_000;
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/** Servidor fora do ar ou máquina offline: tenta de novo bem antes do ciclo normal. */
const RETRY_AFTER_UNREACHABLE_MS = 15 * 60 * 1_000;
/** O download emite progresso muitas vezes por segundo: só reporta de 5 em 5 pontos. */
const PROGRESS_REPORT_STEP = 5;

/** Erros de transporte: o servidor pode estar dormindo ou a máquina sem rede. */
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'ERR_SOCKET_TIMEOUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_RESET',
]);

const UNAVAILABLE_MESSAGE_PATTERN =
  /net::|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|getaddrinfo|Cannot find channel|Unable to find latest version|HttpError: [45]\d\d|status code [45]\d\d|timed? ?out/i;

const readProperty = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Servidor inalcançável, feed ainda não publicado (404) ou API reiniciando (5xx) não são
 * falhas do aplicativo: atualizar é opcional e a próxima checagem tenta de novo sozinha.
 */
const isFeedUnavailable = (error: unknown): boolean => {
  const code = readProperty(error, 'code');
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  const statusCode = readProperty(error, 'statusCode');
  if (typeof statusCode === 'number' && (statusCode === 404 || statusCode === 408 || statusCode >= 500)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return UNAVAILABLE_MESSAGE_PATTERN.test(message);
};

interface AppUpdaterCallbacks {
  /** `message` acompanha o padrão dos outros eventos do main; o renderer traduz pela fase. */
  onStatus: (status: AppUpdateStatus, message: string) => void;
}

/**
 * Auto-update sobre o feed genérico publicado em /downloads (ver publish no
 * electron-builder.yml). Baixa em segundo plano e instala no fechamento do app, então
 * uma run em andamento nunca é interrompida. Sem rede, apenas não atualiza.
 */
export class AppUpdater {
  private status: AppUpdateStatus;
  private initialTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private checking?: Promise<AppUpdateStatus>;
  private installRequested = false;
  private lastReportedPercent = -1;
  private lastEmitted = '';

  constructor(private readonly callbacks: AppUpdaterCallbacks) {
    this.status = {
      // Build de desenvolvimento não tem app-update.yml empacotado: nem tenta.
      phase: app.isPackaged ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
    };
  }

  start(): void {
    if (!app.isPackaged || this.pollTimer) return;

    autoUpdater.autoDownload = true;
    // A instalação real acontece no encerramento, depois de salvar a run e desligar o sidecar.
    autoUpdater.autoInstallOnAppQuit = true;
    this.registerListeners();

    this.initialTimer = setTimeout(() => void this.checkNow(), INITIAL_CHECK_DELAY_MS);
    this.initialTimer.unref();
    this.pollTimer = setInterval(() => void this.checkNow(), PERIODIC_CHECK_INTERVAL_MS);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.initialTimer = undefined;
    this.pollTimer = undefined;
    this.retryTimer = undefined;
  }

  getStatus(): AppUpdateStatus {
    return this.status;
  }

  checkNow(): Promise<AppUpdateStatus> {
    if (!app.isPackaged) return Promise.resolve(this.status);
    if (this.checking) return this.checking;
    // Download em andamento ou concluído: checar de novo só duplicaria o trabalho.
    if (['available', 'downloading', 'ready'].includes(this.status.phase)) {
      return Promise.resolve(this.status);
    }

    this.checking = autoUpdater.checkForUpdates()
      .then(() => this.status)
      .catch((error: unknown) => {
        // O listener de 'error' também recebe a falha; emit() ignora status repetido.
        this.reportFailure(error);
        return this.status;
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  /**
   * Marca a instalação para o encerramento em curso. Retorna false quando não há
   * atualização pronta, para o chamador não prometer algo que não vai acontecer.
   */
  requestInstall(): boolean {
    if (this.status.phase !== 'ready') return false;
    this.installRequested = true;
    return true;
  }

  /** O usuário cancelou o encerramento: a instalação volta a esperar o próximo fechamento. */
  cancelInstall(): void {
    if (!this.installRequested) return;
    this.installRequested = false;
    // Reemite o mesmo status para a UI reabilitar o botão de instalar.
    this.lastEmitted = '';
    this.emit('A instalação foi cancelada; a atualização continua pronta para o próximo fechamento.');
  }

  /**
   * Chamado no fim do desligamento, quando a run já está salva e o sidecar encerrado.
   * Retorna true se o instalador assumiu o encerramento do app.
   */
  installIfRequested(): boolean {
    if (!this.installRequested || this.status.phase !== 'ready') return false;
    this.installRequested = false;
    try {
      autoUpdater.quitAndInstall(true, true);
      return true;
    } catch {
      // Se o instalador não subir, o app segue o encerramento normal e tenta na próxima.
      return false;
    }
  }

  private registerListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      this.update({ phase: 'checking' }, 'Procurando atualizações do aplicativo.');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.lastReportedPercent = -1;
      this.update(
        { phase: 'available', targetVersion: info.version, percent: 0, lastError: undefined },
        `Atualização ${info.version} encontrada; baixando em segundo plano.`
      );
    });

    autoUpdater.on('update-not-available', () => {
      this.update(
        { phase: 'idle', targetVersion: undefined, percent: undefined, lastError: undefined },
        'O aplicativo já está na versão mais recente.'
      );
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      if (percent < 100 && percent - this.lastReportedPercent < PROGRESS_REPORT_STEP) return;
      this.lastReportedPercent = percent;
      this.update({ phase: 'downloading', percent }, `Baixando a atualização: ${percent}%.`);
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.update(
        { phase: 'ready', targetVersion: info.version, percent: 100, lastError: undefined },
        `Atualização ${info.version} pronta; será instalada ao fechar o aplicativo.`
      );
    });

    autoUpdater.on('error', (error: Error) => this.reportFailure(error));
  }

  /** Uma falha de rede interrompe o download; a retomada não pode esperar 6 horas. */
  private scheduleRetry(): void {
    if (this.retryTimer || !this.pollTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.checkNow();
    }, RETRY_AFTER_UNREACHABLE_MS);
    this.retryTimer.unref();
  }

  private reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (isFeedUnavailable(error)) {
      this.update(
        { phase: 'unreachable', lastError: undefined },
        'Não foi possível verificar atualizações agora; o aplicativo tentará de novo depois.'
      );
      this.scheduleRetry();
      return;
    }
    this.update(
      { phase: 'idle', lastError: message },
      `A atualização automática falhou: ${message}`
    );
  }

  private update(patch: Partial<AppUpdateStatus>, message: string): void {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: app.getVersion(),
      lastCheckedAt: new Date().toISOString(),
    };
    this.emit(message);
  }

  private emit(message: string): void {
    const { lastCheckedAt: _lastCheckedAt, ...comparable } = this.status;
    const signature = JSON.stringify(comparable);
    if (signature === this.lastEmitted) return;
    this.lastEmitted = signature;
    this.callbacks.onStatus(this.status, message);
  }
}
