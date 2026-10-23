import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewView, SaveReceipt, Side, TargetView } from '../src/shared/contracts';
import { hasOtherUnfinishedFile, retainedReceiptFor } from '../src/renderer/retained';

const receipt = (side: Side, savedAt = '2026-10-23T10:00:00Z'): SaveReceipt => ({ operationId: side, side, savedAt, targetPath: 'paper.tex', beforeHash: 'before', afterHash: side });
const target = (id: string, saved?: SaveReceipt): TargetView => ({ id, path: 'paper.tex', encoding: 'utf8', bom: false, exists: true, baseHash: 'before', status: saved ? 'saved' : 'pending', receipt: saved });
const review = (): ReviewView => ({ id: 'r', title: 'paper.tex', mode: 'single', createdAt: '', updatedAt: '', left: { text: 'left', revision: 1, targetId: 'shared' }, right: { text: 'right', revision: 1, targetId: 'shared' }, targets: [target('shared')] });

test('retained version follows the actual saved side and survives review serialization', () => {
  for (const side of ['left', 'right'] as const) {
    const r = review(); r.targets[0] = target('shared', receipt(side));
    const restored: ReviewView = JSON.parse(JSON.stringify(r));
    assert.equal(retainedReceiptFor(restored)?.side, side);
    assert.equal(hasOtherUnfinishedFile(restored, restored.targets[0].receipt!), false);
  }
});

test('pending, failed or missing save receipts never collapse a comparison', () => {
  const r = review(); assert.equal(retainedReceiptFor(r), undefined);
  r.targets[0].status = 'saved'; assert.equal(retainedReceiptFor(r), undefined);
  r.targets[0].receipt = receipt('right'); r.targets[0].status = 'error';
  assert.equal(retainedReceiptFor(r), undefined);
});

test('independent files preserve access to unfinished work and use the latest saved result', () => {
  const r = review(); r.mode = 'pair'; r.left.targetId = 'a'; r.right.targetId = 'b';
  r.targets = [target('a', receipt('left')), target('b')];
  assert.equal(hasOtherUnfinishedFile(r, retainedReceiptFor(r)!), true);
  r.targets[1] = target('b', receipt('right', '2026-10-23T10:01:00Z'));
  assert.equal(retainedReceiptFor(r)?.side, 'right');
  assert.equal(hasOtherUnfinishedFile(r, retainedReceiptFor(r)!), false);
});

test('saving one text pane leaves the other unbound draft available', () => {
  const r = review(); r.mode = 'text'; r.right.targetId = null;
  r.targets[0] = target('shared', receipt('left'));
  assert.equal(hasOtherUnfinishedFile(r, retainedReceiptFor(r)!), true);
});
