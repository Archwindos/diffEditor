import type { editor } from 'monaco-editor';
import type { Side } from '../shared/contracts';

/** Monaco uses endLineNumber=0 for an empty side of an insertion/deletion. */
export function replaceChunk(source: string, destination: string, change: editor.ILineChange, from: Side): string {
  const sourceLines = source.split('\n');
  const destLines = destination.split('\n');
  const sourceStart = from === 'left' ? change.originalStartLineNumber : change.modifiedStartLineNumber;
  const sourceEnd = from === 'left' ? change.originalEndLineNumber : change.modifiedEndLineNumber;
  const destStart = from === 'left' ? change.modifiedStartLineNumber : change.originalStartLineNumber;
  const destEnd = from === 'left' ? change.modifiedEndLineNumber : change.originalEndLineNumber;
  const replacement = sourceEnd === 0 ? [] : sourceLines.slice(sourceStart - 1, sourceEnd);
  destLines.splice(destEnd === 0 ? destStart : destStart - 1, destEnd === 0 ? 0 : destEnd - destStart + 1, ...replacement);
  return destLines.join('\n');
}
