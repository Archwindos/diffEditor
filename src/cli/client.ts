import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import type { CliRequest, SubmitRequest, TextEncoding, WireReply } from '../shared/contracts';
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, isReviewSource } from '../shared/contracts';
import { MAX_MESSAGE_BYTES, pipeName } from '../shared/transport';
import { version } from '../../package.json';

export class CliError extends Error {
  constructor(message: string, public code = 'CLI_ERROR', public reviewIds?: string[]) { super(message); }
}

const encodings = new Set<TextEncoding>(['utf8', 'utf16le', 'utf16be', 'gb18030']);
const usage = 'Use baseline <paths...> [--encoding utf8|utf16le|utf16be|gb18030], submit --stdin|--file <json>, withdraw <reviewId> --request-id <original-submit-requestId>, status [reviewId], or wait <reviewIds...> [--timeout seconds].';
export function parseArgs(args: string[]): { request?: CliRequest; input?: 'stdin' | string } {
  const [command, ...rest] = args;
  if (command === 'baseline') {
    const paths: string[] = [];
    let encoding: TextEncoding | undefined;
    let literal = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (!literal && arg === '--') { literal = true; continue; }
      if (!literal && arg === '--encoding') {
        const value = rest[++i] as TextEncoding;
        if (encoding || !encodings.has(value)) throw new CliError('Invalid or repeated --encoding.', 'ARGUMENT_ERROR');
        encoding = value;
      } else if (!literal && arg.startsWith('--')) {
        throw new CliError(`Unsupported option: ${arg}`, 'ARGUMENT_ERROR');
      } else paths.push(path.resolve(arg));
    }
    if (!paths.length) throw new CliError(usage, 'ARGUMENT_ERROR');
    return { request: { command, payload: { paths, ...(encoding ? { encoding } : {}) } } };
  }
  if (command === 'submit') {
    if (rest.length === 1 && rest[0] === '--stdin') return { input: 'stdin' };
    if (rest.length === 2 && rest[0] === '--file' && rest[1] && !rest[1].startsWith('--')) return { input: path.resolve(rest[1]) };
    throw new CliError(usage, 'ARGUMENT_ERROR');
  }
  if (command === 'withdraw') {
    if (rest.length !== 3 || !rest[0]?.trim() || rest[0].startsWith('--') || rest[1] !== '--request-id' || !rest[2]?.trim() || rest[2].startsWith('--')) throw new CliError(usage, 'ARGUMENT_ERROR');
    return { request: { command, payload: { reviewId: rest[0], requestId: rest[2], requireUnedited: true } } };
  }
  if (command === 'status' && rest.length <= 1 && !rest[0]?.startsWith('--')) {
    return { request: { command, payload: rest.length ? { reviewId: rest[0] } : {} } };
  }
  if (command === 'wait') {
    const reviewIds: string[] = [];
    let timeoutMs = DEFAULT_WAIT_MS, hasTimeout = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--timeout') {
        const value = rest[++i];
        if (hasTimeout || !value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_WAIT_MS / 1000) {
          throw new CliError('--timeout must be an integer from 1 to 86400 seconds, specified once.', 'ARGUMENT_ERROR');
        }
        timeoutMs = Number(value) * 1000; hasTimeout = true;
      } else if (arg.startsWith('--') || !arg.trim()) throw new CliError(usage, 'ARGUMENT_ERROR');
      else reviewIds.push(arg);
    }
    if (!reviewIds.length || new Set(reviewIds).size !== reviewIds.length) throw new CliError('wait needs one or more unique review IDs.', 'ARGUMENT_ERROR');
    return { request: { command, payload: { reviewIds, timeoutMs } } };
  }
  throw new CliError(`Unsupported command or arguments. ${usage}`, 'ARGUMENT_ERROR');
}

function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CliError('Input or response is not valid UTF-8.', 'INVALID_UTF8'); }
}

export function parseSubmission(bytes: Buffer): SubmitRequest {
  if (bytes.length > MAX_MESSAGE_BYTES) throw new CliError('Input exceeds message limit.', 'MESSAGE_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(decode(bytes)); }
  catch (error) { if (error instanceof CliError) throw error; throw new CliError('Submission must be a UTF-8 JSON object.', 'INVALID_JSON'); }
  const item = value as SubmitRequest | null;
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
    typeof item.requestId !== 'string' || !item.requestId.trim() ||
    (item.title !== undefined && typeof item.title !== 'string') ||
    Object.keys(item).some(key => !['requestId', 'title', 'source', 'files'].includes(key)) ||
    (item.source !== undefined && !isReviewSource(item.source)) ||
    !Array.isArray(item.files) || item.files.length === 0 || item.files.some(file =>
      !file || typeof file !== 'object' || Array.isArray(file) ||
      typeof file.baselineId !== 'string' || !file.baselineId.trim() || typeof file.text !== 'string' ||
      Object.keys(file).some(key => !['baselineId', 'text'].includes(key)))) {
    throw new CliError('Expected {requestId, title?, source?:{agent, threadId?, threadTitle?}, files:[{baselineId, text}]} with at least one file and valid source metadata.', 'INVALID_SUBMISSION');
  }
  if (new Set(item.files.map(file => file.baselineId)).size !== item.files.length) {
    throw new CliError('Submission contains repeated baselineId values.', 'INVALID_SUBMISSION');
  }
  return item;
}

export function withSubmissionSource(request: SubmitRequest, env: NodeJS.ProcessEnv = process.env): SubmitRequest {
  const source = { ...(request.source ?? { agent: 'Codex' }) };
  if (source.threadId === undefined && env.CODEX_THREAD_ID) source.threadId = env.CODEX_THREAD_ID;
  if (!isReviewSource(source)) throw new CliError('Source metadata is invalid or exceeds its length limits.', 'INVALID_SUBMISSION');
  return { ...request, source };
}

export async function readInput(input: string, timeoutMs: number): Promise<Buffer> {
  if (input !== 'stdin') {
    const handle = await fs.open(input, 'r');
    try {
      if ((await handle.stat()).size > MAX_MESSAGE_BYTES) throw new CliError('Input exceeds message limit.', 'MESSAGE_TOO_LARGE');
      // Limit the read as well: the file could grow after stat().
      const bytes = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_MESSAGE_BYTES) throw new CliError('Input exceeds message limit.', 'MESSAGE_TOO_LARGE');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      process.stdin.pause();
      if (error) reject(error); else resolve(Buffer.concat(chunks, length));
    };
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_MESSAGE_BYTES) finish(new CliError('Input exceeds message limit.', 'MESSAGE_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new CliError('Timed out reading stdin.', 'TIMEOUT')), timeoutMs);
    process.stdin.on('data', onData).once('end', onEnd).once('error', onError);
    process.stdin.resume();
  });
}

function connect(pipe: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    const timer = setTimeout(() => { socket.destroy(); reject(new CliError('Timed out connecting to DiffEditor.', 'TIMEOUT')); }, timeoutMs);
    const onError = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('error', onError);
    socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', onError); resolve(socket); });
  });
}

async function appCommand(): Promise<{ exe: string; args: string[]; cwd: string }> {
  const entryDir = path.dirname(path.resolve(process.argv[1]));
  const project = path.resolve(entryDir, '..');
  const explicit = process.env.DIFFEDITOR_EXE;
  const candidates = explicit ? [{ exe: path.resolve(explicit), args: [] as string[], cwd: path.dirname(path.resolve(explicit)) }] : [
    { exe: path.join(entryDir, 'DiffEditor.exe'), args: [], cwd: entryDir },
    { exe: path.join(project, 'release', version, 'win-unpacked', 'DiffEditor.exe'), args: [], cwd: project },
    { exe: path.join(project, 'release', 'win-unpacked', 'DiffEditor.exe'), args: [], cwd: project },
    { exe: path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [project], cwd: project },
  ];
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate.exe)).isFile()) return candidate; } catch { /* Try next supported location. */ }
  }
  throw new CliError('DiffEditor executable not found. Build/package the app or set DIFFEDITOR_EXE.', 'APP_NOT_FOUND');
}

async function launchApp(): Promise<void> {
  const command = await appCommand();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.exe, command.args, { cwd: command.cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function sendRequest(request: CliRequest, timeoutMs = 20_000): Promise<unknown> {
  const message = Buffer.from(JSON.stringify(request) + '\n', 'utf8');
  if (message.length > MAX_MESSAGE_BYTES) throw new CliError('Request exceeds message limit.', 'MESSAGE_TOO_LARGE');
  const deadline = Date.now() + timeoutMs;
  const pipe = pipeName();
  let socket: net.Socket;
  try { socket = await connect(pipe, Math.min(timeoutMs, 1000)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['ENOENT', 'ECONNREFUSED'].includes(code ?? '')) throw error;
    if (process.env.DIFFEDITOR_PIPE && !process.env.DIFFEDITOR_EXE) {
      throw new CliError('Custom DiffEditor pipe is unavailable; automatic startup is disabled without DIFFEDITOR_EXE.', 'UNAVAILABLE');
    }
    await launchApp();
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CliError('DiffEditor did not become ready before the timeout.', 'TIMEOUT');
      try { socket = await connect(pipe, Math.min(remaining, 500)); break; }
      catch (retryError) {
        if (!['ENOENT', 'ECONNREFUSED', 'TIMEOUT'].includes((retryError as NodeJS.ErrnoException).code ?? '')) throw retryError;
        await delay(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const responseTimeout = request.command === 'wait' ? request.payload.timeoutMs + timeoutMs : Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => finish(new CliError('Timed out waiting for DiffEditor response; operation outcome is unknown. Query status before retrying.', 'TIMEOUT')), responseTimeout);
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new CliError('Connection closed before a complete response; operation outcome is unknown.', 'INCOMPLETE_RESPONSE')));
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_MESSAGE_BYTES) { finish(new CliError('Response exceeds message limit.', 'MESSAGE_TOO_LARGE')); return; }
      chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline === -1) return;
      try {
        const bytes = Buffer.concat(chunks, length);
        const end = bytes.indexOf(10);
        if (end !== bytes.length - 1) throw new CliError('Unexpected data after response frame.', 'INVALID_RESPONSE');
        const reply = JSON.parse(decode(bytes.subarray(0, end))) as WireReply;
        if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') throw new CliError('Malformed response envelope.', 'INVALID_RESPONSE');
        if (!reply.ok) {
          if (typeof reply.error !== 'string') throw new CliError('Malformed error response.', 'INVALID_RESPONSE');
          if (reply.reviewIds !== undefined && (!Array.isArray(reply.reviewIds) || reply.reviewIds.some(id => typeof id !== 'string'))) throw new CliError('Malformed review IDs in error response.', 'INVALID_RESPONSE');
          finish(new CliError(reply.error, typeof reply.code === 'string' ? reply.code : 'APP_ERROR', reply.reviewIds));
        } else if (!Object.hasOwn(reply, 'result')) throw new CliError('Missing response result.', 'INVALID_RESPONSE');
        else finish(undefined, reply.result);
      } catch (error) { finish(error instanceof CliError ? error : new CliError('Response is not valid JSON.', 'INVALID_RESPONSE')); }
    });
    socket.write(message);
  });
}
