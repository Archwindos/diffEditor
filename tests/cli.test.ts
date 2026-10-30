import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs, parseSubmission, sendRequest, withSubmissionSource } from '../src/cli/client';
import { MAX_MESSAGE_BYTES } from '../src/shared/transport';
import { ReviewStore } from '../src/core/store';
import { createPipeServer } from '../src/main/server';
import { REVIEW_SOURCE_LIMITS } from '../src/shared/contracts';

function uniquePipe(): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\diffeditor-test-${randomUUID()}` : path.join(os.tmpdir(), `de-${randomUUID()}.sock`);
}
async function cli(args: string[], pipe: string, input?: string | Buffer, timeout = 3000, envOverrides: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; value: any; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DIFFEDITOR_PIPE: pipe, DIFFEDITOR_TIMEOUT_MS: String(timeout), ...envOverrides };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.DIFFEDITOR_EXE;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], { env, cwd: path.resolve('.'), windowsHide: true, stdio: 'pipe' });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      try { resolve({ code, value: JSON.parse(stdout), stderr }); } catch (error) { reject(new Error(`Invalid CLI output ${stdout}; ${stderr}`, { cause: error })); }
    });
    child.stdin.end(input);
  });
}
async function serverFixture(handler: (socket: net.Socket, request: any) => void) {
  const pipe = uniquePipe();
  const sockets = new Set<net.Socket>();
  let requests = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let data = '';
    socket.setEncoding('utf8').on('data', chunk => {
      data += chunk;
      if (data.includes('\n')) { requests++; handler(socket, JSON.parse(data.trim())); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  return { pipe, requests: () => requests, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('unsupported save/approval commands are rejected before contacting the server', async () => {
  const fixture = await serverFixture(() => assert.fail('Unsupported command reached server'));
  try {
    for (const command of ['approve', 'save', 'force-save', 'reject', 'delete', 'status --force', 'baseline --approve']) {
      const result = await cli(command.split(' '), fixture.pipe);
      assert.equal(result.code, 1);
      assert.equal(result.value.code, 'ARGUMENT_ERROR');
    }
    assert.equal(fixture.requests(), 0);
  } finally { await fixture.close(); }
});

test('withdraw accepts exactly the review ID and original request proof, requires the unedited protocol, and passes the receipt through unchanged', async () => {
  const payload = { reviewId: 'review-id', requestId: 'original-submit-request', requireUnedited: true };
  assert.deepEqual(parseArgs(['withdraw', payload.reviewId, '--request-id', payload.requestId]).request, { command: 'withdraw', payload });
  for (const args of [
    ['withdraw'], ['withdraw', 'r'], ['withdraw', 'r', '--request-id'], ['withdraw', 'r', '--request-id', ''],
    ['withdraw', ' ', '--request-id', 'q'], ['withdraw', 'r', '--request-id', ' '], ['withdraw', '--request-id', 'q'],
    ['withdraw', 'r', '--request-id', '--force'], ['withdraw', 'r', '--request-id', 'q', '--force'],
    ['withdraw', 'r', '--request-id', 'q', '--approve'], ['withdraw', 'r', '--request-id', 'q', 'other'],
    ['withdraw', 'r', '--file', 'payload.json'], ['withdraw', 'r', '--request-id', 'q', '--request-id', 'q'],
    ['withdraw', 'r', '--request-id', 'q', '--require-unedited', 'false'],
  ]) assert.throws(() => parseArgs(args), error => (error as { code: string }).code === 'ARGUMENT_ERROR');
  const receipt = { reviewId: payload.reviewId, status: 'withdrawn', withdrawnAt: '2026-10-30T00:00:00.000Z', duplicate: false,
    review: { id: payload.reviewId, leftRevision: 2, rightRevision: 3, targets: [{ status: 'withdrawn' }], lifecycle: 'open' } };
  const fixture = await serverFixture((socket, request) => {
    assert.deepEqual(request, { command: 'withdraw', payload });
    socket.end(JSON.stringify({ ok: true, result: receipt }) + '\n');
  });
  try {
    const result = await cli(['withdraw', payload.reviewId, '--request-id', payload.requestId], fixture.pipe);
    assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.deepEqual(result.value, receipt);
    assert.equal(fixture.requests(), 1);
  } finally { await fixture.close(); }
});

test('new CLI refuses an old strict withdrawal protocol without retrying or dropping its unedited requirement', async () => {
  const fixture = await serverFixture((socket, request) => {
    // v15 accepts only these two payload keys, so the version guard must make it reject rather than silently use its old policy.
    const oldProtocolAccepts = Object.keys(request.payload).every(key => ['reviewId', 'requestId'].includes(key));
    assert.equal(request.payload.requireUnedited, true); assert.equal(oldProtocolAccepts, false);
    socket.end(JSON.stringify({ ok: false, error: '撤回需要 reviewId 和原提交 requestId' }) + '\n');
  });
  try {
    const result = await cli(['withdraw', 'r', '--request-id', 'q'], fixture.pipe);
    assert.equal(result.code, 1); assert.equal(result.value.ok, false); assert.equal(fixture.requests(), 1);
  } finally { await fixture.close(); }
});

const defaultSource = { agent: 'Codex', ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}) };

test('baseline resolves file arguments and preserves explicit encoding', async () => {
  const fixture = await serverFixture((socket, request) => {
    assert.deepEqual(request, { command: 'baseline', payload: { paths: [path.resolve('论文 草稿.tex')], encoding: 'gb18030' } });
    socket.end(JSON.stringify({ ok: true, result: { files: [{ id: 'immutable-id', text: '原文' }] } }) + '\n');
  });
  try {
    const result = await cli(['baseline', '论文 草稿.tex', '--encoding', 'gb18030'], fixture.pipe);
    assert.equal(result.code, 0);
    assert.equal(result.value.files[0].id, 'immutable-id');
    assert.equal(result.stderr, '');
  } finally { await fixture.close(); }
});

test('stdin carries structured Unicode and shell characters literally', async () => {
  const payload = { requestId: 'stable-request', title: '论文审阅 🧪', files: [{ baselineId: 'b1', text: '\\section{修改}\n中文 ` $() & < > "\r\n😀' }] };
  const fixture = await serverFixture((socket, request) => {
    assert.deepEqual(request, { command: 'submit', payload: { ...payload, source: defaultSource } });
    const bytes = Buffer.from(JSON.stringify({ ok: true, result: { reviewIds: ['r1'], duplicate: false } }) + '\n');
    socket.write(bytes.subarray(0, 5));
    socket.end(bytes.subarray(5));
  });
  try {
    const result = await cli(['submit', '--stdin'], fixture.pipe, JSON.stringify(payload));
    assert.equal(result.code, 0);
    assert.deepEqual(result.value, { reviewIds: ['r1'], duplicate: false });
  } finally { await fixture.close(); }
});

test('UTF-8 JSON file submission and duplicate receipts are returned without rewriting them', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-cli-'));
  const input = path.join(directory, '提案.json');
  const payload = { requestId: 'same-request', files: [{ baselineId: 'b1', text: '候选内容' }] };
  await fs.writeFile(input, JSON.stringify(payload), 'utf8');
  const fixture = await serverFixture((socket, request) => {
    assert.deepEqual(request.payload, { ...payload, source: defaultSource });
    socket.end(JSON.stringify({ ok: true, result: { reviewIds: ['existing'], duplicate: true } }) + '\n');
  });
  try {
    const result = await cli(['submit', '--file', input], fixture.pipe);
    assert.equal(result.code, 0);
    assert.equal(result.value.duplicate, true);
    assert.equal(await fs.readFile(input, 'utf8'), JSON.stringify(payload));
  } finally {
    await fixture.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('diffeditor-cli-'));
    await fs.rm(directory, { recursive: true });
  }
});

test('invalid input fails locally and cannot inject a different command', async () => {
  const fixture = await serverFixture(() => assert.fail('Invalid input reached server'));
  try {
    for (const input of ['not-json', '{"command":"save"}', '{"requestId":"x","files":[]}', Buffer.from([0xff])]) {
      const result = await cli(['submit', '--stdin'], fixture.pipe, input);
      assert.equal(result.code, 1);
      assert.equal(result.value.ok, false);
    }
    assert.equal(fixture.requests(), 0);
  } finally { await fixture.close(); }
});

test('source metadata is validated locally and source defaults never fabricate a chat title', async () => {
  const payload = { requestId: 'source', files: [{ baselineId: 'b1', text: 'candidate' }] };
  const fixture = await serverFixture(() => assert.fail('Invalid source reached server'));
  try {
    const invalid = [null, [], {}, { agent: '' }, { agent: ' ' }, { agent: 1 }, { agent: 'Codex', threadId: null },
      { agent: 'Codex', threadTitle: 1 }, { agent: 'Codex', threadId: '' }, { agent: 'Codex', threadTitle: ' ' },
      { agent: 'Codex', extra: 'field' },
      ...Object.entries(REVIEW_SOURCE_LIMITS).map(([field, limit]) => ({ agent: 'Codex', [field]: 'x'.repeat(limit + 1) }))];
    for (const source of invalid) {
      const input = JSON.stringify({ ...payload, source });
      assert.throws(() => parseSubmission(Buffer.from(input)), error => (error as { code: string }).code === 'INVALID_SUBMISSION');
      const result = await cli(['submit', '--stdin'], fixture.pipe, input);
      assert.equal(result.code, 1); assert.equal(result.value.code, 'INVALID_SUBMISSION');
    }
    assert.equal(fixture.requests(), 0);
    const atLimits = { agent: 'a'.repeat(REVIEW_SOURCE_LIMITS.agent), threadId: 'i'.repeat(REVIEW_SOURCE_LIMITS.threadId), threadTitle: 't'.repeat(REVIEW_SOURCE_LIMITS.threadTitle) };
    assert.deepEqual(parseSubmission(Buffer.from(JSON.stringify({ ...payload, source: atLimits }))).source, atLimits);
    assert.deepEqual(withSubmissionSource(payload, {}), { ...payload, source: { agent: 'Codex' } });
    assert.deepEqual(withSubmissionSource({ ...payload, source: { agent: 'Research Agent', threadTitle: 'Known chat' } }, { CODEX_THREAD_ID: 'thread-from-env' }).source,
      { agent: 'Research Agent', threadId: 'thread-from-env', threadTitle: 'Known chat' });
    assert.deepEqual(withSubmissionSource({ ...payload, source: { agent: 'Research Agent', threadId: 'explicit' } }, { CODEX_THREAD_ID: 'other' }).source,
      { agent: 'Research Agent', threadId: 'explicit' });
    assert.throws(() => withSubmissionSource(payload, { CODEX_THREAD_ID: 'x'.repeat(REVIEW_SOURCE_LIMITS.threadId + 1) }), /Source metadata/);
  } finally { await fixture.close(); }
});

test('real CLI source defaults and explicit metadata persist through status, wait, deletion and restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-cli-source-')), dataDir = path.join(directory, 'cache');
  const store = new ReviewStore({ dataDir }); await store.init();
  const target = path.join(directory, 'source.txt'); await fs.writeFile(target, 'original');
  const pipe = uniquePipe(), server = createPipeServer(store, () => {});
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  const baseline = await cli(['baseline', target], pipe), request = { requestId: 'source-default', files: [{ baselineId: baseline.value.files[0].id, text: 'candidate' }] };
  const expected = { agent: 'Codex', threadId: 'actual-child-env-thread' };
  const result = await cli(['submit', '--stdin'], pipe, JSON.stringify(request), 3000, { CODEX_THREAD_ID: expected.threadId });
  assert.equal(result.code, 0); const id = result.value.reviewIds[0];
  assert.deepEqual(store.list().reviews[0].source, expected);
  const activeReloaded = new ReviewStore({ dataDir }); await activeReloaded.init();
  assert.deepEqual(activeReloaded.list().reviews[0].source, expected); assert.deepEqual(activeReloaded.status(id).reviews[0].source, expected);
  const status = await cli(['status', id], pipe), wait = await cli(['wait', id, '--timeout', '1'], pipe);
  assert.deepEqual(status.value.reviews[0].source, expected); assert.deepEqual(wait.value.reviews[0].source, expected);
  const retrySource = { agent: 'Explicit Agent', threadId: 'explicit-thread', threadTitle: 'Actual supplied title' };
  const retry = await cli(['submit', '--stdin'], pipe, JSON.stringify({ ...request, source: retrySource }), 3000, { CODEX_THREAD_ID: 'ignored-env' });
  assert.deepEqual(retry.value, { reviewIds: [id], duplicate: true }); assert.deepEqual(store.status(id).reviews[0].source, expected);
  await store.setReviewClosed(id, true); await store.deleteReview(id);
  const deleted = await cli(['status', id], pipe); assert.deepEqual(deleted.value.reviews[0].source, expected);
  const deletedWait = await cli(['wait', id, '--timeout', '1'], pipe);
  assert.equal(deletedWait.value.reason, 'attention'); assert.deepEqual(deletedWait.value.reviews[0].source, expected);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  assert.deepEqual(reloaded.status(id).reviews[0].source, expected);
  assert.equal(reloaded.status(id).reviews[0].lifecycle, 'deleted');
  const nextBaseline = await cli(['baseline', target], pipe);
  const explicit = await cli(['submit', '--stdin'], pipe, JSON.stringify({ requestId: 'source-explicit', source: retrySource,
    files: [{ baselineId: nextBaseline.value.files[0].id, text: 'explicit candidate' }] }), 3000, { CODEX_THREAD_ID: 'ignored-env' });
  assert.equal(explicit.code, 0); assert.deepEqual(store.status(explicit.value.reviewIds[0]).reviews[0].source, retrySource);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(directory, '.diffeditor-backups')), { code: 'ENOENT' });
});

test('application error receipts use a nonzero exit', async () => {
  const fixture = await serverFixture(socket => socket.end(JSON.stringify({ ok: false, code: 'CONFLICT', error: '文件已变更' }) + '\n'));
  try {
    const result = await cli(['status', 'r1'], fixture.pipe);
    assert.equal(result.code, 1);
    assert.deepEqual(result.value, { ok: false, code: 'CONFLICT', error: '文件已变更' });
  } finally { await fixture.close(); }
});

test('real CLI reports occupied review IDs and expired baselines without reopening review windows', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-cli-round-'));
  const store = new ReviewStore({ dataDir: path.join(directory, 'cache') }); await store.init();
  const target = path.join(directory, 'sample.txt'); await fs.writeFile(target, 'original');
  const pipe = uniquePipe(); let shown = 0;
  const server = createPipeServer(store, () => shown++);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  const baseline = await cli(['baseline', target], pipe), otherBaseline = await cli(['baseline', target], pipe);
  assert.equal(baseline.code, 0); assert.equal(otherBaseline.code, 0);
  const request = { requestId: 'first', files: [{ baselineId: baseline.value.files[0].id, text: 'candidate' }] };
  const first = await cli(['submit', '--stdin'], pipe, JSON.stringify(request));
  assert.equal(first.code, 0);
  const retry = await cli(['submit', '--stdin'], pipe, JSON.stringify(request));
  assert.deepEqual(retry.value, { reviewIds: first.value.reviewIds, duplicate: true });
  const next = { requestId: 'second', files: [{ baselineId: otherBaseline.value.files[0].id, text: 'queued candidate' }] };
  const occupied = await cli(['submit', '--stdin'], pipe, JSON.stringify(next));
  assert.equal(occupied.code, 1); assert.equal(occupied.value.code, 'REVIEW_IN_PROGRESS');
  assert.deepEqual(occupied.value.reviewIds, first.value.reviewIds); assert.equal(occupied.stderr, '');
  await store.rejectReview(first.value.reviewIds[0]);
  const expired = await cli(['submit', '--stdin'], pipe, JSON.stringify(next));
  assert.equal(expired.code, 1); assert.equal(expired.value.code, 'BASELINE_EXPIRED');
  assert.deepEqual(expired.value.reviewIds, first.value.reviewIds);
  assert.equal(shown, 1); assert.equal(store.list().reviews.length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
});

test('malformed, truncated, and extra response frames fail clearly', async () => {
  for (const [response, code] of [['{bad}\n', 'INVALID_RESPONSE'], ['{"ok":true}', 'INCOMPLETE_RESPONSE'], ['{}\n{}\n', 'INVALID_RESPONSE'], ['{"ok":true}\n', 'INVALID_RESPONSE']]) {
    const fixture = await serverFixture(socket => socket.end(response));
    try {
      const result = await cli(['status'], fixture.pipe);
      assert.equal(result.code, 1);
      assert.equal(result.value.code, code);
    } finally { await fixture.close(); }
  }
});

test('unavailable custom pipe never launches the GUI', async () => {
  const result = await cli(['status'], uniquePipe());
  assert.equal(result.code, 1);
  assert.equal(result.value.code, 'UNAVAILABLE');
});

test('oversized responses and invalid UTF-8 fail instead of producing a receipt', async () => {
  for (const [response, code] of [
    [Buffer.alloc(MAX_MESSAGE_BYTES + 1, 120), 'MESSAGE_TOO_LARGE'],
    [Buffer.from([0xff, 10]), 'INVALID_UTF8'],
  ] as const) {
    const fixture = await serverFixture(socket => socket.end(response));
    try {
      const result = await cli(['status'], fixture.pipe);
      assert.equal(result.code, 1);
      assert.equal(result.value.code, code);
    } finally { await fixture.close(); }
  }
});

test('response timeout reports unknown outcome without replaying request', async () => {
  const fixture = await serverFixture(() => {});
  try {
    const result = await cli(['status'], fixture.pipe, undefined, 100);
    assert.equal(result.code, 1);
    assert.equal(result.value.code, 'TIMEOUT');
    assert.match(result.value.error, /unknown/);
    assert.equal(fixture.requests(), 1);
  } finally { await fixture.close(); }
});

test('size and argument limits are enforced before connecting', async () => {
  assert.throws(() => parseSubmission(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), /limit/);
  assert.throws(() => parseArgs(['baseline', 'file', '--encoding', 'latin1']), /encoding/);
  assert.throws(() => parseSubmission(Buffer.from(JSON.stringify({ requestId: 'x', files: [{ baselineId: 'x', text: '' }, { baselineId: 'x', text: '' }] }))), /repeated/);
  await assert.rejects(sendRequest({ command: 'submit', payload: { requestId: 'x', files: [{ baselineId: 'x', text: 'x'.repeat(MAX_MESSAGE_BYTES) }] } }), /limit/);
});

test('wait parses unique review IDs and bounded seconds without approval options', () => {
  assert.deepEqual(parseArgs(['wait', 'first', 'second']).request,
    { command: 'wait', payload: { reviewIds: ['first', 'second'], timeoutMs: 1800000 } });
  assert.deepEqual(parseArgs(['wait', 'first', '--timeout', '86400', 'second']).request,
    { command: 'wait', payload: { reviewIds: ['first', 'second'], timeoutMs: 86400000 } });
  for (const args of [
    ['wait'], ['wait', ''], ['wait', ' '], ['wait', 'r1', 'r1'],
    ['wait', 'r1', '--approve'], ['wait', 'r1', '--timeout'],
    ...['0', '-1', '1.5', '86401', 'NaN', 'Infinity'].map(value => ['wait', 'r1', '--timeout', value]),
    ['wait', 'r1', '--timeout', '1', '--timeout', '2'],
  ]) assert.throws(() => parseArgs(args), error => (error as { code: string }).code === 'ARGUMENT_ERROR');
});

test('wait has its own response deadline and all three outcomes exit successfully without replay', async () => {
  for (const reason of ['saved', 'attention', 'timeout']) {
    const result = { reason, reviews: [{ id: 'first' }, { id: 'second' }] };
    const fixture = await serverFixture((socket, request) => {
      assert.deepEqual(request, { command: 'wait', payload: { reviewIds: ['first', 'second'], timeoutMs: 1000 } });
      setTimeout(() => socket.end(JSON.stringify({ ok: true, result }) + '\n'), 150);
    });
    try {
      const output = await cli(['wait', 'first', 'second', '--timeout', '1'], fixture.pipe, undefined, 50);
      assert.equal(output.code, 0); assert.equal(output.stderr, ''); assert.deepEqual(output.value, result);
      assert.equal(fixture.requests(), 1);
    } finally { await fixture.close(); }
  }
});
