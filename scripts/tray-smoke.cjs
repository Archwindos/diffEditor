// Exercises the built Electron app with an isolated cache/pipe and no formal saves.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

(async () => {
  const project = path.resolve(__dirname, '..');
  const root = path.join(project, 'test-results', `tray-${randomUUID()}`);
  const data = path.join(root, 'app-data');
  await fs.mkdir(root, { recursive: true });
  const bootstrap = path.join(root, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, `
const { Tray } = require('electron');
const fs = require('node:fs/promises');
global.__trayTest = { failDraftWrite: false };
const setMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function(menu) {
  global.__trayTest.tray = this; global.__trayTest.menu = menu;
  return setMenu.call(this, menu);
};
const open = fs.open;
fs.open = function(file, ...args) {
  if (global.__trayTest.failDraftWrite && String(file).includes('drafts') && String(file).endsWith('.tmp')) {
    return Promise.reject(Object.assign(new Error('Injected cache failure'), { code: 'EIO' }));
  }
  return open.call(this, file, ...args);
};
require(${JSON.stringify(path.join(project, 'dist-electron', 'main.cjs'))});
`, { flag: 'wx' });
  const env = { ...process.env, DIFFEDITOR_DATA_DIR: data, DIFFEDITOR_PIPE: `\\\\.\\pipe\\diffeditor-tray-${randomUUID()}`, DIFFEDITOR_TIMEOUT_MS: '4000' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const poll = async (fn, expected, label) => {
    const deadline = Date.now() + 12000;
    do {
      if (await fn() === expected) return;
      await new Promise(resolve => setTimeout(resolve, 75));
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
  };
  const cli = async args => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(project, 'dist-electron', 'cli.cjs'), ...args], { env, windowsHide: true });
    return JSON.parse(stdout);
  };
  const launch = async () => {
    app = await electron.launch({ args: [bootstrap], cwd: project, env, timeout: 20000 });
    const page = await app.firstWindow();
    await page.getByTestId('new-text').waitFor();
    const menu = await app.evaluate(() => global.__trayTest.menu.items.map(item => item.label));
    assert.deepEqual(menu, ['打开 DiffEditor', '', '退出']);
    return page;
  };
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  const closeWindow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const readCache = async () => JSON.parse(await fs.readFile(path.join(data, 'drafts', 'state.json'), 'utf8'));
  try {
    let page = await launch();
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('close-to-tray').waitFor();
    assert.equal(await page.getByTestId('close-to-tray').isChecked(), true);
    await page.getByTestId('new-text').click();
    const editor = page.getByTestId('editor-right');
    await editor.click({ position: { x: 120, y: 30 } });
    await page.keyboard.insertText('关闭前的中文草稿 \\section{待审}');
    await closeWindow();
    await poll(visible, false, 'X hides the window after caching');
    assert.equal((await readCache()).reviews[0].right.text, '关闭前的中文草稿 \\section{待审}');
    assert.equal((await cli(['status'])).reviews.length, 1);
    await app.evaluate(() => global.__trayTest.tray.emit('click'));
    await poll(visible, true, 'tray click restores');
    await closeWindow(); await poll(visible, false, 'hide again');
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
    await poll(visible, true, 'second instance restores');
    await closeWindow(); await poll(visible, false, 'hide before AI submission');
    const target = path.join(root, '隔离样本.tex');
    const original = Buffer.from('原稿保持不变\r\n', 'utf8');
    await fs.writeFile(target, original, { flag: 'wx' });
    const baseline = await cli(['baseline', target]);
    const submission = path.join(root, 'proposal.json');
    await fs.writeFile(submission, JSON.stringify({ requestId: randomUUID(), files: [{ baselineId: baseline.files[0].id, text: '只进入草稿的候选文本' }] }), { flag: 'wx' });
    await cli(['submit', '--file', submission]);
    await poll(visible, true, 'AI submission restores');
    assert.deepEqual(await fs.readFile(target), original);
    await page.getByTestId('close-to-tray').click();
    await poll(async () => JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).closeToTray, false, 'setting persisted');
    const closed = app.waitForEvent('close', { timeout: 15000 });
    await closeWindow(); await closed; app = undefined;

    page = await launch();
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('close-to-tray').waitFor();
    assert.equal(await page.getByTestId('close-to-tray').isChecked(), false);
    await page.getByTestId('close-to-tray').click();
    await poll(async () => JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).closeToTray, true, 'setting re-enabled');
    await page.getByTestId('new-text').click();
    await app.evaluate(() => { global.__trayTest.failDraftWrite = true; });
    await page.getByTestId('editor-right').click({ position: { x: 120, y: 30 } });
    await page.keyboard.insertText('缓存失败后重试保留');
    await closeWindow();
    await page.getByRole('alert').filter({ hasText: '草稿尚未缓存' }).waitFor();
    assert.equal(await visible(), true);
    await app.evaluate(() => global.__trayTest.menu.items.find(item => item.label === '退出').click());
    await page.getByRole('alert').filter({ hasText: '草稿尚未缓存' }).waitFor();
    assert.ok((await cli(['status'])).reviews.length >= 2, 'failed exit must keep the AI server alive');
    await app.evaluate(() => { global.__trayTest.failDraftWrite = false; });
    const exited = app.waitForEvent('close', { timeout: 15000 });
    await app.evaluate(() => global.__trayTest.menu.items.find(item => item.label === '退出').click());
    await exited; app = undefined;
    assert.ok((await readCache()).reviews.some(review => review.right.text === '缓存失败后重试保留'));
    assert.deepEqual(await fs.readFile(target), original);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), scenarios: ['default enabled', 'X flushes then hides', 'pipe remains available', 'tray restore', 'second-instance restore callback', 'AI submit restores without writing target', 'disabled X exits', 'setting survives restart', 'cache failure blocks hide and exit', 'tray Exit retries cache and quits'] }, null, 2));
    console.log(`Tray lifecycle passed. Isolated evidence: ${root}`);
  } finally {
    // Only terminate this isolated test instance if an assertion aborts the run.
    if (app) {
      const stopped = app.waitForEvent('close', { timeout: 10000 }).catch(() => {});
      await app.evaluate(({ app }) => { setTimeout(() => app.exit(1), 0); }).catch(() => {});
      await stopped;
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
