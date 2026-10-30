import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ReviewStore, type Failpoint } from '../src/core/store';
import { handleCli } from '../src/main/server';
import { waitForReviews } from '../src/main/wait';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, failpoint?: (point: Failpoint) => void | Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-withdraw-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('diffeditor-withdraw-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'cache'), store = new ReviewStore({ dataDir, failpoint }); await store.init();
  const target = path.join(root, '原稿.txt'), original = Buffer.from('original\r\n中文\r\n');
  await fs.writeFile(target, original, { flag: 'wx' });
  const baseline = await store.baseline({ paths: [target] });
  // Source-less submissions are the legacy format; request ownership still works.
  const request = { requestId: randomUUID(), files: [{ baselineId: baseline.files[0].id, text: 'AI proposal\n' }] };
  const { reviewIds: [reviewId] } = await store.submit(request);
  const withdraw = { reviewId, requestId: request.requestId };
  return { root, dataDir, store, target, original, request, reviewId, withdraw };
}

test('untouched withdrawal preserves drafts and disk, revokes previews, and wakes wait with durable attention', async t => {
  const { root, dataDir, store, target, original, reviewId, withdraw } = await fixture(t);
  const backups = path.join(root, '.diffeditor-backups'); await fs.mkdir(backups);
  await fs.writeFile(path.join(backups, 'existing.bak'), 'existing backup');
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  const before = store.list().reviews[0];
  const waiting = waitForReviews(store, { reviewIds: [reviewId], timeoutMs: 1000 });
  const receipt = await store.withdraw(withdraw), result = await waiting;
  const after = store.list().reviews[0];
  assert.equal(receipt.reviewId, reviewId); assert.equal(receipt.status, 'withdrawn'); assert.equal(receipt.duplicate, false);
  assert.ok(!Number.isNaN(Date.parse(receipt.withdrawnAt)));
  assert.deepEqual(after.left, before.left); assert.deepEqual(after.right, before.right);
  assert.equal(after.source, undefined); assert.equal(after.closedAt, receipt.withdrawnAt);
  assert.equal(after.updatedAt, receipt.withdrawnAt); assert.equal(after.withdrawnAt, receipt.withdrawnAt);
  assert.equal(after.targets[0].status, 'withdrawn'); assert.equal(after.targets[0].receipt, undefined);
  assert.deepEqual(receipt.review, store.status(reviewId).reviews[0]);
  assert.equal(receipt.review.leftRevision, 0); assert.equal(receipt.review.rightRevision, 0); assert.equal(receipt.review.lifecycle, 'closed');
  assert.equal(result.reason, 'attention'); assert.deepEqual(result.reviews, [receipt.review]);
  await assert.rejects(store.commitSave(preview.token), /找不到保存预览/);
  await assert.rejects(store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 }), /已关闭/);
  await assert.rejects(store.rejectReview(reviewId), /已关闭/);
  await assert.rejects(store.continueTarget(reviewId, after.targets[0].id), /已关闭/);
  assert.deepEqual(await fs.readFile(target), original);
  assert.deepEqual(await fs.readdir(backups), ['existing.bak']);
  assert.equal(await fs.readFile(path.join(backups, 'existing.bak'), 'utf8'), 'existing backup');
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(durable.reviews[0].withdrawnAt, receipt.withdrawnAt); assert.equal(durable.reviews[0].closedAt, receipt.withdrawnAt); assert.deepEqual(durable.plans, {});
  assert.deepEqual(durable.reviews[0].left, before.left); assert.deepEqual(durable.reviews[0].right, before.right);
});

for (const side of ['left', 'right'] as const) test(`withdraw refuses any ${side} human edit, even undone, and retains drafts, ownership and save previews through restart`, async t => {
  const { dataDir, store, target, original, reviewId, withdraw } = await fixture(t);
  const initialText = store.list().reviews[0][side].text;
  await store.updateDraft({ reviewId, side, text: 'human input', expectedRevision: 0 });
  await store.updateDraft({ reviewId, side, text: initialText, expectedRevision: 1 });
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: side === 'right' ? 2 : 0 });
  const before = store.list(), statePath = path.join(dataDir, 'state.json'), cache = await fs.readFile(statePath);
  const check = async (current: ReviewStore) => {
    for (const action of [() => current.withdrawNeedsPreflight(withdraw), () => current.withdraw(withdraw)]) await assert.rejects(action(), error => {
      const failure = error as { code: string; reviewIds: string[] };
      assert.equal(failure.code, 'WITHDRAW_HAS_HUMAN_EDITS'); assert.deepEqual(failure.reviewIds, [reviewId]); return true;
    });
    assert.deepEqual(current.list(), before); assert.deepEqual(await fs.readFile(statePath), cache);
    await assert.rejects(current.openFiles({ mode: 'single', paths: [target] }), /已有待处理审查/);
  };
  await check(store);
  const recovered = new ReviewStore({ dataDir }); await recovered.init(); await check(recovered);
  assert.equal((await waitForReviews(recovered, { reviewIds: [reviewId], timeoutMs: 10 })).reason, 'timeout');
  assert.deepEqual(await fs.readFile(target), original);
  assert.equal(JSON.parse(cache.toString()).plans[preview.token].phase, 'prepared');
  const receipt = await recovered.commitSave(preview.token); assert.equal(receipt.side, 'right');
});

test('an edit queued before withdrawal refuses withdrawal and later queued edits remain pending', async t => {
  const { store, reviewId, withdraw } = await fixture(t);
  const earlyEdit = store.updateDraft({ reviewId, side: 'left', text: 'queued before withdrawal', expectedRevision: 0 });
  const refused = assert.rejects(store.withdraw(withdraw), error => (error as { code: string }).code === 'WITHDRAW_HAS_HUMAN_EDITS');
  const lateEdit = store.updateDraft({ reviewId, side: 'right', text: 'queued after withdrawal', expectedRevision: 0 });
  await earlyEdit; await refused;
  const retained = await lateEdit;
  assert.equal(retained.left.text, 'queued before withdrawal'); assert.equal(retained.right.text, 'queued after withdrawal');
  assert.equal(retained.targets[0].status, 'pending'); assert.equal(retained.withdrawnAt, undefined);
});

test('human-reopened withdrawn reviews retain cache writes and duplicate receipts preserve the reopened lifecycle', async t => {
  const { dataDir, store, target, original, reviewId, withdraw } = await fixture(t);
  const receipt = await store.withdraw(withdraw);
  await assert.rejects(store.updateDraft({ reviewId, side: 'left', text: 'late after auto-close', expectedRevision: 0 }), /已关闭/);
  await store.setReviewClosed(reviewId, false);
  // Human reopening retains the compatibility path for withdrawn history without enabling another save.
  const earlyEdit = store.updateDraft({ reviewId, side: 'left', text: 'legacy retained edit', expectedRevision: 0 });
  const lateEdit = store.updateDraft({ reviewId, side: 'right', text: 'typed before UI learned of withdrawal', expectedRevision: 0 });
  await earlyEdit;
  assert.equal(receipt.review.leftRevision, 0); assert.equal(receipt.review.rightRevision, 0);
  const retained = await lateEdit;
  assert.equal(retained.right.text, 'typed before UI learned of withdrawal'); assert.equal(retained.right.revision, 1);
  assert.equal(retained.targets[0].status, 'withdrawn'); assert.equal(retained.withdrawnAt, receipt.withdrawnAt);
  const duplicate = await store.withdraw(withdraw);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.withdrawnAt, receipt.withdrawnAt);
  assert.equal(duplicate.review.leftRevision, 1); assert.equal(duplicate.review.rightRevision, 1);
  assert.equal(duplicate.review.lifecycle, 'open'); assert.equal(store.list().reviews[0].closedAt, undefined);
  assert.equal(await store.withdrawNeedsPreflight(withdraw), false);
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  assert.deepEqual(recovered.list().reviews[0].left, retained.left); assert.deepEqual(recovered.list().reviews[0].right, retained.right);
  assert.equal(recovered.list().reviews[0].targets[0].status, 'withdrawn');
  const statePath = path.join(dataDir, 'state.json'), cache = await fs.readFile(statePath);
  assert.deepEqual(await recovered.withdraw(withdraw), duplicate); assert.deepEqual(await fs.readFile(statePath), cache);
  assert.equal(recovered.status(reviewId).reviews[0].lifecycle, 'open');
  await recovered.setReviewClosed(reviewId, true);
  await assert.rejects(recovered.updateDraft({ reviewId, side: 'right', text: 'late after close', expectedRevision: 1 }), /已关闭/);
  assert.deepEqual(await fs.readFile(target), original);
});

test('closed withdrawal keeps lifecycle, provenance and drafts through restart, close, reopen and human deletion', async t => {
  const { dataDir, store, target, original, request, reviewId, withdraw } = await fixture(t);
  const statePath = path.join(dataDir, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.reviews[0].source = { agent: 'Research Agent', threadId: 'original-chat', threadTitle: 'Original title' };
  await fs.writeFile(statePath, JSON.stringify(state));
  const sourced = new ReviewStore({ dataDir }); await sourced.init();
  await sourced.setReviewClosed(reviewId, true); const before = sourced.list().reviews[0];
  const receipt = await sourced.withdraw(withdraw);
  assert.equal(receipt.review.lifecycle, 'closed'); assert.deepEqual(receipt.review.source, before.source);
  assert.equal(sourced.list().reviews[0].closedAt, before.closedAt);
  assert.deepEqual(sourced.list().reviews[0].right, before.right);
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  let cache = await fs.readFile(statePath);
  assert.deepEqual(await recovered.withdraw(withdraw), { ...receipt, duplicate: true });
  assert.deepEqual(await fs.readFile(statePath), cache);
  await recovered.setReviewClosed(reviewId, false);
  await assert.rejects(recovered.rejectReview(reviewId), /已撤回/);
  assert.equal(recovered.list().reviews[0].targets[0].status, 'withdrawn');
  await recovered.setReviewClosed(reviewId, true); await recovered.deleteReview(reviewId);
  const tombstone = recovered.status(reviewId).reviews[0];
  assert.equal(tombstone.lifecycle, 'deleted'); assert.equal(tombstone.withdrawnAt, receipt.withdrawnAt);
  assert.equal(tombstone.targets[0].status, 'withdrawn'); assert.deepEqual(tombstone.source, before.source);
  const deleted = new ReviewStore({ dataDir }); await deleted.init(); cache = await fs.readFile(statePath);
  assert.deepEqual(await deleted.withdraw(withdraw), { ...receipt, duplicate: true, review: tombstone });
  assert.deepEqual(await deleted.submit(request), { reviewIds: [reviewId], duplicate: true });
  assert.deepEqual(deleted.list().reviews, []); assert.deepEqual(await fs.readFile(statePath), cache);
  assert.deepEqual(await fs.readFile(target), original);
  assert.equal((await waitForReviews(deleted, { reviewIds: [reviewId], timeoutMs: 100 })).reason, 'attention');
});

test('withdrawal releases file ownership while old and in-flight baselines remain expired and submit replay stays original', async t => {
  const { store, target, original, request, reviewId, withdraw } = await fixture(t);
  const inFlight = await store.baseline({ paths: [target] });
  await store.withdraw(withdraw);
  for (const baselineId of [request.files[0].baselineId, inFlight.files[0].id]) {
    await assert.rejects(store.submit({ requestId: randomUUID(), files: [{ baselineId, text: 'new candidate' }] }),
      error => (error as { code: string }).code === 'BASELINE_EXPIRED');
  }
  assert.deepEqual(await store.submit(request), { reviewIds: [reviewId], duplicate: true });
  const fresh = await store.baseline({ paths: [target] });
  const next = await store.submit({ requestId: randomUUID(), files: [{ baselineId: fresh.files[0].id, text: 'new round' }] });
  assert.notEqual(next.reviewIds[0], reviewId); assert.equal(store.list().reviews.length, 2);
  assert.equal(store.list().reviews[0].targets[0].status, 'withdrawn');
  assert.equal(store.list().reviews[1].targets[0].status, 'pending');
  assert.deepEqual(await fs.readFile(target), original);
});

test('withdraw requires the original submit request ID and cannot claim manual comparisons or deleted pending proposals', async t => {
  const { root, dataDir, store, request, reviewId, withdraw } = await fixture(t);
  const before = store.list(), cache = await fs.readFile(path.join(dataDir, 'state.json'));
  for (const input of [{ reviewId, requestId: 'unrelated' }, { reviewId: 'unknown', requestId: request.requestId },
    { reviewId, requestId: 'constructor' }, { reviewId, requestId: 'toString' }]) {
    await assert.rejects(store.withdraw(input), error => (error as { code: string }).code === 'WITHDRAW_NOT_OWNER');
  }
  assert.deepEqual(store.list(), before); assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), cache);
  await store.setReviewClosed(reviewId, true); await store.deleteReview(reviewId);
  await assert.rejects(store.withdraw(withdraw), error => (error as { code: string }).code === 'WITHDRAW_NOT_ALLOWED');
  const left = path.join(root, 'manual-left.txt'), right = path.join(root, 'manual-right.txt');
  await fs.writeFile(left, 'left'); await fs.writeFile(right, 'right');
  const single = (await store.openFiles({ mode: 'single', paths: [left] })).reviews[0]; await store.rejectReview(single.id);
  const pair = (await store.openFiles({ mode: 'pair', paths: [left, right] })).reviews.at(-1)!;
  const text = await store.createTextReview();
  // Even an inconsistent request index must not turn a manual comparison into a model proposal.
  const statePath = path.join(dataDir, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.requests[request.requestId].reviewIds.push(single.id, pair.id, text.id);
  await fs.writeFile(statePath, JSON.stringify(state));
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  for (const id of [single.id, pair.id, text.id]) await assert.rejects(recovered.withdraw({ reviewId: id, requestId: request.requestId }),
    error => (error as { code: string }).code === 'WITHDRAW_NOT_ALLOWED');
});

for (const action of ['saved', 'rejected'] as const) test(`withdraw refuses ${action} proposals without changing receipts, files or backups`, async t => {
  const { dataDir, store, target, reviewId, withdraw } = await fixture(t);
  let backupPath: string | undefined;
  if (action === 'saved') {
    const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
    backupPath = (await store.commitSave(preview.token)).backupPath;
  } else await store.rejectReview(reviewId);
  const before = store.status(reviewId), disk = await fs.readFile(target), cache = await fs.readFile(path.join(dataDir, 'state.json'));
  const backup = backupPath ? await fs.readFile(backupPath) : undefined;
  await assert.rejects(store.withdraw(withdraw), error => (error as { code: string }).code === 'WITHDRAW_NOT_ALLOWED');
  assert.deepEqual(store.status(reviewId), before); assert.deepEqual(await fs.readFile(target), disk);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), cache);
  if (backupPath) assert.deepEqual(await fs.readFile(backupPath), backup);
});

test('withdraw queued behind an active save cannot cancel it or change its resulting receipt', async t => {
  const reached = gate(), resume = gate();
  const { store, reviewId, withdraw } = await fixture(t, async point => {
    if (point === 'backup') { reached.release(); await resume.promise; }
  });
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  const committing = store.commitSave(preview.token);
  await reached.promise;
  assert.equal(store.status(reviewId).reviews[0].targets[0].status, 'saving');
  const withdrawing = store.withdraw(withdraw), refused = assert.rejects(withdrawing, error => (error as { code: string }).code === 'WITHDRAW_NOT_ALLOWED');
  try { assert.equal(await Promise.race([withdrawing.then(() => 'settled', () => 'settled'), delay(15, 'pending')]), 'pending'); }
  finally { resume.release(); }
  const receipt = await committing; await refused;
  assert.deepEqual(store.status(reviewId).reviews[0].targets[0].receipt, receipt);
  assert.equal(store.status(reviewId).reviews[0].withdrawnAt, undefined);
});

test('withdraw refuses uncertain saves, but a failed save proven to leave the original intact may be withdrawn', async t => {
  const { dataDir, store, target, original, reviewId, withdraw } = await fixture(t, point => { if (point === 'afterReplace') throw new Error('interrupted after replace'); });
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  await assert.rejects(store.commitSave(preview.token), /interrupted/);
  const before = store.status(reviewId), cache = await fs.readFile(path.join(dataDir, 'state.json'));
  await assert.rejects(store.withdraw(withdraw), /尚未核验/);
  assert.deepEqual(store.status(reviewId), before); assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), cache);
  assert.notDeepEqual(await fs.readFile(target), original);
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  assert.equal(recovered.status(reviewId).reviews[0].targets[0].status, 'saved');
  await assert.rejects(recovered.withdraw(withdraw), error => (error as { code: string }).code === 'WITHDRAW_NOT_ALLOWED');

  const other = await fixture(t, point => { if (point === 'backup') throw new Error('backup unavailable'); });
  const failed = await other.store.prepareSave({ reviewId: other.reviewId, side: 'right', expectedRevision: 0 });
  await assert.rejects(other.store.commitSave(failed.token), /backup unavailable/);
  assert.equal((await other.store.withdraw(other.withdraw)).status, 'withdrawn');
  assert.deepEqual(await fs.readFile(other.target), other.original);
});

for (const phase of ['intent', 'applied', 'unknown'] as const) test(`withdraw refuses unresolved ${phase} save plans without publishing withdrawal`, async t => {
  const { dataDir, store, reviewId, withdraw } = await fixture(t);
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  // Emulate interrupted state that can also exist while journal recovery is pending.
  const internal = store as unknown as { state: { plans: Record<string, { phase: string; outcome?: string }> } };
  internal.state.plans[preview.token].phase = phase === 'unknown' ? 'failed' : phase;
  if (phase === 'unknown') internal.state.plans[preview.token].outcome = 'unknown';
  const before = store.list(), cache = await fs.readFile(path.join(dataDir, 'state.json'));
  await assert.rejects(store.withdraw(withdraw), /尚未核验/);
  assert.deepEqual(store.list(), before); assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), cache);
});

test('failed withdrawal persistence is atomic and preserves draft ownership and prepared tokens for retry', async t => {
  const { root, dataDir, store, target, original, reviewId, withdraw } = await fixture(t);
  const preview = await store.prepareSave({ reviewId, side: 'right', expectedRevision: 0 });
  const before = store.list(), statePath = path.join(dataDir, 'state.json'), retained = path.join(dataDir, 'retained-state.json');
  const cache = await fs.readFile(statePath);
  await fs.rename(statePath, retained); await fs.mkdir(statePath);
  try {
    await assert.rejects(store.withdraw(withdraw)); assert.deepEqual(store.list(), before);
    await assert.rejects(store.openFiles({ mode: 'single', paths: [target] }), /已有待处理审查/);
  } finally { await fs.rmdir(statePath); await fs.rename(retained, statePath); }
  assert.deepEqual(await fs.readFile(statePath), cache); assert.deepEqual(await fs.readFile(target), original);
  await assert.rejects(fs.stat(path.join(root, '.diffeditor-backups')), { code: 'ENOENT' });
  const recovered = new ReviewStore({ dataDir }); await recovered.init(); assert.deepEqual(recovered.list(), before);
  const durable = JSON.parse(await fs.readFile(statePath, 'utf8')); assert.equal(durable.plans[preview.token].phase, 'prepared');
  const receipt = await recovered.withdraw(withdraw); assert.equal(receipt.duplicate, false);
  await assert.rejects(recovered.commitSave(preview.token), /找不到保存预览/);
});

test('pipe validates withdrawal proof fields and exposes no draft, save or lifecycle mutations', async () => {
  let calls = 0;
  const store = { withdraw: async () => { calls++; return { reviewId: 'r', status: 'withdrawn' }; } } as unknown as ReviewStore;
  for (const payload of [null, [], {}, { reviewId: 'r' }, { requestId: 'q' }, { reviewId: '', requestId: 'q' },
    { reviewId: 'r', requestId: ' ' }, { reviewId: 1, requestId: 'q' }, { reviewId: 'r', requestId: 1 },
    ...[undefined, false, 'true', 1, null].map(requireUnedited => ({ reviewId: 'r', requestId: 'q', requireUnedited })),
    { reviewId: 'r', requestId: 'q', requireUnedited: true, force: true }, { reviewId: 'r', requestId: 'q', requireUnedited: true, text: 'injected' }]) {
    assert.equal((await handleCli(store, { command: 'withdraw', payload }, () => assert.fail('withdraw invoked submit callback'))).ok, false);
  }
  assert.equal(calls, 0);
  assert.equal((await handleCli(store, { command: 'withdraw', payload: { reviewId: 'r', requestId: 'q', requireUnedited: true } }, () => assert.fail('withdraw invoked submit callback'))).ok, true);
  assert.equal(calls, 1);
  for (const command of ['updateDraft', 'update-draft', 'close', 'delete', 'reject', 'save', 'approve']) {
    assert.equal((await handleCli(store, { command, payload: { reviewId: 'r', requestId: 'q' } }, () => {})).ok, false);
  }
  assert.equal(calls, 1);
});
