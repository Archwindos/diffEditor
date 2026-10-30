import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WithdrawCoordinator } from '../src/main/withdraw';
import { createPipeServer } from '../src/main/server';
import { ReviewStore } from '../src/core/store';
import type { WithdrawFinished, WithdrawPreflight, WithdrawRequest, WithdrawResponse, WireReply } from '../src/shared/contracts';

function rendererFixture(timeoutMs = 100) {
  const messages: { channel: string; payload: WithdrawPreflight | WithdrawFinished }[] = [];
  const renderer = { id: 17, send: (channel: string, payload: WithdrawPreflight | WithdrawFinished) => { messages.push({ channel, payload }); } };
  const coordinator = new WithdrawCoordinator(() => renderer, timeoutMs);
  return { messages, renderer, coordinator };
}
const input = { reviewId: 'review-id', requestId: 'request-id' };
const hasCode = (code: string) => (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; };

test('withdraw coordinator holds its unique lock through ACK until the serial operation finishes', async () => {
  const { coordinator, messages, renderer } = rendererFixture();
  const ready = coordinator.beforeWithdraw(input);
  const request = messages[0].payload;
  assert.equal(messages[0].channel, 'review:before-withdraw'); assert.equal(request.reviewId, input.reviewId);
  assert.equal(coordinator.ready(renderer.id + 1, request.token), false);
  assert.equal(coordinator.ready(renderer.id, 'forged-token'), false);
  assert.equal(messages.length, 1);
  assert.equal(coordinator.ready(renderer.id, request.token), true);
  assert.equal(coordinator.ready(renderer.id, request.token), false);
  const finish = await ready;
  assert.equal(messages.length, 1);
  const receipt = { withdrawnAt: '2026-10-30T00:00:00.000Z' } as WithdrawResponse;
  finish(receipt); finish(receipt);
  assert.deepEqual(messages[1], { channel: 'review:withdraw-finished', payload: { ...request, withdrawnAt: receipt.withdrawnAt } });
  assert.equal(messages.length, 2); assert.equal(coordinator.ready(renderer.id, request.token), false);
});

test('withdraw coordinator fails closed on missing renderer, send failure and draft flush error', async () => {
  await assert.rejects(new WithdrawCoordinator(() => undefined).beforeWithdraw(input), hasCode('WITHDRAW_RENDERER_UNAVAILABLE'));
  const broken = new WithdrawCoordinator(() => ({ id: 1, send() { throw new Error('destroyed'); } }));
  await assert.rejects(broken.beforeWithdraw(input), hasCode('WITHDRAW_RENDERER_UNAVAILABLE'));
  const { coordinator, messages, renderer } = rendererFixture();
  const refused = assert.rejects(coordinator.beforeWithdraw(input), hasCode('WITHDRAW_PREFLIGHT_FAILED'));
  assert.equal(coordinator.ready(renderer.id, messages[0].payload.token, '草稿缓存失败'), true);
  await refused;
  assert.deepEqual(messages[1], { channel: 'review:withdraw-finished', payload: messages[0].payload });
});

test('withdraw coordinator releases failed locks on bounded timeout and ignores late or wrong ACKs', async () => {
  const { coordinator, messages, renderer } = rendererFixture(10);
  const refused = assert.rejects(coordinator.beforeWithdraw(input), hasCode('WITHDRAW_PREFLIGHT_TIMEOUT'));
  const request = messages[0].payload;
  assert.equal(coordinator.ready(renderer.id + 1, request.token), false);
  await refused;
  assert.deepEqual(messages[1], { channel: 'review:withdraw-finished', payload: request });
  assert.equal(coordinator.ready(renderer.id, request.token), false);
});

test('withdraw coordinator aborts pending preflights when their renderer exits', async () => {
  const { coordinator, messages, renderer } = rendererFixture();
  const refused = assert.rejects(coordinator.beforeWithdraw(input), hasCode('WITHDRAW_RENDERER_UNAVAILABLE'));
  coordinator.rendererGone(renderer.id + 1); assert.equal(messages.length, 1);
  coordinator.rendererGone(renderer.id); await refused;
  assert.deepEqual(messages[1], { channel: 'review:withdraw-finished', payload: messages[0].payload });
});

test('concurrent withdraw tokens release independently and failure finishes without a success timestamp', async () => {
  const { coordinator, messages, renderer } = rendererFixture();
  const first = coordinator.beforeWithdraw(input), second = coordinator.beforeWithdraw(input);
  const [a, b] = messages.map(message => message.payload);
  assert.notEqual(a.token, b.token);
  coordinator.ready(renderer.id, a.token); const finishA = await first; finishA();
  assert.deepEqual(messages[2], { channel: 'review:withdraw-finished', payload: a });
  coordinator.ready(renderer.id, b.token); const finishB = await second; finishB();
  assert.deepEqual(messages[3], { channel: 'review:withdraw-finished', payload: b });
});

async function pipeCall(pipe: string, input: WithdrawRequest): Promise<WireReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe); let output = '';
    socket.on('error', reject);
    socket.setEncoding('utf8').on('data', bytes => { output += bytes; });
    socket.on('end', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    socket.on('connect', () => socket.write(JSON.stringify({ command: 'withdraw', payload: { ...input, requireUnedited: true } }) + '\n'));
  });
}

async function pipeFixture(t: { after: (fn: () => Promise<void>) => void }, coordinator: WithdrawCoordinator) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-withdraw-pipe-'));
  const dataDir = path.join(root, 'cache'), target = path.join(root, 'original.txt');
  await fs.writeFile(target, 'original\r\n', { flag: 'wx' });
  const store = new ReviewStore({ dataDir }); await store.init();
  const baseline = await store.baseline({ paths: [target] }), requestId = randomUUID();
  const { reviewIds: [reviewId] } = await store.submit({ requestId, files: [{ baselineId: baseline.files[0].id, text: 'candidate\n' }] });
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\diffeditor-withdraw-${randomUUID()}` : path.join(os.tmpdir(), `de-${randomUUID()}.sock`);
  const server = createPipeServer(store, () => assert.fail('withdraw must not restore window'), coordinator.beforeWithdraw);
  await new Promise<void>(resolve => server.listen(pipe, resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('diffeditor-withdraw-pipe-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { store, dataDir, target, pipe, request: { reviewId, requestId } };
}

for (const side of ['left', 'right'] as const) test(`real pipe flushes pending ${side} typing before checking edits and leaves proposal active on refusal`, async t => {
  let flush!: (request: WithdrawPreflight) => Promise<void>;
  const messages: { channel: string; payload: WithdrawPreflight | WithdrawFinished }[] = [];
  const coordinator = new WithdrawCoordinator(() => ({ id: 12, send(channel, payload) {
    messages.push({ channel, payload });
    if (channel === 'review:before-withdraw') void flush(payload);
  } }));
  const fixture = await pipeFixture(t, coordinator), { store, request, dataDir, target, pipe } = fixture;
  const preview = await store.prepareSave({ reviewId: request.reviewId, side: 'right', expectedRevision: 0 });
  flush = async ({ token }) => {
    await store.updateDraft({ reviewId: request.reviewId, side, expectedRevision: 0, text: 'typed before debounce\n' });
    coordinator.ready(12, token);
  };
  const reply = await pipeCall(pipe, request);
  assert.equal(reply.ok, false);
  if (reply.ok) assert.fail('expected refusal');
  assert.equal(reply.code, 'WITHDRAW_HAS_HUMAN_EDITS'); assert.deepEqual(reply.reviewIds, [request.reviewId]);
  const review = store.list().reviews[0];
  assert.equal(review[side].text, 'typed before debounce\n'); assert.equal(review[side].revision, 1);
  assert.equal(review.targets[0].status, 'pending'); assert.equal(review.withdrawnAt, undefined);
  assert.equal(messages.length, 2); assert.deepEqual(messages[1], { channel: 'review:withdraw-finished', payload: messages[0].payload });
  assert.equal(await fs.readFile(target, 'utf8'), 'original\r\n');
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(durable.plans[preview.token].phase, 'prepared');
  const recovered = new ReviewStore({ dataDir }); await recovered.init(); assert.deepEqual(recovered.list(), store.list());
  const retry = await pipeCall(pipe, request); assert.equal(retry.ok, false); assert.equal(messages.length, 2);
  await assert.rejects(store.openFiles({ mode: 'single', paths: [target] }), /已有待处理审查/);
});

test('real pipe fails closed without renderer ACK and keeps all state byte-for-byte unchanged', async t => {
  const { coordinator } = rendererFixture(10);
  const { store, dataDir, target, pipe, request } = await pipeFixture(t, coordinator);
  const before = store.list(), statePath = path.join(dataDir, 'state.json'), cache = await fs.readFile(statePath);
  const reply = await pipeCall(pipe, request);
  assert.equal(reply.ok, false); if (reply.ok) assert.fail('expected refusal');
  assert.equal(reply.code, 'WITHDRAW_PREFLIGHT_TIMEOUT');
  assert.deepEqual(store.list(), before); assert.deepEqual(await fs.readFile(statePath), cache);
  assert.equal(await fs.readFile(target, 'utf8'), 'original\r\n');
});

test('real pipe validates proof before UI lock and skips UI only for previously withdrawn receipts, including deletion', async t => {
  let available = true;
  const messages: { channel: string; payload: WithdrawPreflight | WithdrawFinished }[] = [];
  const coordinator = new WithdrawCoordinator(() => available ? { id: 15, send(channel, payload) {
    messages.push({ channel, payload });
    if (channel === 'review:before-withdraw') coordinator.ready(15, payload.token);
  } } : undefined);
  const { store, pipe, request } = await pipeFixture(t, coordinator);
  const wrong = await pipeCall(pipe, { ...request, requestId: 'wrong-owner' });
  assert.equal(wrong.ok, false); if (wrong.ok) assert.fail('expected refusal');
  assert.equal(wrong.code, 'WITHDRAW_NOT_OWNER'); assert.equal(messages.length, 0);
  available = false;
  const unavailable = await pipeCall(pipe, request);
  assert.equal(unavailable.ok, false); if (unavailable.ok) assert.fail('expected refusal');
  assert.equal(unavailable.code, 'WITHDRAW_RENDERER_UNAVAILABLE'); assert.equal(messages.length, 0);
  available = true;
  const receipt = await pipeCall(pipe, request); assert.equal(receipt.ok, true);
  if (!receipt.ok) assert.fail('expected withdrawal');
  const result = receipt.result as WithdrawResponse;
  assert.equal(messages.length, 2); assert.deepEqual(messages[1], { channel: 'review:withdraw-finished', payload: { ...messages[0].payload, withdrawnAt: result.withdrawnAt } });
  await store.setReviewClosed(request.reviewId, true); await store.deleteReview(request.reviewId); available = false;
  const duplicate = await pipeCall(pipe, request); assert.equal(duplicate.ok, true);
  if (!duplicate.ok) assert.fail('expected duplicate receipt');
  const replay = duplicate.result as WithdrawResponse;
  assert.equal(replay.duplicate, true); assert.equal(replay.withdrawnAt, result.withdrawnAt); assert.equal(replay.review.lifecycle, 'deleted');
  assert.equal(messages.length, 2);
});
