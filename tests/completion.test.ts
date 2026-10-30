import test from 'node:test';
import assert from 'node:assert/strict';
import { proposalCompletionAt } from '../src/shared/completion';
import type { ReviewView, TargetView } from '../src/shared/contracts';

const first = '2026-10-29T10:00:00.000Z', last = '2026-10-30T10:00:00.000Z';
const target = (status: TargetView['status'], savedAt?: string): TargetView => ({
  id: 'target', path: 'target.txt', encoding: 'utf8', bom: false, exists: true, baseHash: 'before', status,
  ...(savedAt ? { receipt: { operationId: 'save', targetPath: 'target.txt', beforeHash: 'before', afterHash: 'after', savedAt, side: 'right' as const } } : {}),
});
const proposal = (targets: TargetView[], withdrawnAt?: string): Pick<ReviewView, 'mode' | 'targets' | 'withdrawnAt'> => ({ mode: 'proposal', targets, withdrawnAt });

test('proposal completion uses the latest receipt only when every target is saved with a receipt', () => {
  assert.equal(proposalCompletionAt(proposal([target('saved', last), target('saved', first)])), last);
  assert.equal(proposalCompletionAt(proposal([target('saved', first), target('saved', last)])), last);
  for (const incomplete of ['pending', 'saving', 'conflict', 'error', 'rejected', 'withdrawn'] as const) {
    assert.equal(proposalCompletionAt(proposal([target('saved', first), target(incomplete, last)], last)), undefined);
  }
  assert.equal(proposalCompletionAt(proposal([target('saved')])), undefined);
  assert.equal(proposalCompletionAt(proposal([])), undefined);
});

test('withdrawal completion requires a timestamp and every target withdrawn', () => {
  assert.equal(proposalCompletionAt(proposal([target('withdrawn'), target('withdrawn')], last)), last);
  assert.equal(proposalCompletionAt(proposal([target('withdrawn')])), undefined);
  assert.equal(proposalCompletionAt(proposal([], last)), undefined);
  assert.equal(proposalCompletionAt(proposal([target('withdrawn'), target('pending')], last)), undefined);
  assert.equal(proposalCompletionAt(proposal([target('rejected')], last)), undefined);
});

test('manual comparisons never count as completed AI proposals', () => {
  for (const mode of ['single', 'pair', 'text'] as const) {
    assert.equal(proposalCompletionAt({ mode, targets: [target('saved', last)] }), undefined);
    assert.equal(proposalCompletionAt({ mode, targets: [target('withdrawn')], withdrawnAt: last }), undefined);
  }
});
