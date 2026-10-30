import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ReviewStore, type Failpoint } from '../src/core/store';
import { decode, hash } from '../src/core/text';
import { waitForReviews } from '../src/main/wait';
import { createPipeServer, handleCli } from '../src/main/server';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, failpoint?: (point: Failpoint) => void | Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-wait-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('diffeditor-wait-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'cache');
  const store = new ReviewStore({ dataDir, failpoint }); await store.init();
  const target = path.join(root, '临时 样本.txt');
  await fs.writeFile(target, 'original\r\n中文\r\n', { flag: 'wx' });
  const baseline = await store.baseline({ paths: [target] });
  const request = { requestId: randomUUID(), files: [{ baselineId: baseline.files[0].id, text: 'AI proposal\n' }] };
  const { reviewIds: [reviewId] } = await store.submit(request);
  return { root, dataDir, store, target, reviewId };
}
async function save(store: ReviewStore, reviewId: string, side: 'left' | 'right' = 'right') {
  const review = store.list().reviews.find(review => review.id === reviewId)!;
  return store.commitSave((await store.prepareSave({ reviewId, side, expectedRevision: review[side].revision })).token);
}
async function pending(promise: Promise<unknown>) {
  assert.equal(await Promise.race([promise.then(() => 'settled'), delay(15, 'pending')]), 'pending');
}
function subscriptions(store: ReviewStore) {
  const subscribe = store.onDidChange.bind(store);
  let active = 0;
  store.onDidChange = listener => {
    active++;
    const unsubscribe = subscribe(listener);
    let disposed = false;
    return () => { if (!disposed) { disposed = true; active--; unsubscribe(); } };
  };
  return () => active;
}

test('wait observes durable completion only, with the actual user side, edited bytes, backup and receipt', async t => {
  const reached = gate(), resume = gate();
  const { store, reviewId, target, dataDir } = await fixture(t, async point => {
    if (point === 'afterReplace') { reached.release(); await resume.promise; }
  });
  const original = await fs.readFile(target);
  const count = subscriptions(store);
  const waiting = waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 1500 });
  await pending(waiting);
  await store.updateDraft({ reviewId, side: 'right', text: '用户实际选择\n手工修改\n', expectedRevision: 0 });
  await pending(waiting);
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 1 });
  await pending(waiting);
  const committing = store.commitSave(preview.token);
  try {
    await reached.promise;
    assert.equal(store.status(reviewId).reviews[0].targets[0].status, 'saving');
    assert.equal(decode(await fs.readFile(target)).text, '用户实际选择\n手工修改\n');
    await pending(waiting);
  } finally { resume.release(); }
  const receipt = await committing, result = await waiting;
  assert.equal(result.reason, 'saved');
  assert.deepEqual(result.reviews[0].targets[0].receipt, receipt);
  assert.equal(receipt.side, 'right');
  assert.equal(hash(await fs.readFile(target)), receipt.afterHash);
  assert.deepEqual(await fs.readFile(receipt.backupPath!), original);
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(durable.reviews[0].targets[0].receipt, receipt);
  assert.equal(count(), 0);
});

test('saved receipts are available after auto-close, restart, reopening and deletion without another write', async t => {
  const { store, reviewId, dataDir, target } = await fixture(t);
  const receipt = await save(store, reviewId);
  for (const lifecycle of ['closed', 'open', 'deleted'] as const) {
    if (lifecycle === 'open') await store.setReviewClosed(reviewId, false);
    if (lifecycle === 'deleted') { await store.setReviewClosed(reviewId, true); await store.deleteReview(reviewId); }
    const recovered = new ReviewStore({ dataDir }); await recovered.init();
    const before = await fs.readFile(path.join(dataDir, 'state.json'));
    const bytes = await fs.readFile(target);
    const result = await waitForReviews(recovered, { reviewIds: [reviewId], timeoutMs: 100 });
    assert.equal(result.reason, 'saved');
    assert.equal(result.reviews[0].lifecycle, lifecycle);
    assert.deepEqual(result.reviews[0].targets[0].receipt, receipt);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), before);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.equal((await fs.readdir(path.dirname(receipt.backupPath!))).length, 1);
  }
});

test('restart recovery verifies an interrupted replacement before wait reports saved', async t => {
  const { store, reviewId, dataDir, target } = await fixture(t, point => { if (point === 'afterReplace') throw new Error('interrupted'); });
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  await assert.rejects(store.commitSave(preview.token), /interrupted/);
  assert.equal((await waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 100 })).reason, 'attention');
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  const result = await waitForReviews(recovered, { reviewIds: [reviewId], timeoutMs: 100 });
  assert.equal(result.reason, 'saved');
  assert.equal(result.reviews[0].targets[0].receipt?.operationId, preview.token);
  assert.equal(hash(await fs.readFile(target)), result.reviews[0].targets[0].receipt?.afterHash);
});

test('multiple reviews retain requested order and wait until every requested review is saved', async t => {
  const { store, root, reviewId } = await fixture(t);
  const other = path.join(root, 'other.txt'); await fs.writeFile(other, 'second');
  const second = (await store.openFiles({ paths: [other], mode: 'single' })).reviews.at(-1)!;
  const waiting = waitForReviews(store, { reviewIds: [second.id, reviewId], timeoutMs: 1500 });
  await save(store, reviewId);
  await store.setReviewClosed(reviewId, true);
  await pending(waiting);
  const partial = await waitForReviews(store, { reviewIds: [second.id, reviewId], timeoutMs: 30 });
  assert.equal(partial.reason, 'timeout');
  assert.deepEqual(partial.reviews.map(review => review.targets[0].status), ['pending', 'saved']);
  await save(store, second.id);
  const result = await waiting;
  assert.equal(result.reason, 'saved');
  assert.deepEqual(result.reviews.map(review => review.id), [second.id, reviewId]);
});

test('a pair requires every target receipt; a text comparison with no targets cannot report saved', async t => {
  const { store, root } = await fixture(t);
  const left = path.join(root, 'left.txt'), right = path.join(root, 'right.txt');
  await fs.writeFile(left, 'left'); await fs.writeFile(right, 'right');
  const review = (await store.openFiles({ paths: [left, right], mode: 'pair' })).reviews.at(-1)!;
  await save(store, review.id, 'left');
  const result = await waitForReviews(store, { reviewIds: [review.id], timeoutMs: 30 });
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(result.reviews[0].targets.map(target => target.status), ['saved', 'pending']);
  await save(store, review.id, 'right');
  assert.equal((await waitForReviews(store, { reviewIds: [review.id], timeoutMs: 100 })).reason, 'saved');
  const text = await store.createTextReview();
  assert.equal((await waitForReviews(store, { reviewIds: [text.id], timeoutMs: 30 })).reason, 'timeout');
});

for (const action of ['reject', 'close'] as const) test(`incomplete ${action} wakes wait with attention and its persisted lifecycle`, async t => {
  const { store, reviewId, target } = await fixture(t);
  const bytes = await fs.readFile(target), count = subscriptions(store);
  const waiting = waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 1000 });
  if (action === 'reject') await store.rejectReview(reviewId);
  if (action === 'close') await store.setReviewClosed(reviewId, true);
  const result = await waiting;
  assert.equal(result.reason, 'attention');
  assert.equal(result.reviews[0].lifecycle, action === 'close' ? 'closed' : 'open');
  assert.equal(result.reviews[0].targets[0].status, action === 'reject' ? 'rejected' : 'pending');
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(count(), 0);
});

test('an incomplete comparison deleted after closing returns persisted attention without changing its file', async t => {
  const { store, reviewId, target, dataDir } = await fixture(t), bytes = await fs.readFile(target);
  await store.setReviewClosed(reviewId, true); await store.deleteReview(reviewId);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  const result = await waitForReviews(reloaded, { reviewIds: [reviewId], timeoutMs: 100 });
  assert.equal(result.reason, 'attention'); assert.equal(result.reviews[0].lifecycle, 'deleted');
  assert.equal(result.reviews[0].targets[0].status, 'pending');
  assert.deepEqual(await fs.readFile(target), bytes);
});

for (const failure of ['error', 'conflict'] as const) test(`save ${failure} returns attention without inventing a receipt`, async t => {
  const { store, reviewId, target } = await fixture(t, point => { if (failure === 'error' && point === 'backup') throw new Error('injected backup failure'); });
  const waiting = waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 1000 });
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  if (failure === 'conflict') await fs.writeFile(target, 'external change');
  await assert.rejects(store.commitSave(preview.token));
  const result = await waiting;
  assert.equal(result.reason, 'attention');
  assert.equal(result.reviews[0].targets[0].status, failure);
  assert.equal(result.reviews[0].targets[0].receipt, undefined);
});

test('timeout snapshots current revisions and releases its subscription', async t => {
  const { store, reviewId } = await fixture(t);
  const count = subscriptions(store);
  const waiting = waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 40 });
  await store.updateDraft({ reviewId, side: 'right', text: 'changed while waiting', expectedRevision: 0 });
  const result = await waiting;
  assert.equal(result.reason, 'timeout');
  assert.equal(result.reviews[0].rightRevision, 1);
  assert.equal(count(), 0);
});

test('cancellation releases wait, and a later wait can complete from a real save', async t => {
  const { store, reviewId } = await fixture(t);
  const count = subscriptions(store), controller = new AbortController();
  const waiting = waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 86400000 }, controller.signal);
  const rejected = assert.rejects(waiting);
  assert.equal(count(), 1); controller.abort(); await rejected;
  assert.equal(count(), 0);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 100 }, alreadyAborted.signal));
  assert.equal(count(), 0);
  await save(store, reviewId);
  assert.equal((await waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 100 })).reason, 'saved');
});

test('server rejects unknown reviews and malformed wait payloads without invoking submit', async t => {
  const { store, reviewId } = await fixture(t);
  const count = subscriptions(store);
  const payloads = [
    { reviewIds: [], timeoutMs: 100 }, { reviewIds: [''], timeoutMs: 100 }, { reviewIds: ['  '], timeoutMs: 100 },
    { reviewIds: [reviewId, reviewId], timeoutMs: 100 }, { reviewIds: [1], timeoutMs: 100 },
    { reviewIds: [reviewId], timeoutMs: 0 }, { reviewIds: [reviewId], timeoutMs: 86400001 },
    { reviewIds: [reviewId], timeoutMs: 1.5 }, { reviewIds: [reviewId], timeoutMs: '100' },
    { reviewIds: ['unknown'], timeoutMs: 100 },
  ];
  for (const payload of payloads) {
    const result = await handleCli(store, { command: 'wait', payload }, () => assert.fail('wait invoked submit'));
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(count(), 0);
  }
});

test('pipe wait outlives ordinary socket timeout and disconnect disposes its listener', async t => {
  const { store, reviewId } = await fixture(t);
  const count = subscriptions(store), sockets = new Set<net.Socket>();
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\diffeditor-wait-${randomUUID()}` : path.join(os.tmpdir(), `de-${randomUUID()}.sock`);
  const server = createPipeServer(store, () => assert.fail('wait invoked submit'));
  // Compress the normal thirty-second idle timeout without changing the wait deadline.
  server.prependListener('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const setTimeout = socket.setTimeout.bind(socket);
    socket.setTimeout = ((ms: number, callback?: () => void) => setTimeout(ms === 30000 ? 20 : ms, callback)) as typeof socket.setTimeout;
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  function request(timeoutMs: number) {
    const socket = net.createConnection(pipe);
    socket.on('error', () => {});
    socket.once('connect', () => socket.write(JSON.stringify({ command: 'wait', payload: { reviewIds: [reviewId], timeoutMs } }) + '\n'));
    return socket;
  }
  const timed = request(80);
  const reply = await new Promise<any>((resolve, reject) => {
    let data = ''; timed.setEncoding('utf8').on('data', chunk => { data += chunk; });
    timed.once('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    timed.once('error', reject);
  });
  assert.equal(reply.ok, true); assert.equal(reply.result.reason, 'timeout'); assert.equal(count(), 0);
  const disconnected = request(86400000);
  for (let i = 0; i < 100 && count() === 0; i++) await delay(5);
  assert.equal(count(), 1); disconnected.destroy();
  for (let i = 0; i < 100 && count() !== 0; i++) await delay(5);
  assert.equal(count(), 0);
  await store.updateDraft({ reviewId, side: 'right', text: 'queue still works', expectedRevision: 0 });
});
