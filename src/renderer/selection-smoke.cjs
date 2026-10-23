const assert = require('node:assert/strict');

// Read rendered pixels, not just CSS: opaque diff decorations used to hide selections.
async function pixels(page, points, path, source) {
  const png = source || await page.screenshot(path ? { path } : {});
  return page.evaluate(async ({ data, points }) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return points.map(({ x, y }) => [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3));
  }, { data: png.toString('base64'), points });
}

async function checkSelectionEdges(page, editor, baseline, side, state, alpha) {
  await editor.locator('.cslr.selected-text').first().waitFor();
  const points = await editor.evaluate(el => {
    const clip = el.querySelector('.monaco-scrollable-element').getBoundingClientRect();
    return [...el.querySelectorAll('.cslr.selected-text')].flatMap(element => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right - 8);
      if (right - left < 3 || rect.y < clip.top || rect.bottom > clip.bottom - 8) return [];
      // Both ends and the middle of each strip, above/below glyphs. This catches
      // Monaco's white reverse-corner masks as well as hidden blue selection edges.
      return [rect.y + 1, rect.bottom - 2].flatMap(y =>
        [left + 1, (left + right) / 2, right - 2].map(x => ({ x, y })));
    });
  });
  assert.ok(points.length > 12, `${side} ${state}: exercise a multiline selection`);
  const before = await pixels(page, points, undefined, baseline), actual = await pixels(page, points);
  for (let i = 0; i < points.length; i++) {
    const expected = before[i].map((value, channel) => Math.round(value * (1 - alpha) + [75, 155, 232][channel] * alpha));
    assert.ok(actual[i].every((value, channel) => Math.abs(value - expected[channel]) <= 2),
      `${side} ${state} edge ${i} at ${JSON.stringify(points[i])}: ${actual[i]} should blend with ${before[i]} (expected ${expected})`);
  }
  assert.equal(await editor.locator('.cslr.monaco-editor-background').count(), 0,
    'transparent selections must not generate opaque editor-background corner masks');
}

module.exports = async function checkSelections(page) {
  await page.addInitScript(() => {
    const review = window.__mock.reviews[0];
    review.left.text = ['共同内容 plain text', '相同开头 原来的措辞 相同结尾', '', '原稿长段落需要清楚地显示所选范围。'.repeat(8), '结束'].join('\n');
    review.right.text = ['共同内容 plain text', '相同开头 更新后的表达 相同结尾', '', '新稿长段落同样保留绿色差异背景。'.repeat(8), '结束'].join('\n');
  });
  await page.goto(process.env.DIFFEDITOR_TEST_URL || 'http://127.0.0.1:4173');
  await page.getByTestId('chunk-to-left-0').waitFor();
  // Keep caret blinking/current-line tint and delayed word matching out of the
  // before/after compositing probe; selections themselves use production CSS.
  await page.addStyleTag({ content: '.monaco-editor .current-line{background:transparent!important;border:0!important}.monaco-editor .cursors-layer{visibility:hidden!important}.monaco-editor .wordHighlightText,.monaco-editor .wordHighlight,.monaco-editor .wordHighlightStrong,.monaco-editor .selectionHighlight{background:transparent!important}' });
  for (const side of ['left', 'right']) {
    const editor = page.getByTestId(`editor-${side}`);
    await editor.click({ position: { x: 130, y: 25 } });
    await page.keyboard.press('Control+End');
    const points = await editor.evaluate((el, side) => {
      const box = el.querySelector('.view-line').getBoundingClientRect();
      const kind = side === 'left' ? 'delete' : 'insert';
      const line = el.querySelector(`.line-${kind}`).getBoundingClientRect();
      const char = [...el.querySelectorAll(`.char-${kind}`)].map(e => e.getBoundingClientRect()).find(r => r.width > 12);
      const lines = [...el.querySelectorAll('.view-line')].map(e => e.getBoundingClientRect());
      // Sample above glyphs, inside neutral, whole-line, character and wrapped-line backgrounds.
      return [{ x: box.x + 8, y: box.y + 2 }, { x: box.x + 8, y: line.y + 2 },
        { x: char.x + 6, y: char.y + 2 }, { x: box.x + 20, y: lines[4].y + 2 }];
    }, side);
    const baseline = await page.screenshot();
    const before = await pixels(page, points);
    await page.keyboard.press('Control+A');
    await editor.locator('.selected-text').first().waitFor();
    const selected = await pixels(page, points, `outputs/selection-${side}-active.png`);
    const assertBlend = (actual, alpha, state) => {
      for (let i = 0; i < before.length; i++) {
        const expected = before[i].map((value, channel) => Math.round(value * (1 - alpha) + [75, 155, 232][channel] * alpha));
        assert.ok(actual[i].every((value, channel) => Math.abs(value - expected[channel]) <= 2),
          `${side} ${state} sample ${i}: ${actual[i]} should blend blue with ${before[i]} (expected ${expected})`);
      }
      assert.notDeepEqual(actual[0], actual[1], 'selection must preserve the underlying diff tint');
    };
    assertBlend(selected, 0.4, 'focused');
    await checkSelectionEdges(page, editor, baseline, side, 'focused wrapped', 0.4);
    // The text layer must remain above the selection, including for mouse hit testing.
    assert.equal(await editor.evaluate(el => {
      const line = el.querySelector('.view-line').getBoundingClientRect();
      return !!document.elementFromPoint(line.x + 8, line.y + 10)?.closest('.view-lines');
    }), true);
    await page.getByTestId('toggle-wrap').focus();
    assertBlend(await pixels(page, points), 77 / 255, 'unfocused');
    await checkSelectionEdges(page, editor, baseline, side, 'unfocused wrapped', 77 / 255);
    await editor.click({ position: { x: 130, y: 25 } });
    await page.keyboard.press('Control+End');
    assert.deepEqual(await pixels(page, points), before, 'clearing selection restores the original diff colors');
    // Partial selection starts within the first line, crosses short/empty lines,
    // and includes the wrapped diff paragraph, producing both inward corners.
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+Shift+End');
    await checkSelectionEdges(page, editor, baseline, side, 'partial wrapped', 0.4);
    await page.getByTestId('toggle-wrap').focus();
    await checkSelectionEdges(page, editor, baseline, side, 'partial unfocused', 77 / 255);
  }
  await page.getByTestId('toggle-wrap').click();
  await page.waitForFunction(() => ['left', 'right'].every(side => document.querySelector(`[data-testid="editor-${side}"]`)?.querySelectorAll('.view-line').length === 5));
  for (const side of ['left', 'right']) {
    const editor = page.getByTestId(`editor-${side}`);
    await editor.click({ position: { x: 130, y: 25 } });
    await page.keyboard.press('Control+End');
    // Return horizontal scrolling to the start without changing text/selection.
    await page.keyboard.press('Control+Home');
    const baseline = await page.screenshot();
    await page.keyboard.press('Control+A');
    await checkSelectionEdges(page, editor, baseline, side, 'unwrapped', 0.4);
    await page.getByTestId('toggle-wrap').focus();
    await checkSelectionEdges(page, editor, baseline, side, 'unwrapped unfocused', 77 / 255);
  }
  await page.getByTestId('toggle-wrap').click();
  // Also exercise the actual mouse gesture across lines, with no text edits or save calls.
  const lines = page.getByTestId('editor-left').locator('.view-line');
  const start = await lines.nth(0).boundingBox(), end = await lines.nth(1).boundingBox();
  await page.mouse.move(start.x + 2, start.y + 10); await page.mouse.down();
  await page.mouse.move(end.x + 150, end.y + 10, { steps: 8 }); await page.mouse.up();
  assert.ok(await page.getByTestId('editor-left').locator('.selected-text').count() >= 2);
  await page.screenshot({ path: 'outputs/selection-mouse-drag.png' });
  assert.deepEqual(await page.evaluate(() => [window.__mock.updates.length, window.__mock.commits.length]), [0, 0]);
};
