// Run against Vite: npx vite --host 127.0.0.1 --port 4173
// Then: node src/renderer/smoke.cjs (uses the installed Edge browser).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

async function installMock(page, pair = false, empty = false) {
  await page.addInitScript(({ pair, empty }) => {
    const target = (id, name) => ({ id, path: `C:\\review\\${name}.tex`, encoding: 'utf8', bom: false, exists: true, baseHash: 'old', status: 'pending' });
    const targets = pair ? [target('t1', 'left'), target('t2', 'right')] : [target('t1', 'paper')];
    const review = { id: 'r1', title: 'paper.tex', mode: pair ? 'pair' : 'single', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), left: { text: 'alpha\nbeta\ngamma\n', revision: 0, targetId: 't1' }, right: { text: 'alpha\nnew beta\ngamma\nlast', revision: 0, targetId: pair ? 't2' : 't1' }, targets };
    const state = { reviews: empty ? [] : [review], commits: [], updates: [], deleted: [], textCount: 0, activeUpdates: 0, updateDelay: 25, writesAfterDelete: 0, failUpdates: false, failDelete: false, failCommit: false, cancelSave: false, prepareCount: 0, changed: () => {}, beforeClose: () => {}, closed: false, token: undefined, settings: JSON.parse(sessionStorage.getItem('smoke-settings') || '{"closeToTray":true}'), failSettings: false };
    const restored = sessionStorage.getItem('smoke-reviews');
    if (restored) state.reviews = JSON.parse(restored);
    window.__mock = state;
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
        if (closed) current.closedAt = new Date().toISOString(); else delete current.closedAt;
        state.changed();
      },
      deleteReview: async id => { if (state.failDelete) throw Error('模拟删除失败'); state.deleted.push(id); state.reviews = state.reviews.filter(r => r.id !== id); state.changed(); },
      updateDraft: async (request) => {
        state.updates.push(request);
        const current = state.reviews.find(r => r.id === request.reviewId), pane = current[request.side];
        if (pane.revision !== request.expectedRevision) throw Error('草稿版本冲突');
        state.activeUpdates++;
        try {
          await new Promise(resolve => setTimeout(resolve, state.updateDelay));
          if (state.deleted.includes(request.reviewId)) state.writesAfterDelete++;
          if (state.failUpdates) throw Error('模拟缓存失败');
          pane.text = request.text.replace(/\r\n?/g, '\n'); pane.revision++; state.changed();
          return structuredClone(current);
        } finally { state.activeUpdates--; }
      },
      prepareSave: async (request) => {
        state.prepareCount++;
        if (state.cancelSave) return null;
        state.token = request;
        const current = state.reviews.find(r => r.id === request.reviewId);
        let t = current.targets.find(t => t.id === current[request.side].targetId);
        if (!t) {
          t = { id: `saved-${current.id}-${request.side}`, path: `C:\\review\\saved-${current.id}-${request.side}.txt`, encoding: 'utf8', exists: false, bom: false, baseHash: null, status: 'pending' };
          current.targets.push(t); current[request.side].targetId = t.id; state.changed();
        }
        return { token: 'token', reviewId: current.id, side: request.side, revision: request.expectedRevision, targetPath: t.path, backupPath: t.exists ? `C:\\review\\backup\\${t.id}.bak` : undefined, isNew: !t.exists, encoding: request.encoding || t.encoding, beforeHash: t.baseHash, afterHash: 'new' };
      },
      commitSave: async () => {
        const current = state.reviews.find(r => r.id === state.token.reviewId);
        const t = current.targets.find(t => t.id === current[state.token.side].targetId);
        if (state.failCommit) { t.status = 'conflict'; t.error = '磁盘文件已被修改，请基于磁盘继续'; throw Error(t.error); }
        state.commits.push(state.token);
        t.status = 'saved'; t.exists = true; t.receipt = { operationId: `op-${state.commits.length}`, targetPath: t.path, backupPath: `C:\\review\\backup\\${t.id}.bak`, beforeHash: 'old', afterHash: 'new', savedAt: new Date().toISOString(), side: state.token.side };
        return structuredClone(t.receipt);
      },
      continueTarget: async () => structuredClone(review), rejectReview: async () => {}, showInFolder: async () => {}, getFilePath: () => '',
      onChanged: callback => { state.changed = callback; return () => {}; }, onSaveShortcut: () => () => {},
      onBeforeClose: callback => { state.beforeClose = callback; return () => {}; }, readyToClose: () => { state.closed = true; },
    };
  }, { pair, empty });
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
    assert.equal(await page.getByTestId('line-count-left').innerText(), '4 行');
    assert.equal(await page.getByTestId('line-count-right').innerText(), '4 行');
    assert.equal(await page.getByTestId('change-count-left').innerText(), '−2 行');
    assert.equal(await page.getByTestId('change-count-right').innerText(), '+2 行');
    await page.getByRole('button', { name: '上一处差异', exact: true }).click();
    assert.equal(await page.getByTestId('diff-count').innerText(), '2 / 2');
    await page.getByTestId('chunk-to-right-0').click();
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
    assert.equal(await scrollBar.evaluate(bar => bar.getBoundingClientRect().width), 6);
    await rightPage.getByTestId('editor-right').hover();
    await rightPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="editor-right"] .scrollbar.vertical')).opacity === '0');
    await rightPage.mouse.wheel(0, 300);
    await rightPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="editor-right"] .scrollbar.vertical')).opacity === '1');
    await rightPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="editor-right"] .scrollbar.vertical')).opacity === '0');
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
    assert.ok(keptBox.width >= workBox.width - 2, 'saved version should fill the workspace');
    await rightPage.evaluate(() => sessionStorage.setItem('smoke-reviews', JSON.stringify(window.__mock.reviews)));
    await rightPage.reload(); await rightPage.getByTestId('retained-view').waitFor();
    assert.equal(await rightPage.getByTestId('save-left').count(), 0);
    assert.match(await rightPage.getByTestId('editor-retained').innerText(), /new\s+beta/);
    const keptBar = rightPage.getByTestId('editor-retained').locator('.monaco-scrollable-element > .scrollbar.vertical').first();
    assert.equal(await keptBar.evaluate(bar => bar.getBoundingClientRect().width), 6);
    await rightPage.getByTestId('editor-retained').hover();
    await rightPage.mouse.wheel(0, 150);
    await rightPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="editor-retained"] .scrollbar.vertical')).opacity === '1');
    await rightPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="editor-retained"] .scrollbar.vertical')).opacity === '0');
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
    assert.equal(await textPage.locator('.pane-heading strong').first().innerText(), '左侧文本');
    assert.equal(await textPage.locator('.pane-heading strong').last().innerText(), '右侧文本');
    assert.equal(await textPage.locator('.pane-path').first().innerText(), '保存时选择文件位置');
    const typeText = async (side, text) => {
      await textPage.getByTestId(`editor-${side}`).click({ position: { x: 130, y: 30 } });
      await textPage.keyboard.press('Control+A'); await textPage.keyboard.type(text);
    };
    await typeText('left', 'before\nshared\n');
    await typeText('right', 'after\nshared\n');
    await textPage.waitForFunction(() => window.__mock.reviews[0].left.text.replace(/\r\n/g, '\n') === 'before\nshared\n' && window.__mock.reviews[0].right.text.replace(/\r\n/g, '\n') === 'after\nshared\n');
    await textPage.getByTestId('chunk-to-right-0').click();
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
    assert.equal(await textPage.getByTestId('delete-text-1').isDisabled(), true);
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
    await textPage.getByTestId('delete-text-1').click();
    await textPage.getByTestId('delete-dialog').waitFor();
    assert.match(await textPage.getByTestId('delete-dialog').innerText(), /真实文件及备份文件不会删除/);
    await textPage.getByTestId('cancel-delete').click();
    assert.equal(await textPage.getByTestId('review-text-1').count(), 1);
    await textPage.evaluate(() => { window.__mock.failDelete = true; });
    await typeText('left', 'survive delete failure');
    await textPage.getByTestId('delete-text-1').click(); await textPage.getByTestId('confirm-delete').click();
    await textPage.getByRole('alert').filter({ hasText: '模拟删除失败' }).waitFor();
    await textPage.getByTestId('cancel-delete').click();
    await textPage.waitForFunction(() => window.__mock.reviews[0].left.text === 'survive delete failure');
    assert.equal(await textPage.getByTestId('draft-status-left').innerText(), '草稿已缓存');
    await textPage.evaluate(() => { window.__mock.failDelete = false; window.__mock.updateDelay = 800; });
    await typeText('right', 'pending deletion draft');
    await textPage.waitForFunction(() => window.__mock.activeUpdates > 0);
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
    await textPage.getByTestId('delete-text-2').click(); await textPage.getByTestId('confirm-delete').click();
    await textPage.getByTestId('empty-new-text').waitFor();
    await textPage.waitForTimeout(600);
    assert.equal(await textPage.evaluate(() => window.__mock.reviews.length), 0);
    assert.equal(await textPage.evaluate(() => window.__mock.textCount), 2);
    assert.deepEqual(pageErrors, []);
    console.log('Renderer smoke passed: blank editable text, chunk transfer, cached switching, Save As cancellation/preview, modal exclusion, close/reopen restoration, delete cancellation/in-flight settlement/cache failure, no ghost callbacks; chunks, frozen preview, no implicit commit, local draft event merge, shared/pair locking, close flush, conflict recovery.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
