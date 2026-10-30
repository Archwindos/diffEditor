// Real portable CLI/helper + desktop, with isolated files, cache and pipe.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

(async () => {
  const project = path.resolve(__dirname, '..'), { version } = require('../package.json');
  const installation = path.join(project, 'release', version, 'win-unpacked');
  const root = path.join(project, 'test-results', `withdraw-${version}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const exe = path.join(installation, 'DiffEditor.exe');
  const original = Buffer.from('原稿\r\n\\section{中文}\n无末尾换行');
  const target = path.join(root, '撤回测试.md');
  await fs.writeFile(target, original, { flag: 'wx' });
  const env = { ...process.env, DIFFEDITOR_HOME: installation, DIFFEDITOR_DATA_DIR: path.join(root, 'data'),
    CODEX_THREAD_ID: 'withdraw-fixture-thread', DIFFEDITOR_PIPE: `\\\\.\\pipe\\diffeditor-withdraw-${randomUUID()}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const helper = process.env.DIFFEDITOR_TEST_HELPER || path.join(installation, 'skill', 'diffeditor', 'scripts', 'invoke_diffeditor.py');
  const python = process.env.DIFFEDITOR_TEST_PYTHON || 'D:\\software\\miniconda3\\python.exe';
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(python, [helper, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI stalled: ${args[0]}`)); }, 15000);
    child.stdout.setEncoding('utf8').on('data', text => stdout += text);
    child.stderr.setEncoding('utf8').on('data', text => stderr += text);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { assert.equal(stderr, ''); resolve({ code, value: JSON.parse(stdout) }); }
      catch (error) { reject(new Error(`Invalid helper output for ${args[0]} (exit ${code}, ${stdout.length} stdout bytes, ${stderr.length} stderr bytes)`, { cause: error })); }
    });
  });
  const propose = async (baselineId, requestId = randomUUID()) => {
    const payload = { requestId, source: { agent: 'Codex', threadTitle: '模型撤回测试' }, files: [{ baselineId, text: '候选稿' }] };
    const file = path.join(root, requestId + '.json');
    await fs.writeFile(file, JSON.stringify(payload), { flag: 'wx' });
    return { payload, file };
  };
  let app;
  const launch = async () => { app = await _electron.launch({ executablePath: exe, env, timeout: 20000 }); const page = await app.firstWindow(); await page.getByTestId('new-text').waitFor(); return page; };
  const stop = async page => {
    await page.evaluate(() => window.diffEditor.setSettings({ closeToTray: false }));
    const exited = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited; app = undefined;
  };
  try {
    let page = await launch();
    const baseline = await cli(['baseline', target]); assert.equal(baseline.code, 0);
    const proposal = await propose(baseline.value.files[0].id);
    const submitted = await cli(['submit', '--file', proposal.file]); assert.equal(submitted.code, 0);
    const id = submitted.value.reviewIds[0]; await page.getByTestId(`review-${id}`).waitFor();
    const denied = await cli(['withdraw', id, '--request-id', 'wrong-request']);
    assert.equal(denied.code, 1); assert.equal(denied.value.code, 'WITHDRAW_NOT_OWNER');
    const waiting = cli(['wait', id, '--timeout', '10']);
    const result = await cli(['withdraw', id, '--request-id', proposal.payload.requestId]);
    assert.equal(result.code, 0); assert.equal(result.value.status, 'withdrawn'); assert.equal(result.value.duplicate, false);
    assert.equal(result.value.review.lifecycle, 'closed');
    const observation = await waiting; assert.equal(observation.code, 0); assert.equal(observation.value.reason, 'attention');
    assert.equal(observation.value.reviews[0].targets[0].status, 'withdrawn');
    await page.getByTestId(`review-${id}`).waitFor({ state: 'hidden' });
    await page.getByTestId(`closed-${id}`).waitFor();
    assert.equal(await page.getByTestId('new-text').isEnabled(), true);
    await page.screenshot({ path: path.join(root, 'withdrawn-history.png') });
    const repeated = await cli(['withdraw', id, '--request-id', proposal.payload.requestId]);
    assert.equal(repeated.value.duplicate, true); assert.equal(repeated.value.withdrawnAt, result.value.withdrawnAt);
    assert.deepEqual((await cli(['submit', '--file', proposal.file])).value, { reviewIds: [id], duplicate: true });
    const stale = await propose(baseline.value.files[0].id);
    const expired = await cli(['submit', '--file', stale.file]); assert.equal(expired.value.code, 'BASELINE_EXPIRED');
    await stop(page); page = await launch(); await page.getByTestId(`closed-${id}`).waitFor();
    await page.getByTestId(`reopen-${id}`).click();
    assert.equal(await page.getByTestId('save-left').isDisabled(), true); assert.equal(await page.getByTestId('save-right').isDisabled(), true);
    const retained = await page.evaluate(async id => (await window.diffEditor.list()).reviews.find(r => r.id === id), id);
    assert.equal(retained.targets[0].status, 'withdrawn'); assert.equal(retained.right.text, '候选稿');
    assert.equal(retained.source.threadId, env.CODEX_THREAD_ID);
    const fresh = await cli(['baseline', target]); const next = await propose(fresh.value.files[0].id);
    const nextReview = await cli(['submit', '--file', next.file]); assert.equal(nextReview.code, 0);
    const editedId = nextReview.value.reviewIds[0];
    await page.getByTestId(`review-${editedId}`).click();
    await page.getByTestId('editor-right').click({ position: { x: 130, y: 30 } });
    await page.keyboard.press('Control+End'); await page.keyboard.type('人工改稿');
    const protectedEdit = await cli(['withdraw', editedId, '--request-id', next.payload.requestId]);
    assert.equal(protectedEdit.code, 1); assert.equal(protectedEdit.value.code, 'WITHDRAW_HAS_HUMAN_EDITS');
    await page.waitForFunction(() => !document.querySelector('[data-testid="save-right"]').disabled && !document.querySelector('[data-testid="new-text"]').disabled);
    const edited = await page.evaluate(async id => (await window.diffEditor.list()).reviews.find(r => r.id === id), editedId);
    assert.equal(edited.right.text, '候选稿人工改稿'); assert.ok(edited.right.revision > 0);
    assert.equal(edited.targets[0].status, 'pending'); assert.equal(edited.withdrawnAt, undefined);
    const busyBaseline = await cli(['baseline', target]); const busyProposal = await propose(busyBaseline.value.files[0].id);
    assert.equal((await cli(['submit', '--file', busyProposal.file])).value.code, 'REVIEW_IN_PROGRESS');
    const undoTarget = path.join(root, '快速撤销测试.md'); await fs.writeFile(undoTarget, original, { flag: 'wx' });
    const undoBaseline = await cli(['baseline', undoTarget]); const undoProposal = await propose(undoBaseline.value.files[0].id);
    const undoId = (await cli(['submit', '--file', undoProposal.file])).value.reviewIds[0];
    await page.getByTestId(`review-${undoId}`).click();
    await page.getByTestId('editor-left').click({ position: { x: 130, y: 30 } });
    await page.keyboard.press('Control+End'); await page.keyboard.type('x'); await page.keyboard.press('Control+Z');
    const protectedUndo = await cli(['withdraw', undoId, '--request-id', undoProposal.payload.requestId]);
    assert.equal(protectedUndo.code, 1); assert.equal(protectedUndo.value.code, 'WITHDRAW_HAS_HUMAN_EDITS');
    const undone = await page.evaluate(async id => (await window.diffEditor.list()).reviews.find(r => r.id === id), undoId);
    assert.equal(undone.left.text, undoBaseline.value.files[0].text); assert.ok(undone.left.revision > 0);
    await stop(page); page = await launch();
    assert.equal((await cli(['withdraw', editedId, '--request-id', next.payload.requestId])).value.code, 'WITHDRAW_HAS_HUMAN_EDITS');
    assert.equal((await cli(['withdraw', undoId, '--request-id', undoProposal.payload.requestId])).value.code, 'WITHDRAW_HAS_HUMAN_EDITS');
    assert.deepEqual(await fs.readFile(target), original);
    assert.deepEqual(await fs.readFile(undoTarget), original);
    await assert.rejects(fs.stat(path.join(root, '.diffeditor-backups')), { code: 'ENOENT' });
    await stop(page);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ version, passed: true, result: result.value, observation: observation.value, retained, edited, undone, protectedEdit: protectedEdit.value, protectedUndo: protectedUndo.value, originalUnchanged: true }, null, 2), { flag: 'wx' });
    console.log(`Portable withdrawal smoke passed: ${root}`);
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
