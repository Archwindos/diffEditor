import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';
import iconv from 'iconv-lite';
import type { TextEncoding } from '../shared/contracts';

export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');
export interface TextSnapshot {
  raw: string; text: string; encoding: TextEncoding; bom: boolean;
  lines: string[]; endings: string[]; defaultEnding: string;
}
export function decode(bytes: Buffer, requested?: TextEncoding): TextSnapshot {
  let encoding: TextEncoding = requested ?? 'utf8';
  let offset = 0;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { encoding = 'utf8'; offset = 3; }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) { encoding = 'utf16le'; offset = 2; }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) { encoding = 'utf16be'; offset = 2; }
  const body = bytes.subarray(offset);
  let source: string;
  try {
    if (encoding === 'gb18030') {
      source = iconv.decode(body, encoding, { stripBOM: false });
      if (!iconv.encode(source, encoding).equals(body)) throw new Error('GB18030 字节序列无效');
    } else source = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(body);
  } catch { throw new Error('无法按此编码无损读取，请选择实际编码；不支持二进制文件'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(source)) throw new Error('不支持二进制或包含控制字符的文件');
  const lines: string[] = [], endings: string[] = [];
  const matches = source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g);
  for (const match of matches) {
    if (!match[0]) continue;
    lines.push(match[1]); endings.push(match[2]);
  }
  const counts = new Map<string, number>();
  for (const ending of endings) if (ending) counts.set(ending, (counts.get(ending) ?? 0) + 1);
  const defaultEnding = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n';
  return { raw: bytes.toString('base64'), text: normalize(source), encoding, bom: offset > 0, lines, endings, defaultEnding };
}
export function encode(snapshot: TextSnapshot, draft: string, encoding: TextEncoding): { bytes: Buffer; bom: boolean } {
  const text = normalize(draft);
  const bom = encoding === snapshot.encoding ? snapshot.bom : encoding === 'utf16le' || encoding === 'utf16be';
  if (text === snapshot.text && encoding === snapshot.encoding) return { bytes: Buffer.from(snapshot.raw, 'base64'), bom };
  const finalNewline = text.endsWith('\n');
  const lines = text === '' ? [] : text.split('\n');
  if (finalNewline) lines.pop();
  const endings: (string | undefined)[] = new Array(lines.length);
  let oldIndex = 0, newIndex = 0;
  for (const change of diffArrays(snapshot.lines, lines)) {
    if (change.removed) oldIndex += change.value.length;
    else if (change.added) newIndex += change.value.length;
    else for (let i = 0; i < change.value.length; i++) endings[newIndex++] = snapshot.endings[oldIndex++];
  }
  const source = lines.map((line, index) => {
    if (index === lines.length - 1 && !finalNewline) return line;
    let ending = endings[index];
    if (!ending) {
      for (let i = index - 1; i >= 0 && !ending; i--) ending = endings[i];
      for (let i = index + 1; i < endings.length && !ending; i++) ending = endings[i];
      ending ||= snapshot.defaultEnding;
    }
    return line + ending;
  }).join('');
  const body = iconv.encode(source, encoding);
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(source)) throw new Error('不支持包含二进制控制字符的文本');
  if (iconv.decode(body, encoding, { stripBOM: false }) !== source) throw new Error('所选编码无法无损表示草稿中的部分字符');
  const prefix = !bom ? Buffer.alloc(0) : Buffer.from(encoding === 'utf8' ? [0xef, 0xbb, 0xbf] : encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]);
  return { bytes: Buffer.concat([prefix, body]), bom };
}
