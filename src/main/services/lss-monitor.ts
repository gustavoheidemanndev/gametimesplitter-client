import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { ParsedLss, RunPayload } from '../../shared/types';
import { parseLssFile } from './lss-parser';

export class LssMonitor {
  private watcher?: FSWatcher;
  private debounce?: NodeJS.Timeout;
  private generation = 0;

  constructor(
    private readonly onParsed: (filePath: string, parsed: ParsedLss, runs: RunPayload[]) => Promise<void>,
    private readonly onError: (error: Error) => void
  ) {}

  async start(filePath: string, gameId: string): Promise<ParsedLss> {
    this.stop();
    const generation = this.generation;
    const directory = path.dirname(filePath);
    const filename = path.basename(filePath).toLocaleLowerCase();

    this.watcher = watch(directory, (_eventType, changedFile) => {
      if (generation !== this.generation) return;
      if (!changedFile || changedFile.toString().toLocaleLowerCase() !== filename) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        if (generation !== this.generation) return;
        void this.process(filePath, gameId, generation).catch((error: unknown) => {
          if (generation === this.generation) this.reportError(error);
        });
      }, 700);
    });
    this.watcher.on('error', (error) => {
      if (generation !== this.generation) return;
      this.reportError(error);
      this.stop();
    });

    try {
      return await this.process(filePath, gameId, generation);
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  isMonitoring(): boolean {
    return Boolean(this.watcher);
  }

  private async process(filePath: string, gameId: string, generation: number): Promise<ParsedLss> {
    const parsed = await parseLssFile(filePath);
    if (generation !== this.generation) return parsed;
    const runs = parsed.attempts.map((attempt) => ({
      ...attempt,
      gameId,
      gameName: parsed.gameName,
      categoryName: parsed.categoryName,
    }));
    await this.onParsed(filePath, parsed, runs);
    return parsed;
  }

  private reportError(error: unknown): void {
    this.onError(error instanceof Error ? error : new Error('Falha desconhecida no monitor do LiveSplit.'));
  }
}
