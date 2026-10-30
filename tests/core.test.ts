import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import iconv from 'iconv-lite';
import { ReviewStore, type Failpoint } from '../src/core/store';
import { decode, encode } from '../src/core/text';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, failpoint?: (point: Failpoint) => void | Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffeditor-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'cache'), store = new ReviewStore({ dataDir, failpoint }); await store.init();
  const target = path.join(root, '中文 空格.txt');
  await fs.writeFile(target, 'alpha\r\nbravo\ncharlie\rdelta');
  return { root, dataDir, store, target };
}
async function open(store: ReviewStore, target: string) { return (await store.openFiles({ paths: [target], mode: 'single' })).reviews.at(-1)!; }

test('strict encoding detection and byte-exact unchanged round trips', () => {
  for (const encoding of ['utf8', 'utf16le', 'utf16be', 'gb18030'] as const) {
    const prefixes = { utf8: [0xef, 0xbb, 0xbf], utf16le: [0xff, 0xfe], utf16be: [0xfe, 0xff], gb18030: [] };
    const bytes = Buffer.concat([Buffer.from(prefixes[encoding]), iconv.encode('中文𠀀\r\nx\ry\n', encoding)]);
    const snapshot = decode(bytes, encoding === 'gb18030' ? encoding : undefined);
    assert.equal(snapshot.encoding, encoding);
    assert.equal(snapshot.text, '中文𠀀\nx\ny\n');
    assert.deepEqual(encode(snapshot, snapshot.text, encoding).bytes, bytes);
    const edited = encode(snapshot, snapshot.text + '新增', encoding).bytes;
    assert.equal(decode(edited, encoding === 'gb18030' ? encoding : undefined).text, snapshot.text + '新增');
  }
  assert.throws(() => decode(Buffer.from([0xc3, 0x28])), /无损读取/);
  assert.throws(() => decode(Buffer.from([0xff, 0xfe, 0x00])), /无损读取/);
  assert.throws(() => decode(Buffer.from([65, 0, 66])), /二进制/);
  assert.throws(() => encode(decode(Buffer.from('a')), '\ud800', 'utf8'), /无损表示/);
});

test('mixed line endings follow unchanged lines and draft controls final newline', () => {
  const snapshot = decode(Buffer.from('alpha\r\nbravo\ncharlie\rdelta'));
  assert.equal(encode(snapshot, 'alpha\nchanged\ncharlie\ndelta', 'utf8').bytes.toString(), 'alpha\r\nchanged\r\ncharlie\rdelta');
  assert.equal(encode(snapshot, 'alpha\nbravo\ncharlie\ndelta\n', 'utf8').bytes.toString(), 'alpha\r\nbravo\ncharlie\rdelta\r');
  const terminated = decode(Buffer.from('a\r\nb\n'));
  assert.equal(encode(terminated, 'a\nb', 'utf8').bytes.toString(), 'a\r\nb');
});

test('draft CAS persists independently, final save has verified raw backup and duplicate clicks replay receipt', async t => {
  const { store, target, dataDir } = await fixture(t);
  const original = await fs.readFile(target); const review = await open(store, target);
  await store.updateDraft({ reviewId: review.id, side: 'left', text: 'left choice', expectedRevision: 0 });
  await store.updateDraft({ reviewId: review.id, side: 'right', text: 'right choice\n', expectedRevision: 0 });
  await assert.rejects(store.updateDraft({ reviewId: review.id, side: 'right', text: 'stale', expectedRevision: 0 }), /草稿版本/);
  assert.deepEqual(await fs.readFile(target), original);
  const reopened = new ReviewStore({ dataDir }); await reopened.init();
  assert.equal(reopened.list().reviews[0].left.text, 'left choice');
  assert.equal(reopened.list().reviews[0].right.text, 'right choice\n');
  const preview = await reopened.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 });
  assert.deepEqual(await fs.readFile(target), original);
  const [receipt, duplicate] = await Promise.all([reopened.commitSave(preview.token), reopened.commitSave(preview.token)]);
  assert.deepEqual(receipt, duplicate);
  assert.deepEqual(await fs.readFile(receipt.backupPath!), original);
  assert.equal(decode(await fs.readFile(target)).text, 'right choice\n');
  assert.equal(reopened.status(review.id).reviews[0].targets[0].status, 'saved');
  await assert.rejects(reopened.updateDraft({ reviewId: review.id, side: 'left', text: 'late', expectedRevision: 1 }), /冻结/);
  const continued = await reopened.continueTarget(review.id, review.targets[0].id);
  assert.equal(continued.left.text, 'right choice\n');
  assert.equal(reopened.list().reviews.length, 2);
});

test('save preview becomes stale if either pane editing the same target changes', async t => {
  const { store, target } = await fixture(t); const review = await open(store, target);
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 0 });
  await store.updateDraft({ reviewId: review.id, side: 'left', text: 'changed', expectedRevision: 0 });
  await assert.rejects(store.commitSave(preview.token), /已过期/);
  assert.equal((await fs.readFile(target, 'utf8')).startsWith('alpha'), true);
});

test('stale content and same-path replacement identity prevent overwrite', async t => {
  const { store, target, root } = await fixture(t); const review = await open(store, target);
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 0 });
  const replacement = path.join(root, 'replacement'); await fs.copyFile(target, replacement); await fs.rename(replacement, target);
  await assert.rejects(store.commitSave(preview.token), /被创建或替换/);
  const continued = await store.continueTarget(review.id, review.targets[0].id);
  const second = await store.prepareSave({ reviewId: continued.id, side: 'left', expectedRevision: 0 });
  await fs.writeFile(target, 'external edit');
  await assert.rejects(store.commitSave(second.token), /内容已变化/);
  assert.equal(await fs.readFile(target, 'utf8'), 'external edit');
});

test('idempotent submit binds exact payload and rejects active draft collisions', async t => {
  const { store, target, dataDir } = await fixture(t);
  const baseline = await store.baseline({ paths: [target] });
  const request = { requestId: 'request-one', title: 'Proposal', files: [{ baselineId: baseline.files[0].id, text: 'proposal' }] };
  const first = await store.submit(request); assert.equal(first.duplicate, false);
  await store.updateDraft({ reviewId: first.reviewIds[0], side: 'right', text: 'user draft', expectedRevision: 0 });
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  const replay = await reloaded.submit({ ...request, source: { agent: 'Codex', threadId: 'later-cli-origin' } }); assert.equal(replay.duplicate, true); assert.deepEqual(first.reviewIds, replay.reviewIds);
  assert.equal(reloaded.list().reviews[0].source, undefined);
  assert.equal(reloaded.list().reviews[0].right.text, 'user draft');
  await assert.rejects(reloaded.submit({ ...request, title: 'different' }), /用于不同内容/);
  await assert.rejects(reloaded.submit({ ...request, requestId: 'request-two' }), /已有待处理审查/);
  await reloaded.rejectReview(first.reviewIds[0]);
  await assert.rejects(reloaded.submit({ ...request, requestId: 'request-three' }), { code: 'BASELINE_EXPIRED' });
  const refreshed = await reloaded.baseline({ paths: [target] });
  assert.equal((await reloaded.submit({ ...request, requestId: 'request-three', files: [{ baselineId: refreshed.files[0].id, text: 'new proposal' }] })).duplicate, false);
});

test('proposal-left prepares and legacy pending left tokens cannot write, while right saves remain verified', async t => {
  const { store, target, dataDir } = await fixture(t), review = await open(store, target), original = await fs.readFile(target);
  await store.updateDraft({ reviewId: review.id, side: 'left', text: 'left draft', expectedRevision: 0 });
  await store.updateDraft({ reviewId: review.id, side: 'right', text: 'right candidate', expectedRevision: 0 });
  // A prepared left token from an older version must not bypass the current proposal action.
  const legacy = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1 });
  const statePath = path.join(dataDir, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.reviews[0].mode = 'proposal'; await fs.writeFile(statePath, JSON.stringify(state));
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  const before = reloaded.list(), cache = await fs.readFile(statePath);
  await assert.rejects(reloaded.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1 }), /原稿仅支持退回/);
  await assert.rejects(reloaded.commitSave(legacy.token), /原稿仅支持退回/);
  assert.deepEqual(reloaded.list(), before); assert.deepEqual(await fs.readFile(statePath), cache); assert.deepEqual(await fs.readFile(target), original);
  await assert.rejects(fs.stat(path.dirname(legacy.backupPath!)), { code: 'ENOENT' });
  const right = await reloaded.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 }), receipt = await reloaded.commitSave(right.token);
  assert.equal(receipt.side, 'right'); assert.equal(decode(await fs.readFile(target)).text, 'right candidate');
  assert.deepEqual(await fs.readFile(receipt.backupPath!), original);
});

test('legacy completed proposal-left receipts remain valid history after restart', async t => {
  const { store, target, dataDir } = await fixture(t), review = await open(store, target);
  await store.updateDraft({ reviewId: review.id, side: 'left', text: 'legacy saved left', expectedRevision: 0 });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1 }), receipt = await store.commitSave(preview.token);
  const statePath = path.join(dataDir, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.reviews[0].mode = 'proposal'; await fs.writeFile(statePath, JSON.stringify(state));
  const before = await fs.readFile(target), backup = await fs.readFile(receipt.backupPath!);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  assert.deepEqual(reloaded.status(review.id).reviews[0].targets[0].receipt, receipt);
  assert.deepEqual(await reloaded.commitSave(preview.token), receipt);
  assert.deepEqual(await fs.readFile(target), before); assert.deepEqual(await fs.readFile(receipt.backupPath!), backup);
});

test('pair targets complete independently; same-path pair shares one frozen target', async t => {
  const { store, target, root } = await fixture(t); const other = path.join(root, 'other.txt'); await fs.writeFile(other, 'other');
  const review = (await store.openFiles({ paths: [target, other], mode: 'pair' })).reviews[0];
  await store.updateDraft({ reviewId: review.id, side: 'left', text: 'saved left', expectedRevision: 0 });
  const first = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 1 }); await store.commitSave(first.token);
  assert.deepEqual(store.status(review.id).reviews[0].targets.map(target => target.status), ['saved', 'pending']);
  await store.updateDraft({ reviewId: review.id, side: 'right', text: 'saved right', expectedRevision: 0 });
  const second = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 }); await store.commitSave(second.token);
  assert.deepEqual(store.status(review.id).reviews[0].targets.map(target => target.status), ['saved', 'saved']);
  const same = (await store.openFiles({ paths: [target, target], mode: 'pair' })).reviews.at(-1)!;
  assert.equal(same.targets.length, 1); assert.equal(same.left.targetId, same.right.targetId);
  const preview = await store.prepareSave({ reviewId: same.id, side: 'right', expectedRevision: 0 }); await store.commitSave(preview.token);
  await assert.rejects(store.updateDraft({ reviewId: same.id, side: 'left', text: 'no', expectedRevision: 0 }), /冻结/);
});

test('single mode opens multiple independent reviews in one atomic cache change', async t => {
  const { store, target, root, dataDir } = await fixture(t); const other = path.join(root, 'second.txt'); await fs.writeFile(other, 'second');
  const workspace = await store.openFiles({ paths: [target, other], mode: 'single' });
  assert.equal(workspace.reviews.length, 2);
  for (const review of workspace.reviews) {
    assert.equal(review.mode, 'single'); assert.equal(review.targets.length, 1); assert.equal(review.left.targetId, review.right.targetId);
  }
  assert.equal(workspace.reviews[1].left.text, 'second');
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init(); assert.deepEqual(reloaded.list(), workspace);
});

test('new files use exclusive creation and UTF-16 BOM detection', async t => {
  const { store, root } = await fixture(t); const target = path.join(root, 'new.txt');
  const review = (await store.openFiles({ paths: [target], mode: 'single', encoding: 'utf16be' })).reviews[0];
  await store.updateDraft({ reviewId: review.id, side: 'right', text: '新文件\n', expectedRevision: 0 });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 });
  assert.equal(preview.isNew, true); assert.equal(preview.backupPath, undefined);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await store.commitSave(preview.token);
  const bytes = await fs.readFile(target); assert.deepEqual([...bytes.subarray(0, 2)], [0xfe, 0xff]); assert.equal(decode(bytes).text, '新文件\n');
});

test('new file created externally after preview is never overwritten', async t => {
  let target = '';
  const { store, root } = await fixture(t, async point => { if (point === 'beforeReplace') await fs.writeFile(target, 'external', { flag: 'wx' }); });
  target = path.join(root, 'new.txt'); const review = await open(store, target);
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 0 });
  await assert.rejects(store.commitSave(preview.token), /被创建或替换/);
  assert.equal(await fs.readFile(target, 'utf8'), 'external');
});

for (const point of ['backup', 'beforeReplace', 'afterReplace'] as const) test(`fault ${point} preserves backup/original evidence and consumes token`, async t => {
  const { store, target, dataDir } = await fixture(t, current => { if (current === point) throw new Error(`injected ${point}`); });
  const original = await fs.readFile(target); const review = await open(store, target);
  await store.updateDraft({ reviewId: review.id, side: 'right', text: 'replacement', expectedRevision: 0 });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 });
  await assert.rejects(store.commitSave(preview.token), /injected/);
  await assert.rejects(store.commitSave(preview.token), /已使用/);
  assert.deepEqual(await fs.readFile(target), point === 'afterReplace' ? Buffer.from('replacement') : original);
  if (point !== 'backup') assert.deepEqual(await fs.readFile(preview.backupPath!), original);
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  const targetView = reloaded.status(review.id).reviews[0].targets[0];
  if (point === 'afterReplace') {
    assert.equal(targetView.status, 'saved'); assert.equal(targetView.error, undefined);
    assert.equal(targetView.receipt?.operationId, preview.token);
    assert.deepEqual(await reloaded.commitSave(preview.token), targetView.receipt);
  } else {
    assert.equal(targetView.status, 'error'); assert.match(targetView.error!, /原稿未改/);
    assert.equal(targetView.receipt, undefined);
  }
});

test('journal recovery classifies interrupted replacement and never applies or rolls back', async t => {
  const { store, target, dataDir } = await fixture(t, point => { if (point === 'afterReplace') throw new Error('crash'); });
  const review = await open(store, target); await store.updateDraft({ reviewId: review.id, side: 'right', text: 'new disk', expectedRevision: 0 });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 }); await assert.rejects(store.commitSave(preview.token));
  const statePath = path.join(dataDir, 'state.json'); const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.plans[preview.token].phase = 'intent'; state.reviews[0].targets[0].status = 'saving'; await fs.writeFile(statePath, JSON.stringify(state));
  const recovered = new ReviewStore({ dataDir }); await recovered.init();
  assert.equal(recovered.status(review.id).reviews[0].targets[0].status, 'saved');
  assert.equal(await fs.readFile(target, 'utf8'), 'new disk');
  assert.equal((await recovered.commitSave(preview.token)).operationId, preview.token);
  const again = new ReviewStore({ dataDir }); await again.init(); assert.equal(again.status(review.id).reviews[0].targets[0].status, 'saved');
});

for (const damage of ['missing', 'forged'] as const) test(`recovery refuses success when original backup is ${damage}`, async t => {
  const { store, target, dataDir } = await fixture(t, point => { if (point === 'afterReplace') throw new Error('injected afterReplace'); });
  const review = await open(store, target); await store.updateDraft({ reviewId: review.id, side: 'right', text: 'new disk', expectedRevision: 0 });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 }); await assert.rejects(store.commitSave(preview.token));
  if (damage === 'missing') await fs.unlink(preview.backupPath!); else await fs.writeFile(preview.backupPath!, 'forged original');
  const bytes = await fs.readFile(target); const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  const targetView = reloaded.status(review.id).reviews[0].targets[0];
  assert.equal(targetView.status, 'error'); assert.equal(targetView.receipt, undefined); assert.match(targetView.error!, /备份缺失或校验失败/);
  assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(reloaded.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 }), /从磁盘继续/);
  await assert.rejects(reloaded.commitSave(preview.token), /已使用/);
});

test('interrupted new file save reconstructs receipt without requiring an original backup', async t => {
  const { store, root, dataDir } = await fixture(t, point => { if (point === 'afterReplace') throw new Error('injected afterReplace'); });
  const target = path.join(root, 'new-recovery.txt'), review = await open(store, target);
  await store.updateDraft({ reviewId: review.id, side: 'right', text: 'new content', expectedRevision: 0 });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 }); await assert.rejects(store.commitSave(preview.token));
  const reloaded = new ReviewStore({ dataDir }); await reloaded.init();
  const saved = reloaded.status(review.id).reviews[0].targets[0]; assert.equal(saved.status, 'saved'); assert.equal(saved.receipt?.backupPath, undefined);
  assert.equal((await reloaded.commitSave(preview.token)).operationId, preview.token); assert.equal(await fs.readFile(target, 'utf8'), 'new content');
});

test('failed target blocks both fresh previews and pre-existing tokens until explicit continue', async t => {
  const { store, target } = await fixture(t, point => { if (point === 'beforeReplace') throw new Error('injected beforeReplace'); });
  const review = await open(store, target);
  const first = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 0 });
  const second = await store.prepareSave({ reviewId: review.id, side: 'left', expectedRevision: 0 });
  await assert.rejects(store.commitSave(first.token), /injected/);
  await assert.rejects(store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 0 }), /从磁盘继续/);
  await assert.rejects(store.commitSave(second.token), /从磁盘继续/);
  const continued = await store.continueTarget(review.id, review.targets[0].id);
  assert.equal(continued.targets[0].status, 'pending'); assert.equal(store.status(review.id).reviews[0].targets[0].status, 'rejected');
});

for (const outcome of ['before', 'unknown'] as const) test(`journal recovery reports ${outcome} without touching disk`, async t => {
  const { store, target, dataDir } = await fixture(t); const review = await open(store, target);
  await store.updateDraft({ reviewId: review.id, side: 'right', text: 'intended output', expectedRevision: 0 });
  const preview = await store.prepareSave({ reviewId: review.id, side: 'right', expectedRevision: 1 });
  const statePath = path.join(dataDir, 'state.json'); const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.plans[preview.token].phase = 'intent'; state.reviews[0].targets[0].status = 'saving'; await fs.writeFile(statePath, JSON.stringify(state));
  if (outcome === 'unknown') await fs.writeFile(target, 'unrelated external output');
  const bytes = await fs.readFile(target); const recovered = new ReviewStore({ dataDir }); await recovered.init();
  assert.match(recovered.status(review.id).reviews[0].targets[0].error!, outcome === 'before' ? /原稿未改/ : /与两版均不一致/);
  assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(recovered.commitSave(preview.token), /已使用/);
});

test('cache autosave failure leaves in-memory and persisted draft revision unchanged', async t => {
  const { store, target, dataDir } = await fixture(t); const review = await open(store, target);
  const statePath = path.join(dataDir, 'state.json'); const durable = await fs.readFile(statePath);
  await fs.unlink(statePath); await fs.mkdir(statePath);
  await assert.rejects(store.updateDraft({ reviewId: review.id, side: 'right', text: 'must not appear', expectedRevision: 0 }));
  assert.equal(store.list().reviews[0].right.revision, 0); assert.equal(store.list().reviews[0].right.text, review.right.text);
  await fs.rmdir(statePath); await fs.writeFile(statePath, durable);
  const recovered = new ReviewStore({ dataDir }); await recovered.init(); assert.equal(recovered.list().reviews[0].right.revision, 0);
});
