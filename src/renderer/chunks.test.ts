import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceChunk } from './chunks';

const change = (originalStartLineNumber: number, originalEndLineNumber: number, modifiedStartLineNumber: number, modifiedEndLineNumber: number) => ({ originalStartLineNumber, originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber, charChanges: undefined });
test('insertions at beginning, middle and end use the empty-side anchor', () => {
  assert.equal(replaceChunk('x\na', 'a', change(1, 1, 0, 0), 'left'), 'x\na');
  assert.equal(replaceChunk('a\nx\nb', 'a\nb', change(2, 2, 1, 0), 'left'), 'a\nx\nb');
  assert.equal(replaceChunk('a\nlast', 'a', change(2, 2, 1, 0), 'left'), 'a\nlast');
});
test('deletions and the reverse direction preserve unrelated text', () => {
  assert.equal(replaceChunk('a\nb', 'a\nx\nb', change(1, 0, 2, 2), 'left'), 'a\nb');
  assert.equal(replaceChunk('a\nx\nb', 'a\nb', change(1, 0, 2, 2), 'right'), 'a\nx\nb');
  assert.equal(replaceChunk('a\nb', 'a\nx\nb', change(2, 2, 1, 0), 'right'), 'a\nb');
});
test('empty documents and trailing newlines can be copied exactly', () => {
  assert.equal(replaceChunk('', 'x', change(1, 1, 1, 1), 'left'), '');
  assert.equal(replaceChunk('x', '', change(1, 1, 1, 1), 'left'), 'x');
  assert.equal(replaceChunk('a\n', 'a', change(2, 2, 1, 0), 'left'), 'a\n');
  assert.equal(replaceChunk('a', 'a\n', change(1, 0, 2, 2), 'left'), 'a');
});
