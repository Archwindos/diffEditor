// Real packaged-app integration fixture. Final saving is performed in the UI,
// never by a private command or test bypass. All files are isolated test copies.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
const results = path.join(project, 'test-results');
const manifestPath = path.join(results, 'active-e2e.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] || 'prepare';
async function cli(context, args) {
  const env = { ...process.env, DIFFEDITOR_DATA_DIR: context.dataDir, DIFFEDITOR_PIPE: context.pipe,
    DIFFEDITOR_EXE: context.exe, DIFFEDITOR_TIMEOUT_MS: '45000', ELECTRON_RUN_AS_NODE: '1' };
  return new Promise((resolve, reject) => {
    const child = spawn(context.exe, [path.join(path.dirname(context.exe), 'cli.cjs'), ...args], { env, windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk.toString('utf8'));
    child.stderr.on('data', chunk => error += chunk.toString('utf8'));
    child.on('error', reject);
    child.on('close', code => {
      try { const value = JSON.parse(output.trim()); if (code) throw new Error(JSON.stringify(value)); resolve(value); }
      catch (e) { reject(new Error(`${e.message}; stderr: ${error}`)); }
    });
  });
}
if (mode === 'prepare') {
  const id = randomUUID();
  const root = path.join(results, `desktop-${id}`);
  const context = { id, root, exe: path.join(project, 'release', version, 'win-unpacked', 'DiffEditor.exe'),
    pipe: `\\\\.\\pipe\\diffeditor-e2e-${id}`, dataDir: path.join(root, 'app-data'),
    target: path.join(root, '论文 样本.tex'), title: '端到端验证 · 论文样本' };
  await fs.access(context.exe);
  await fs.mkdir(root, { recursive: true });
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\\section{引言}\r\n我们比较两个模型。\n结果尚待验证。\r\n\\section{方法}\r\n保留这个段落。')]);
  const candidate = '\\section{引言}\n我们比较三个模型。\n结果尚待验证。\n\\section{方法}\n保留这个段落。\n新增一句：全部修改仍需人工审阅。';
  await fs.writeFile(context.target, original, { flag: 'wx' });
  const baseline = await cli(context, ['baseline', context.target]);
  const input = { requestId: id, title: context.title, files: [{ baselineId: baseline.files[0].id, text: candidate }] };
  const candidatePath = path.join(context.dataDir, 'inbox', 'candidate.json');
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  await fs.writeFile(candidatePath, JSON.stringify(input), { flag: 'wx' });
  const submitted = await cli(context, ['submit', '--file', candidatePath]);
  Object.assign(context, { reviewId: submitted.reviewIds[0], originalBase64: original.toString('base64'), candidate });
  assert.equal(digest(await fs.readFile(context.target)), digest(original));
  const status = await cli(context, ['status', context.reviewId]);
  assert.equal(status.reviews[0].targets[0].status, 'pending');
  await fs.writeFile(manifestPath, JSON.stringify(context, null, 2));
  console.log(JSON.stringify({ phase: 'pending_ui_review', manifestPath, reviewId: context.reviewId,
    target: context.target, originalUnchanged: true, instruction: '在 DiffEditor 的样本中测试块替换/编辑；右侧保留候选稿，最终点击保存此侧并确认。然后运行 npm run test:e2e -- verify。' }, null, 2));
} else if (mode === 'check-pending' || mode === 'verify') {
  const context = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const status = await cli(context, ['status', context.reviewId]);
  const target = status.reviews[0].targets[0];
  const original = Buffer.from(context.originalBase64, 'base64');
  const disk = await fs.readFile(context.target);
  if (mode === 'check-pending') {
    assert.equal(target.status, 'pending');
    assert.deepEqual(disk, original);
    console.log(JSON.stringify({ pending: true, originalUnchanged: true, status }));
  } else {
    assert.equal(target.status, 'saved');
    assert.ok(target.receipt);
    const receipt = target.receipt;
    assert.deepEqual(await fs.readFile(receipt.backupPath), original);
    assert.equal(digest(disk), receipt.afterHash);
    assert.equal(digest(original), receipt.beforeHash);
    const state = JSON.parse(await fs.readFile(path.join(context.dataDir, 'drafts', 'state.json'), 'utf8'));
    const plan = state.plans[receipt.operationId];
    assert.deepEqual(disk, Buffer.from(plan.bytes, 'base64'));
    assert.equal(plan.phase, 'done');
    const report = { verifiedAt: new Date().toISOString(), packagedApp: context.exe,
      reviewId: context.reviewId, confirmedSide: receipt.side, approvedBytesMatch: true,
      backupBytesMatch: true, receiptMatchesDisk: true, receipt };
    await fs.writeFile(path.join(results, 'desktop-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
} else throw new Error('Use prepare, check-pending, or verify.');
