import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings } from '../shared/contracts';

function validate(value: unknown): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof (value as AppSettings).closeToTray !== 'boolean' ||
      Object.keys(value).some(key => key !== 'closeToTray')) {
    throw new Error('设置格式无效：closeToTray 必须为布尔值');
  }
  return { closeToTray: (value as AppSettings).closeToTray };
}

export class SettingsStore {
  private settings: AppSettings = { closeToTray: true };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;
  constructor(private readonly dataDir: string) { this.filePath = path.join(dataDir, 'settings.json'); }
  get(): AppSettings { return { ...this.settings }; }
  async init(): Promise<void> {
    try { this.settings = validate(JSON.parse(await fs.readFile(this.filePath, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`无法读取设置：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  set(value: unknown): Promise<AppSettings> {
    // Capture a validated copy before this operation waits for earlier writes.
    let next: AppSettings;
    try { next = validate(value); } catch (error) { return Promise.reject(error); }
    const result = this.queue.then(async () => {
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(this.dataDir, { recursive: true });
        const file = await fs.open(temporary, 'wx');
        try { await file.writeFile(JSON.stringify(next) + '\n', 'utf8'); await file.sync(); }
        finally { await file.close(); }
        await fs.rename(temporary, this.filePath);
        this.settings = next;
        return this.get();
      } catch (error) {
        throw new Error(`无法保存设置：${error instanceof Error ? error.message : String(error)}`);
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
