import { sanitizeOverlayTheme, type OverlayTheme } from '../../shared/overlay-theme';
import { ApiClient, ApiError } from './api-client';
import { OverlayThemeStore } from './overlay-theme-store';
import type { ActiveOverlayLayout } from '../../shared/types';

const LAYOUT_POLL_INTERVAL_MS = 5_000;

interface OverlayThemeSyncCallbacks {
  onRemoteTheme: (theme: OverlayTheme) => void;
  onStatus: (message: string, isError: boolean) => void;
}

const isRemoteLayoutNewer = (
  remoteUpdatedAt: string | null | undefined,
  localModifiedAt: string | null | undefined
): boolean => {
  if (!remoteUpdatedAt) return false;
  if (!localModifiedAt) return true;
  const remoteMs = Date.parse(remoteUpdatedAt);
  const localMs = Date.parse(localModifiedAt);
  if (!Number.isFinite(remoteMs)) return false;
  if (!Number.isFinite(localMs)) return true;
  return remoteMs > localMs;
};

export class OverlayThemeSync {
  private pollTimer?: NodeJS.Timeout;
  private lastRevision: string | null | undefined;
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
    this.pendingTheme = undefined;
    this.localDraftIds.clear();
    if (authenticated) {
      const syncState = this.themeStore.getSyncState();
      this.lastRevision = syncState.revision;
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

  private localWinsAgainst(remoteUpdatedAt: string | null | undefined): boolean {
    return !isRemoteLayoutNewer(remoteUpdatedAt, this.themeStore.getSyncState().localModifiedAt);
  }

  private remoteDroppedLocalComponentTypes(remoteTheme: OverlayTheme): boolean {
    const remoteTypes = new Set(sanitizeOverlayTheme(remoteTheme).components.map((component) => component.type));
    return this.themeStore.get().components.some((component) => !remoteTypes.has(component.type));
  }

  private async applyRemoteLayout(
    layout: ActiveOverlayLayout,
    expectedLocalVersion: number,
    generation: number,
    userId: string
  ): Promise<boolean> {
    if (!layout.revision) return false;
    const result = await this.themeStore.applyRemote(
      layout.theme,
      layout.revision,
      expectedLocalVersion,
      layout.updatedAt
    );
    if (!this.sessionIsCurrent(generation, userId)) return false;
    if (!result.applied) return false;
    this.lastRevision = layout.revision;
    this.pendingTheme = undefined;
    this.callbacks.onRemoteTheme(result.theme);
    this.reportSuccess('Layout atualizado a partir da web.');
    return true;
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
            if (this.localDraftIds.size > 0) return;
            if (
              this.pendingTheme === pending &&
              this.themeStore.getLocalVersion() === pendingLocalVersion
            ) {
              // Keep what this client sent. An older API sanitizer may drop
              // newer component types from remote.theme; applying that would
              // wipe a successful local edit (Best Split Times, etc.).
              const result = await this.themeStore.markSynced(
                pending,
                remote.revision,
                pendingLocalVersion,
                remote.updatedAt
              );
              if (!this.sessionIsCurrent(generation, userId)) return;
              if (!result.applied) return;
              this.pendingTheme = undefined;
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
            if (!this.localWinsAgainst(latest.updatedAt)) {
              await this.applyRemoteLayout(latest, pendingLocalVersion, generation, userId);
              return;
            }
            this.lastRevision = latest.revision;
            this.pendingTheme = this.pendingTheme ?? pending;
            await this.themeStore.rebaseLocal(
              this.pendingTheme,
              sanitizeOverlayTheme(latest.theme),
              latest.revision,
              latest.updatedAt
            );
            if (!this.sessionIsCurrent(generation, userId)) return;
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
          this.pendingTheme = sanitizeOverlayTheme(this.themeStore.get());
          continue;
        }

        if (remote.revision !== this.lastRevision) {
          const syncState = this.themeStore.getSyncState();
          if (syncState.dirty && this.localWinsAgainst(remote.updatedAt)) {
            this.lastRevision = remote.revision;
            this.pendingTheme = sanitizeOverlayTheme(this.themeStore.get());
            await this.themeStore.rebaseLocal(
              this.pendingTheme,
              sanitizeOverlayTheme(remote.theme),
              remote.revision,
              remote.updatedAt
            );
            if (!this.sessionIsCurrent(generation, userId)) return;
            continue;
          }
          if (
            this.localWinsAgainst(remote.updatedAt) &&
            this.remoteDroppedLocalComponentTypes(remote.theme)
          ) {
            this.lastRevision = remote.revision;
            return;
          }
          await this.applyRemoteLayout(remote, readLocalVersion, generation, userId);
        }
        return;
      }
    } catch (error) {
      if (!this.sessionIsCurrent(generation, userId)) return;
      const message = error instanceof Error ? error.message : 'Falha desconhecida ao sincronizar o layout.';
      if (message !== this.lastError) {
        this.lastError = message;
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
