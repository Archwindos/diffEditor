import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReviewStore } from '../src/core/store';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'cache'), store = new ReviewStore({ dataDir }); await store.init();
  return { root, dataDir, store };
}

test('blank text panes edit independently, persist, and save as separate new files', async t => {
  const { root, dataDir, store } = await fixture(t), review = await store.createTextReview();
  assert.equal(review.mode, 'text'); assert.deepEqual(review.targets, []);
  assert.equal(review.left.targetId, null); assert.equal(review.right.targetId, null);
  await store.updateDraft({ reviewId: review.id, side: 'left', expectedRevision: 0, text: 'left\r\n草稿' });
  await store.updateDraft({ reviewId: review.id, side: 'right', expectedRevision: 0, text: 'right\n草稿' });
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  assert.equal(reloaded.list().reviews[0].left.text, 'left\n草稿'); assert.equal(reloaded.list().reviews[0].right.text, 'right\n草稿');
  const leftPath = path.join(root, 'left.txt'), rightPath = path.join(root, 'right.txt');
  const left = await reloaded.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1, newPath: leftPath });
  const right = await reloaded.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1, newPath: rightPath, encoding: 'utf16be' });
  assert.equal(left.isNew, true); assert.equal(left.backupPath, undefined);
  await assert.rejects(fs.stat(leftPath), { code: 'ENOENT' }); await assert.rejects(fs.stat(rightPath), { code: 'ENOENT' });
  assert.notEqual(reloaded.list().reviews[0].left.targetId, reloaded.list().reviews[0].right.targetId);
  await reloaded.commitSave(left.token); await reloaded.commitSave(right.token);
  assert.equal(await fs.readFile(leftPath, 'utf8'), 'left\n草稿');
  assert.deepEqual([...(await fs.readFile(rightPath)).subarray(0, 2)], [0xfe, 0xff]);
});

test('Save As refuses existing and already reserved new paths without binding a pane', async t => {
  const { root, store } = await fixture(t), review = await store.createTextReview(), existing = path.join(root, 'existing.txt');
  await fs.writeFile(existing, 'unchanged');
  await assert.rejects(store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: existing }), /已经存在/);
  assert.equal(store.list().reviews[0].left.targetId, null); assert.equal(await fs.readFile(existing, 'utf8'), 'unchanged');
  const target = path.join(root, 'new.txt'); await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: target });
  await assert.rejects(store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 0, newPath: target }), /已有待处理审查/);
  assert.equal(store.list().reviews[0].right.targetId, null);
});

test('new text save previews freeze their own revision while the other pane remains independent', async t => {
  const { root, store } = await fixture(t), review = await store.createTextReview(), target = path.join(root, 'revision.txt');
  const stale = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: target });
  await store.updateDraft({ reviewId: review.id, side: 'left', expectedRevision: 0, text: 'current' });
  await assert.rejects(store.commitSave(stale.token), /已过期/);
  const current = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1 });
  await store.updateDraft({ reviewId: review.id, side: 'right', expectedRevision: 0, text: 'independent' });
  await store.commitSave(current.token); assert.equal(await fs.readFile(target, 'utf8'), 'current');
});

test('uncommitted text Save As can choose a new destination without changing the target identity', async t => {
  const { root, store } = await fixture(t), review = await store.createTextReview();
  await store.updateDraft({ reviewId: review.id, side: 'left', expectedRevision: 0, text: 'draft' });
  const firstPath = path.join(root, 'first.txt'), nextPath = path.join(root, 'next.txt'), existingPath = path.join(root, 'existing.txt');
  await fs.writeFile(existingPath, 'preserved');
  const first = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1, newPath: firstPath });
  const targetId = store.list().reviews[0].left.targetId;
  const next = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1, newPath: nextPath });
  assert.equal(store.list().reviews[0].left.targetId, targetId); assert.equal(store.list().reviews[0].targets.length, 1);
  await assert.rejects(store.commitSave(first.token), /找不到保存预览/);
  await assert.rejects(fs.stat(firstPath), { code: 'ENOENT' }); await assert.rejects(fs.stat(nextPath), { code: 'ENOENT' });
  const beforeRefusal = store.list();
  await assert.rejects(store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1, newPath: existingPath }), /已经存在/);
  assert.deepEqual(store.list(), beforeRefusal); assert.equal(await fs.readFile(existingPath, 'utf8'), 'preserved');
  await store.openFiles({ paths: [firstPath], mode: 'single' });
  await store.commitSave(next.token); assert.equal(await fs.readFile(nextPath, 'utf8'), 'draft');
  await assert.rejects(fs.stat(firstPath), { code: 'ENOENT' });
});

test('reselecting a new destination excludes only its own reservation and preserves exclusive creation', async t => {
  const { root, store } = await fixture(t), review = await store.createTextReview(), leftPath = path.join(root, 'left.txt'), rightPath = path.join(root, 'right.txt');
  const first = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: leftPath });
  const samePath = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: leftPath });
  await assert.rejects(store.commitSave(first.token), /找不到保存预览/);
  await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 0, newPath: rightPath });
  const beforeRefusal = store.list();
  await assert.rejects(store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: rightPath }), /已有待处理审查/);
  assert.deepEqual(store.list(), beforeRefusal);
  await fs.writeFile(leftPath, 'external', { flag: 'wx' }); await assert.rejects(store.commitSave(samePath.token), /被创建或替换/);
  await assert.rejects(store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: path.join(root, 'failed.txt') }), /不能另存为/);
  assert.equal(await fs.readFile(leftPath, 'utf8'), 'external');
});

test('closing retains exact drafts and target ownership, rejects mutations, and consumes previews', async t => {
  const { root, dataDir, store } = await fixture(t), review = await store.createTextReview();
  await store.updateDraft({ reviewId: review.id, side: 'left', expectedRevision: 0, text: 'left draft\n' });
  await store.updateDraft({ reviewId: review.id, side: 'right', expectedRevision: 0, text: 'right draft' });
  const target = path.join(root, 'reserved.txt'), preview = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1, newPath: target });
  const before = store.list().reviews[0]; await store.setReviewClosed(review.id, true);
  assert.equal(store.status(review.id).reviews[0].lifecycle, 'closed');
  await assert.rejects(store.updateDraft({ reviewId: review.id, side: 'right', expectedRevision: 1, text: 'late' }), /已关闭/);
  await assert.rejects(store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1 }), /已关闭/);
  await assert.rejects(store.commitSave(preview.token), /找不到保存预览/);
  await assert.rejects(store.openFiles({ mode: 'single', paths: [target] }), /已有待处理审查/);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init(); await reloaded.setReviewClosed(review.id, false);
  const reopened = reloaded.list().reviews[0]; assert.deepEqual(reopened.left, before.left); assert.deepEqual(reopened.right, before.right);
  assert.equal(reopened.closedAt, undefined); assert.equal(reloaded.status(review.id).reviews[0].lifecycle, 'open');
  const second = await reloaded.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1 }); await reloaded.commitSave(second.token);
  assert.equal(await fs.readFile(target, 'utf8'), 'left draft\n');
});

test('closed saved and rejected historical comparisons do not reacquire target ownership', async t => {
  const { root, store } = await fixture(t), target = path.join(root, 'historical.txt'); await fs.writeFile(target, 'original');
  const saved = (await store.openFiles({ paths: [target], mode: 'single' })).reviews[0];
  const preview = await store.prepareSave({ reviewId: saved.id, side: 'right', expectedRevision: 0 }); await store.commitSave(preview.token);
  await store.setReviewClosed(saved.id, true);
  const rejected = (await store.openFiles({ paths: [target], mode: 'single' })).reviews.at(-1)!;
  await store.rejectReview(rejected.id); await store.setReviewClosed(rejected.id, true);
  const current = (await store.openFiles({ paths: [target], mode: 'single' })).reviews.at(-1)!;
  const currentPreview = await store.prepareSave({ reviewId: current.id, side: 'right', expectedRevision: 0 }); await store.commitSave(currentPreview.token);
  const continued = await store.continueTarget(current.id, current.targets[0].id);
  assert.equal(continued.targets[0].status, 'pending'); assert.equal(continued.left.text, 'original');
});

test('deletion removes text and tokens, preserves receipt metadata, disk and backup, and submit replay tombstone', async t => {
  const { root, dataDir, store } = await fixture(t), target = path.join(root, 'original.txt');
  await fs.writeFile(target, 'private original'); const baseline = await store.baseline({ paths: [target] });
  const request = { requestId: 'delete-request', files: [{ baselineId: baseline.files[0].id, text: 'private proposal' }] };
  const submitted = await store.submit(request), reviewId = submitted.reviewIds[0];
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 }), receipt = await store.commitSave(preview.token);
  const disk = await fs.readFile(target), backup = await fs.readFile(receipt.backupPath!);
  await store.deleteReview(reviewId); await store.deleteReview(reviewId);
  assert.deepEqual(store.list().reviews, []); const tombstone = store.status(reviewId).reviews[0];
  assert.equal(tombstone.lifecycle, 'deleted'); assert.deepEqual(tombstone.targets[0].receipt, receipt);
  assert.deepEqual(await fs.readFile(target), disk); assert.deepEqual(await fs.readFile(receipt.backupPath!), backup);
  await assert.rejects(store.commitSave(preview.token), /找不到保存预览/);
  const cache = await fs.readFile(path.join(dataDir, 'state.json'), 'utf8');
  assert.equal(cache.includes('private original'), false); assert.equal(cache.includes('private proposal'), false);
  assert.deepEqual(JSON.parse(cache).baselines, {}); assert.deepEqual(JSON.parse(cache).plans, {});
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  assert.deepEqual(await reloaded.submit(request), { reviewIds: [reviewId], duplicate: true }); assert.equal(reloaded.list().reviews.length, 0);
  assert.equal(reloaded.status(reviewId).reviews[0].lifecycle, 'deleted');
  await reloaded.openFiles({ paths: [target], mode: 'single' });
});

test('deleting a pending blank comparison invalidates preview and never creates its destination', async t => {
  const { root, store } = await fixture(t), review = await store.createTextReview(), target = path.join(root, 'never-created.txt');
  const preview = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: target });
  await store.deleteReview(review.id); await assert.rejects(store.commitSave(preview.token), /找不到保存预览/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('old v1 state loads, and legacy submit payload survives conversion to a deletion tombstone', async t => {
  const { root, dataDir, store } = await fixture(t), target = path.join(root, 'legacy.txt'); await fs.writeFile(target, 'legacy');
  const baseline = await store.baseline({ paths: [target] }), request = { requestId: 'legacy-request', files: [{ baselineId: baseline.files[0].id, text: 'legacy proposal' }] };
  const submitted = await store.submit(request), statePath = path.join(dataDir, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.deleted; state.requests[request.requestId] = { payload: JSON.stringify({ title: '', files: request.files }), reviewIds: submitted.reviewIds };
  await fs.writeFile(statePath, JSON.stringify(state)); const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  assert.equal((await reloaded.submit(request)).duplicate, true); await reloaded.deleteReview(submitted.reviewIds[0]);
  assert.equal((await reloaded.submit(request)).duplicate, true); assert.equal(reloaded.status().reviews[0].lifecycle, 'deleted');
});

test('unresolved journal blocks deletion until explicit disk continuation clears recovery references', async t => {
  const { root, dataDir } = await fixture(t), target = path.join(root, 'interrupted.txt'); await fs.writeFile(target, 'original');
  const store = new ReviewStore({ dataDir, failpoint: point => { if (point === 'afterReplace') throw new Error('interrupted'); } }); await store.init();
  const review = (await store.openFiles({ paths: [target], mode: 'single' })).reviews[0];
  await store.updateDraft({ reviewId: review.id, side: 'right', expectedRevision: 0, text: 'replacement' });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 }); await assert.rejects(store.commitSave(preview.token), /interrupted/);
  await assert.rejects(store.rejectReview(review.id), /尚未核验/);
  assert.equal(store.status(review.id).reviews[0].targets[0].status, 'error');
  await assert.rejects(store.deleteReview(review.id), /尚未核验/);
  await store.continueTarget(review.id, review.targets[0].id); await store.deleteReview(review.id);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  assert.equal(reloaded.status(review.id).reviews[0].lifecycle, 'deleted'); assert.equal(reloaded.list().reviews.length, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'replacement');
});

test('orphaned recovery journal is reported unresolved without crashing or inventing success', async t => {
  const { root, dataDir, store } = await fixture(t), review = await store.createTextReview(), target = path.join(root, 'orphan.txt');
  const preview = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0, newPath: target });
  const statePath = path.join(dataDir, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.plans[preview.token].phase = 'intent'; state.reviews = []; await fs.writeFile(statePath, JSON.stringify(state));
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  const recovered = JSON.parse(await fs.readFile(statePath, 'utf8')).plans[preview.token];
  assert.equal(recovered.phase, 'failed'); assert.equal(recovered.outcome, 'unknown'); assert.match(recovered.error, /缺少审查或目标引用/);
  await assert.rejects(reloaded.commitSave(preview.token), /已使用/); await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});
