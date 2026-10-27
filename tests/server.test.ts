import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { handleCli, createPipeServer } from '../src/main/server';
import type { ReviewStore } from '../src/core/store';

test('the pipe cannot approve or write, even when the caller bypasses the CLI parser', async () => {
  let calls = 0;
  const store = new Proxy({}, { get() { return () => { calls++; throw new Error('unexpected operation'); }; } }) as ReviewStore;
  for (const command of ['approve', 'save', 'force-save', 'commitSave', 'review:commit', 'createTextReview', 'setReviewClosed', 'deleteReview', 'review:delete', 'deleteClosedReviews', 'review:delete-closed', 'constructor']) {
    const reply = await handleCli(store, { command, payload: { token: 'forged' } }, () => {});
    assert.equal(reply.ok, false);
  }
  assert.equal(calls, 0);
});

test('invalid protocol inputs fail without opening files or submitting a draft', async () => {
  let calls = 0;
  const store = new Proxy({}, { get() { return () => { calls++; }; } }) as ReviewStore;
  for (const input of [null, [], { command: 'baseline', payload: { paths: [] } },
    { command: 'baseline', payload: { paths: ['sample.tex'], encoding: 'guess' } },
    { command: 'submit', payload: { requestId: 'x', files: [{ baselineId: 'b', text: null }] } }]) {
    assert.equal((await handleCli(store, input, () => {})).ok, false);
  }
  assert.equal(calls, 0);
});

test('a fragmented UTF-8 pipe request preserves Chinese and backslashes and executes once', async () => {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\diffeditor-server-test-${randomUUID()}` : `/tmp/diffeditor-${randomUUID()}.sock`;
  const input = { command: 'submit', payload: { requestId: '样本', files: [{ baselineId: 'a', text: '\\section{中文}\r\n下一行' }] } };
  let received: unknown;
  let shown = 0;
  const store = { submit: async (request: unknown) => { received = request; return { reviewIds: ['r'], duplicate: false }; } } as ReviewStore;
  const server = createPipeServer(store, () => shown++);
  await new Promise<void>(resolve => server.listen(pipe, resolve));
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(pipe);
      let output = '';
      socket.on('error', reject);
      socket.on('data', b => output += b.toString('utf8'));
      socket.on('end', () => resolve(output));
      socket.on('connect', () => {
        const bytes = Buffer.from(JSON.stringify(input) + '\n');
        for (let i = 0; i < bytes.length; i += 3) socket.write(bytes.subarray(i, i + 3));
      });
    });
    assert.equal(JSON.parse(response).ok, true);
    assert.deepEqual(received, input.payload);
    assert.equal(shown, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
