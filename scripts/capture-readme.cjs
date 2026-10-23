// Capture real portable-app screens with public demo text and an isolated cache/pipe.
// Stops at the save confirmation; never clicks the final save button.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

(async () => {
  const project = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const installation = path.join(project, 'release', version, 'win-unpacked');
  const exe = path.join(installation, 'DiffEditor.exe');
  const images = path.join(project, 'docs', 'images');
  await fs.mkdir(images, { recursive: true });
  await fs.mkdir(path.join(project, 'test-results'), { recursive: true });
  let root;
  for (let n = 1; ; n++) {
    root = path.join(project, 'test-results', `demo-${String(n).padStart(2, '0')}`);
    try { await fs.mkdir(root); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const target = path.join(root, '协作流程.md');
  const original = [
    '# 一次可审阅的论文修改', '',
    '## 确定修改范围',
    '本轮调整引言的组织方式，保留术语、引用与已有结论。',
    '范围以外的问题单独提出，等待作者决定。', '',
    '## 交付候选稿',
    'agent 直接更新原文件，并在聊天里说明变动。', '',
    '## 审阅与修改',
    '作者在聊天中阅读更新摘要。',
    '接受哪些修改，由作者逐项决定。', '',
    '## 保存并继续',
    '作者回复“确认”，agent 继续下一项工作。', '',
    '## 文本与文件',
    '支持 .tex、.md、.bib 等文本文件，也可以直接输入文本。',
  ].join('\n');
  const candidate = original
    .replace('agent 直接更新原文件，并在聊天里说明变动。', 'agent 通过 skill 提交候选稿，原文件在确认前保持不变。')
    .replace('作者在聊天中阅读更新摘要。', '作者查看原稿与新稿，按块替换，也可以直接编辑。')
    .replace('作者回复“确认”，agent 继续下一项工作。', '作者在软件内确认保存，旧稿自动备份，保存结果完成校验。\nagent 通过 wait 收到保存回执后，继续已授权的工作。');
  const bytes = Buffer.from(original, 'utf8');
  await fs.writeFile(target, bytes, { flag: 'wx' });
  const dataDir = path.join(root, 'app-data');
  const env = { ...process.env, DIFFEDITOR_DATA_DIR: dataDir, DIFFEDITOR_PIPE: `\\\\.\\pipe\\diffeditor-readme-${randomUUID()}` };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DIFFEDITOR_EXE;
  const app = await _electron.launch({ executablePath: exe, env, timeout: 20000 });
  const proc = app.process();
  const cli = async args => {
    const { stdout } = await promisify(execFile)(exe, [path.join(installation, 'cli.cjs'), ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 10000,
    });
    return JSON.parse(stdout);
  };
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 820));
    await page.getByTestId('new-text').waitFor();
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
    const baseline = await cli(['baseline', target]);
    const proposalPath = path.join(dataDir, 'inbox', 'candidate.json');
    await fs.mkdir(path.dirname(proposalPath), { recursive: true });
    await fs.writeFile(proposalPath, JSON.stringify({ requestId: randomUUID(), files: [{ baselineId: baseline.files[0].id, text: candidate }] }), { flag: 'wx' });
    const { reviewIds: [reviewId] } = await cli(['submit', '--file', proposalPath]);
    await page.getByTestId(`review-${reviewId}`).waitFor();
    await page.getByTestId('chunk-to-left-0').waitFor();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="text-overview"]')?.getAttribute('data-green-count')) > 0);
    assert.match(await page.getByTestId('pane-path-right').innerText(), /AI 提供的草稿/);
    const arrow = await page.getByTestId('chunk-to-left-0').boundingBox();
    await page.mouse.move(arrow.x - 40, arrow.y + 12);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-left-0"]')).opacity === '1');
    await page.screenshot({ path: path.join(images, 'ai-review.png') });
    await page.getByTestId('save-right').click();
    await page.getByTestId('save-dialog').waitFor();
    assert.equal(await page.getByTestId('preview-text').innerText(), candidate);
    await page.mouse.move(20, 20);
    await page.screenshot({ path: path.join(images, 'save-confirmation.png') });
    await page.getByTestId('cancel-save').click();
    const status = await cli(['status', reviewId]);
    assert.equal(status.reviews[0].targets[0].status, 'pending');
    assert.equal(status.reviews[0].targets[0].receipt, undefined);
    assert.deepEqual(await fs.readFile(target), bytes);
    await assert.rejects(fs.stat(path.join(root, '.diffeditor-backups')), { code: 'ENOENT' });
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('close-to-tray').click();
    await page.waitForFunction(async () => !(await window.diffEditor.getSettings()).closeToTray);
    const exited = new Promise(resolve => proc.once('exit', resolve));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited;
    const imageHashes = {};
    for (const name of ['ai-review.png', 'save-confirmation.png']) imageHashes[name] = createHash('sha256').update(await fs.readFile(path.join(images, name))).digest('hex');
    await fs.writeFile(path.join(root, 'capture.json'), JSON.stringify({ version, target, reviewId, status, originalUnchanged: true, finalSaveClicked: false, imageHashes }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ version, images, evidence: path.join(root, 'capture.json') }));
  } finally { if (proc.exitCode === null) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
