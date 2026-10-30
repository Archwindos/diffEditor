import { randomUUID } from 'node:crypto';
import { ReviewError } from '../core/store';
import type { WithdrawFinished, WithdrawPreflight, WithdrawRequest, WithdrawResponse } from '../shared/contracts';

interface Renderer {
  id: number;
  send(channel: string, payload: WithdrawPreflight | WithdrawFinished): void;
}
interface Pending {
  renderer: Renderer;
  request: WithdrawPreflight;
  timer: ReturnType<typeof setTimeout>;
  ready: boolean;
  resolve: (finish: (result?: WithdrawResponse) => void) => void;
  reject: (error: ReviewError) => void;
}

// The pipe cannot observe text still waiting for Monaco's draft-cache debounce.
// Keep both editors frozen from the renderer's flush until the serial store check ends.
export class WithdrawCoordinator {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly getRenderer: () => Renderer | undefined, private readonly timeoutMs = 5000) {}

  beforeWithdraw = async ({ reviewId }: WithdrawRequest): Promise<(result?: WithdrawResponse) => void> => {
    const renderer = this.getRenderer();
    if (!renderer) throw new ReviewError('编辑窗口不可用，无法核验未缓存的人工编辑；请恢复窗口后重试', 'WITHDRAW_RENDERER_UNAVAILABLE', [reviewId]);
    const request = { token: randomUUID(), reviewId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(request.token, '编辑窗口未及时完成草稿核验，提案保持原状态', 'WITHDRAW_PREFLIGHT_TIMEOUT'), this.timeoutMs);
      this.pending.set(request.token, { renderer, request, timer, ready: false, resolve, reject });
      try { renderer.send('review:before-withdraw', request); }
      catch { this.fail(request.token, '编辑窗口不可用，提案保持原状态', 'WITHDRAW_RENDERER_UNAVAILABLE'); }
    });
  };

  ready(rendererId: number, token: unknown, error?: unknown): boolean {
    if (typeof token !== 'string') return false;
    const pending = this.pending.get(token);
    if (!pending || pending.renderer.id !== rendererId || pending.ready) return false;
    if (error !== undefined) {
      this.fail(token, typeof error === 'string' && error.trim() ? error : '编辑窗口无法核验草稿，提案保持原状态', 'WITHDRAW_PREFLIGHT_FAILED');
      return true;
    }
    clearTimeout(pending.timer);
    pending.ready = true;
    pending.resolve(result => this.finish(token, result));
    return true;
  }

  rendererGone(rendererId: number) {
    for (const [token, pending] of this.pending) if (pending.renderer.id === rendererId && !pending.ready) {
      this.fail(token, '编辑窗口已退出，无法核验未缓存的人工编辑；提案保持原状态', 'WITHDRAW_RENDERER_UNAVAILABLE');
    }
  }

  private fail(token: string, message: string, code: string) {
    const pending = this.pending.get(token);
    if (!pending) return;
    this.finish(token);
    pending.reject(new ReviewError(message, code, [pending.request.reviewId]));
  }

  private finish(token: string, result?: WithdrawResponse) {
    const pending = this.pending.get(token);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(token);
    try { pending.renderer.send('review:withdraw-finished', { ...pending.request, ...(result ? { withdrawnAt: result.withdrawnAt } : {}) }); }
    catch { /* Renderer recovery can reload the authoritative persisted state. */ }
  }
}
