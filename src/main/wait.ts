import { MAX_WAIT_MS, type WaitRequest, type WaitResponse, type ReviewStatus } from '../shared/contracts';
import type { ReviewStore } from '../core/store';

export function validateWaitRequest(payload: Record<string, unknown>): WaitRequest {
  const { reviewIds, timeoutMs } = payload;
  if (Object.keys(payload).some(key => !['reviewIds', 'timeoutMs'].includes(key)) ||
      !Array.isArray(reviewIds) || !reviewIds.length ||
      reviewIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(reviewIds).size !== reviewIds.length ||
      typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) {
    throw new Error('wait 需要不重复的非空 reviewIds，以及 1 到 86400000 毫秒的 timeoutMs');
  }
  return { reviewIds, timeoutMs };
}

const saved = (review: ReviewStatus) => review.targets.length > 0 && review.targets.every(t => t.status === 'saved' && !!t.receipt);

// This observer must stay outside the store's write queue: saving needs that queue.
export function waitForReviews(store: ReviewStore, request: WaitRequest, signal?: AbortSignal): Promise<WaitResponse> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, result?: WaitResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error('等待已取消；保存结果请重新查询 status 或 wait'));
    const check = (timedOut = false) => {
      if (finished) return;
      try {
        const reviews = request.reviewIds.map(id => store.status(id).reviews[0]);
        const reason = reviews.every(saved) ? 'saved' : reviews.some(review => !saved(review) &&
          (review.lifecycle === 'closed' || review.lifecycle === 'deleted' ||
            review.targets.some(t => ['error', 'conflict', 'rejected'].includes(t.status)))) ? 'attention' : timedOut ? 'timeout' : undefined;
        if (reason) finish(undefined, { reason, reviews });
      } catch (error) { finish(error); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    // Subscribe first, then read durable state so a quick save cannot be missed.
    unsubscribe = store.onDidChange(() => check());
    timer = setTimeout(() => check(true), request.timeoutMs);
    check();
  });
}
