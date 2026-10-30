// Run against Vite: npx vite --host 127.0.0.1 --port 4173
// Then: node src/renderer/smoke.cjs (uses the installed Edge browser).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

async function installMock(page, pair = false, empty = false, proposal = false, source = { agent: 'Codex', threadId: '01a18-review-origin-20261029', threadTitle: '论文修改与证据核验' }) {
  await page.addInitScript(({ pair, empty, proposal, source }) => {
    const target = (id, name) => ({ id, path: `C:\\review\\${name}.tex`, encoding: 'utf8', bom: false, exists: true, baseHash: 'old', status: 'pending' });
    const targets = pair ? [target('t1', 'left'), target('t2', 'right')] : [target('t1', 'paper')];
    const review = { id: 'r1', title: 'paper.tex', mode: pair ? 'pair' : proposal ? 'proposal' : 'single', ...(proposal && source ? { source } : {}), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), left: { text: 'alpha\nbeta\ngamma\n', revision: 0, targetId: 't1' }, right: { text: 'alpha\nnew beta\ngamma\nlast', revision: 0, targetId: pair ? 't2' : 't1' }, targets };
    const state = { reviews: empty ? [] : [review], commits: [], updates: [], deleted: [], rejects: [], deleteCalls: 0, textCount: 0, activeUpdates: 0, updateDelay: 25, staleUpdateSnapshots: false, returnedStaleUpdates: 0, writesAfterDelete: 0, failUpdates: false, failDelete: false, failCommit: false, failReject: false, cancelSave: false, prepareCount: 0, changed: () => {}, saveShortcut: () => {}, beforeClose: () => {}, beforeWithdraw: () => {}, withdrawFinished: () => {}, withdrawRequests: {}, withdrawReadyResults: [], withdrawResults: [], holdWithdraw: false, closed: false, token: undefined, settings: JSON.parse(sessionStorage.getItem('smoke-settings') || '{"closeToTray":true}'), failSettings: false };
    const restored = sessionStorage.getItem('smoke-reviews');
    if (restored) state.reviews = JSON.parse(restored);
    const touch = current => current.updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
    state.delayedWithdrawFinished = [];
    window.__mock = state;
    state.startWithdraw = (token, reviewId = 'r1', timeout = 3000) => {
      state.withdrawRequests[token] = { reviewId, timer: setTimeout(() => state.finishWithdraw(token, '撤回检查超时'), timeout) };
      state.beforeWithdraw({ token, reviewId });
    };
    state.finishWithdraw = (token, error) => {
      const request = state.withdrawRequests[token];
      if (!request) return;
      clearTimeout(request.timer); delete state.withdrawRequests[token];
      const current = state.reviews.find(r => r.id === request.reviewId);
      if (!error && (current.left.revision || current.right.revision)) error = '用户已编辑，禁止 AI 撤回';
      const withdrawnAt = error ? undefined : touch(current);
      if (withdrawnAt) {
        current.withdrawnAt = withdrawnAt; current.targets.forEach(t => { t.status = 'withdrawn'; });
        if (current.mode === 'proposal') current.closedAt ||= withdrawnAt;
      }
      state.withdrawResults.push({ token, error, withdrawnAt });
      const result = { token, reviewId: request.reviewId, withdrawnAt };
      if (state.delayWithdrawFinished) state.delayedWithdrawFinished.push(result); else state.withdrawFinished(result);
      state.changed();
    };
    const snapshot = () => structuredClone({ reviews: state.reviews });
    window.diffEditor = {
      getSettings: async () => structuredClone(state.settings),
      setSettings: async settings => { if (state.failSettings) throw Error('模拟设置写入失败'); state.settings = structuredClone(settings); sessionStorage.setItem('smoke-settings', JSON.stringify(settings)); return structuredClone(settings); },
      list: async () => snapshot(), pickFiles: async () => snapshot(), openFiles: async () => snapshot(),
      createTextReview: async () => {
        const next = { id: `text-${++state.textCount}`, title: `文本比较 ${state.textCount}`, mode: 'text', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), left: { text: '', revision: 0, targetId: null }, right: { text: '', revision: 0, targetId: null }, targets: [] };
        state.reviews.push(next); state.changed(); return structuredClone(next);
      },
      setReviewClosed: async (id, closed) => {
        const current = state.reviews.find(r => r.id === id);
        if (closed) current.closedAt = touch(current); else { delete current.closedAt; touch(current); }
        state.changed();
      },
      deleteReview: async id => {
        state.deleteCalls++;
        if (!state.reviews.find(r => r.id === id)?.closedAt) throw Error('请先关闭比较后再删除');
        if (state.failDelete) throw Error('模拟删除失败'); state.deleted.push(id); state.reviews = state.reviews.filter(r => r.id !== id); state.changed();
      },
      deleteClosedReviews: async ids => {
        state.deleteCalls++;
        if (ids.some(id => !state.reviews.find(r => r.id === id)?.closedAt)) throw Error('请先关闭比较后再删除');
        if (state.failDelete) throw Error('模拟删除失败');
        const deleted = state.reviews.filter(r => r.closedAt && ids.includes(r.id)).map(r => r.id);
        state.deleted.push(...deleted); state.reviews = state.reviews.filter(r => !deleted.includes(r.id)); state.changed(); return deleted;
      },
      updateDraft: async (request) => {
        state.updates.push(request);
        const current = state.reviews.find(r => r.id === request.reviewId), pane = current[request.side];
        if (pane.revision !== request.expectedRevision) throw Error('草稿版本冲突');
        const earlierSnapshot = state.staleUpdateSnapshots ? structuredClone(current) : undefined;
        state.activeUpdates++;
        try {
          await new Promise(resolve => setTimeout(resolve, state.updateDelay));
          if (state.deleted.includes(request.reviewId)) state.writesAfterDelete++;
          if (state.failUpdates) throw Error('模拟缓存失败');
          pane.text = request.text.replace(/\r\n?/g, '\n'); pane.revision++; touch(current); state.changed();
          if (earlierSnapshot) { earlierSnapshot[request.side] = structuredClone(pane); state.returnedStaleUpdates++; return earlierSnapshot; }
          return structuredClone(current);
        } finally { state.activeUpdates--; }
      },
      prepareSave: async (request) => {
        state.prepareCount++;
        if (state.cancelSave) return null;
        state.token = request;
        const current = state.reviews.find(r => r.id === request.reviewId);
        if (current.withdrawnAt) throw Error('AI 已撤回');
        if (current.mode === 'proposal' && request.side === 'left') throw Error('AI 提案原稿只能退回，不能保存');
        let t = current.targets.find(t => t.id === current[request.side].targetId);
        if (!t) {
          t = { id: `saved-${current.id}-${request.side}`, path: `C:\\review\\saved-${current.id}-${request.side}.txt`, encoding: 'utf8', exists: false, bom: false, baseHash: null, status: 'pending' };
          current.targets.push(t); current[request.side].targetId = t.id; state.changed();
        }
        return { token: 'token', reviewId: current.id, side: request.side, revision: request.expectedRevision, targetPath: t.path, backupPath: t.exists ? `C:\\review\\backup\\${t.id}.bak` : undefined, isNew: !t.exists, encoding: request.encoding || t.encoding, beforeHash: t.baseHash, afterHash: 'new' };
      },
      commitSave: async () => {
        const current = state.reviews.find(r => r.id === state.token.reviewId);
        if (current.withdrawnAt) throw Error('AI 已撤回');
        if (current.mode === 'proposal' && state.token.side === 'left') throw Error('AI 提案原稿只能退回，不能保存');
        const t = current.targets.find(t => t.id === current[state.token.side].targetId);
        if (state.failCommit) { t.status = 'conflict'; t.error = '磁盘文件已被修改，请基于磁盘继续'; throw Error(t.error); }
        state.commits.push(state.token);
        t.status = 'saved'; t.exists = true; t.receipt = { operationId: `op-${state.commits.length}`, targetPath: t.path, backupPath: `C:\\review\\backup\\${t.id}.bak`, beforeHash: 'old', afterHash: 'new', savedAt: touch(current), side: state.token.side };
        if (current.mode === 'proposal' && current.targets.every(target => target.status === 'saved')) current.closedAt ||= t.receipt.savedAt;
        state.changed();
        return structuredClone(t.receipt);
      },
      continueTarget: async () => structuredClone(review), rejectReview: async id => {
        if (state.failReject) throw Error('模拟退回失败');
        const current = state.reviews.find(r => r.id === id);
        if (current.withdrawnAt) throw Error('AI 已撤回');
        for (const t of current.targets) if (!['saved', 'saving'].includes(t.status)) { t.status = 'rejected'; delete t.error; }
        state.rejects.push(id); state.changed();
      }, showInFolder: async () => {}, getFilePath: () => '',
      onChanged: callback => { state.changed = callback; return () => {}; }, onSaveShortcut: callback => { state.saveShortcut = callback; return () => {}; },
      onBeforeClose: callback => { state.beforeClose = callback; return () => {}; }, readyToClose: () => { state.closed = true; },
      onBeforeWithdraw: callback => { state.beforeWithdraw = callback; return () => {}; },
      withdrawReady: (token, error) => { state.withdrawReadyResults.push({ token, error }); if (!state.holdWithdraw) state.finishWithdraw(token, error); },
      onWithdrawFinished: callback => { state.withdrawFinished = callback; return () => {}; },
    };
  }, { pair, empty, proposal, source });
}

async function hoverTransfer(page, to, index = 0) {
  const button = page.getByTestId(`chunk-to-${to}-${index}`);
  const box = await button.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(id => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)).opacity === '1', `chunk-to-${to}-${index}`);
  return button;
}

async function withdrawGuardCases(browser, trackErrors) {
  const createCase = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(page); await installMock(page, false, false, true);
    await page.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await page.getByTestId('chunk-to-left-0').waitFor();
    return page;
  };
  const type = async (page, side, text) => {
    await page.getByTestId(`editor-${side}`).click({ position: { x: 130, y: 30 } });
    await page.keyboard.press('Control+A'); await page.keyboard.insertText(text);
  };
  const begin = async (page, token, options = {}) => page.evaluate(({ token, options }) => {
    Object.assign(window.__mock, options);
    window.__mock.startWithdraw(token);
    // These clicks occur before React can render disabled buttons.
    document.querySelector('[data-testid="chunk-to-left-0"]')?.click();
    document.querySelector('button[title="撤销（Ctrl+Z）"]')?.click();
    document.querySelector('[data-testid="save-left"]')?.click();
    window.__mock.saveShortcut();
  }, { token, options });

  const dirty = await createCase();
  await type(dirty, 'left', 'uncached original-side edit');
  await type(dirty, 'right', 'uncached AI-side edit');
  assert.equal(await dirty.evaluate(() => window.__mock.updates.length), 0);
  await begin(dirty, 'dirty', { holdWithdraw: true, updateDelay: 650 });
  await dirty.waitForFunction(() => window.__mock.activeUpdates === 2);
  assert.equal(await dirty.getByTestId('new-text').isDisabled(), true);
  assert.equal(await dirty.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true);
  await dirty.getByTestId('editor-right').click({ position: { x: 130, y: 30 } });
  await dirty.keyboard.insertText('blocked typing'); await dirty.keyboard.press('Control+Z');
  await dirty.waitForFunction(() => window.__mock.withdrawReadyResults.length === 1);
  assert.deepEqual(await dirty.evaluate(() => window.__mock.reviews.map(r => [r.left.text, r.right.text, r.left.revision, r.right.revision])), [['uncached original-side edit', 'uncached AI-side edit', 1, 1]]);
  assert.equal(await dirty.evaluate(() => window.__mock.prepareCount + window.__mock.rejects.length), 0);
  assert.equal(await dirty.getByTestId('close-r1').isDisabled(), true, 'ACK must not unlock before main finishes');
  await dirty.evaluate(() => window.__mock.finishWithdraw('dirty'));
  await dirty.waitForFunction(() => !document.querySelector('[data-testid="save-right"]').disabled);
  assert.match(await dirty.evaluate(() => window.__mock.withdrawResults[0].error), /用户已编辑/);
  assert.equal(await dirty.getByTestId('withdrawal-notice').count(), 0);
  await type(dirty, 'right', 'editable after refused withdrawal');
  await dirty.getByTestId('close-r1').click();
  await dirty.getByTestId('toggle-closed').click(); await dirty.getByTestId('reopen-r1').click();
  await dirty.getByTestId('editor-right').waitFor();
  assert.equal(await dirty.evaluate(() => window.__mock.reviews[0].right.text), 'editable after refused withdrawal');

  const undone = await createCase();
  const before = await undone.evaluate(() => window.__mock.reviews[0].right.text);
  await undone.getByTestId('editor-right').click({ position: { x: 130, y: 30 } });
  await undone.keyboard.press('Control+Home'); await undone.keyboard.type('X');
  await undone.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await undone.evaluate(() => window.__mock.updates.length), 0);
  // A refresh must not erase the local record of a net-zero edit.
  await undone.evaluate(() => window.__mock.changed());
  await begin(undone, 'undone');
  await undone.waitForFunction(() => window.__mock.withdrawResults.length === 1);
  assert.deepEqual(await undone.evaluate(() => ({ text: window.__mock.reviews[0].right.text, revision: window.__mock.reviews[0].right.revision, error: window.__mock.withdrawResults[0].error })), { text: before, revision: 1, error: '用户已编辑，禁止 AI 撤回' });
  await undone.getByTestId('close-r1').click(); await undone.getByTestId('toggle-closed').click(); await undone.getByTestId('reopen-r1').click();
  await undone.getByTestId('editor-right').waitFor();
  await begin(undone, 'undone-reopened');
  await undone.waitForFunction(() => window.__mock.withdrawResults.length === 2);
  assert.match(await undone.evaluate(() => window.__mock.withdrawResults[1].error), /用户已编辑/);

  const failed = await createCase();
  await type(failed, 'right', 'preserved after flush error');
  await begin(failed, 'failed', { failUpdates: true });
  await failed.waitForFunction(() => window.__mock.withdrawResults.length === 1);
  assert.match(await failed.evaluate(() => window.__mock.withdrawReadyResults[0].error), /模拟缓存失败/);
  assert.equal(await failed.getByTestId('new-text').isEnabled(), true);
  await failed.evaluate(() => { window.__mock.failUpdates = false; });
  await failed.getByRole('button', { name: '重试', exact: true }).click();
  await failed.waitForFunction(() => window.__mock.reviews[0].right.text === 'preserved after flush error');

  const timeout = await createCase();
  await type(timeout, 'right', 'draft during timeout');
  await timeout.evaluate(() => { window.__mock.updateDelay = 650; window.__mock.startWithdraw('timeout', 'r1', 100); });
  await timeout.waitForFunction(() => window.__mock.withdrawResults.length === 1);
  assert.equal(await timeout.getByTestId('new-text').isEnabled(), true);
  await type(timeout, 'right', 'editable after timeout');
  await timeout.waitForFunction(() => window.__mock.activeUpdates === 0 && window.__mock.reviews[0].right.text === 'editable after timeout');
  assert.equal(await timeout.evaluate(() => window.__mock.withdrawReadyResults.length), 0, 'late flush cannot ACK an expired token');

  const concurrent = await createCase();
  await concurrent.evaluate(() => { window.__mock.holdWithdraw = true; window.__mock.startWithdraw('one'); window.__mock.startWithdraw('two'); });
  await concurrent.waitForFunction(() => window.__mock.withdrawReadyResults.length === 2);
  await concurrent.evaluate(() => window.__mock.finishWithdraw('one', '模拟失败'));
  assert.equal(await concurrent.getByTestId('new-text').isDisabled(), true);
  assert.equal(await concurrent.getByTestId('save-right').isDisabled(), true);
  await concurrent.getByTestId('editor-right').click({ position: { x: 130, y: 30 } }); await concurrent.keyboard.insertText('still blocked');
  await concurrent.evaluate(() => window.__mock.finishWithdraw('two', '模拟失败'));
  await concurrent.waitForFunction(() => !document.querySelector('[data-testid="new-text"]').disabled);
  assert.equal(await concurrent.evaluate(() => window.__mock.updates.length), 0);
  await type(concurrent, 'right', 'editable after both finish');
  await concurrent.getByTestId('close-r1').click();
  await concurrent.getByTestId('review-r1').waitFor({ state: 'hidden' });
  assert.equal(await concurrent.evaluate(() => window.__mock.reviews[0].right.text), 'editable after both finish');

  for (const modal of ['reject', 'save']) {
    const pending = await createCase();
    await pending.getByTestId(modal === 'reject' ? 'save-left' : 'save-right').click();
    await pending.getByTestId(`${modal}-dialog`).waitFor();
    await begin(pending, `${modal}-failure`, { holdWithdraw: true });
    await pending.waitForFunction(() => window.__mock.withdrawReadyResults.length === 1);
    assert.equal(await pending.getByTestId(`confirm-${modal}`).isDisabled(), true);
    await pending.evaluate(token => window.__mock.finishWithdraw(token, '模拟检查失败'), `${modal}-failure`);
    await pending.waitForFunction(id => !document.querySelector(`[data-testid="${id}"]`).disabled, `confirm-${modal}`);
    assert.equal(await pending.getByTestId(`${modal}-dialog`).isVisible(), true, 'failure preserves the existing confirmation');
    await begin(pending, `${modal}-success`, { holdWithdraw: false });
    await pending.getByTestId('closed-r1').waitFor();
    assert.equal(await pending.getByTestId('comparison-view').count(), 0);
    await pending.getByTestId('reopen-r1').click();
    await pending.getByTestId('withdrawal-notice').waitFor();
    await pending.getByTestId(`${modal}-dialog`).waitFor({ state: 'hidden' });
    assert.equal(await pending.getByTestId('new-text').isEnabled(), true);
    assert.equal(await pending.getByTestId('save-right').isDisabled(), true);
    assert.equal(await pending.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true);
    await pending.getByTestId('editor-right').click({ position: { x: 130, y: 30 } }); await pending.keyboard.insertText('must remain terminal');
    await pending.keyboard.press('Control+Z'); await pending.keyboard.press('Control+S');
    assert.equal(await pending.evaluate(() => window.__mock.updates.length + window.__mock.commits.length + window.__mock.rejects.length), 0);
    assert.equal(await pending.evaluate(() => window.__mock.reviews[0].left.revision + window.__mock.reviews[0].right.revision), 0, 'untouched preflight creates no edit revisions');
  }
}

async function autoArchiveCases(browser, trackErrors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  trackErrors(page); await installMock(page, false, false, true);
  await page.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
  await page.getByTestId('editor-right').waitFor();
  await page.evaluate(() => {
    const state = window.__mock, base = state.reviews[0];
    base.createdAt = '2020-01-01T00:00:00.000Z';
    const add = (id, mode, createdAt, status, completionAt) => {
      const review = structuredClone(base);
      Object.assign(review, { id, title: `${id}.tex`, mode, createdAt, updatedAt: completionAt || createdAt, closedAt: completionAt || createdAt });
      review.targets[0].status = status;
      if (status === 'saved') review.targets[0].receipt = { operationId: `op-${id}`, targetPath: review.targets[0].path, beforeHash: 'old', afterHash: 'new', savedAt: completionAt, side: 'right' };
      if (status === 'withdrawn') review.withdrawnAt = completionAt;
      state.reviews.push(review);
      return review;
    };
    add('approved-old', 'proposal', '2020-01-02T00:00:00.000Z', 'saved', '2020-01-05T00:00:00.000Z');
    add('withdrawn-b', 'proposal', '2020-01-03T00:00:00.000Z', 'withdrawn', '2020-01-06T00:00:00.000Z');
    add('withdrawn-a', 'proposal', '2020-01-04T00:00:00.000Z', 'withdrawn', '2020-01-06T00:00:00.000Z');
    add('manual-newest', 'single', '2020-01-10T00:00:00.000Z', 'saved', '2020-01-11T00:00:00.000Z');
    add('unfinished-proposal', 'proposal', '2020-01-09T00:00:00.000Z', 'pending');
    const open = add('open-newer', 'text', '2020-01-08T00:00:00.000Z', 'pending');
    delete open.closedAt; open.targets = []; open.left.targetId = null; open.right.targetId = null;
    state.oldSnapshot = structuredClone({ reviews: state.reviews }); state.changed();
  });
  await page.getByTestId('closed-withdrawn-a').waitFor();
  assert.deepEqual(await page.locator('.closed-review').evaluateAll(rows => rows.map(row => row.dataset.testid)), ['closed-withdrawn-a', 'closed-withdrawn-b', 'closed-approved-old', 'closed-manual-newest', 'closed-unfinished-proposal']);
  assert.deepEqual(await page.locator('.review-item').evaluateAll(rows => rows.map(row => row.dataset.testid)), ['review-open-newer', 'review-r1']);
  assert.equal(await page.getByTestId('completion-approved-old').innerText(), '已通过');
  assert.equal(await page.getByTestId('completion-withdrawn-a').innerText(), 'AI 已撤回');
  assert.equal(await page.getByTestId('completion-manual-newest').count(), 0);
  await page.getByTestId('toggle-closed').click();
  await page.getByTestId('save-right').click(); await page.getByTestId('confirm-save').click();
  await page.getByTestId('closed-r1').waitFor();
  assert.equal(await page.locator('.closed-review').first().getAttribute('data-testid'), 'closed-r1');
  assert.equal(await page.locator('.review-row.selected [data-testid="review-open-newer"]').count(), 1);
  await page.screenshot({ path: 'outputs/proposal-auto-archive-ui.png' });
  await page.evaluate(() => {
    const state = window.__mock; state.completedSnapshot = structuredClone({ reviews: state.reviews });
    state.realList = window.diffEditor.list; window.diffEditor.list = async () => structuredClone(state.oldSnapshot); state.changed();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('closed-r1').isVisible(), true, 'stale list cannot reopen an automatically closed proposal');
  await page.evaluate(() => { window.diffEditor.list = window.__mock.realList; window.__mock.changed(); });
  await page.getByTestId('reopen-r1').click(); await page.getByTestId('retained-view').waitFor();
  await page.evaluate(() => {
    const state = window.__mock; window.diffEditor.list = async () => structuredClone(state.completedSnapshot); state.changed();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('retained-view').isVisible(), true, 'stale completed snapshot cannot undo a human reopen');
  await page.evaluate(() => { window.diffEditor.list = window.__mock.realList; sessionStorage.setItem('smoke-reviews', JSON.stringify(window.__mock.reviews)); });
  await page.reload(); await page.getByTestId('review-r1').click(); await page.getByTestId('retained-view').waitFor();
  assert.equal(await page.getByTestId('closed-r1').count(), 0, 'reopened history remains open after refresh/restart');
  await page.close();

  const delayed = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  trackErrors(delayed); await installMock(delayed, false, false, true);
  await delayed.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
  await delayed.getByTestId('editor-right').waitFor();
  await delayed.evaluate(() => { window.__mock.delayWithdrawFinished = true; window.__mock.startWithdraw('delayed-finish'); });
  await delayed.getByTestId('closed-r1').waitFor();
  assert.equal(await delayed.getByTestId('completion-r1').innerText(), 'AI 已撤回');
  // Another window can reopen history before this renderer receives finish.
  await delayed.evaluate(() => window.diffEditor.setReviewClosed('r1', false));
  await delayed.getByTestId('withdrawal-notice').waitFor();
  await delayed.evaluate(() => { const state = window.__mock; state.delayedWithdrawFinished.forEach(result => state.withdrawFinished(result)); });
  await delayed.waitForFunction(() => !document.querySelector('[data-testid="new-text"]').disabled);
  assert.equal(await delayed.getByTestId('withdrawal-notice').isVisible(), true, 'late finish retains explicit reopen');
  assert.equal(await delayed.getByTestId('closed-r1').count(), 0);
  assert.equal(await delayed.getByTestId('save-right').isDisabled(), true);
  await delayed.close();
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.DIFFEDITOR_TEST_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    const trackErrors = current => current.on('pageerror', error => {
      // Monaco's WordHighlighter rejects its delayed work when an editor is disposed.
      if (error.name === 'Canceled' && error.message === 'Canceled' && error.stack.includes('Delayer.cancel') && error.stack.includes('Delayer.dispose')) return;
      pageErrors.push(error.message); console.error('Renderer error:', error.stack);
    });
    if (process.env.DIFFEDITOR_WITHDRAW_ONLY) {
      await withdrawGuardCases(browser, trackErrors); assert.deepEqual(pageErrors, []);
      console.log('Withdrawal renderer smoke passed: uncached and undone edits persist before refusal; synchronous and concurrent locks, failed/timeout release, modal restoration and untouched terminal completion.');
      return;
    }
    if (process.env.DIFFEDITOR_ARCHIVE_ONLY) {
      await autoArchiveCases(browser, trackErrors); assert.deepEqual(pageErrors, []);
      console.log('Renderer auto-archive smoke passed: completion-first order, automatic disclosure, next-open selection, stale snapshots, explicit reopen/restart, and delayed withdrawal finish.');
      return;
    }
    trackErrors(page);
    await installMock(page);
    await page.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await page.getByTestId('settings-toggle').click();
    const closeToTray = page.getByTestId('close-to-tray');
    await closeToTray.waitFor();
    assert.equal(await closeToTray.isChecked(), true);
    await closeToTray.uncheck();
    await page.waitForFunction(() => window.__mock.settings.closeToTray === false);
    await page.reload();
    await page.getByTestId('settings-toggle').click();
    await page.getByTestId('close-to-tray').waitFor();
    assert.equal(await closeToTray.isChecked(), false);
    await page.evaluate(() => { window.__mock.failSettings = true; });
    await closeToTray.click();
    await page.getByRole('alert').filter({ hasText: '设置未保存' }).waitFor();
    assert.equal(await closeToTray.isChecked(), false);
    assert.equal(await page.evaluate(() => window.__mock.settings.closeToTray), false);
    await page.evaluate(() => { window.__mock.failSettings = false; });
    await closeToTray.check();
    await page.waitForFunction(() => window.__mock.settings.closeToTray === true);
    await page.screenshot({ path: 'outputs/tray-settings-ui.png' });
    await page.getByTestId('settings-toggle').click();
    assert.match(await page.getByTestId('toggle-wrap').getAttribute('class'), /active/);
    await page.getByTestId('chunk-to-right-0').waitFor();
    assert.deepEqual(await page.locator('.side-label').allTextContents(), ['原稿（左）', '新稿（右）']);
    assert.equal(await page.getByTestId('save-left').innerText(), '保存原稿');
    assert.equal(await page.getByTestId('save-right').innerText(), '保存新稿');
    assert.equal(await page.getByTestId('review-source').count(), 0);
    assert.equal(await page.getByTestId('source-badge-r1').count(), 0);
    assert.equal(await page.getByTestId('delete-r1').count(), 0);
    assert.equal(await page.getByTestId('pane-path-right').innerText(), 'C:\\review\\paper.tex');
    assert.equal(await page.getByTestId('chunk-to-left-0').evaluate(el => getComputedStyle(el).opacity), '0');
    assert.equal(await page.getByTestId('chunk-to-right-0').evaluate(el => getComputedStyle(el).opacity), '0');
    const arrowBox = await page.getByTestId('chunk-to-left-0').boundingBox();
    await page.mouse.move(arrowBox.x - 65, arrowBox.y + 10);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-left-0"]')).opacity === '1');
    assert.equal(await page.getByTestId('chunk-to-right-0').evaluate(el => getComputedStyle(el).opacity), '0');
    assert.equal(await page.getByTestId('chunk-to-left-0').evaluate(el => getComputedStyle(el).color), 'rgb(21, 148, 103)');
    await page.mouse.move(arrowBox.x + 100, arrowBox.y + 10);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-right-0"]')).opacity === '1');
    assert.equal(await page.getByTestId('chunk-to-left-0').evaluate(el => getComputedStyle(el).opacity), '0');
    assert.equal(await page.getByTestId('chunk-to-right-0').evaluate(el => getComputedStyle(el).color), 'rgb(207, 69, 78)');
    await page.screenshot({ path: 'outputs/hover-red-arrow-ui.png' });
    await page.mouse.move(20, 20);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-right-0"]')).opacity === '0');
    await require('./hover-smoke.cjs')(page);
    assert.equal(await page.getByTestId('line-count-left').innerText(), '4 行');
    assert.equal(await page.getByTestId('line-count-right').innerText(), '4 行');
    assert.equal(await page.getByTestId('change-count-left').innerText(), '−2 行');
    assert.equal(await page.getByTestId('change-count-right').innerText(), '+2 行');
    await page.getByRole('button', { name: '上一处差异', exact: true }).click();
    assert.equal(await page.getByTestId('diff-count').innerText(), '2 / 2');
    await (await hoverTransfer(page, 'right')).click();
    await page.getByTestId('save-right').click();
    await page.getByTestId('save-dialog').waitFor();
    assert.equal(await page.getByTestId('preview-text').innerText(), 'alpha\nbeta\ngamma\nlast');
    await page.waitForFunction(() => document.querySelector('[data-testid="change-count-left"]')?.textContent === '−1 行');
    assert.equal(await page.getByTestId('change-count-left').innerText(), '−1 行');
    assert.equal(await page.getByTestId('change-count-right').innerText(), '+1 行');
    assert.equal(await page.evaluate(() => window.__mock.commits.length), 0);
    await page.getByTestId('cancel-save').click();

    const left = page.getByTestId('editor-left');
    await left.click({ position: { x: 130, y: 30 } }); await page.keyboard.press('Control+A'); await page.keyboard.type('local draft\n');
    await page.evaluate(() => {
      const next = structuredClone(window.__mock.reviews[0]); next.id = 'r2'; next.title = 'second.txt';
      window.__mock.reviews.push(next); window.__mock.changed();
    });
    await page.getByTestId('review-r2').waitFor();
    await page.getByTestId('save-left').click();
    await page.getByTestId('save-dialog').waitFor();
    assert.equal(await page.getByTestId('preview-text').innerText(), 'local draft\n');
    await page.getByTestId('confirm-save').click();
    await page.getByTestId('save-dialog').waitFor({ state: 'hidden' });
    await page.getByTestId('retained-view').waitFor();
    assert.equal(await page.getByTestId('save-left').isDisabled(), true);
    assert.equal(await page.getByTestId('save-right').count(), 0);
    assert.equal(await page.getByTestId('diff-editor').count(), 0);
    assert.equal(await page.locator('.chunk-rail').count(), 0);
    await page.getByTestId('editor-retained').click({ position: { x: 130, y: 30 } }); await page.keyboard.type('must stay locked');
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__mock.reviews[0].left.text), 'local draft\n');
    await page.evaluate(() => window.__mock.beforeClose());
    await page.waitForFunction(() => window.__mock.closed);
    assert.deepEqual(pageErrors, []);

    const proposalPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(proposalPage); await installMock(proposalPage, false, false, true);
    await proposalPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await proposalPage.getByTestId('chunk-to-left-0').waitFor();
    assert.equal(await proposalPage.getByTestId('pane-path-left').innerText(), 'C:\\review\\paper.tex');
    assert.equal(await proposalPage.getByTestId('pane-path-right').innerText(), 'AI 提供的草稿，确认后保存至：C:\\review\\paper.tex');
    assert.equal(await proposalPage.getByTestId('source-badge-r1').innerText(), 'Codex');
    assert.equal(await proposalPage.getByTestId('source-thread-title').innerText(), '发起对话：论文修改与证据核验');
    assert.equal(await proposalPage.getByTestId('source-thread-id').innerText(), '对话 ID：01a18-review-origin-20261029');
    assert.equal(await proposalPage.getByTestId('save-left').innerText(), '退回');
    assert.equal(await proposalPage.getByTestId('save-right').innerText(), '通过');
    assert.equal(await proposalPage.getByTestId('save-encoding-left').count(), 0);
    assert.equal(await proposalPage.getByTestId('reject-review').count(), 0);
    assert.equal(await proposalPage.getByTestId('delete-r1').count(), 0);
    await proposalPage.screenshot({ path: 'outputs/proposal-origin-ui.png' });
    await hoverTransfer(proposalPage, 'left'); await proposalPage.screenshot({ path: 'outputs/ai-proposal-green-arrow-ui.png' });
    await proposalPage.getByTestId('chunk-to-left-0').click();
    await proposalPage.getByTestId('save-left').click(); await proposalPage.getByTestId('confirm-reject').waitFor();
    await proposalPage.getByTestId('reject-dialog').waitFor();
    assert.equal(await proposalPage.getByTestId('cancel-reject').evaluate(el => el === document.activeElement), true);
    for (const viewport of [{ width: 850, height: 480 }, { width: 640, height: 360 }]) {
      await proposalPage.setViewportSize(viewport);
      for (const id of ['reject-dialog', 'confirm-reject', 'cancel-reject']) {
        const bounds = await proposalPage.getByTestId(id).boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, `${id} must remain inside viewport`);
      }
      for (let i = 0; i < 4; i++) {
        await proposalPage.keyboard.press('Tab');
        assert.equal(await proposalPage.getByTestId('reject-dialog').evaluate(el => el.contains(document.activeElement)), true);
      }
    }
    await proposalPage.screenshot({ path: 'outputs/reject-dialog-small-ui.png' });
    await proposalPage.keyboard.press('Escape');
    await proposalPage.getByTestId('reject-dialog').waitFor({ state: 'hidden' });
    assert.equal(await proposalPage.getByTestId('new-text').isEnabled(), true);
    assert.equal(await proposalPage.evaluate(() => window.__mock.rejects.length), 0);
    await proposalPage.setViewportSize({ width: 1280, height: 800 });
    await proposalPage.getByTestId('save-left').click();
    await proposalPage.getByRole('button', { name: '取消退回', exact: true }).click();
    assert.equal(await proposalPage.getByTestId('new-text').isEnabled(), true);
    await proposalPage.getByTestId('save-left').click();
    assert.equal(await proposalPage.getByTestId('save-dialog').count(), 0);
    assert.equal(await proposalPage.evaluate(() => window.__mock.prepareCount), 0);
    assert.equal(await proposalPage.evaluate(() => window.__mock.commits.length), 0);
    await proposalPage.getByTestId('cancel-reject').click();
    assert.equal(await proposalPage.getByTestId('new-text').isEnabled(), true);
    await proposalPage.getByTestId('editor-left').click({ position: { x: 130, y: 30 } });
    await proposalPage.keyboard.press('Control+S'); await proposalPage.getByTestId('confirm-reject').waitFor();
    await proposalPage.getByTestId('cancel-reject').click();
    await proposalPage.evaluate(() => { window.__mock.failReject = true; window.__mock.saveShortcut(); });
    await proposalPage.getByTestId('confirm-reject').click();
    await proposalPage.getByRole('alert').filter({ hasText: '模拟退回失败' }).waitFor();
    assert.equal(await proposalPage.getByTestId('reject-dialog').getByRole('alert').count(), 1);
    assert.equal(await proposalPage.evaluate(() => window.__mock.rejects.length), 0);
    assert.equal(await proposalPage.getByTestId('confirm-reject').isEnabled(), true);
    await proposalPage.getByTestId('cancel-reject').click();
    assert.equal(await proposalPage.getByTestId('new-text').isEnabled(), true);
    await proposalPage.evaluate(() => { window.__mock.failReject = false; });
    await proposalPage.getByTestId('save-left').click();
    await proposalPage.getByTestId('confirm-reject').click();
    await proposalPage.getByTestId('confirm-reject').waitFor({ state: 'hidden' });
    assert.equal(await proposalPage.getByTestId('new-text').isEnabled(), true);
    assert.deepEqual(await proposalPage.evaluate(() => window.__mock.rejects), ['r1']);
    assert.deepEqual(await proposalPage.evaluate(() => window.__mock.reviews[0].targets.map(t => t.status)), ['rejected']);
    assert.equal(await proposalPage.evaluate(() => window.__mock.reviews[0].left.text), 'alpha\nnew beta\ngamma\n');
    assert.equal(await proposalPage.evaluate(() => window.__mock.prepareCount + window.__mock.commits.length), 0);
    assert.equal(await proposalPage.getByTestId('save-left').isDisabled(), true);
    assert.equal(await proposalPage.getByTestId('save-right').isDisabled(), true);

    const approvalPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(approvalPage); await installMock(approvalPage, false, false, true);
    await approvalPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await approvalPage.getByTestId('editor-right').click({ position: { x: 130, y: 30 } });
    await approvalPage.keyboard.press('Control+S'); await approvalPage.getByTestId('save-dialog').waitFor();
    assert.equal(await approvalPage.getByTestId('confirm-save').innerText(), '确认通过并保存');
    assert.equal(await approvalPage.getByTestId('preview-text').innerText(), 'alpha\nnew beta\ngamma\nlast');
    assert.equal(await approvalPage.evaluate(() => window.__mock.commits.length), 0);
    await approvalPage.screenshot({ path: 'outputs/proposal-approval-ui.png' });
    await approvalPage.getByTestId('cancel-save').click();
    await approvalPage.getByTestId('save-right').click(); await approvalPage.getByTestId('confirm-save').click();
    await approvalPage.getByTestId('closed-r1').waitFor();
    assert.equal(await approvalPage.getByTestId('comparison-view').count(), 0);
    assert.equal(await approvalPage.getByTestId('completion-r1').innerText(), '已通过');
    await approvalPage.screenshot({ path: 'outputs/proposal-closed-ui.png' });
    await approvalPage.getByTestId('reopen-r1').click();
    await approvalPage.getByTestId('retained-view').waitFor();
    assert.equal(await approvalPage.evaluate(() => window.__mock.commits[0].side), 'right');
    assert.equal(await approvalPage.getByTestId('save-right').isDisabled(), true);
    assert.equal(await approvalPage.getByTestId('save-left').count(), 0);
    assert.equal(await approvalPage.getByTestId('review-source').count(), 1);
    await approvalPage.getByTestId('close-r1').click();
    assert.equal(await approvalPage.getByTestId('source-badge-r1').innerText(), 'Codex');

    const legacyPage = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    trackErrors(legacyPage); await installMock(legacyPage, false, false, true, null);
    await legacyPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await legacyPage.getByTestId('source-thread-unknown').waitFor();
    assert.equal(await legacyPage.getByTestId('source-thread-unknown').innerText(), '来源对话未记录');
    assert.equal(await legacyPage.getByTestId('source-thread-title').count() + await legacyPage.getByTestId('source-thread-id').count(), 0);
    assert.equal(await legacyPage.getByTestId('source-badge-r1').innerText(), 'Codex');
    await legacyPage.evaluate(() => { window.__mock.reviews[0].source = { agent: 'Codex', threadId: 'only-id-recorded' }; window.__mock.changed(); });
    await legacyPage.getByTestId('source-thread-id').waitFor();
    assert.equal(await legacyPage.getByTestId('source-thread-title').count(), 0);
    assert.equal(await legacyPage.getByTestId('source-thread-unknown').count(), 0);
    const pairPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(pairPage);
    await installMock(pairPage, true);
    await pairPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await pairPage.getByTestId('save-left').click(); await pairPage.getByTestId('confirm-save').click();
    await pairPage.getByTestId('save-dialog').waitFor({ state: 'hidden' });
    await pairPage.getByTestId('retained-view').waitFor();
    assert.equal(await pairPage.getByTestId('save-left').isDisabled(), true);
    assert.equal(await pairPage.getByTestId('save-right').count(), 0);
    await pairPage.getByTestId('resume-comparison').click();
    await pairPage.getByTestId('diff-editor').waitFor();
    assert.equal(await pairPage.getByTestId('save-right').isEnabled(), true);
    await pairPage.evaluate(() => { window.__mock.failCommit = true; });
    await pairPage.getByTestId('save-right').click(); await pairPage.getByTestId('confirm-save').click();
    await pairPage.getByTestId('save-dialog').waitFor({ state: 'hidden' });
    await pairPage.getByRole('alert').filter({ hasText: '磁盘文件已被修改' }).first().waitFor();
    assert.equal(await pairPage.getByTestId('save-right').isDisabled(), true);
    assert.equal(await pairPage.getByTestId('continue-right').innerText(), '基于磁盘继续');
    assert.equal(await pairPage.getByTestId('retained-view').count(), 0);
    const rightPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(rightPage);
    await installMock(rightPage);
    await rightPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await rightPage.getByTestId('editor-right').waitFor();
    await rightPage.evaluate(() => {
      const current = window.__mock.reviews[0];
      current.left.text = 'old version ' + '这是一段很长的中文和 English paragraph，用于确认编辑器自动折行。'.repeat(80);
      current.right.text = 'new beta ' + '这是保留后的长段落，长文本应该在当前栏内自动换行，而不需要左右拖动查看。'.repeat(80);
      current.left.revision++; current.right.revision++; window.__mock.changed();
    });
    await rightPage.waitForFunction(() => document.querySelector('[data-testid="line-count-right"]')?.textContent === '1 行' && document.querySelectorAll('[data-testid="editor-right"] .view-line').length > 8);
    assert.equal(await rightPage.locator('.diffOverview').count(), 0);
    assert.ok(await rightPage.getByTestId('editor-right').evaluate(editor => {
      const edge = editor.getBoundingClientRect().right;
      return Array.from(editor.querySelectorAll('.view-line')).every(line => {
        const range = document.createRange(); range.selectNodeContents(line);
        return range.getBoundingClientRect().right <= edge + 1;
      });
    }), 'wrapped text must stay within its pane');
    const scrollBar = rightPage.getByTestId('editor-right').locator('.monaco-scrollable-element > .scrollbar.vertical').first();
    assert.equal(await scrollBar.evaluate(bar => bar.getBoundingClientRect().width), 0);
    const overview = rightPage.getByTestId('text-overview');
    await rightPage.waitForFunction(() => document.querySelector('[data-testid="text-overview"]')?.getAttribute('data-red-count') === '1');
    assert.equal(await overview.getAttribute('data-red-count'), '1');
    assert.equal(await overview.getAttribute('data-green-count'), '1');
    await rightPage.getByTestId('editor-right').hover();
    await rightPage.mouse.wheel(0, 300);
    await rightPage.waitForFunction(() => Number(document.querySelector('[data-testid="text-overview"]').getAttribute('aria-valuenow')) > 0);
    const overviewBox = await overview.boundingBox();
    await rightPage.mouse.click(overviewBox.x + 20, overviewBox.y + overviewBox.height - 15);
    const afterClick = Number(await overview.getAttribute('aria-valuenow'));
    assert.ok(afterClick > 300, 'clicking overview should move down the document');
    const thumb = await rightPage.getByTestId('overview-viewport').boundingBox();
    await rightPage.mouse.move(thumb.x + 20, thumb.y + thumb.height / 2); await rightPage.mouse.down();
    await rightPage.mouse.move(thumb.x + 20, overviewBox.y + 15, { steps: 8 }); await rightPage.mouse.up();
    await rightPage.waitForFunction(before => Number(document.querySelector('[data-testid="text-overview"]').getAttribute('aria-valuenow')) < before, afterClick);
    const pixels = await rightPage.getByTestId('overview-canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0, green = 0;
      for (let i = 0; i < data.length; i += 4) { if (data[i] > data[i + 1] + 15 && data[i + 3]) red++; if (data[i + 1] > data[i] + 15 && data[i + 3]) green++; }
      return { red, green };
    });
    assert.ok(pixels.red > 0 && pixels.green > 0, 'overview must paint actual red/green diff strokes');
    await rightPage.screenshot({ path: 'outputs/wrapped-comparison-ui.png' });
    await rightPage.getByTestId('save-right').click();
    await rightPage.getByTestId('save-dialog').waitFor();
    await rightPage.getByTestId('cancel-save').click();
    assert.equal(await rightPage.getByTestId('diff-editor').count(), 1);
    assert.equal(await rightPage.getByTestId('retained-view').count(), 0);
    await rightPage.getByTestId('save-right').click(); await rightPage.getByTestId('confirm-save').click();
    await rightPage.getByTestId('retained-view').waitFor();
    assert.equal(await rightPage.getByTestId('save-left').count(), 0);
    assert.equal(await rightPage.getByTestId('save-right').isDisabled(), true);
    assert.equal(await rightPage.locator('.pane-header').count(), 1);
    assert.match(await rightPage.getByTestId('editor-retained').innerText(), /new\s+beta/);
    const keptBox = await rightPage.getByTestId('retained-editor').boundingBox();
    const workBox = await rightPage.locator('.workspace').boundingBox();
    assert.ok(keptBox.width >= workBox.width - 42, 'saved version should fill the workspace beside the overview');
    await rightPage.evaluate(() => sessionStorage.setItem('smoke-reviews', JSON.stringify(window.__mock.reviews)));
    await rightPage.reload(); await rightPage.getByTestId('retained-view').waitFor();
    assert.equal(await rightPage.getByTestId('save-left').count(), 0);
    assert.match(await rightPage.getByTestId('editor-retained').innerText(), /new\s+beta/);
    const keptBar = rightPage.getByTestId('editor-retained').locator('.monaco-scrollable-element > .scrollbar.vertical').first();
    assert.equal(await keptBar.evaluate(bar => bar.getBoundingClientRect().width), 0);
    assert.equal(await rightPage.getByTestId('text-overview').getAttribute('data-red-count'), '0');
    assert.equal(await rightPage.getByTestId('text-overview').getAttribute('data-green-count'), '0');
    await rightPage.getByTestId('text-overview').hover(); await rightPage.mouse.wheel(0, 150);
    await rightPage.waitForFunction(() => Number(document.querySelector('[data-testid="text-overview"]').getAttribute('aria-valuenow')) > 0);
    await rightPage.getByTestId('editor-retained').click({ position: { x: 100, y: 50 } });
    await rightPage.keyboard.press('Control+Home');
    await rightPage.screenshot({ path: 'outputs/retained-right-ui.png' });
    const textPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(textPage);
    await installMock(textPage, false, true);
    await textPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await textPage.getByTestId('empty-new-text').click();
    await textPage.getByTestId('editor-left').waitFor();
    assert.equal(await textPage.getByTestId('save-left').innerText(), '另存为…');
    assert.equal(await textPage.getByTestId('save-right').innerText(), '另存为…');
    assert.equal(await textPage.getByTestId('reject-review').count(), 0);
    assert.equal(await textPage.locator('.pane-heading strong').first().innerText(), '原稿文本');
    assert.equal(await textPage.locator('.pane-heading strong').last().innerText(), '新稿文本');
    assert.equal(await textPage.locator('.pane-path').first().innerText(), '保存时选择文件位置');
    const typeText = async (side, text) => {
      await textPage.getByTestId(`editor-${side}`).click({ position: { x: 130, y: 30 } });
      await textPage.keyboard.press('Control+A'); await textPage.keyboard.type(text);
    };
    await typeText('left', 'before\nshared\n');
    await typeText('right', 'after\nshared\n');
    await textPage.waitForFunction(() => window.__mock.reviews[0].left.text.replace(/\r\n/g, '\n') === 'before\nshared\n' && window.__mock.reviews[0].right.text.replace(/\r\n/g, '\n') === 'after\nshared\n');
    await (await hoverTransfer(textPage, 'right')).click();
    await textPage.waitForFunction(() => document.querySelector('[data-testid="diff-count"]')?.textContent === '0 处差异');
    await typeText('right', 'second draft\n');
    await textPage.getByTestId('new-text').click();
    await textPage.getByTestId('review-text-2').waitFor();
    assert.equal(await textPage.evaluate(() => window.__mock.reviews[0].right.text.replace(/\r\n/g, '\n')), 'second draft\n');
    await textPage.getByTestId('review-text-1').click();
    await textPage.waitForFunction(() => document.querySelector('[data-testid="editor-right"] .view-lines')?.textContent.replace(/\s/g, '').includes('seconddraft'));
    await textPage.evaluate(() => { window.__mock.cancelSave = true; });
    await textPage.getByTestId('save-left').click();
    await textPage.waitForFunction(() => window.__mock.prepareCount === 1);
    await textPage.waitForFunction(() => !document.querySelector('[data-testid="save-left"]').disabled);
    assert.equal(await textPage.getByTestId('save-dialog').count(), 0);
    await textPage.evaluate(() => { window.__mock.cancelSave = false; });
    await textPage.getByTestId('save-left').click();
    await textPage.getByTestId('save-dialog').waitFor();
    assert.equal(await textPage.getByTestId('preview-text').innerText(), 'before\nshared\n');
    assert.equal(await textPage.getByTestId('preview-target').innerText(), 'C:\\review\\saved-text-1-left.txt');
    assert.equal(await textPage.getByTestId('new-text').isDisabled(), true);
    assert.equal(await textPage.getByTestId('close-text-1').isDisabled(), true);
    assert.equal(await textPage.getByTestId('delete-text-1').count(), 0);
    await textPage.getByTestId('cancel-save').click();
    assert.equal(await textPage.getByTestId('save-left').innerText(), '另存为…');
    await textPage.getByTestId('save-left').click(); await textPage.getByTestId('save-dialog').waitFor();
    assert.equal(await textPage.getByTestId('preview-target').innerText(), 'C:\\review\\saved-text-1-left.txt');
    await textPage.getByTestId('cancel-save').click();
    await textPage.screenshot({ path: 'outputs/text-lifecycle-ui.png' });
    await typeText('left', 'close flush draft');
    await textPage.getByTestId('close-text-1').click();
    await textPage.getByTestId('review-text-1').waitFor({ state: 'hidden' });
    assert.equal(await textPage.evaluate(() => window.__mock.reviews[0].left.text), 'close flush draft');
    await textPage.getByTestId('toggle-closed').click();
    await textPage.getByTestId('reopen-text-1').click();
    await textPage.getByTestId('review-text-1').waitFor();
    await textPage.waitForFunction(() => document.querySelector('[data-testid="editor-left"] .view-lines')?.textContent.replace(/\s/g, '').includes('closeflushdraft'));
    assert.equal(await textPage.getByTestId('delete-text-1').count(), 0);
    await typeText('left', 'survive delete failure');
    await textPage.getByTestId('close-text-1').click();
    await textPage.getByTestId('closed-text-1').waitFor();
    await textPage.getByTestId('delete-text-1').click();
    await textPage.getByTestId('delete-dialog').waitFor();
    assert.match(await textPage.getByTestId('delete-dialog').innerText(), /真实文件及备份文件不会删除/);
    await textPage.getByTestId('cancel-delete').click();
    assert.equal(await textPage.getByTestId('closed-text-1').count(), 1);
    await textPage.evaluate(() => { window.__mock.failDelete = true; });
    await textPage.getByTestId('delete-text-1').click(); await textPage.getByTestId('confirm-delete').click();
    await textPage.getByRole('alert').filter({ hasText: '模拟删除失败' }).waitFor();
    await textPage.getByTestId('cancel-delete').click();
    await textPage.getByTestId('reopen-text-1').click();
    await textPage.getByTestId('review-text-1').waitFor();
    assert.equal(await textPage.evaluate(() => window.__mock.reviews[0].left.text), 'survive delete failure');
    assert.equal(await textPage.getByTestId('draft-status-left').innerText(), '草稿已缓存');
    await textPage.evaluate(() => { window.__mock.failDelete = false; window.__mock.updateDelay = 800; });
    await typeText('right', 'pending deletion draft');
    await textPage.waitForFunction(() => window.__mock.activeUpdates > 0);
    await textPage.getByTestId('close-text-1').click();
    await textPage.getByTestId('closed-text-1').waitFor();
    await textPage.getByTestId('delete-text-1').click();
    await textPage.getByTestId('confirm-delete').click();
    await textPage.getByTestId('delete-dialog').waitFor({ state: 'hidden' });
    await textPage.waitForTimeout(1000);
    assert.equal(await textPage.getByTestId('review-text-1').count(), 0);
    assert.deepEqual(await textPage.evaluate(() => window.__mock.deleted), ['text-1']);
    assert.equal(await textPage.evaluate(() => window.__mock.writesAfterDelete), 0);
    await textPage.evaluate(() => { window.__mock.failUpdates = true; window.__mock.updateDelay = 25; });
    await typeText('left', 'uncached draft');
    await textPage.waitForFunction(() => document.querySelector('[data-testid="draft-status-left"]')?.textContent === '草稿缓存失败');
    await textPage.evaluate(() => { window.__mock.reviews[0].closedAt = new Date().toISOString(); window.__mock.changed(); });
    await textPage.getByTestId('closed-text-2').waitFor();
    await textPage.getByTestId('delete-text-2').click(); await textPage.getByTestId('confirm-delete').click();
    await textPage.getByTestId('empty-new-text').waitFor();
    await textPage.waitForTimeout(600);
    assert.equal(await textPage.evaluate(() => window.__mock.reviews.length), 0);
    assert.equal(await textPage.evaluate(() => window.__mock.textCount), 2);
    const bulkPage = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    trackErrors(bulkPage); await installMock(bulkPage);
    await bulkPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await bulkPage.getByTestId('review-r1').waitFor();
    assert.equal(await bulkPage.getByTestId('delete-closed').count(), 0);
    await bulkPage.evaluate(() => {
      const template = window.__mock.reviews[0];
      for (const id of ['closed-1', 'closed-2']) window.__mock.reviews.push({ ...structuredClone(template), id, title: `已关闭的知识记录 ${id}`, closedAt: new Date().toISOString() });
      window.__mock.changed();
    });
    await bulkPage.getByTestId('delete-closed').click();
    assert.match(await bulkPage.getByTestId('delete-dialog').innerText(), /全部 2 项已关闭比较/);
    assert.equal(await bulkPage.getByTestId('delete-closed').isDisabled(), true);
    await bulkPage.screenshot({ path: 'outputs/delete-closed-confirm-ui.png' });
    await bulkPage.getByTestId('cancel-delete').click();
    assert.deepEqual(await bulkPage.evaluate(() => window.__mock.deleted), []);
    await bulkPage.getByTestId('toggle-closed').click();
    await bulkPage.getByTestId('delete-closed-1').click();
    // A second window can reopen an item while this confirmation is still visible.
    await bulkPage.evaluate(() => { delete window.__mock.reviews.find(r => r.id === 'closed-1').closedAt; });
    await bulkPage.getByTestId('confirm-delete').click();
    await bulkPage.getByTestId('delete-dialog').waitFor({ state: 'hidden' });
    assert.equal(await bulkPage.evaluate(() => window.__mock.deleteCalls), 0);
    assert.equal(await bulkPage.getByTestId('review-closed-1').count(), 1);
    await bulkPage.getByTestId('close-closed-1').click();
    await bulkPage.getByTestId('delete-closed').click();
    await bulkPage.evaluate(() => { delete window.__mock.reviews.find(r => r.id === 'closed-2').closedAt; window.__mock.changed(); });
    await bulkPage.getByTestId('confirm-delete').click();
    await bulkPage.getByTestId('delete-dialog').waitFor({ state: 'hidden' });
    assert.equal(await bulkPage.evaluate(() => window.__mock.deleteCalls), 0);
    assert.deepEqual(await bulkPage.evaluate(() => window.__mock.deleted), []);
    await bulkPage.getByTestId('close-closed-2').click();
    await bulkPage.evaluate(() => { window.__mock.failDelete = true; });
    await bulkPage.getByTestId('delete-closed').click(); await bulkPage.getByTestId('confirm-delete').click();
    await bulkPage.getByRole('alert').filter({ hasText: '模拟删除失败' }).waitFor();
    assert.equal(await bulkPage.evaluate(() => window.__mock.reviews.length), 3);
    await bulkPage.getByTestId('cancel-delete').click();
    await bulkPage.evaluate(() => { window.__mock.failDelete = false; });
    await bulkPage.getByTestId('delete-closed').click();
    // A newly closed item after confirmation opened is not part of the batch.
    await bulkPage.evaluate(() => {
      window.__mock.reviews.push({ ...structuredClone(window.__mock.reviews[1]), id: 'later-closed' });
      window.__mock.changed();
    });
    await bulkPage.getByTestId('confirm-delete').click();
    await bulkPage.getByTestId('delete-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await bulkPage.evaluate(() => window.__mock.deleted), ['closed-1', 'closed-2']);
    assert.equal(await bulkPage.getByTestId('review-r1').count(), 1);
    await bulkPage.getByTestId('delete-closed').click(); await bulkPage.getByTestId('confirm-delete').click();
    await bulkPage.getByTestId('delete-closed').waitFor({ state: 'hidden' });
    assert.equal(await bulkPage.getByTestId('review-r1').count(), 1);
    assert.equal(await bulkPage.evaluate(() => window.__mock.commits.length), 0);

    await autoArchiveCases(browser, trackErrors);
    await withdrawGuardCases(browser, trackErrors);
    // Defensive compatibility with historical v0.1.15 sessions/external notifications.
    // New withdrawal requests above must reject these human-edited reviews.
    const withdrawRemotely = async currentPage => currentPage.evaluate(() => {
      const current = window.__mock.reviews.find(r => r.id === 'r1');
      current.withdrawnAt = new Date().toISOString(); current.closedAt = current.withdrawnAt; current.updatedAt = current.withdrawnAt;
      for (const target of current.targets) { target.status = 'withdrawn'; delete target.error; }
      window.__mock.changed();
    });
    const withdrawnPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(withdrawnPage); await installMock(withdrawnPage, false, false, true);
    await withdrawnPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await withdrawnPage.getByTestId('editor-right').waitFor();
    await withdrawnPage.evaluate(() => {
      const next = structuredClone(window.__mock.reviews[0]); next.id = 'r2'; next.title = 'other-proposal.tex';
      window.__mock.reviews.push(next); window.__mock.updateDelay = 1400; window.__mock.staleUpdateSnapshots = true; window.__mock.changed();
    });
    const withdrawalDrafts = { left: 'human original-side draft\n', right: 'human changed AI draft\n' };
    for (const side of ['left', 'right']) {
      await withdrawnPage.getByTestId(`editor-${side}`).click({ position: { x: 130, y: 30 } });
      await withdrawnPage.keyboard.press('Control+A'); await withdrawnPage.keyboard.type(withdrawalDrafts[side]);
    }
    await withdrawnPage.waitForFunction(() => window.__mock.activeUpdates === 2);
    // Keep a newer optimistic buffer while its earlier cache request is still in flight.
    withdrawalDrafts.right = 'latest human draft before AI withdrawal\n';
    await withdrawnPage.getByTestId('editor-right').click({ position: { x: 130, y: 30 } });
    await withdrawnPage.keyboard.press('Control+A'); await withdrawnPage.keyboard.type(withdrawalDrafts.right);
    await withdrawRemotely(withdrawnPage);
    await withdrawnPage.getByTestId('closed-r1').waitFor();
    assert.equal(await withdrawnPage.locator('.review-row.selected [data-testid="review-r2"]').count(), 1, 'next open comparison is selected after automatic closure');
    await withdrawnPage.getByTestId('reopen-r1').click();
    const withdrawalNotice = withdrawnPage.getByTestId('withdrawal-notice');
    await withdrawalNotice.waitFor();
    assert.match(await withdrawalNotice.innerText(), /AI 已撤回.*原文件未改动。草稿与历史记录已保留/s);
    assert.match(await withdrawnPage.getByTestId('review-r1').innerText(), /AI 已撤回/);
    assert.match(await withdrawnPage.getByTestId('review-r1').getAttribute('class'), /review-item/);
    assert.equal(await withdrawnPage.locator('.review-row.selected [data-testid="review-r1"]').count(), 1);
    assert.equal(await withdrawnPage.getByTestId('save-left').isDisabled(), true);
    assert.equal(await withdrawnPage.getByTestId('save-right').isDisabled(), true);
    assert.equal(await withdrawnPage.getByTestId('save-encoding-right').isDisabled(), true);
    assert.equal(await withdrawnPage.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true);
    assert.equal(await withdrawnPage.getByRole('button', { name: '重做', exact: true }).isDisabled(), true);
    assert.equal(await withdrawnPage.getByTestId('new-text').isEnabled(), true);
    assert.equal(await withdrawnPage.getByTestId('review-r2').isEnabled(), true);
    assert.equal(await withdrawnPage.getByTestId('source-thread-id').innerText(), '对话 ID：01a18-review-origin-20261029');
    assert.equal(await withdrawnPage.getByTestId('pane-path-right').innerText(), '已撤回的 AI 草稿，原目标文件：C:\\review\\paper.tex');
    assert.equal(await withdrawnPage.locator('.chunk-action:not(:disabled)').count(), 0);
    await withdrawnPage.waitForFunction(() => window.__mock.returnedStaleUpdates >= 2 && window.__mock.activeUpdates > 0);
    assert.equal(await withdrawalNotice.isVisible(), true);
    assert.equal(await withdrawnPage.getByTestId('save-right').isDisabled(), true);
    await withdrawnPage.waitForFunction(expected => {
      const current = window.__mock.reviews.find(r => r.id === 'r1');
      return !window.__mock.activeUpdates && current.left.text === expected.left && current.right.text === expected.right;
    }, withdrawalDrafts);
    for (const side of ['left', 'right']) {
      assert.equal(await withdrawnPage.getByTestId(`draft-status-${side}`).innerText(), '草稿已缓存');
      await withdrawnPage.getByTestId(`editor-${side}`).click({ position: { x: 130, y: 30 } });
      await withdrawnPage.keyboard.type('must stay read only'); await withdrawnPage.keyboard.press('Control+S');
    }
    await withdrawnPage.waitForTimeout(550);
    assert.deepEqual(await withdrawnPage.evaluate(() => {
      const current = window.__mock.reviews.find(r => r.id === 'r1');
      return { left: current.left.text, right: current.right.text, status: current.targets[0].status, closed: !!current.closedAt, receipt: !!current.targets[0].receipt, prepares: window.__mock.prepareCount, commits: window.__mock.commits.length, rejects: window.__mock.rejects.length };
    }), { ...withdrawalDrafts, status: 'withdrawn', closed: false, receipt: false, prepares: 0, commits: 0, rejects: 0 });
    await withdrawnPage.screenshot({ path: 'outputs/withdrawn-proposal-ui.png' });
    await withdrawnPage.getByTestId('review-r2').click();
    await withdrawnPage.getByTestId('withdrawal-notice').waitFor({ state: 'hidden' });
    await withdrawnPage.getByTestId('review-r1').click(); await withdrawalNotice.waitFor();
    await withdrawnPage.getByTestId('close-r1').click();
    await withdrawnPage.getByTestId('reopen-r1').click();
    await withdrawalNotice.waitFor();
    assert.equal(await withdrawnPage.getByTestId('save-right').isDisabled(), true);

    const withdrawnRejectPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(withdrawnRejectPage); await installMock(withdrawnRejectPage, false, false, true);
    await withdrawnRejectPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await withdrawnRejectPage.getByTestId('save-left').click();
    await withdrawnRejectPage.getByTestId('reject-dialog').waitFor();
    assert.equal(await withdrawnRejectPage.getByTestId('new-text').isDisabled(), true);
    await withdrawRemotely(withdrawnRejectPage);
    await withdrawnRejectPage.getByTestId('reject-dialog').waitFor({ state: 'hidden' });
    assert.equal(await withdrawnRejectPage.getByTestId('new-text').isEnabled(), true);
    assert.equal(await withdrawnRejectPage.getByTestId('close-r1').count(), 0);
    assert.equal(await withdrawnRejectPage.getByTestId('reopen-r1').isEnabled(), true);
    assert.equal(await withdrawnRejectPage.evaluate(() => window.__mock.rejects.length), 0);
    await withdrawnRejectPage.getByTestId('new-text').click();
    await withdrawnRejectPage.getByTestId('review-text-1').waitFor();

    const withdrawnSavePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(withdrawnSavePage); await installMock(withdrawnSavePage, false, false, true);
    await withdrawnSavePage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await withdrawnSavePage.getByTestId('save-right').click();
    await withdrawnSavePage.getByTestId('save-dialog').waitFor();
    await withdrawRemotely(withdrawnSavePage);
    await withdrawnSavePage.getByTestId('save-dialog').waitFor({ state: 'hidden' });
    assert.equal(await withdrawnSavePage.getByTestId('new-text').isEnabled(), true);
    assert.equal(await withdrawnSavePage.getByTestId('close-r1').count(), 0);
    await withdrawnSavePage.getByTestId('reopen-r1').click();
    await withdrawnSavePage.getByTestId('withdrawal-notice').waitFor();
    assert.equal(await withdrawnSavePage.getByTestId('save-right').isDisabled(), true);
    assert.equal(await withdrawnSavePage.evaluate(() => window.__mock.commits.length), 0);

    const mapPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(mapPage); await installMock(mapPage, false, false, true);
    await mapPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await mapPage.getByTestId('editor-right').waitFor();
    await mapPage.evaluate(() => {
      const before = Array.from({ length: 350 }, (_, index) => `第 ${index + 1} 行：保留的讨论记录与上下文。`);
      const after = [...before];
      after[20] = '新的论述：这里是一处修改。'; after[200] = '补充论据：这里是另一处修改。';
      after.splice(300, 0, '新增结论：等待用户审核。'); after.splice(100, 1);
      const current = window.__mock.reviews[0];
      current.left.text = before.join('\n'); current.right.text = after.join('\n');
      current.left.revision++; current.right.revision++; window.__mock.changed();
    });
    await mapPage.waitForFunction(() => Number(document.querySelector('[data-testid="text-overview"]')?.getAttribute('data-red-count')) > 0 && Number(document.querySelector('[data-testid="text-overview"]')?.getAttribute('aria-valuemax')) > 1000);
    const map = mapPage.getByTestId('text-overview'), mapBox = await map.boundingBox();
    assert.equal(mapBox.width, 40);
    await mapPage.screenshot({ path: 'outputs/color-text-overview-ui.png' });
    await mapPage.mouse.click(mapBox.x + 20, mapBox.y + mapBox.height * .75);
    await mapPage.waitForFunction(() => Number(document.querySelector('[data-testid="text-overview"]').getAttribute('aria-valuenow')) > 3000);
    await mapPage.getByTestId('toggle-fold').click();
    await mapPage.waitForTimeout(250);
    assert.ok(Number(await map.getAttribute('data-red-count')) > 0);
    assert.ok(Number(await map.getAttribute('data-green-count')) > 0);
    await mapPage.getByTestId('toggle-fold').click();
    await map.focus(); await mapPage.keyboard.press('Home');
    await mapPage.waitForFunction(() => document.querySelector('[data-testid="text-overview"]').getAttribute('aria-valuenow') === '0');
    await mapPage.keyboard.press('PageDown');
    await mapPage.waitForFunction(() => Number(document.querySelector('[data-testid="text-overview"]').getAttribute('aria-valuenow')) > 0);
    const selectionPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(selectionPage); await installMock(selectionPage);
    await require('./selection-smoke.cjs')(selectionPage);
    const findPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    trackErrors(findPage); await installMock(findPage);
    await findPage.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
    await require('./find-smoke.cjs')(findPage);
    assert.equal(await findPage.evaluate(() => window.__mock.updates.length + window.__mock.commits.length), 0);
    assert.deepEqual(pageErrors, []);
    console.log('Renderer smoke passed: AI withdrawal retains delayed human drafts, read-only review, source, sidebar navigation and modal race guards; proposal source/legacy/closed badges; return and approve buttons, keyboard routes, failed/canceled/rejected/saved states and explicit final save; closed-only deletion with stale-confirmation guards; manual text/pair/save labels and prior editor/settings regressions.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
