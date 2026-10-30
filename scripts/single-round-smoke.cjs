// Actual portable app + CLI with isolated data/files. No formal-save automation.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

(async () => {
  const project = path.resolve(__dirname, '..'), { version } = require('../package.json');
  const installation = path.join(project, 'release', version, 'win-unpacked');
  const exe = path.join(installation, 'DiffEditor.exe');
  const root = path.join(project, 'test-results', `single-round-${version}-${randomUUID()}`);
  const dataDir = path.join(root, 'app-data'), inbox = path.join(dataDir, 'inbox');
  await fs.mkdir(inbox, { recursive: true });
  const target = path.join(root, '单轮审阅.md'), alias = path.join(root, '同文件别名.md');
  const original = Buffer.from('原稿\r\n\\section{中文}\n无末尾换行');
  await fs.writeFile(target, original, { flag: 'wx' }); await fs.link(target, alias);
  const env = { ...process.env, CODEX_THREAD_ID: 'single-round-fixture-thread', DIFFEDITOR_DATA_DIR: dataDir, DIFFEDITOR_PIPE: `\\\\.\\pipe\\diffeditor-single-round-${randomUUID()}` };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, proc;
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(exe, [path.join(installation, 'cli.cjs'), ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI stalled: ${args[0]}`)); }, 15000);
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { assert.equal(stderr, ''); resolve({ code, value: JSON.parse(stdout) }); } catch (error) { reject(error); }
    });
  });
  const proposal = async baselineId => {
    const payload = { requestId: randomUUID(), source: { agent: 'Codex', threadTitle: '论文重组 · 测试对话' }, files: [{ baselineId, text: '本轮累计最终稿' }] };
    const file = path.join(inbox, payload.requestId + '.json');
    await fs.writeFile(file, JSON.stringify(payload), { flag: 'wx' }); return file;
  };
  const launch = async () => {
    app = await _electron.launch({ executablePath: exe, env, timeout: 20000 }); proc = app.process();
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
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
    const baseline = await cli(['baseline', target]), spare = await cli(['baseline', alias]);
    assert.equal(baseline.code, 0); assert.equal(spare.code, 0);
    const draft = path.join(inbox, 'proposed.md'); await fs.writeFile(draft, original, { flag: 'wx' });
    for (const text of ['调整结构', '内部纠错', '本轮累计最终稿']) await fs.writeFile(draft, text);
    assert.deepEqual((await cli(['status'])).value.reviews, []);
    assert.deepEqual(await fs.readFile(target), original);
    const firstFile = await proposal(baseline.value.files[0].id);
    const first = await cli(['submit', '--file', firstFile]); assert.equal(first.code, 0);
    const id = first.value.reviewIds[0]; await page.getByTestId(`review-${id}`).waitFor();
    assert.equal(await page.getByTestId(`delete-${id}`).count(), 0);
    assert.equal(await page.getByTestId('save-left').innerText(), '退回');
    assert.equal(await page.getByTestId('save-right').innerText(), '通过');
    assert.equal(await page.getByTestId(`source-badge-${id}`).innerText(), 'Codex');
    assert.match(await page.getByTestId('source-thread-title').innerText(), /论文重组 · 测试对话/);
    assert.match(await page.getByTestId('source-thread-id').innerText(), /single-round-fixture-thread/);
    const firstStatus = (await cli(['status', id])).value.reviews[0];
    assert.deepEqual(firstStatus.source, { agent: 'Codex', threadId: env.CODEX_THREAD_ID, threadTitle: '论文重组 · 测试对话' });
    await page.getByTestId('save-right').click(); await page.getByTestId('save-dialog').waitFor();
    assert.match(await page.getByTestId('confirm-save').innerText(), /通过/);
    assert.deepEqual(await fs.readFile(target), original);
    await page.getByTestId('cancel-save').click();
    await page.screenshot({ path: path.join(root, 'ai-review-origin.png') });
    const retry = await cli(['submit', '--file', firstFile]);
    assert.deepEqual(retry.value, { reviewIds: [id], duplicate: true });
    const queuedFile = await proposal(spare.value.files[0].id);
    const blocked = await cli(['submit', '--file', queuedFile]);
    assert.equal(blocked.code, 1); assert.equal(blocked.value.code, 'REVIEW_IN_PROGRESS'); assert.deepEqual(blocked.value.reviewIds, [id]);
    await page.getByTestId(`close-${id}`).click(); await page.getByTestId(`review-${id}`).waitFor({ state: 'hidden' });
    await stop(page); page = await launch();
    const stillBlocked = await cli(['submit', '--file', queuedFile]);
    assert.equal(stillBlocked.code, 1); assert.equal(stillBlocked.value.code, 'REVIEW_IN_PROGRESS'); assert.deepEqual(stillBlocked.value.reviewIds, [id]);
    await page.getByTestId('toggle-closed').click(); await page.getByTestId(`reopen-${id}`).click();
    await page.getByTestId('source-thread-id').waitFor();
    assert.match(await page.getByTestId('source-thread-id').innerText(), /single-round-fixture-thread/);
    const waiting = cli(['wait', id, '--timeout', '5']);
    await page.getByTestId('save-left').click(); await page.getByTestId('confirm-reject').click();
    await page.waitForFunction(async () => (await window.diffEditor.list()).reviews[0].targets[0].status === 'rejected');
    const returned = await waiting; assert.equal(returned.code, 0); assert.equal(returned.value.reason, 'attention');
    assert.equal(returned.value.reviews[0].targets[0].status, 'rejected');
    const expired = await cli(['submit', '--file', queuedFile]);
    assert.equal(expired.code, 1); assert.equal(expired.value.code, 'BASELINE_EXPIRED'); assert.deepEqual(expired.value.reviewIds, [id]);
    const fresh = await cli(['baseline', target]); assert.equal(fresh.code, 0);
    const second = await cli(['submit', '--file', await proposal(fresh.value.files[0].id)]); assert.equal(second.code, 0);
    const secondId = second.value.reviewIds[0];
    assert.equal(await page.getByTestId(`delete-${secondId}`).count(), 0);
    await page.getByTestId(`close-${secondId}`).click();
    await page.getByTestId(`review-${secondId}`).waitFor({ state: 'hidden' });
    await page.getByTestId(`delete-${secondId}`).click(); await page.getByTestId('confirm-delete').click();
    await page.getByTestId('delete-dialog').waitFor({ state: 'hidden' });
    const afterDelete = await cli(['baseline', alias]); assert.equal(afterDelete.code, 0);
    const third = await cli(['submit', '--file', await proposal(afterDelete.value.files[0].id)]); assert.equal(third.code, 0);
    const states = (await cli(['status'])).value.reviews;
    assert.equal(states.filter(r => r.targets.some(t => t.status === 'pending')).length, 2); // Deleted tombstone plus the sole active round.
    assert.equal(states.filter(r => r.lifecycle !== 'deleted' && r.targets.some(t => t.status === 'pending')).length, 1);
    assert.deepEqual(states.find(r => r.id === secondId).source, firstStatus.source);
    await page.getByTestId('new-text').click();
    await page.getByTestId('save-left').waitFor();
    assert.equal(await page.getByTestId('save-left').innerText(), '另存为…');
    assert.equal(await page.getByTestId('save-right').innerText(), '另存为…');
    for (const file of [target, alias]) assert.deepEqual(await fs.readFile(file), original);
    await assert.rejects(fs.stat(path.join(root, '.diffeditor-backups')), { code: 'ENOENT' });
    await stop(page);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ version, passed: true, originalUnchanged: true, blocked: blocked.value, afterRestart: stillBlocked.value, expired: expired.value, states }, null, 2), { flag: 'wx' });
    console.log(`Portable single-round smoke passed: ${root}`);
  } finally { if (app && proc.exitCode === null) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
