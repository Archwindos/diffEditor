import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BaselineRequest, BaselineResponse, SubmitRequest, SubmitResponse, OpenFilesRequest, UpdateDraftRequest, PrepareSaveRequest, SavePreview, SaveReceipt, ReviewView, ReviewStatus, TargetView, WorkspaceView, StatusResponse, TextEncoding } from '../shared/contracts';
import { decode, encode, hash, normalize, type TextSnapshot } from './text';

interface Snapshot extends TextSnapshot { id: string; path: string; exists: boolean; sha256: string | null; identity: string | null; mode?: number; }
interface Target extends TargetView { snapshot: Snapshot; }
interface Review extends Omit<ReviewView, 'targets'> { targets: Target[]; }
type Phase = 'prepared' | 'intent' | 'applied' | 'done' | 'failed';
interface Plan { preview: SavePreview; bytes: string; bom: boolean; targetId: string; beforeIdentity: string | null; revisions: number[]; phase: Phase; receipt?: SaveReceipt; outcome?: 'before' | 'after' | 'unknown'; error?: string; }
interface State { version: 1; baselines: Record<string, Snapshot>; requests: Record<string, { payload?: string; payloadHash?: string; reviewIds: string[] }>; reviews: Review[]; plans: Record<string, Plan>; deleted?: Record<string, ReviewStatus>; }
const fresh = (): State => ({ version: 1, baselines: {}, requests: {}, reviews: [], plans: {}, deleted: {} });
const identity = (stat: Awaited<ReturnType<typeof fs.stat>>) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const copy = <T>(value: T): T => structuredClone(value);
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const errorMessage = (error: unknown): string => {
  const failure = error as NodeJS.ErrnoException;
  if (failure.code) {
    const messages: Record<string, string> = { ENOENT: '文件或目录不存在', EACCES: '没有访问权限', EPERM: '文件被占用或没有操作权限', EEXIST: '目标已经存在', ENOSPC: '磁盘空间不足', EIO: '磁盘读写失败', EISDIR: '目标是目录', ENOTDIR: '路径中的目录无效' };
    return `${messages[failure.code] ?? '文件操作失败'}（${failure.code}）${failure.path ? `：${failure.path}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
};
const diskMessage = (outcome: Plan['outcome']) => outcome === 'before' ? '原稿未改，请从磁盘继续后重新保存。' : outcome === 'after' ? '已写入待核验，请重新打开应用核验，或从磁盘继续。' : '目标状态不明或与两版均不一致，请检查磁盘文件并从磁盘继续。';
export type Failpoint = 'backup' | 'beforeReplace' | 'afterReplace';

export class ReviewStore {
  private state: State = fresh();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly statePath: string;
  constructor(private readonly options: { dataDir: string; onChange?: () => void; failpoint?: (point: Failpoint) => void | Promise<void> }) {
    this.statePath = path.join(options.dataDir, 'state.json');
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work).catch(error => { throw new Error(errorMessage(error)); }); this.queue = result.catch(() => undefined); return result;
  }
  private async persist(state: State) {
    await fs.mkdir(this.options.dataDir, { recursive: true });
    const temporary = this.statePath + '.' + randomUUID() + '.tmp';
    try {
      const file = await fs.open(temporary, 'wx');
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, this.statePath);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
    this.state = copy(state);
    try { this.options.onChange?.(); } catch { /* UI notification cannot undo a persisted operation. */ }
  }
  async init() {
    return this.serial(async () => {
      await fs.mkdir(this.options.dataDir, { recursive: true });
      try { const loaded = JSON.parse(await fs.readFile(this.statePath, 'utf8')); if (loaded.version !== 1) throw new Error('草稿缓存版本不受支持'); this.state = loaded; }
      catch (error) { if (!isMissing(error)) throw new Error(`无法读取草稿缓存：${error instanceof SyntaxError ? '缓存内容损坏或格式无效' : errorMessage(error)}`); }
      const next = copy(this.state); let recovered = false;
      for (const plan of Object.values(next.plans)) if (plan.phase === 'intent' || plan.phase === 'applied' || (plan.phase === 'failed' && plan.outcome === 'after')) {
        plan.outcome = await this.outcome(plan);
        const target = next.reviews.find(review => review.id === plan.preview.reviewId)?.targets.find(target => target.id === plan.targetId);
        if (!target) {
          plan.phase = 'failed'; plan.outcome = 'unknown'; plan.error = '保存记录缺少审查或目标引用，无法自动核验；请检查磁盘文件。'; recovered = true; continue;
        }
        if (plan.outcome === 'after' && await this.verifyRecoveryBackup(plan, target) && await this.outcome(plan) === 'after') {
          const receipt = this.receipt(plan);
          this.markSaved(next, plan, target, receipt);
        } else {
          plan.phase = 'failed';
          plan.error = plan.outcome === 'after' ? '已写入待核验，但备份缺失或校验失败；请检查磁盘文件并从磁盘继续。' : `上次保存中断：${diskMessage(plan.outcome)}`;
          target.status = 'error'; target.error = plan.error;
        }
        recovered = true;
      }
      if (recovered) await this.persist(next);
    });
  }
  private view(review: Review): ReviewView {
    const result = copy(review); return { ...result, targets: result.targets.map(({ snapshot: _snapshot, ...target }) => target) };
  }
  list(): WorkspaceView { return { reviews: this.state.reviews.map(review => this.view(review)) }; }
  status(reviewId?: string): StatusResponse {
    const reviews: ReviewStatus[] = [...this.list().reviews.map(review => ({ id: review.id, title: review.title, targets: review.targets, leftRevision: review.left.revision, rightRevision: review.right.revision, lifecycle: review.closedAt ? 'closed' as const : 'open' as const })), ...Object.values(this.state.deleted ?? {}).map(copy)].filter(review => !reviewId || review.id === reviewId);
    if (reviewId && !reviews.length) throw new Error('找不到此审查记录');
    return { reviews };
  }
  private review(state: State, id: string) { const review = state.reviews.find(item => item.id === id); if (!review) throw new Error('找不到此审查记录'); return review; }
  private assertOpen(review: Review) { if (review.closedAt) throw new Error('比较已关闭，请重新打开后操作'); }
  private assertNoUnresolvedSave(state: State, reviewId: string) {
    if (Object.values(state.plans).some(plan => plan.preview.reviewId === reviewId && (plan.phase === 'intent' || plan.phase === 'applied' || (plan.phase === 'failed' && plan.outcome !== 'before')))) throw new Error('保存结果尚未核验，请先检查文件并从磁盘继续，再处理此比较');
  }
  private findTarget(state: State, reviewId: string, targetId: string) { const target = this.review(state, reviewId).targets.find(item => item.id === targetId); if (!target) throw new Error('找不到目标文件'); return target; }
  private async snapshot(input: string, encoding?: TextEncoding): Promise<Snapshot> {
    const absolute = path.resolve(input);
    const parent = await fs.realpath(path.dirname(absolute));
    const targetPath = path.join(parent, path.basename(absolute));
    try {
      const link = await fs.lstat(targetPath); if (!link.isFile() || link.isSymbolicLink()) throw new Error('只支持普通文件，不支持目录或符号链接');
      const file = await fs.open(targetPath, 'r');
      try {
        const before = await file.stat(); const bytes = await file.readFile(); const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('读取时文件发生变化，请重试');
        return { ...decode(bytes, encoding), id: randomUUID(), path: targetPath, exists: true, sha256: hash(bytes), identity: identity(after), mode: after.mode };
      } finally { await file.close(); }
    } catch (error) {
      if (!isMissing(error)) throw error;
      const empty = decode(Buffer.alloc(0), encoding);
      // New UTF-16 files need a BOM so future opens detect their encoding.
      if (encoding === 'utf16le' || encoding === 'utf16be') {
        empty.bom = true;
        empty.raw = Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]).toString('base64');
      }
      return { ...empty, id: randomUUID(), path: targetPath, exists: false, sha256: null, identity: null };
    }
  }
  async baseline(request: BaselineRequest): Promise<BaselineResponse> {
    return this.serial(async () => {
      if (!request.paths.length) throw new Error('请至少选择一个文件');
      const snapshots = await Promise.all(request.paths.map(file => this.snapshot(file, request.encoding)));
      const next = copy(this.state); for (const snapshot of snapshots) next.baselines[snapshot.id] = snapshot;
      await this.persist(next);
      return { files: snapshots.map(({ id, path, sha256, exists, text, encoding, bom }) => ({ id, path, sha256, exists, text, encoding, bom })) };
    });
  }
  private assertAvailable(state: State, snapshots: Snapshot[], excludedTargetId?: string) {
    const paths = new Set<string>();
    for (const snapshot of snapshots) {
      if (paths.has(key(snapshot.path))) throw new Error('目标路径重复'); paths.add(key(snapshot.path));
      for (const review of state.reviews) for (const target of review.targets) if (target.id !== excludedTargetId && key(target.path) === key(snapshot.path) && !['saved', 'rejected'].includes(target.status)) throw new Error(`此文件已有待处理审查：${snapshot.path}`);
    }
  }
  private makeReview(snapshots: Snapshot[], mode: Review['mode'], title?: string, proposal?: string): Review {
    const now = new Date().toISOString();
    const targets: Target[] = snapshots.map(snapshot => ({ id: randomUUID(), path: snapshot.path, encoding: snapshot.encoding, bom: snapshot.bom, exists: snapshot.exists, baseHash: snapshot.sha256, status: 'pending', snapshot }));
    return { id: randomUUID(), title: title || snapshots.map(item => path.basename(item.path)).join(' ↔ '), mode, createdAt: now, updatedAt: now,
      left: { text: snapshots[0].text, revision: 0, targetId: targets[0].id },
      right: { text: proposal === undefined ? snapshots[snapshots.length - 1].text : normalize(proposal), revision: 0, targetId: targets[targets.length - 1].id }, targets };
  }
  async createTextReview(): Promise<ReviewView> {
    return this.serial(async () => {
      const next = copy(this.state), now = new Date().toISOString();
      const review: Review = { id: randomUUID(), title: '文本比较', mode: 'text', createdAt: now, updatedAt: now, left: { text: '', revision: 0, targetId: null }, right: { text: '', revision: 0, targetId: null }, targets: [] };
      next.reviews.push(review); await this.persist(next); return this.view(review);
    });
  }
  async setReviewClosed(reviewId: string, closed: boolean): Promise<void> {
    return this.serial(async () => {
      const next = copy(this.state), review = this.review(next, reviewId);
      if (review.targets.some(target => target.status === 'saving')) throw new Error('正在保存，请稍候');
      if (!!review.closedAt === closed) return;
      review.closedAt = closed ? new Date().toISOString() : undefined;
      review.updatedAt = new Date().toISOString();
      for (const [token, plan] of Object.entries(next.plans)) if (plan.preview.reviewId === reviewId && plan.phase === 'prepared') delete next.plans[token];
      await this.persist(next);
    });
  }
  async deleteReview(reviewId: string): Promise<void> {
    return this.serial(async () => {
      if (this.state.deleted?.[reviewId]) return;
      const next = copy(this.state), review = this.review(next, reviewId);
      if (review.targets.some(target => target.status === 'saving')) throw new Error('正在保存，请稍候');
      this.assertNoUnresolvedSave(next, reviewId);
      const { left, right, targets } = this.view(review);
      (next.deleted ??= {})[reviewId] = { id: review.id, title: review.title, targets, leftRevision: left.revision, rightRevision: right.revision, lifecycle: 'deleted' };
      next.reviews = next.reviews.filter(item => item.id !== reviewId);
      for (const [token, plan] of Object.entries(next.plans)) if (plan.preview.reviewId === reviewId) delete next.plans[token];
      for (const target of review.targets) if (!next.reviews.some(item => item.targets.some(other => other.snapshot.id === target.snapshot.id))) delete next.baselines[target.snapshot.id];
      for (const request of Object.values(next.requests)) if (request.reviewIds.includes(reviewId) && request.payload !== undefined) { request.payloadHash = hash(Buffer.from(request.payload)); delete request.payload; }
      await this.persist(next);
    });
  }
  async submit(request: SubmitRequest): Promise<SubmitResponse> {
    return this.serial(async () => {
      if (!request.requestId || !request.files.length) throw new Error('必须提供 requestId 和文件');
      const payload = JSON.stringify({ title: request.title ?? '', files: request.files.map(file => ({ baselineId: file.baselineId, text: file.text })) });
      const prior = this.state.requests[request.requestId];
      if (prior) { if ((prior.payloadHash ?? hash(Buffer.from(prior.payload ?? ''))) !== hash(Buffer.from(payload))) throw new Error('此 requestId 已用于不同内容，不能重复使用'); return { reviewIds: [...prior.reviewIds], duplicate: true }; }
      const snapshots = request.files.map(file => { const snapshot = this.state.baselines[file.baselineId]; if (!snapshot) throw new Error('找不到原始快照'); return snapshot; });
      this.assertAvailable(this.state, snapshots);
      const next = copy(this.state);
      const reviews = snapshots.map((snapshot, index) => this.makeReview([snapshot], 'proposal', request.title, request.files[index].text));
      next.reviews.push(...reviews); const reviewIds = reviews.map(review => review.id);
      next.requests[request.requestId] = { payloadHash: hash(Buffer.from(payload)), reviewIds }; await this.persist(next); return { reviewIds, duplicate: false };
    });
  }
  async openFiles(request: OpenFilesRequest): Promise<WorkspaceView> {
    return this.serial(async () => {
      if (!request.paths.length || (request.mode === 'pair' && request.paths.length !== 2)) throw new Error('请选择至少一个文件；双文件比较需要两个文件');
      const snapshots = await Promise.all(request.paths.map(file => this.snapshot(file, request.encoding)));
      // A pair may intentionally show the same target twice.
      const unique = snapshots.filter((snapshot, index) => snapshots.findIndex(other => key(other.path) === key(snapshot.path)) === index);
      this.assertAvailable(this.state, request.mode === 'pair' ? unique : snapshots);
      const next = copy(this.state);
      if (request.mode === 'single') next.reviews.push(...snapshots.map(snapshot => this.makeReview([snapshot], 'single')));
      else {
        const review = this.makeReview(snapshots, 'pair');
        if (unique.length === 1) { review.targets.pop(); review.right.targetId = review.left.targetId; }
        next.reviews.push(review);
      }
      await this.persist(next); return this.list();
    });
  }
  async updateDraft(request: UpdateDraftRequest): Promise<ReviewView> {
    return this.serial(async () => {
      const next = copy(this.state), review = this.review(next, request.reviewId), pane = review[request.side];
      this.assertOpen(review);
      const target = pane.targetId === null ? undefined : this.findTarget(next, review.id, pane.targetId);
      if (target && (target.status === 'saved' || target.status === 'rejected' || target.status === 'saving')) throw new Error('目标已冻结，请从磁盘继续后编辑');
      if (pane.revision !== request.expectedRevision) throw new Error('草稿版本已变化，请刷新后重试');
      pane.text = normalize(request.text); pane.revision++; review.updatedAt = new Date().toISOString();
      await this.persist(next); return this.view(review);
    });
  }
  async prepareSave(request: PrepareSaveRequest): Promise<SavePreview> {
    return this.serial(async () => {
      const next = copy(this.state), review = this.review(next, request.reviewId), pane = review[request.side];
      this.assertOpen(review);
      if (pane.revision !== request.expectedRevision) throw new Error('草稿版本已变化，请刷新后重试');
      let target = pane.targetId === null ? undefined : this.findTarget(next, review.id, pane.targetId);
      if (request.newPath && target && !(review.mode === 'text' && !target.exists && target.status === 'pending')) throw new Error('当前目标不能另存为，请从磁盘继续后重新编辑');
      if (!target || request.newPath) {
        if (!request.newPath) throw new Error('请为此文本选择新文件路径');
        if (target) await this.validateDisk(target.snapshot);
        const snapshot = await this.snapshot(request.newPath, request.encoding ?? target?.encoding);
        if (snapshot.exists) throw new Error('目标已经存在，请选择新的文件路径');
        this.assertAvailable(next, [snapshot], target?.id);
        if (target) Object.assign(target, { path: snapshot.path, encoding: snapshot.encoding, bom: snapshot.bom, snapshot });
        else {
          target = { id: randomUUID(), path: snapshot.path, encoding: snapshot.encoding, bom: snapshot.bom, exists: false, baseHash: null, status: 'pending', snapshot };
          review.targets.push(target); pane.targetId = target.id;
        }
        for (const [token, plan] of Object.entries(next.plans)) if (plan.preview.reviewId === review.id && plan.targetId === target.id && plan.phase === 'prepared') delete next.plans[token];
      }
      if (target.status !== 'pending') throw new Error('当前目标不能保存，请从磁盘继续后重新编辑');
      const encoding = request.encoding ?? target.encoding;
      const { bytes, bom } = encode(target.snapshot, pane.text, encoding);
      const token = randomUUID();
      const preview: SavePreview = { token, reviewId: review.id, side: request.side, revision: pane.revision, targetPath: target.path,
        backupPath: target.exists ? path.join(path.dirname(target.path), '.diffeditor-backups', path.basename(target.path) + '.' + token + '.bak') : undefined,
        isNew: !target.exists, encoding, beforeHash: target.baseHash, afterHash: hash(bytes) };
      next.plans[token] = { preview, bytes: bytes.toString('base64'), bom, targetId: target.id, beforeIdentity: target.snapshot.identity, revisions: [review.left.revision, review.right.revision], phase: 'prepared' };
      await this.persist(next); return copy(preview);
    });
  }
  private async validateDisk(snapshot: Snapshot) {
    try {
      const stat = await fs.lstat(snapshot.path);
      if (!snapshot.exists || !stat.isFile() || stat.isSymbolicLink() || identity(stat) !== snapshot.identity) throw new Error('磁盘冲突：目标已被创建或替换');
      if (hash(await fs.readFile(snapshot.path)) !== snapshot.sha256) throw new Error('磁盘冲突：目标内容已变化');
    } catch (error) { if (isMissing(error)) { if (snapshot.exists) throw new Error('磁盘冲突：目标已被删除'); } else throw error; }
  }
  private async outcome(plan: Plan): Promise<'before' | 'after' | 'unknown'> {
    try {
      const stat = await fs.lstat(plan.preview.targetPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return 'unknown';
      const bytes = await fs.readFile(plan.preview.targetPath); const digest = hash(bytes);
      const currentIdentity = identity(await fs.stat(plan.preview.targetPath));
      if (digest === plan.preview.afterHash && (plan.preview.afterHash !== plan.preview.beforeHash || currentIdentity !== plan.beforeIdentity)) return 'after';
      if (digest === plan.preview.beforeHash && currentIdentity === plan.beforeIdentity) return 'before';
    } catch (error) { if (isMissing(error) && plan.preview.isNew) return 'before'; }
    return 'unknown';
  }
  private async verifyRecoveryBackup(plan: Plan, target: Target): Promise<boolean> {
    if (plan.preview.isNew) return !plan.preview.backupPath && plan.preview.beforeHash === null;
    if (!plan.preview.backupPath || plan.preview.beforeHash !== target.snapshot.sha256) return false;
    try {
      const stat = await fs.lstat(plan.preview.backupPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const bytes = await fs.readFile(plan.preview.backupPath);
      return hash(bytes) === plan.preview.beforeHash && bytes.equals(Buffer.from(target.snapshot.raw, 'base64'));
    } catch { return false; }
  }
  private receipt(plan: Plan): SaveReceipt {
    return { operationId: plan.preview.token, targetPath: plan.preview.targetPath, backupPath: plan.preview.backupPath, beforeHash: plan.preview.beforeHash, afterHash: plan.preview.afterHash, side: plan.preview.side, savedAt: new Date().toISOString() };
  }
  private markSaved(state: State, plan: Plan, target: Target, receipt: SaveReceipt) {
    target.status = 'saved'; target.encoding = plan.preview.encoding; target.bom = plan.bom; target.receipt = receipt; target.error = undefined;
    plan.phase = 'done'; plan.receipt = receipt; plan.outcome = 'after'; plan.error = undefined;
    this.review(state, plan.preview.reviewId).updatedAt = receipt.savedAt;
  }
  async commitSave(token: string): Promise<SaveReceipt> {
    return this.serial(async () => {
      let next = copy(this.state), plan = next.plans[token];
      if (!plan) throw new Error('找不到保存预览，请重新准备保存');
      if (plan.phase === 'done' && plan.receipt) return copy(plan.receipt);
      if (plan.phase !== 'prepared') throw new Error('此保存凭证已使用，请检查文件并从磁盘继续');
      const review = this.review(next, plan.preview.reviewId), target = this.findTarget(next, review.id, plan.targetId);
      this.assertOpen(review);
      if (review[plan.preview.side].revision !== plan.preview.revision || [review.left, review.right].some((pane, index) => pane.targetId === target.id && pane.revision !== plan.revisions[index])) throw new Error('保存预览已过期，请重新准备保存');
      if (target.status !== 'pending') throw new Error('目标已冻结，请从磁盘继续后重新保存');
      const bytes = Buffer.from(plan.bytes, 'base64');
      const temporary = path.join(path.dirname(target.path), '.' + path.basename(target.path) + '.' + token + '.tmp');
      try {
        await this.validateDisk(target.snapshot);
        target.status = 'saving'; target.error = undefined; plan.phase = 'intent'; await this.persist(next);
        if (plan.preview.backupPath) {
          await this.options.failpoint?.('backup');
          await fs.mkdir(path.dirname(plan.preview.backupPath), { recursive: true });
          const backup = await fs.open(plan.preview.backupPath, 'wx');
          try { await backup.writeFile(Buffer.from(target.snapshot.raw, 'base64')); await backup.sync(); } finally { await backup.close(); }
          if (hash(await fs.readFile(plan.preview.backupPath)) !== target.baseHash) throw new Error('原稿备份校验失败，已停止保存');
        }
        const output = await fs.open(temporary, 'wx', target.snapshot.mode === undefined ? 0o666 : target.snapshot.mode & 0o777);
        try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
        await this.options.failpoint?.('beforeReplace');
        await this.validateDisk(target.snapshot);
        if (target.exists) await fs.rename(temporary, target.path);
        else { await fs.link(temporary, target.path); await fs.unlink(temporary); }
        await this.options.failpoint?.('afterReplace');
        plan.phase = 'applied'; await this.persist(next);
        if (hash(await fs.readFile(target.path)) !== plan.preview.afterHash) throw new Error('保存后回读校验失败，请检查磁盘文件');
        const receipt = this.receipt(plan);
        this.markSaved(next, plan, target, receipt);
        await this.persist(next); return copy(receipt);
      } catch (error) {
        // Read the durable journal, because a failed cache write must not publish its unpersisted clone.
        next = copy(this.state); plan = next.plans[token];
        plan.phase = 'failed'; plan.error = errorMessage(error); plan.outcome = await this.outcome(plan);
        const failed = this.findTarget(next, plan.preview.reviewId, plan.targetId);
        failed.status = errorMessage(error).includes('磁盘冲突') ? 'conflict' : 'error';
        failed.error = `${errorMessage(error)}；${diskMessage(plan.outcome)}`;
        await this.persist(next).catch(() => undefined);
        throw error;
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    });
  }
  async continueTarget(reviewId: string, targetId: string): Promise<ReviewView> {
    return this.serial(async () => {
      this.assertOpen(this.review(this.state, reviewId));
      const original = this.findTarget(this.state, reviewId, targetId);
      if (original.status === 'saving') throw new Error('正在保存，请稍候');
      if (!['saved', 'error', 'conflict'].includes(original.status)) throw new Error('仅已保存或保存中断的目标可以从磁盘继续');
      const snapshot = await this.snapshot(original.path, original.encoding);
      const next = copy(this.state);
      const prior = this.findTarget(next, reviewId, targetId);
      // A failed review remains visible with its drafts, while releasing ownership explicitly.
      if (prior.status !== 'saved') prior.status = 'rejected';
      for (const [token, plan] of Object.entries(next.plans)) if (plan.preview.reviewId === reviewId && plan.targetId === targetId && plan.phase !== 'done') delete next.plans[token];
      this.assertAvailable(next, [snapshot]);
      const review = this.makeReview([snapshot], 'single'); next.reviews.push(review); await this.persist(next); return this.view(review);
    });
  }
  async rejectReview(reviewId: string): Promise<void> {
    return this.serial(async () => {
      const next = copy(this.state), review = this.review(next, reviewId);
      this.assertOpen(review);
      if (review.targets.some(target => target.status === 'saving')) throw new Error('正在保存，请稍候');
      this.assertNoUnresolvedSave(next, reviewId);
      for (const target of review.targets) if (target.status !== 'saved') target.status = 'rejected';
      await this.persist(next);
    });
  }
}
