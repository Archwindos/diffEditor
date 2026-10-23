import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs, parseSubmission, sendRequest } from '../src/cli/client';
import { MAX_MESSAGE_BYTES } from '../src/shared/transport';

function uniquePipe(): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\diffeditor-test-${randomUUID()}` : path.join(os.tmpdir(), `de-${randomUUID()}.sock`);
}
async function cli(args: string[], pipe: string, input?: string | Buffer, timeout = 3000) {
  return new Promise<{ code: number | null; value: any; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DIFFEDITOR_PIPE: pipe, DIFFEDITOR_TIMEOUT_MS: String(timeout) };
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
    for (const command of ['approve', 'save', 'force-save', 'status --force', 'baseline --approve']) {
      const result = await cli(command.split(' '), fixture.pipe);
      assert.equal(result.code, 1);
      assert.equal(result.value.code, 'ARGUMENT_ERROR');
    }
    assert.equal(fixture.requests(), 0);
  } finally { await fixture.close(); }
});

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
    assert.deepEqual(request, { command: 'submit', payload });
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
    assert.deepEqual(request.payload, payload);
    socket.end(JSON.stringify({ ok: true, result: { reviewIds: ['existing'], duplicate: true } }) + '\n');
  });
  try {
    const result = await cli(['submit', '--file', input], fixture.pipe);
    assert.equal(result.code, 0);
    assert.equal(result.value.duplicate, true);
    assert.equal(await fs.readFile(input, 'utf8'), JSON.stringify(payload));
  } finally { await fixture.close(); await fs.rm(directory, { recursive: true }); }
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

test('application error receipts use a nonzero exit', async () => {
  const fixture = await serverFixture(socket => socket.end(JSON.stringify({ ok: false, code: 'CONFLICT', error: '文件已变更' }) + '\n'));
  try {
    const result = await cli(['status', 'r1'], fixture.pipe);
    assert.equal(result.code, 1);
    assert.deepEqual(result.value, { ok: false, code: 'CONFLICT', error: '文件已变更' });
  } finally { await fixture.close(); }
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
