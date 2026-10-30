// Exercise approval/withdrawal archiving using isolated test files only.
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

(async () => {
  const project = path.resolve(__dirname, '..'), { version } = require('../package.json');
  const installation = path.join(project, 'release', version, 'win-unpacked');
  const exe = path.join(installation, 'DiffEditor.exe');
  const root = await fs.mkdtemp(path.join(project, 'test-results', 'auto-archive-'));
  const env = { ...process.env, DIFFEDITOR_DATA_DIR: path.join(root, 'data'),
    DIFFEDITOR_PIPE: `\\\\.\\pipe\\auto-archive-${randomUUID()}`, CODEX_THREAD_ID: 'archive-fixture' };
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(exe, [path.join(installation, 'cli.cjs'), ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${args[0]}`)); }, 15000);
    child.stdout.setEncoding('utf8').on('data', text => out += text);
    child.stderr.setEncoding('utf8').on('data', text => err += text);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); try { assert.equal(err, ''); assert.equal(code, 0, out); resolve(JSON.parse(out)); } catch (error) { reject(error); } });
  });
  const submit = async (target, title, text) => {
    const b = await cli(['baseline', target]);
    const payload = { requestId: randomUUID(), title, source: { agent: 'Codex', threadTitle: '自动归档验证' }, files: [{ baselineId: b.files[0].id, text }] };
    const file = path.join(root, payload.requestId + '.json'); await fs.writeFile(file, JSON.stringify(payload), { flag: 'wx' });
    return { id: (await cli(['submit', '--file', file])).reviewIds[0], payload, file };
  };
  const original = Buffer.from('old approval\r\nkeep old bytes');
  const approvedTarget = path.join(root, '通过稿件.md'), withdrawnTarget = path.join(root, '撤回稿件.md');
  for (const file of [approvedTarget, withdrawnTarget]) await fs.writeFile(file, original, { flag: 'wx' });
  let app;
  const launch = async () => { app = await _electron.launch({ executablePath: exe, env, timeout: 20000 }); const p = await app.firstWindow(); await p.getByTestId('new-text').waitFor(); return p; };
  const stop = async p => { await p.evaluate(() => window.diffEditor.setSettings({ closeToTray: false })); const done = app.waitForEvent('close'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await done; app = undefined; };
  try {
    let page = await launch();
    const approved = await submit(approvedTarget, '通过的稿件', 'approved draft');
    const withdrawn = await submit(withdrawnTarget, '撤回的稿件', 'withdrawn draft');
    await page.getByTestId(`review-${approved.id}`).click();
    await page.getByTestId('save-right').click(); await page.getByTestId('save-dialog').waitFor();
    // This confirmation only writes the isolated test target created above.
    await page.getByTestId('confirm-save').click();
    await page.getByTestId(`review-${approved.id}`).waitFor({ state: 'hidden' });
    await page.getByTestId(`closed-${approved.id}`).waitFor();
    const saved = await cli(['wait', approved.id, '--timeout', '1']);
    assert.equal(saved.reason, 'saved'); assert.equal(saved.reviews[0].lifecycle, 'closed');
    const receipt = saved.reviews[0].targets[0].receipt;
    assert.deepEqual(await fs.readFile(approvedTarget), Buffer.from('approved draft'));
    assert.deepEqual(await fs.readFile(receipt.backupPath), original);
    const result = await cli(['withdraw', withdrawn.id, '--request-id', withdrawn.payload.requestId]);
    assert.equal(result.review.lifecycle, 'closed');
    await page.getByTestId(`review-${withdrawn.id}`).waitFor({ state: 'hidden' });
    await page.getByTestId(`closed-${withdrawn.id}`).waitFor();
    await page.getByTestId('new-text').click();
    const manualId = await page.evaluate(async () => (await window.diffEditor.list()).reviews.find(r => r.mode === 'text').id);
    await page.getByTestId(`close-${manualId}`).click();
    const closedIds = () => page.locator('.closed-review').evaluateAll(els => els.map(el => el.dataset.testid.slice(7)));
    assert.deepEqual(await closedIds(), [withdrawn.id, approved.id, manualId]);
    await page.screenshot({ path: path.join(root, 'completed-first.png') });
    await page.getByTestId(`reopen-${approved.id}`).click(); await page.getByTestId('retained-view').waitFor();
    assert.equal((await cli(['submit', '--file', approved.file])).duplicate, true);
    assert.equal((await cli(['status', approved.id])).reviews[0].lifecycle, 'open');
    await page.getByTestId(`reopen-${withdrawn.id}`).click(); await page.getByTestId('withdrawal-notice').waitFor();
    assert.equal((await cli(['withdraw', withdrawn.id, '--request-id', withdrawn.payload.requestId])).duplicate, true);
    assert.equal((await cli(['status', withdrawn.id])).reviews[0].lifecycle, 'open');
    await stop(page); page = await launch();
    for (const id of [approved.id, withdrawn.id]) await page.getByTestId(`review-${id}`).waitFor();
    assert.deepEqual(await fs.readFile(withdrawnTarget), original);
    assert.deepEqual(await fs.readFile(receipt.backupPath), original);
    const states = await cli(['status']);
    await stop(page);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ version, passed: true, saved, result, states, manualId }, null, 2));
    console.log(`Portable auto-archive smoke passed: ${root}`);
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
