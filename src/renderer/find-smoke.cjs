const assert = require('node:assert/strict');

module.exports = async function verifyFindClose(page) {
  for (const width of [1280, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    for (const side of ['left', 'right']) for (const replace of [false, true]) {
      const editor = page.getByTestId(`editor-${side}`);
      await editor.click({ position: { x: 120, y: 120 } });
      await page.keyboard.press(replace ? 'Control+h' : 'Control+f');
      const widget = editor.locator('.find-widget.visible');
      await widget.waitFor();
      await widget.locator('.find-part textarea').fill('alpha');
      const close = widget.locator('[role="button"][aria-label^="Close"]');
      await close.hover();
      const tooltip = page.locator('.workbench-hover-container').filter({ hasText: /^Close \(Escape\)$/ });
      await tooltip.waitFor();
      const tooltipBox = await tooltip.boundingBox(), closeBox = await close.boundingBox();
      assert.ok(tooltipBox && closeBox);
      assert.ok(tooltipBox.y + tooltipBox.height <= closeBox.y + 1, 'close tooltip must stay above its button');
      assert.equal(await close.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), true, 'the close button must receive the mouse click after its tooltip appears');
      if (width === 1000 && side === 'right' && replace) await page.screenshot({ path: 'outputs/find-close-tooltip-ui.png' });
      await close.click();
      await widget.waitFor({ state: 'hidden' });
    }
  }
  const editor = page.getByTestId('editor-right');
  await editor.click({ position: { x: 120, y: 120 } });
  await page.keyboard.press('Control+f');
  await editor.locator('.find-widget.visible').waitFor();
  await page.keyboard.press('Escape');
  await editor.locator('.find-widget.visible').waitFor({ state: 'hidden' });
};
