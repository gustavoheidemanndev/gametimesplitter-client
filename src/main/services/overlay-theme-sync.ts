import { sanitizeOverlayTheme, type OverlayTheme } from '../../shared/overlay-theme';
import { ApiClient, ApiError } from './api-client';
import { OverlayThemeStore } from './overlay-theme-store';

const LAYOUT_POLL_INTERVAL_MS = 5_000;

interface OverlayThemeSyncCallbacks {
  onRemoteTheme: (theme: OverlayTheme) => void;
  onStatus: (message: string, isError: boolean) => void;
}

const valuesDiffer = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) !== JSON.stringify(right);

const mergeLocalChanges = (
  baseline: OverlayTheme | undefined,
  local: OverlayTheme,
  remote: OverlayTheme
): OverlayTheme => {
  if (!baseline) return sanitizeOverlayTheme(local);
  const merged = { ...sanitizeOverlayTheme(remote) } as Record<string, unknown>;
  (Object.keys(local) as Array<keyof OverlayTheme>).forEach((key) => {
    if (valuesDiffer(baseline[key], local[key])) merged[key] = local[key];
  });
  return sanitizeOverlayTheme(merged);
};

export class OverlayThemeSync {
  private pollTimer?: NodeJS.Timeout;
  private lastRevision: string | null | undefined;
  private baselineTheme?: OverlayTheme;
  private pendingTheme?: OverlayTheme;
  private inFlight?: Promise<void>;
  private lastError?: string;
  private sessionGeneration = 0;
  private readonly localDraftIds = new Set<string>();

  constructor(
    private readonly api: ApiClient,
    private readonly themeStore: OverlayThemeStore,
    private readonly callbacks: OverlayThemeSyncCallbacks
  ) {}

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.syncNow(), LAYOUT_POLL_INTERVAL_MS);
    this.pollTimer.unref();
    void this.syncNow();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.sessionGeneration += 1;
  }

  handleSessionChange(authenticated: boolean): void {
    this.sessionGeneration += 1;
    this.lastRevision = undefined;
    this.baselineTheme = undefined;
    this.pendingTheme = undefined;
    this.localDraftIds.clear();
    if (authenticated) {
      const syncState = this.themeStore.getSyncState();
      this.lastRevision = syncState.revision;
      this.baselineTheme = syncState.baselineTheme
        ? sanitizeOverlayTheme(syncState.baselineTheme)
        : syncState.dirty ? undefined : sanitizeOverlayTheme(this.themeStore.get());
      this.pendingTheme = syncState.dirty ? sanitizeOverlayTheme(this.themeStore.get()) : undefined;
      void this.syncNow();
    }
  }

  beginLocalDraft(draftId: string): void {
    if (this.localDraftIds.has(draftId)) return;
    this.localDraftIds.add(draftId);
    this.themeStore.markDraftStarted();
  }

  endLocalDraft(draftId: string): void {
    if (!this.localDraftIds.delete(draftId) || this.localDraftIds.size > 0) return;
    void this.syncNow();
  }

  clearLocalDrafts(): void {
    this.localDraftIds.clear();
  }

  queueUpload(theme: OverlayTheme): void {
    this.pendingTheme = sanitizeOverlayTheme(theme);
    void this.syncNow();
  }

  syncNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.synchronize().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private sessionIsCurrent(generation: number, userId: string): boolean {
    return this.sessionGeneration === generation && this.api.getSession()?.user.id === userId;
  }

  private async synchronize(): Promise<void> {
    const session = this.api.getSession();
    if (!session || this.localDraftIds.size > 0) return;
    const generation = this.sessionGeneration;
    const userId = session.user.id;

    try {
      while (this.sessionIsCurrent(generation, userId)) {
        const pending = this.pendingTheme;
        if (pending) {
          const pendingLocalVersion = this.themeStore.getLocalVersion();
          try {
            const remote = await this.api.updateActiveLayout(pending, this.lastRevision ?? null);
            if (!this.sessionIsCurrent(generation, userId)) return;
            if (!remote.revision) throw new Error('A API não retornou a revisão do layout salvo.');
            this.lastRevision = remote.revision;
            this.baselineTheme = sanitizeOverlayTheme(remote.theme);
            if (this.localDraftIds.size > 0) return;
            if (
              this.pendingTheme === pending &&
              this.themeStore.getLocalVersion() === pendingLocalVersion
            ) {
              const result = await this.themeStore.markSynced(
                remote.theme,
                remote.revision,
                pendingLocalVersion
              );
              if (!this.sessionIsCurrent(generation, userId)) return;
              if (!result.applied) return;
              this.pendingTheme = undefined;
              this.callbacks.onRemoteTheme(result.theme);
            }
            this.reportSuccess('Layout enviado e sincronizado com a web.');
            if (this.pendingTheme) continue;
            return;
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409) throw error;
            const latest = await this.api.getActiveLayout();
            if (!this.sessionIsCurrent(generation, userId) || this.localDraftIds.size > 0) return;
            if (
              this.themeStore.getLocalVersion() !== pendingLocalVersion &&
              this.pendingTheme === pending
            ) return;
            const local = this.pendingTheme ?? pending;
            const merged = mergeLocalChanges(
              this.baselineTheme,
              local,
              sanitizeOverlayTheme(latest.theme)
            );
            this.lastRevision = latest.revision;
            this.baselineTheme = sanitizeOverlayTheme(latest.theme);
            this.pendingTheme = merged;
            const persisted = await this.themeStore.rebaseLocal(
              merged,
              sanitizeOverlayTheme(latest.theme),
              latest.revision
            );
            if (!this.sessionIsCurrent(generation, userId)) return;
            this.callbacks.onRemoteTheme(persisted);
            this.callbacks.onStatus(
              'O layout também mudou na web; as alterações foram mescladas e reenviadas.',
              false
            );
            continue;
          }
        }

        const readLocalVersion = this.themeStore.getLocalVersion();
        const remote = await this.api.getActiveLayout();
        if (!this.sessionIsCurrent(generation, userId) || this.localDraftIds.size > 0) return;
        if (this.pendingTheme) continue;
        if (this.themeStore.getLocalVersion() !== readLocalVersion) return;

        if (remote.revision === null) {
          this.lastRevision = null;
          this.baselineTheme = sanitizeOverlayTheme(this.themeStore.get());
          this.pendingTheme = sanitizeOverlayTheme(this.themeStore.get());
          continue;
        }

        if (remote.revision !== this.lastRevision) {
          const result = await this.themeStore.applyRemote(
            remote.theme,
            remote.revision,
            readLocalVersion
          );
          if (!this.sessionIsCurrent(generation, userId)) return;
          if (!result.applied) return;
          this.lastRevision = remote.revision;
          this.baselineTheme = result.theme;
          this.callbacks.onRemoteTheme(result.theme);
          this.reportSuccess('Layout atualizado a partir da web.');
        }
        return;
      }
    } catch (error) {
      if (!this.sessionIsCurrent(generation, userId)) return;
      const message = error instanceof Error ? error.message : 'Falha desconhecida ao sincronizar o layout.';
      if (message !== this.lastError) {
        this.lastError = message;
        // Sem resposta da API o layout local continua valendo; a próxima tentativa reconcilia.
        const unreachable = error instanceof ApiError && error.status === 0;
        this.callbacks.onStatus(
          unreachable
            ? `${message} O layout atual da overlay foi mantido e será sincronizado quando a API voltar.`
            : `Sincronização do layout: ${message}`,
          true
        );
      }
    }
  }

  private reportSuccess(message: string): void {
    this.lastError = undefined;
    this.callbacks.onStatus(message, false);
  }
}
