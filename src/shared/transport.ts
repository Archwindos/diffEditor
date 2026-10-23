import { createHash } from 'node:crypto';
import { userInfo, tmpdir } from 'node:os';
import path from 'node:path';
export function pipeName(): string {
  if (process.env.DIFFEDITOR_PIPE) return process.env.DIFFEDITOR_PIPE;
  const suffix = createHash('sha256').update(userInfo().username).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\diffeditor-${suffix}` : path.join(tmpdir(), `diffeditor-${suffix}.sock`);
}
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
