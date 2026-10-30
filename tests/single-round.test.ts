import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReviewStore, ReviewError, type Failpoint } from '../src/core/store';
import { handleCli } from '../src/main/server';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, failpoint?: (point: Failpoint) => void | Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-round-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'cache'), store = new ReviewStore({ dataDir, failpoint }); await store.init();
  const target = path.join(root, 'sample.txt'); await fs.writeFile(target, 'original');
  return { root, target, dataDir, store };
}
async function proposal(store: ReviewStore, target: string, requestId: string) {
  const { files } = await store.baseline({ paths: [target] });
  return { requestId, files: [{ baselineId: files[0].id, text: 'candidate' }] };
}
function blocked(code: string, reviewIds: string[]) {
  return (error: unknown) => {
    assert.ok(error instanceof ReviewError); assert.equal(error.code, code); assert.deepEqual(error.reviewIds, reviewIds); return true;
  };
}

test('concurrent submissions serialize, preserve the first candidate, and retry without a second notification', async t => {
  const { store, target } = await fixture(t);
  const first = await proposal(store, target, 'first'), second = await proposal(store, target, 'second');
  let notifications = 0;
  const [a, b] = await Promise.all([first, second].map(payload => handleCli(store, { command: 'submit', payload }, () => notifications++)));
  assert.equal(a.ok, true); assert.equal(b.ok, false);
  if (!a.ok || b.ok) return assert.fail('Expected exactly one accepted submit');
  const ids = (a.result as { reviewIds: string[] }).reviewIds;
  assert.equal(b.code, 'REVIEW_IN_PROGRESS'); assert.deepEqual(b.reviewIds, ids);
  const retry = await handleCli(store, { command: 'submit', payload: first }, () => notifications++);
  assert.deepEqual(retry, { ok: true, result: { reviewIds: ids, duplicate: true } });
  assert.equal(notifications, 1); assert.equal(store.list().reviews.length, 1);
  await assert.rejects(store.submit({ ...first, files: [{ ...first.files[0], text: 'different' }] }), blocked('REQUEST_ID_REUSED', ids));
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
});

test('new request IDs, fresh baselines, case aliases, and hard links cannot bypass an active closed round after restart', async t => {
  const { root, store, dataDir, target } = await fixture(t), alias = path.join(root, 'hardlink.txt');
  await fs.link(target, alias);
  const original = await proposal(store, target, 'first'), linked = await proposal(store, alias, 'linked');
  const { reviewIds } = await store.submit(original);
  await assert.rejects(store.submit(linked), blocked('REVIEW_IN_PROGRESS', reviewIds));
  await assert.rejects(store.submit(await proposal(store, alias, 'fresh-linked')), blocked('REVIEW_IN_PROGRESS', reviewIds));
  if (process.platform === 'win32') await assert.rejects(store.submit(await proposal(store, target.toUpperCase(), 'case')), blocked('REVIEW_IN_PROGRESS', reviewIds));
  await store.setReviewClosed(reviewIds[0], true);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  await assert.rejects(reloaded.submit(await proposal(reloaded, target, 'after-restart')), blocked('REVIEW_IN_PROGRESS', reviewIds));
  assert.deepEqual(await reloaded.submit(original), { reviewIds, duplicate: true });
  assert.equal(reloaded.list().reviews.length, 1);
});

for (const release of ['save-right', 'reject', 'delete'] as const) test(`${release} releases ownership but all pre-round and pending-round baselines stay expired across restart`, async t => {
  const { root, store, dataDir, target } = await fixture(t), alias = path.join(root, 'alias.txt'); await fs.link(target, alias);
  const first = await proposal(store, target, 'first'), queued = await proposal(store, target, 'queued'), linked = await proposal(store, alias, 'linked');
  const { reviewIds } = await store.submit(first), id = reviewIds[0];
  const during = await proposal(store, target, 'during');
  if (release === 'save-right') {
    const preview = await store.prepareSave({ reviewId: id, side: 'right', expectedRevision: 0 });
    const receipt = await store.commitSave(preview.token); assert.equal(receipt.side, 'right');
  } else if (release === 'reject') await store.rejectReview(id);
  else { await store.setReviewClosed(id, true); await store.deleteReview(id); }
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  for (const request of [queued, linked, during]) await assert.rejects(reloaded.submit(request), blocked('BASELINE_EXPIRED', reviewIds));
  assert.deepEqual(await reloaded.submit(first), { reviewIds, duplicate: true });
  assert.equal(await fs.readFile(target, 'utf8'), release === 'save-right' ? 'candidate' : 'original');
  const next = await reloaded.submit(await proposal(reloaded, target, 'fresh'));
  assert.notDeepEqual(next.reviewIds, reviewIds);
});

test('save failure and conflict keep ownership, including closed error reviews', async t => {
  const { store, target, dataDir } = await fixture(t, point => { if (point === 'backup') throw new Error('simulated failure'); });
  const { reviewIds } = await store.submit(await proposal(store, target, 'first'));
  const preview = await store.prepareSave({ reviewId: reviewIds[0], side: 'right', expectedRevision: 0 });
  await assert.rejects(store.commitSave(preview.token), /simulated failure/);
  assert.equal(store.status(reviewIds[0]).reviews[0].targets[0].status, 'error');
  await store.setReviewClosed(reviewIds[0], true);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  await assert.rejects(reloaded.submit(await proposal(reloaded, target, 'blocked')), blocked('REVIEW_IN_PROGRESS', reviewIds));
  await reloaded.setReviewClosed(reviewIds[0], false); await reloaded.rejectReview(reviewIds[0]);
  const next = await reloaded.submit(await proposal(reloaded, target, 'fresh'));
  await fs.writeFile(target, 'external');
  const conflict = await reloaded.prepareSave({ reviewId: next.reviewIds[0], side: 'right', expectedRevision: 0 });
  await assert.rejects(reloaded.commitSave(conflict.token), /磁盘冲突/);
  assert.equal(reloaded.status(next.reviewIds[0]).reviews[0].targets[0].status, 'conflict');
  await assert.rejects(reloaded.submit(await proposal(reloaded, target, 'conflict-blocked')), blocked('REVIEW_IN_PROGRESS', next.reviewIds));
});

test('a submission queued during saving cannot replace the round after the save fails', async t => {
  let entered!: () => void, release!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const { store, target } = await fixture(t, async point => { if (point === 'backup') { entered(); await resume; throw new Error('save failed'); } });
  const first = await proposal(store, target, 'first'), queued = await proposal(store, target, 'queued');
  const { reviewIds } = await store.submit(first);
  const preview = await store.prepareSave({ reviewId: reviewIds[0], side: 'right', expectedRevision: 0 });
  const committing = assert.rejects(store.commitSave(preview.token), /save failed/);
  await saving; assert.equal(store.status(reviewIds[0]).reviews[0].targets[0].status, 'saving');
  const submitting = assert.rejects(store.submit(queued), blocked('REVIEW_IN_PROGRESS', reviewIds));
  release(); await Promise.all([committing, submitting]); assert.equal(store.list().reviews.length, 1);
});

test('a queued old submission stays expired after a successful save releases the round', async t => {
  let entered!: () => void, release!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const { store, target } = await fixture(t, async point => { if (point === 'backup') { entered(); await resume; } });
  const first = await proposal(store, target, 'first'), queued = await proposal(store, target, 'queued');
  const { reviewIds } = await store.submit(first);
  const preview = await store.prepareSave({ reviewId: reviewIds[0], side: 'right', expectedRevision: 0 });
  const committing = store.commitSave(preview.token); await saving;
  const submitting = assert.rejects(store.submit(queued), blocked('BASELINE_EXPIRED', reviewIds));
  release(); await Promise.all([committing, submitting]);
  assert.equal(store.list().reviews.length, 1); assert.equal(await fs.readFile(target, 'utf8'), 'candidate');
});

test('rebinding a baseline alias or replacing an occupied path cannot bypass physical ownership', async t => {
  const { root, store, target } = await fixture(t), alias = path.join(root, 'alias.txt'); await fs.writeFile(alias, 'different file');
  const stale = await proposal(store, alias, 'rebound');
  const { reviewIds } = await store.submit(await proposal(store, target, 'first'));
  await fs.unlink(alias); await fs.link(target, alias);
  await assert.rejects(store.submit(stale), blocked('REVIEW_IN_PROGRESS', reviewIds));
  await store.rejectReview(reviewIds[0]);
  await assert.rejects(store.submit(stale), blocked('BASELINE_EXPIRED', []));
  const active = await store.submit(await proposal(store, target, 'second'));
  const replacement = path.join(root, 'replacement'); await fs.writeFile(replacement, 'replacement'); await fs.rename(replacement, target);
  await fs.unlink(alias); await fs.link(target, alias);
  const freshAlias = await proposal(store, alias, 'new-alias');
  await assert.rejects(store.submit(freshAlias), blocked('REVIEW_IN_PROGRESS', active.reviewIds));
  await store.rejectReview(active.reviewIds[0]);
  await assert.rejects(store.submit(freshAlias), blocked('BASELINE_EXPIRED', active.reviewIds));
});

test('independent files proceed; a batch with an occupied file creates no partial reviews or invalidations', async t => {
  const { root, store, target } = await fixture(t), other = path.join(root, 'other.txt'); await fs.writeFile(other, 'other');
  const occupied = await store.submit(await proposal(store, target, 'occupied'));
  const independent = await proposal(store, other, 'independent'), retry = await proposal(store, target, 'retry');
  const before = store.list();
  await assert.rejects(store.submit({ requestId: 'batch', files: [...independent.files, ...retry.files] }), blocked('REVIEW_IN_PROGRESS', occupied.reviewIds));
  assert.deepEqual(store.list(), before);
  await store.submit(independent); assert.equal(store.list().reviews.length, 2);
});

test('a batch cannot create two rounds for hard links and rejection is atomic', async t => {
  const { root, store, target } = await fixture(t), alias = path.join(root, 'alias.txt'); await fs.link(target, alias);
  const first = await proposal(store, target, 'one'), second = await proposal(store, alias, 'two');
  await assert.rejects(store.submit({ requestId: 'batch', files: [...first.files, ...second.files] }), blocked('DUPLICATE_TARGET', []));
  assert.equal(store.list().reviews.length, 0); await store.submit(first);
});

test('UI file open, disk continuation and Save As invalidate baselines acquired before their rounds', async t => {
  const { root, store, target } = await fixture(t), before = await proposal(store, target, 'before-open');
  const review = (await store.openFiles({ paths: [target], mode: 'single' })).reviews[0];
  await store.rejectReview(review.id); await assert.rejects(store.submit(before), blocked('BASELINE_EXPIRED', [review.id]));
  const active = (await store.openFiles({ paths: [target], mode: 'single' })).reviews.at(-1)!;
  const saved = await store.prepareSave({ reviewId: active.id, side: 'left', expectedRevision: 0 }); await store.commitSave(saved.token);
  const between = await proposal(store, target, 'between');
  const continued = await store.continueTarget(active.id, active.targets[0].id); await store.rejectReview(continued.id);
  await assert.rejects(store.submit(between), blocked('BASELINE_EXPIRED', [continued.id]));
  const destination = path.join(root, 'new.txt'), prior = await proposal(store, destination, 'before-save-as');
  const text = await store.createTextReview(); await store.prepareSave({ reviewId: text.id, side: 'left', expectedRevision: 0, newPath: destination });
  await store.setReviewClosed(text.id, true); await store.deleteReview(text.id); await assert.rejects(store.submit(prior), blocked('BASELINE_EXPIRED', [text.id]));
});

test('legacy caches preserve reviews and idempotent receipts but require fresh baseline validity', async t => {
  const { store, dataDir, target } = await fixture(t), before = await proposal(store, target, 'legacy');
  const submitted = await store.submit(before); await store.rejectReview(submitted.reviewIds[0]);
  const stale = await proposal(store, target, 'legacy-unused'), statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8')); delete state.baselineValidityVersion; delete state.invalidatedBaselines;
  await fs.writeFile(statePath, JSON.stringify(state));
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  assert.deepEqual(await reloaded.submit(before), { ...submitted, duplicate: true });
  await assert.rejects(reloaded.submit(stale), blocked('BASELINE_EXPIRED', submitted.reviewIds));
  await reloaded.submit(await proposal(reloaded, target, 'new'));
});
