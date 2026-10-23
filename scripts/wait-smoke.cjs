// Actual portable app + CLI, isolated data/pipe/files. No final-save automation.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

(async () => {
  const project = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const installation = path.join(project, 'release', version, 'win-unpacked');
  const exe = path.join(installation, 'DiffEditor.exe');
  const root = path.join(project, 'test-results', `wait-${version}-${randomUUID()}`);
  const dataDir = path.join(root, 'app-data');
  await fs.mkdir(root, { recursive: true });
  const env = { ...process.env, DIFFEDITOR_DATA_DIR: dataDir, DIFFEDITOR_PIPE: `\\\\.\\pipe\\diffeditor-wait-smoke-${randomUUID()}` };
  delete env.ELECTRON_RUN_AS_NODE; delete env.DIFFEDITOR_EXE;
  const app = await _electron.launch({ executablePath: exe, env, timeout: 20000 });
  const proc = app.process();
  const children = new Set();
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(exe, [path.join(installation, 'cli.cjs'), ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error(`CLI stalled: ${args[0]}`)); }, 45000);
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); children.delete(child);
      try { assert.equal(code, 0, stdout + stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('new-text').waitFor();
    const target = path.join(root, '等待审阅样本.tex');
    const original = Buffer.from('\\section{原稿}\r\n隔离测试，正式确认前保持原字节。');
    await fs.writeFile(target, original, { flag: 'wx' });
    const baseline = await cli(['baseline', target]);
    const candidate = path.join(dataDir, 'inbox', 'wait-smoke.json');
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, JSON.stringify({ requestId: randomUUID(), files: [{ baselineId: baseline.files[0].id, text: '\\section{新稿}\n只等待，不自动保存。' }] }), { flag: 'wx' });
    const { reviewIds: [reviewId] } = await cli(['submit', '--file', candidate]);
    await page.getByTestId(`review-${reviewId}`).waitFor();
    const started = Date.now();
    const waiting = cli(['wait', reviewId, '--timeout', '31']);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const timed = await waiting;
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs >= 30000, 'wait must outlive both ordinary transport deadlines');
    assert.equal(timed.reason, 'timeout');
    assert.equal(timed.reviews[0].targets[0].status, 'pending');
    assert.equal(timed.reviews[0].targets[0].receipt, undefined);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const closedWait = cli(['wait', reviewId, '--timeout', '10']);
    await page.getByTestId(`close-${reviewId}`).click();
    const closed = await closedWait;
    assert.equal(closed.reason, 'attention');
    assert.equal(closed.reviews[0].lifecycle, 'closed');
    assert.equal(closed.reviews[0].targets[0].status, 'pending');
    assert.deepEqual(await fs.readFile(target), original);
    await assert.rejects(fs.stat(path.join(root, '.diffeditor-backups')), { code: 'ENOENT' });
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('close-to-tray').click();
    await page.waitForFunction(async () => !(await window.diffEditor.getSettings()).closeToTray);
    const exited = new Promise(resolve => proc.once('exit', resolve));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited;
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ version, elapsedMs, timed, closed, originalUnchanged: true, exitCode: proc.exitCode }, null, 2), { flag: 'wx' });
    console.log(`Portable wait smoke passed (31s, background, close, no formal saves): ${root}`);
  } finally {
    for (const child of children) child.kill();
    if (proc.exitCode === null) await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
