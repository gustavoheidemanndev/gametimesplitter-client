import { app, safeStorage } from 'electron';
import { readFile, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { AuthSession } from '../../shared/types';
import {
  DEFAULT_AUTOSPLIT_CONFIG,
  type AutosplitConfig,
} from '../../shared/timer-protocol';

interface StoredSettings {
  selectedFile?: string;
  selectedGameId?: string;
  encryptedSession?: string;
  /**
   * Só os campos que a interface controla. Guardar parcial em vez do objeto inteiro faz mudanças
   * futuras nos padrões — offsets, listas de rota — chegarem a quem já tem arquivo salvo.
   */
  autosplit?: Partial<AutosplitConfig>;
}

export class SessionStore {
  private readonly filePath = path.join(app.getPath('userData'), 'settings.json');
  private settings: StoredSettings = {};

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const stored = JSON.parse(content) as StoredSettings & { apiUrl?: unknown };
      delete stored.apiUrl;
      this.settings = stored;
    } catch {
      this.settings = {};
    }
  }

  getSelectedFile(): string | undefined {
    return this.settings.selectedFile;
  }

  getSelectedGameId(): string | undefined {
    return this.settings.selectedGameId;
  }

  /**
   * Mescla o que está salvo sobre os padrões. `load()` não valida o JSON, então mesclar garante que
   * um arquivo antigo ou editado à mão nunca entregue configuração incompleta ao sidecar.
   */
  getAutosplitConfig(): AutosplitConfig {
    return { ...DEFAULT_AUTOSPLIT_CONFIG, ...this.settings.autosplit };
  }

  async saveAutosplitConfig(partial: Partial<AutosplitConfig>): Promise<void> {
    this.settings.autosplit = { ...this.settings.autosplit, ...partial };
    await this.persist();
  }

  restoreSession(): AuthSession | undefined {
    if (!this.settings.encryptedSession || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(this.settings.encryptedSession, 'base64'));
      return JSON.parse(decrypted) as AuthSession;
    } catch {
      return undefined;
    }
  }

  async saveSession(session: AuthSession, remember: boolean): Promise<void> {
    if (remember && safeStorage.isEncryptionAvailable()) {
      this.settings.encryptedSession = safeStorage.encryptString(JSON.stringify(session)).toString('base64');
    } else {
      delete this.settings.encryptedSession;
    }
    await this.persist();
  }

  async updateSession(session: AuthSession): Promise<void> {
    if (!this.settings.encryptedSession || !safeStorage.isEncryptionAvailable()) return;
    this.settings.encryptedSession = safeStorage.encryptString(JSON.stringify(session)).toString('base64');
    await this.persist();
  }

  async savePreferences(selectedFile?: string, selectedGameId?: string): Promise<void> {
    this.settings.selectedFile = selectedFile;
    this.settings.selectedGameId = selectedGameId;
    await this.persist();
  }

  async clearSession(): Promise<void> {
    delete this.settings.encryptedSession;
    await this.persist();
  }

  async clearAll(): Promise<void> {
    this.settings = {};
    await rm(this.filePath, { force: true });
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.settings, null, 2), 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}
