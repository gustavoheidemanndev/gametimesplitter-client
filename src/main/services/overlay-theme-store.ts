import { app } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultOverlayTheme,
  sanitizeOverlayTheme,
  type OverlayTheme,
} from '../../shared/overlay-theme';

interface ThemeSyncState {
  revision: string | null;
  dirty: boolean;
  baselineTheme?: OverlayTheme;
}

interface StoredThemeEnvelope {
  theme: OverlayTheme;
  revision: string | null;
  dirty: boolean;
  baselineTheme: OverlayTheme | null;
}

interface RemoteThemeResult {
  theme: OverlayTheme;
  applied: boolean;
}

export interface OverlayThemeOwnerContext {
  ownerId?: string;
  generation: number;
}

/**
 * Como resolver a ausência de tema salvo para o dono solicitado: `last-known` mantém
 * o visual da última conta carregada (sessão perdida, API offline) e `default` volta ao
 * tema padrão (logout explícito).
 */
export type MissingThemeFallback = 'default' | 'last-known';

export class OverlayThemeOwnerChangedError extends Error {
  constructor() {
    super('A conta ativa mudou antes de salvar o tema.');
    this.name = 'OverlayThemeOwnerChangedError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class OverlayThemeStore {
  private ownerId?: string;
  private lastRememberedOwnerId?: string;
  private ownerGeneration = 0;
  private theme: OverlayTheme = defaultOverlayTheme;
  private syncRevision: string | null = null;
  private dirty = false;
  private baselineTheme?: OverlayTheme;
  private localVersion = 0;
  private mutationChain: Promise<void> = Promise.resolve();

  load(
    ownerId?: string,
    missingFallback: MissingThemeFallback = 'last-known'
  ): Promise<OverlayTheme> {
    const requestedGeneration = ++this.ownerGeneration;
    let resolveResult!: (theme: OverlayTheme) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<OverlayTheme>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationChain = this.mutationChain.catch(() => undefined).then(async () => {
      try {
        if (requestedGeneration !== this.ownerGeneration) {
          resolveResult(this.theme);
          return;
        }
        this.ownerId = ownerId;
        this.localVersion += 1;
        const filePath = this.getFilePath();
        try {
          this.hydrate(JSON.parse(await readFile(filePath, 'utf8')), Boolean(ownerId));
        } catch {
          const recovered = ownerId
            ? await this.migrateLegacyFile(filePath)
            : missingFallback === 'last-known' && await this.hydrateLastKnownTheme();
          if (!recovered) this.setCleanDefault();
        }
        if (ownerId) await this.rememberLastOwner(ownerId);
        resolveResult(this.theme);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  get(): OverlayTheme {
    return this.theme;
  }

  getOwnerContext(): OverlayThemeOwnerContext {
    return { ownerId: this.ownerId, generation: this.ownerGeneration };
  }

  getSyncState(): ThemeSyncState {
    return {
      revision: this.syncRevision,
      dirty: this.dirty,
      baselineTheme: this.baselineTheme,
    };
  }

  getLocalVersion(): number {
    return this.localVersion;
  }

  markDraftStarted(): void {
    this.localVersion += 1;
  }

  update(
    partial: Partial<OverlayTheme>,
    expectedOwner?: OverlayThemeOwnerContext
  ): Promise<OverlayTheme> {
    return this.enqueue((current) => {
      this.assertOwner(expectedOwner);
      return { ...current, ...partial };
    });
  }

  replace(next: OverlayTheme, expectedOwner?: OverlayThemeOwnerContext): Promise<OverlayTheme> {
    return this.enqueue(() => {
      this.assertOwner(expectedOwner);
      return next;
    });
  }

  reset(expectedOwner?: OverlayThemeOwnerContext): Promise<OverlayTheme> {
    return this.enqueue((current) => {
      this.assertOwner(expectedOwner);
      return { ...defaultOverlayTheme, language: current.language };
    });
  }

  private assertOwner(expectedOwner?: OverlayThemeOwnerContext): void {
    if (
      expectedOwner &&
      (expectedOwner.generation !== this.ownerGeneration || expectedOwner.ownerId !== this.ownerId)
    ) {
      throw new OverlayThemeOwnerChangedError();
    }
  }

  rebaseLocal(next: OverlayTheme, baseline: OverlayTheme, revision: string | null): Promise<OverlayTheme> {
    return this.enqueue(
      () => next,
      { revision, dirty: true, baselineTheme: sanitizeOverlayTheme(baseline) }
    );
  }

  applyRemote(next: OverlayTheme, revision: string, expectedLocalVersion: number): Promise<RemoteThemeResult> {
    return this.enqueueRemote(next, revision, expectedLocalVersion);
  }

  markSynced(next: OverlayTheme, revision: string, expectedLocalVersion: number): Promise<RemoteThemeResult> {
    return this.enqueueRemote(next, revision, expectedLocalVersion);
  }

  private hydrate(value: unknown, legacyIsDirty: boolean): void {
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'theme')) {
      this.theme = sanitizeOverlayTheme(value.theme);
      this.syncRevision = typeof value.revision === 'string' ? value.revision : null;
      this.dirty = typeof value.dirty === 'boolean' ? value.dirty : legacyIsDirty;
      this.baselineTheme = isRecord(value.baselineTheme)
        ? sanitizeOverlayTheme(value.baselineTheme)
        : this.dirty ? undefined : this.theme;
      return;
    }
    this.theme = sanitizeOverlayTheme(value);
    this.syncRevision = null;
    this.dirty = legacyIsDirty;
    this.baselineTheme = legacyIsDirty ? undefined : this.theme;
  }

  private setCleanDefault(): void {
    this.theme = sanitizeOverlayTheme(defaultOverlayTheme);
    this.syncRevision = null;
    this.dirty = false;
    this.baselineTheme = this.theme;
  }

  private getFilePath(): string {
    return this.getFilePathFor(this.ownerId);
  }

  private getFilePathFor(ownerId?: string): string {
    if (!ownerId) return path.join(app.getPath('userData'), 'overlay-theme.json');
    const safeOwner = ownerId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    return path.join(app.getPath('userData'), `overlay-theme.${safeOwner || 'account'}.json`);
  }

  private getLastOwnerPointerPath(): string {
    return path.join(app.getPath('userData'), 'overlay-theme.last-owner.json');
  }

  /**
   * Sem conta ativa — sessão expirada ou API fora do ar — a overlay reaproveita o
   * tema da última conta carregada em vez de voltar ao padrão, para o visual da live
   * continuar igual até o login ser refeito.
   */
  private async hydrateLastKnownTheme(): Promise<boolean> {
    const lastOwnerId = await this.readLastOwnerId();
    if (!lastOwnerId) return false;
    try {
      this.hydrate(JSON.parse(await readFile(this.getFilePathFor(lastOwnerId), 'utf8')), false);
    } catch {
      return false;
    }
    // O tema apenas continua exibido: sem conta não há revisão a comparar nem envio pendente.
    this.syncRevision = null;
    this.dirty = false;
    this.baselineTheme = this.theme;
    return true;
  }

  private async readLastOwnerId(): Promise<string | undefined> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.getLastOwnerPointerPath(), 'utf8'));
      const ownerId = isRecord(stored) ? stored.ownerId : undefined;
      return typeof ownerId === 'string' && ownerId ? ownerId : undefined;
    } catch {
      return undefined;
    }
  }

  private async rememberLastOwner(ownerId: string): Promise<void> {
    if (this.lastRememberedOwnerId === ownerId) return;
    try {
      await this.writeAtomic(this.getLastOwnerPointerPath(), JSON.stringify({ ownerId }, null, 2));
      this.lastRememberedOwnerId = ownerId;
    } catch {
      // O ponteiro é só um atalho de recuperação: falhar aqui não afeta o tema em uso.
    }
  }

  private async migrateLegacyFile(accountFilePath: string): Promise<boolean> {
    const legacyFilePath = path.join(app.getPath('userData'), 'overlay-theme.json');
    try {
      await mkdir(path.dirname(accountFilePath), { recursive: true });
      await rename(legacyFilePath, accountFilePath);
      this.hydrate(JSON.parse(await readFile(accountFilePath, 'utf8')), true);
      return true;
    } catch {
      return false;
    }
  }

  private enqueue(
    createNext: (current: OverlayTheme) => unknown,
    syncState: ThemeSyncState = {
      revision: this.syncRevision,
      dirty: true,
      baselineTheme: this.baselineTheme,
    }
  ): Promise<OverlayTheme> {
    let resolveResult!: (theme: OverlayTheme) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<OverlayTheme>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationChain = this.mutationChain.catch(() => undefined).then(async () => {
      try {
        this.localVersion += 1;
        const next = sanitizeOverlayTheme(createNext(this.theme));
        const baselineTheme = syncState.baselineTheme ?? this.baselineTheme ?? null;
        await this.persistSnapshot({ theme: next, ...syncState, baselineTheme });
        this.theme = next;
        this.syncRevision = syncState.revision;
        this.dirty = syncState.dirty;
        this.baselineTheme = baselineTheme ?? undefined;
        resolveResult(next);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private enqueueRemote(
    value: OverlayTheme,
    revision: string,
    expectedLocalVersion: number
  ): Promise<RemoteThemeResult> {
    let resolveResult!: (result: RemoteThemeResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<RemoteThemeResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationChain = this.mutationChain.catch(() => undefined).then(async () => {
      try {
        if (this.localVersion !== expectedLocalVersion) {
          resolveResult({ theme: this.theme, applied: false });
          return;
        }
        const next = sanitizeOverlayTheme(value);
        await this.persistSnapshot({
          theme: next,
          revision,
          dirty: false,
          baselineTheme: next,
        });
        this.theme = next;
        this.syncRevision = revision;
        this.dirty = false;
        this.baselineTheme = next;
        resolveResult({ theme: next, applied: true });
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private async persistSnapshot(snapshot: StoredThemeEnvelope): Promise<void> {
    await this.writeAtomic(this.getFilePath(), JSON.stringify(snapshot, null, 2));
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  }
}
