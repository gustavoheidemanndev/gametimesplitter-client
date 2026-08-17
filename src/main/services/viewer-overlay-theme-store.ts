import { app } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultViewerOverlayTheme,
  sanitizeViewerOverlayTheme,
  type ViewerOverlayTheme,
} from '../../shared/viewer-overlay-theme';

/**
 * Tema da overlay de espectador em disco, por máquina.
 *
 * Diferente de `OverlayThemeStore`, não há dono, revisão nem upload: a v1 da feature mantém a
 * personalização do espectador fora da API de layouts, então o arquivo é único da instalação.
 */
export class ViewerOverlayThemeStore {
  private theme: ViewerOverlayTheme = defaultViewerOverlayTheme;
  private mutationChain: Promise<void> = Promise.resolve();

  async load(): Promise<ViewerOverlayTheme> {
    try {
      this.theme = sanitizeViewerOverlayTheme(JSON.parse(await readFile(this.getFilePath(), 'utf8')));
    } catch {
      this.theme = sanitizeViewerOverlayTheme(defaultViewerOverlayTheme);
    }
    return this.theme;
  }

  get(): ViewerOverlayTheme {
    return this.theme;
  }

  update(partial: Partial<ViewerOverlayTheme>): Promise<ViewerOverlayTheme> {
    return this.enqueue((current) => ({ ...current, ...partial }));
  }

  reset(): Promise<ViewerOverlayTheme> {
    return this.enqueue(() => defaultViewerOverlayTheme);
  }

  private getFilePath(): string {
    return path.join(app.getPath('userData'), 'viewer-overlay-theme.json');
  }

  private enqueue(createNext: (current: ViewerOverlayTheme) => unknown): Promise<ViewerOverlayTheme> {
    let resolveResult!: (theme: ViewerOverlayTheme) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<ViewerOverlayTheme>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationChain = this.mutationChain.catch(() => undefined).then(async () => {
      try {
        const next = sanitizeViewerOverlayTheme(createNext(this.theme));
        await this.writeAtomic(this.getFilePath(), JSON.stringify(next, null, 2));
        this.theme = next;
        resolveResult(next);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  }
}
