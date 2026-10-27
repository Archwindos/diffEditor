// Exercise the portable app with isolated files, cache and pipe. Never save a formal file.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

(async () => {
  const project = path.resolve(__dirname, '..'), { version } = require('../package.json');
  const installation = path.join(project, 'release', version, 'win-unpacked');
  const exe = path.join(installation, 'DiffEditor.exe');
  const root = path.join(project, 'test-results', `delete-closed-${version}-${randomUUID()}`);
  const dataDir = path.join(root, 'app-data');
  await fs.mkdir(root, { recursive: true });
  const env = { ...process.env, DIFFEDITOR_DATA_DIR: dataDir, DIFFEDITOR_PIPE: `\\\\.\\pipe\\diffeditor-delete-closed-${randomUUID()}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const paths = [path.join(root, '原稿一.md'), path.join(root, '原稿二.tex')];
  const original = Buffer.from('原稿\r\n\\section{中文}\n保持原字节');
  for (const file of paths) await fs.writeFile(file, original, { flag: 'wx' });
  let app;
  const launch = async () => {
    app = await _electron.launch({ executablePath: exe, env, timeout: 20000 });
    const page = await app.firstWindow(); await page.getByTestId('new-text').waitFor(); return page;
  };
  const stop = async page => {
    await page.evaluate(() => window.diffEditor.setSettings({ closeToTray: false }));
    const exited = app.waitForEvent('close', { timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited; app = undefined;
  };
  try {
    let page = await launch();
    const opened = await page.evaluate(paths => window.diffEditor.openFiles({ paths, mode: 'single' }), paths);
    for (const review of opened.reviews) {
      await page.getByTestId(`close-${review.id}`).click();
      await page.getByTestId(`review-${review.id}`).waitFor({ state: 'hidden' });
    }
    await page.getByTestId('new-text').click();
    await page.waitForFunction(async () => (await window.diffEditor.list()).reviews.some(r => r.mode === 'text'));
    const openId = await page.evaluate(async () => (await window.diffEditor.list()).reviews.find(r => r.mode === 'text').id);
    await page.getByTestId('delete-closed').click(); await page.getByTestId('cancel-delete').click();
    assert.equal(await page.evaluate(async () => (await window.diffEditor.list()).reviews.length), 3);
    await page.screenshot({ path: path.join(root, 'delete-closed-button.png') });
    await page.getByTestId('delete-closed').click(); await page.getByTestId('confirm-delete').click();
    await page.getByTestId('delete-dialog').waitFor({ state: 'hidden' });
    await page.getByTestId('delete-closed').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(async () => (await window.diffEditor.list()).reviews.map(r => r.id)), [openId]);
    const result = await promisify(execFile)(exe, [path.join(installation, 'cli.cjs'), 'status'], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 10000,
    });
    const statuses = JSON.parse(result.stdout).reviews;
    for (const review of opened.reviews) assert.equal(statuses.find(r => r.id === review.id).lifecycle, 'deleted');
    await stop(page); page = await launch();
    await page.getByTestId(`review-${openId}`).waitFor();
    assert.equal(await page.getByTestId('delete-closed').count(), 0);
    for (const file of paths) assert.deepEqual(await fs.readFile(file), original);
    await assert.rejects(fs.stat(path.join(root, '.diffeditor-backups')), { code: 'ENOENT' });
    await stop(page);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ version, passed: true, originalUnchanged: true, statuses }, null, 2), { flag: 'wx' });
    console.log(`Portable bulk-delete smoke passed: ${root}`);
  } finally {
    if (app) await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
