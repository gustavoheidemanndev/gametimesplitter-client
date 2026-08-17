import type {
  ActiveOverlayLayout,
  AuthSession,
  CloudLssFile,
  Game,
  RaceRoomsOverviewResponse,
  RaceSpectatorStateResponse,
  RaceStateResponse,
  ReportRaceSplitsPayload,
  RunPayload,
  RunProgressPayload,
} from '../../shared/types';
import type { OverlayTheme } from '../../shared/overlay-theme';
import { DESKTOP_API_URL } from '../../shared/app-config';

interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Motivo da mudança de sessão, para separar queda de rede de credenciais inválidas. */
export type SessionChangeReason = 'authenticated' | 'refreshed' | 'logout' | 'unauthorized';

/** `unavailable` cobre os casos em que a API não respondeu e a sessão segue válida. */
type RefreshOutcome = 'refreshed' | 'rejected' | 'unavailable';

/**
 * Só a recusa explícita da API invalida a sessão. Timeout, falha de conexão e erro
 * de servidor (a API dormindo ou reiniciando em produção) são temporários: manter a
 * sessão evita deslogar o usuário e resetar o estado local por causa de indisponibilidade.
 */
const isCredentialRejection = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

export class ApiClient {
  private readonly apiUrl = this.normalizeApiUrl(DESKTOP_API_URL);
  private session?: AuthSession;
  private gamesCache?: { games: Game[]; expiresAt: number };
  private gamesRequest?: Promise<Game[]>;

  constructor(
    private readonly onSessionChanged: (
      session: AuthSession | undefined,
      reason: SessionChangeReason
    ) => void
  ) {}

  setSession(session?: AuthSession): void {
    this.session = session;
  }

  getSession(): AuthSession | undefined {
    return this.session;
  }

  async login(identifier: string, password: string): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }, false);
    this.session = session;
    this.onSessionChanged(session, 'authenticated');
    return session;
  }

  async logout(): Promise<void> {
    const refreshToken = this.session?.refreshToken;
    if (refreshToken) {
      try {
        await this.request('/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        }, false);
      } catch {
        // A sessão local deve ser encerrada mesmo se o servidor estiver offline.
      }
    }
    this.session = undefined;
    this.onSessionChanged(undefined, 'logout');
  }

  getGames(): Promise<Game[]> {
    const now = Date.now();
    if (this.gamesCache && this.gamesCache.expiresAt > now) {
      return Promise.resolve(this.gamesCache.games);
    }
    if (this.gamesRequest) return this.gamesRequest;

    const request = this.request<Game[]>('/games?isActive=true', { method: 'GET' })
      .then((games) => {
        this.gamesCache = { games, expiresAt: Date.now() + 60_000 };
        return games;
      })
      .finally(() => {
        if (this.gamesRequest === request) this.gamesRequest = undefined;
      });
    this.gamesRequest = request;
    return request;
  }

  getLssFiles(): Promise<CloudLssFile[]> {
    return this.request<CloudLssFile[]>('/lss-files', { method: 'GET' });
  }

  getLssFile(id: string): Promise<CloudLssFile> {
    return this.request<CloudLssFile>(`/lss-files/${encodeURIComponent(id)}`, { method: 'GET' });
  }

  downloadLssFile(id: string): Promise<string> {
    return this.requestText(`/lss-files/${encodeURIComponent(id)}/download`);
  }

  createRun(run: RunPayload): Promise<unknown> {
    const { gameName: _gameName, categoryName: _categoryName, ...payload } = run;
    return this.request('/runs', { method: 'POST', body: JSON.stringify(payload) });
  }

  async syncRunProgress(progress: RunProgressPayload): Promise<unknown> {
    if (!progress.gameId) throw new ApiError('O jogo do split ainda não foi identificado.', 0);
    const { gameName: _gameName, categoryName: _categoryName, ...payload } = progress;
    return this.request('/runs/progress', { method: 'PUT', body: JSON.stringify(payload) });
  }

  /** null quando o usuário não está em nenhuma corrida ativa. */
  getActiveRace(): Promise<RaceStateResponse | null> {
    return this.request<RaceStateResponse | null>('/races/active', { method: 'GET' });
  }

  getRace(raceId: string): Promise<RaceStateResponse> {
    return this.request<RaceStateResponse>(`/races/${encodeURIComponent(raceId)}`, { method: 'GET' });
  }

  /** Salas vivas (open/armed/running). Para o papel viewer o servidor devolve `activeRace: null`. */
  getRaces(): Promise<RaceRoomsOverviewResponse> {
    return this.request<RaceRoomsOverviewResponse>('/races', { method: 'GET' });
  }

  /**
   * Mesma rota de `getRace`, mas com o DTO que o servidor devolve para o papel viewer: líder e
   * delta na perspectiva neutra, sem `me`/`opponent`.
   */
  getSpectatorRace(raceId: string): Promise<RaceSpectatorStateResponse> {
    return this.request<RaceSpectatorStateResponse>(
      `/races/${encodeURIComponent(raceId)}`,
      { method: 'GET' }
    );
  }

  /** Publica os segmentos do .lss carregado; o backend define ou valida a lista da sala. */
  raceClientCheck(raceId: string, segmentNames: string[]): Promise<RaceStateResponse> {
    return this.request<RaceStateResponse>(`/races/${encodeURIComponent(raceId)}/client-check`, {
      method: 'POST',
      body: JSON.stringify({ segmentNames }),
    });
  }

  reportRaceSplits(
    raceId: string,
    payload: ReportRaceSplitsPayload
  ): Promise<RaceStateResponse> {
    return this.request<RaceStateResponse>(`/races/${encodeURIComponent(raceId)}/splits`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getActiveLayout(): Promise<ActiveOverlayLayout> {
    return this.request<ActiveOverlayLayout>('/layouts/active', { method: 'GET' });
  }

  updateActiveLayout(
    theme: OverlayTheme,
    expectedRevision: string | null,
    layoutName?: string
  ): Promise<ActiveOverlayLayout> {
    return this.request<ActiveOverlayLayout>('/layouts/active', {
      method: 'PUT',
      body: JSON.stringify({ layoutName, theme, expectedRevision }),
    });
  }

  private normalizeApiUrl(value: string): string {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('A URL da API deve usar HTTP ou HTTPS.');
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (url.protocol === 'http:' && !localHosts.has(url.hostname)) {
      throw new Error('Servidores remotos devem usar HTTPS para proteger senha e tokens.');
    }
    return url.toString().replace(/\/$/, '');
  }

  private async requestText(path: string, retryAfterRefresh = true): Promise<string> {
    const requestSession = this.session;
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/xml,text/xml',
          ...(requestSession?.accessToken ? { Authorization: `Bearer ${requestSession.accessToken}` } : {}),
        },
      });
    } catch {
      throw new ApiError('Não foi possível baixar o arquivo .lss.', 0);
    }

    let refresh: RefreshOutcome | undefined;
    if (
      response.status === 401 &&
      retryAfterRefresh &&
      requestSession?.refreshToken &&
      this.session === requestSession
    ) {
      refresh = await this.refreshAccessToken(requestSession);
      if (refresh === 'refreshed' && this.session?.user.id === requestSession.user.id) {
        return this.requestText(path, false);
      }
    }

    if (!response.ok) {
      let message = `Erro HTTP ${response.status}.`;
      try {
        const body = await response.json() as Partial<ApiEnvelope<unknown>>;
        if (body.message) message = body.message;
      } catch {
        // Mantém a mensagem HTTP quando a API não retorna JSON.
      }
      if (this.shouldDropSession(response.status, requestSession, refresh)) {
        this.session = undefined;
        this.onSessionChanged(undefined, 'unauthorized');
      }
      throw new ApiError(message, response.status);
    }

    return response.text();
  }

  private async request<T>(path: string, init: RequestInit, retryAfterRefresh = true): Promise<T> {
    const requestSession = this.session;
    const requestApiUrl = this.apiUrl;
    let response: Response;
    try {
      response = await fetch(`${requestApiUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json',
          ...(requestSession?.accessToken ? { Authorization: `Bearer ${requestSession.accessToken}` } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ApiError('Não foi possível conectar ao servidor.', 0);
    }

    let refresh: RefreshOutcome | undefined;
    if (
      response.status === 401 &&
      retryAfterRefresh &&
      requestSession?.refreshToken &&
      this.session === requestSession
    ) {
      refresh = await this.refreshAccessToken(requestSession);
      if (refresh === 'refreshed' && this.session?.user.id === requestSession.user.id) {
        return this.request<T>(path, init, false);
      }
    }

    let body: Partial<ApiEnvelope<T>> = {};
    try {
      body = await response.json() as Partial<ApiEnvelope<T>>;
    } catch {
      // Uma mensagem genérica será usada quando a API não retornar JSON.
    }

    if (!response.ok || body.success === false) {
      if (this.shouldDropSession(response.status, requestSession, refresh)) {
        this.session = undefined;
        this.onSessionChanged(undefined, 'unauthorized');
      }
      throw new ApiError(body.message || `Erro HTTP ${response.status}.`, response.status);
    }

    return body.data as T;
  }

  /**
   * O 401 só encerra a sessão quando a renovação também foi recusada pela API.
   * Se o refresh não chegou ao servidor, o token pode continuar válido e a sessão
   * é mantida para a próxima tentativa.
   */
  private shouldDropSession(
    status: number,
    requestSession: AuthSession | undefined,
    refresh: RefreshOutcome | undefined
  ): boolean {
    return status === 401 &&
      Boolean(requestSession) &&
      this.session === requestSession &&
      refresh !== 'unavailable';
  }

  private async refreshAccessToken(expectedSession: AuthSession): Promise<RefreshOutcome> {
    if (this.session !== expectedSession) return 'unavailable';

    try {
      const result = await this.request<{ accessToken: string }>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: expectedSession.refreshToken }),
      }, false);
      if (this.session !== expectedSession) return 'unavailable';
      this.session = { ...expectedSession, accessToken: result.accessToken };
      this.onSessionChanged(this.session, 'refreshed');
      return 'refreshed';
    } catch (error) {
      // Sem resposta da API não há como saber se o refresh token caiu: preserva a
      // sessão para tentar de novo quando a API voltar.
      if (!isCredentialRejection(error)) return 'unavailable';
      if (this.session === expectedSession) {
        this.session = undefined;
        this.onSessionChanged(undefined, 'unauthorized');
      }
      return 'rejected';
    }
  }
}
