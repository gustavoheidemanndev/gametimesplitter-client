import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CloudLssFile } from '../../shared/types';

const safePart = (value: string): string => value
  .normalize('NFKD')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 100);

export class CloudLssStore {
  async save(userId: string, file: CloudLssFile, content: string): Promise<string> {
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    if (sha256 !== file.sha256) {
      throw new Error('O arquivo baixado não corresponde ao hash informado pelo servidor.');
    }
    if (Buffer.byteLength(content, 'utf8') !== file.size) {
      throw new Error('O tamanho do arquivo baixado não corresponde ao informado pelo servidor.');
    }

    const ownerDirectory = path.join(
      app.getPath('userData'),
      'lss',
      safePart(userId) || 'user'
    );
    await mkdir(ownerDirectory, { recursive: true });
    const originalBase = safePart(path.basename(file.originalName, path.extname(file.originalName))) || 'run';
    const filePath = path.join(ownerDirectory, `${originalBase}-${safePart(file.id)}.lss`);
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
    return filePath;
  }
}
