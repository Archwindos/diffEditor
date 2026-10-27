// Run against Vite: npx vite --host 127.0.0.1 --port 4173
// Then: node src/renderer/smoke.cjs (uses the installed Edge browser).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

async function installMock(page, pair = false, empty = false, proposal = false) {
  await page.addInitScript(({ pair, empty, proposal }) => {
    const target = (id, name) => ({ id, path: `C:\\review\\${name}.tex`, encoding: 'utf8', bom: false, exists: true, baseHash: 'old', status: 'pending' });
    const targets = pair ? [target('t1', 'left'), target('t2', 'right')] : [target('t1', 'paper')];
    const review = { id: 'r1', title: 'paper.tex', mode: pair ? 'pair' : proposal ? 'proposal' : 'single', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), left: { text: 'alpha\nbeta\ngamma\n', revision: 0, targetId: 't1' }, right: { text: 'alpha\nnew beta\ngamma\nlast', revision: 0, targetId: pair ? 't2' : 't1' }, targets };
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
      deleteClosedReviews: async ids => {
        if (state.failDelete) throw Error('模拟删除失败');
        const deleted = state.reviews.filter(r => r.closedAt && ids.includes(r.id)).map(r => r.id);
        state.deleted.push(...deleted); state.reviews = state.reviews.filter(r => !deleted.includes(r.id)); state.changed(); return deleted;
      },
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
  }, { pair, empty, proposal });
}

async function hoverTransfer(page, to, index = 0) {
  const button = page.getByTestId(`chunk-to-${to}-${index}`);
  const box = await button.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(id => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)).opacity === '1', `chunk-to-${to}-${index}`);
  return button;
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
    assert.deepEqual(await page.locator('.side-label').allTextContents(), ['原稿（左）', '新稿（右）']);
    assert.equal(await page.getByTestId('save-left').innerText(), '保存原稿');
    assert.equal(await page.getByTestId('save-right').innerText(), '保存新稿');
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
    await hoverTransfer(proposalPage, 'left'); await proposalPage.screenshot({ path: 'outputs/ai-proposal-green-arrow-ui.png' });
    await proposalPage.getByTestId('chunk-to-left-0').click();
    await proposalPage.getByTestId('save-left').click(); await proposalPage.getByTestId('save-dialog').waitFor();
    assert.match(await proposalPage.getByTestId('save-dialog').innerText(), /确认保存原稿（左）/);
    assert.equal(await proposalPage.getByTestId('preview-text').innerText(), 'alpha\nnew beta\ngamma\n');
    assert.equal(await proposalPage.evaluate(() => window.__mock.commits.length), 0);
    await proposalPage.getByTestId('cancel-save').click();
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
    console.log('Renderer smoke passed: find/replace tooltip mouse-close and Escape, transparent selections over red/green diffs, version names and AI provenance, hover-only green/red directional transfers, colored text overview painting/click/drag/wheel/folding/keyboard/retained view, settings and prior draft/save/lifecycle regressions.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
