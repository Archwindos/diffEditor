import net from 'node:net';
import { MAX_MESSAGE_BYTES } from '../shared/transport';
import type { BaselineRequest, SubmitRequest, TextEncoding, WireReply } from '../shared/contracts';
import type { ReviewStore } from '../core/store';
import { validateWaitRequest, waitForReviews } from './wait';
const encodings: TextEncoding[] = ['utf8', 'utf16le', 'utf16be', 'gb18030'];
export function failure(error: unknown): WireReply {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
export async function handleCli(store: ReviewStore, request: unknown, onSubmit: () => void,
  waiting?: { signal: AbortSignal; onWait: () => void }): Promise<WireReply> {
  try {
    if (!request || typeof request !== 'object') throw new Error('请求必须为 JSON 对象');
    const { command, payload } = request as { command?: unknown; payload?: unknown };
    if (!payload || typeof payload !== 'object') throw new Error('缺少请求参数');
    const p = payload as Record<string, unknown>;
    if (command === 'baseline') {
      if (!Array.isArray(p.paths) || p.paths.length === 0 || p.paths.some(x => typeof x !== 'string' || !x)) throw new Error('paths 必须为非空文件路径列表');
      if (p.encoding !== undefined && !encodings.includes(p.encoding as TextEncoding)) throw new Error('不支持的编码');
      return { ok: true, result: await store.baseline(p as unknown as BaselineRequest) };
    }
    if (command === 'submit') {
      if (typeof p.requestId !== 'string' || !p.requestId || !Array.isArray(p.files) || p.files.length === 0) throw new Error('提交需要 requestId 和 files');
      if (p.title !== undefined && typeof p.title !== 'string') throw new Error('title 必须为文本');
      if (p.files.some(f => !f || typeof f !== 'object' || typeof f.baselineId !== 'string' || typeof f.text !== 'string')) throw new Error('每个文件需要 baselineId 和 text');
      const result = await store.submit(p as unknown as SubmitRequest);
      onSubmit();
      return { ok: true, result };
    }
    if (command === 'status') {
      if (p.reviewId !== undefined && typeof p.reviewId !== 'string') throw new Error('reviewId 必须为文本');
      return { ok: true, result: store.status(p.reviewId as string | undefined) };
    }
    if (command === 'wait') {
      const input = validateWaitRequest(p);
      waiting?.onWait();
      return { ok: true, result: await waitForReviews(store, input, waiting?.signal) };
    }
    throw new Error('CLI 仅支持 baseline、submit、status、wait；保存必须在桌面窗口中确认');
  } catch (error) { return failure(error); }
}
export function createPipeServer(store: ReviewStore, onSubmit: () => void): net.Server {
  return net.createServer(socket => {
    const abort = new AbortController();
    socket.once('close', () => abort.abort());
    let bytes = 0;
    const chunks: Buffer[] = [];
    let done = false;
    socket.setTimeout(30000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) {
        done = true;
        socket.end(JSON.stringify(failure(new Error('请求超过 32 MiB 限制'))) + '\n');
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      done = true;
      const line = Buffer.concat(chunks).toString('utf8').split('\n')[0];
      (async () => {
        let reply: WireReply;
        try { reply = await handleCli(store, JSON.parse(line), onSubmit, {
          signal: abort.signal,
          // Validated waits have their own bounded review deadline.
          onWait: () => socket.setTimeout(0),
        }); }
        catch (error) { reply = failure(error); }
        if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n');
      })();
    });
  });
}
