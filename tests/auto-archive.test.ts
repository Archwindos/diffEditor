import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ReviewStore, type Failpoint } from '../src/core/store';
import { waitForReviews } from '../src/main/wait';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, failpoint?: (point: Failpoint) => void | Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-auto-archive-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('diffeditor-auto-archive-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'cache'), store = new ReviewStore({ dataDir, failpoint }); await store.init();
  return { root, dataDir, store, statePath: path.join(dataDir, 'state.json') };
}
async function proposal(store: ReviewStore, root: string, name: string) {
  const target = path.join(root, name + '.txt'); await fs.writeFile(target, 'original\r\n');
  const baseline = await store.baseline({ paths: [target] });
  const request = { requestId: randomUUID(), files: [{ baselineId: baseline.files[0].id, text: 'candidate\n' }] };
  const { reviewIds: [reviewId] } = await store.submit(request);
  return { target, request, reviewId };
}
async function save(store: ReviewStore, reviewId: string, side: 'left' | 'right' = 'right') {
  const review = store.list().reviews.find(review => review.id === reviewId)!;
  return store.commitSave((await store.prepareSave({ reviewId, side, expectedRevision: review[side].revision })).token);
}

test('verified proposal save archives with the receipt in the same durable terminal transition', async t => {
  const { root, dataDir, statePath, store } = await fixture(t);
  const { reviewId, target } = await proposal(store, root, 'save');
  const before = store.list().reviews[0], observed: ReturnType<ReviewStore['list']>[] = [];
  store.onDidChange(() => observed.push(store.list()));
  const receipt = await save(store, reviewId), after = store.list().reviews[0];
  assert.equal(after.closedAt, receipt.savedAt); assert.equal(after.updatedAt, receipt.savedAt);
  assert.deepEqual(after.left, before.left); assert.deepEqual(after.right, before.right);
  assert.equal(after.targets[0].status, 'saved'); assert.deepEqual(after.targets[0].receipt, receipt);
  for (const workspace of observed) {
    const review = workspace.reviews[0];
    if (review.targets[0].status === 'saved') assert.equal(review.closedAt, review.targets[0].receipt!.savedAt);
    else assert.equal(review.closedAt, undefined);
  }
  const durable = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(durable.reviews[0].closedAt, receipt.savedAt);
  assert.equal(durable.plans[receipt.operationId].phase, 'done');
  assert.deepEqual(durable.reviews[0].targets[0].receipt, receipt);
  assert.equal(await fs.readFile(target, 'utf8'), 'candidate\r\n');
  assert.equal(await fs.readFile(receipt.backupPath!, 'utf8'), 'original\r\n');
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  const result = await waitForReviews(recovered, { reviewIds: [reviewId], timeoutMs: 100 });
  assert.equal(result.reason, 'saved'); assert.equal(result.reviews[0].lifecycle, 'closed');
  assert.deepEqual(result.reviews[0].targets[0].receipt, receipt);
});

test('duplicate saves and submissions preserve a human-reopened completed proposal across restarts', async t => {
  const { root, dataDir, statePath, store } = await fixture(t);
  const { reviewId, request } = await proposal(store, root, 'reopened');
  const receipt = await save(store, reviewId);
  await store.setReviewClosed(reviewId, false);
  const reopened = store.list(), cache = await fs.readFile(statePath);
  assert.deepEqual(await store.commitSave(receipt.operationId), receipt);
  assert.equal((await store.submit(request)).duplicate, true);
  assert.deepEqual(store.list(), reopened); assert.deepEqual(await fs.readFile(statePath), cache);
  for (let i = 0; i < 2; i++) {
    const recovered = new ReviewStore({ dataDir }); await recovered.init();
    assert.deepEqual(recovered.list(), JSON.parse(JSON.stringify(reopened)));
    assert.deepEqual(await recovered.commitSave(receipt.operationId), receipt);
    assert.equal(recovered.status(reviewId).reviews[0].lifecycle, 'open');
    assert.deepEqual(await fs.readFile(statePath), cache);
  }
});

test('explicit reopening has a newer durable timestamp even in the same millisecond as completion', async t => {
  const { root, dataDir, store } = await fixture(t);
  const { reviewId } = await proposal(store, root, 'same-millisecond');
  const receipt = await save(store, reviewId), completed = store.list().reviews[0];
  t.mock.method(Date, 'now', () => Date.parse(receipt.savedAt));
  await store.setReviewClosed(reviewId, false);
  const reopened = store.list().reviews[0];
  assert.equal(reopened.closedAt, undefined);
  assert.equal(Date.parse(reopened.updatedAt), Date.parse(completed.updatedAt) + 1);
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  assert.equal(recovered.list().reviews[0].updatedAt, reopened.updatedAt);
  assert.equal(recovered.status(reviewId).reviews[0].lifecycle, 'open');
});

test('failed final cache write does not publish saved status or closure before verified recovery', async t => {
  const { root, dataDir, statePath, store } = await fixture(t);
  const { reviewId } = await proposal(store, root, 'failed-final-write');
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  const internal = store as unknown as { persist(state: { reviews: { targets: { status: string }[] }[] }): Promise<void> };
  const persist = internal.persist.bind(store); let fail = true;
  internal.persist = async state => {
    if (fail && state.reviews.some(review => review.targets.some(target => target.status === 'saved'))) {
      fail = false; throw new Error('final cache write failed');
    }
    await persist(state);
  };
  await assert.rejects(store.commitSave(preview.token), /final cache write failed/);
  const failed = store.list().reviews[0], durable = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(failed.closedAt, undefined); assert.equal(failed.targets[0].status, 'error'); assert.equal(failed.targets[0].receipt, undefined);
  assert.equal(durable.reviews[0].closedAt, undefined); assert.equal(durable.plans[preview.token].phase, 'failed');
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  const after = recovered.list().reviews[0];
  assert.equal(after.targets[0].status, 'saved'); assert.equal(after.closedAt, after.targets[0].receipt!.savedAt);
});

test('saving one target of a historical multi-target proposal keeps it open while another target is pending', async t => {
  const { root, dataDir, statePath, store } = await fixture(t);
  const paths = ['partial-proposal-left', 'partial-proposal-right'].map(name => path.join(root, name + '.txt'));
  for (const target of paths) await fs.writeFile(target, 'original');
  const review = (await store.openFiles({ paths, mode: 'pair' })).reviews[0];
  const state = JSON.parse(await fs.readFile(statePath, 'utf8')); state.reviews[0].mode = 'proposal';
  await fs.writeFile(statePath, JSON.stringify(state));
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  await save(recovered, review.id);
  const after = recovered.list().reviews[0];
  assert.deepEqual(after.targets.map(target => target.status), ['pending', 'saved']);
  assert.equal(after.closedAt, undefined); assert.equal(recovered.status(review.id).reviews[0].lifecycle, 'open');
  const again = new ReviewStore({ dataDir }); await again.init();
  assert.equal(again.status(review.id).reviews[0].lifecycle, 'open');
});

for (const failure of ['backup', 'beforeReplace', 'afterReplace', 'conflict'] as const) test(`proposal save ${failure} stays open until verified recovery`, async t => {
  const { root, dataDir, store } = await fixture(t, point => { if (point === failure) throw new Error('interrupted ' + failure); });
  const { reviewId, target } = await proposal(store, root, failure);
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  if (failure === 'conflict') await fs.writeFile(target, 'external');
  await assert.rejects(store.commitSave(preview.token));
  assert.equal(store.status(reviewId).reviews[0].lifecycle, 'open');
  assert.equal(store.list().reviews[0].closedAt, undefined);
  assert.equal(store.list().reviews[0].targets[0].receipt, undefined);
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  const after = recovered.list().reviews[0];
  if (failure === 'afterReplace') {
    assert.equal(after.targets[0].status, 'saved'); assert.equal(after.closedAt, after.targets[0].receipt!.savedAt);
  } else {
    assert.equal(after.closedAt, undefined); assert.equal(after.targets[0].receipt, undefined);
  }
});

test('manual single, pair and text saves stay open, including partial pair saves', async t => {
  const { root, dataDir, store } = await fixture(t);
  const paths = ['single', 'pair-left', 'pair-right'].map(name => path.join(root, name + '.txt'));
  for (const target of paths) await fs.writeFile(target, 'manual');
  const single = (await store.openFiles({ paths: [paths[0]], mode: 'single' })).reviews.at(-1)!;
  await save(store, single.id);
  const pair = (await store.openFiles({ paths: paths.slice(1), mode: 'pair' })).reviews.at(-1)!;
  await save(store, pair.id, 'left');
  assert.equal(store.list().reviews.find(review => review.id === pair.id)!.closedAt, undefined);
  await save(store, pair.id, 'right');
  const text = await store.createTextReview();
  const preview = await store.prepareSave({ reviewId: text.id, side: 'left', expectedRevision: 0, newPath: path.join(root, 'text.txt') });
  await store.commitSave(preview.token);
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  for (const review of recovered.list().reviews) {
    assert.equal(review.closedAt, undefined); assert.ok(review.targets.every(target => target.status === 'saved'));
  }
});

test('one-time migration archives historical completed proposals, preserves existing closures and leaves other history open', async t => {
  const { root, dataDir, statePath, store } = await fixture(t);
  const saved = await proposal(store, root, 'legacy-saved'), savedReceipt = await save(store, saved.reviewId);
  const withdrawn = await proposal(store, root, 'legacy-withdrawn');
  const withdrawReceipt = await store.withdraw({ reviewId: withdrawn.reviewId, requestId: withdrawn.request.requestId });
  const closed = await proposal(store, root, 'already-closed'); await save(store, closed.reviewId);
  const rejected = await proposal(store, root, 'rejected'); await store.rejectReview(rejected.reviewId);
  const pending = await proposal(store, root, 'pending');
  const manualPath = path.join(root, 'manual.txt'); await fs.writeFile(manualPath, 'manual');
  const manual = (await store.openFiles({ paths: [manualPath], mode: 'single' })).reviews.at(-1)!; await save(store, manual.id);
  const partialPaths = ['partial-left', 'partial-right'].map(name => path.join(root, name + '.txt'));
  for (const target of partialPaths) await fs.writeFile(target, 'partial');
  const partial = (await store.openFiles({ paths: partialPaths, mode: 'pair' })).reviews.at(-1)!; await save(store, partial.id, 'left');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.completedProposalArchiveVersion;
  for (const review of state.reviews) if ([saved.reviewId, withdrawn.reviewId].includes(review.id)) delete review.closedAt;
  state.reviews.find((review: { id: string }) => review.id === closed.reviewId).closedAt = '2026-10-20T00:00:00.000Z';
  state.reviews.find((review: { id: string }) => review.id === partial.id).mode = 'proposal';
  const before = structuredClone(state);
  await fs.writeFile(statePath, JSON.stringify(state));
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  const byId = new Map(recovered.list().reviews.map(review => [review.id, review]));
  assert.equal(byId.get(saved.reviewId)!.closedAt, savedReceipt.savedAt);
  assert.equal(byId.get(withdrawn.reviewId)!.closedAt, withdrawReceipt.withdrawnAt);
  assert.equal(byId.get(closed.reviewId)!.closedAt, '2026-10-20T00:00:00.000Z');
  for (const id of [rejected.reviewId, pending.reviewId, manual.id, partial.id]) assert.equal(byId.get(id)!.closedAt, undefined);
  const migrated = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(migrated.completedProposalArchiveVersion, 1);
  assert.deepEqual(migrated.plans, before.plans); assert.deepEqual(migrated.requests, before.requests);
  assert.deepEqual(migrated.baselines, before.baselines); assert.deepEqual(migrated.deleted, before.deleted);
  for (let i = 0; i < before.reviews.length; i++) {
    const { closedAt: _oldClosed, ...oldReview } = before.reviews[i], { closedAt: _newClosed, ...newReview } = migrated.reviews[i];
    assert.deepEqual(newReview, oldReview);
  }
  await recovered.setReviewClosed(saved.reviewId, false); await recovered.setReviewClosed(withdrawn.reviewId, false);
  const cache = await fs.readFile(statePath), again = new ReviewStore({ dataDir }); await again.init();
  assert.equal(again.status(saved.reviewId).reviews[0].lifecycle, 'open');
  assert.equal(again.status(withdrawn.reviewId).reviews[0].lifecycle, 'open');
  assert.deepEqual(await fs.readFile(statePath), cache);
});

test('legacy migration runs after journal recovery and records only a verified proposal completion', async t => {
  const { root, dataDir, statePath, store } = await fixture(t, point => { if (point === 'afterReplace') throw new Error('interrupted'); });
  const { reviewId } = await proposal(store, root, 'legacy-recovery');
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 }); await assert.rejects(store.commitSave(preview.token));
  const state = JSON.parse(await fs.readFile(statePath, 'utf8')); delete state.completedProposalArchiveVersion;
  await fs.writeFile(statePath, JSON.stringify(state));
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  const review = recovered.list().reviews[0], durable = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(review.targets[0].status, 'saved'); assert.equal(review.closedAt, review.targets[0].receipt!.savedAt);
  assert.equal(durable.completedProposalArchiveVersion, 1); assert.equal(durable.reviews[0].closedAt, review.closedAt);
});
