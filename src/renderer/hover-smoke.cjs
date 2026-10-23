const assert = require('node:assert/strict');

module.exports = async function checkHover(page) {
  const left = page.getByTestId('chunk-to-left-0');
  const right = page.getByTestId('chunk-to-right-0');
  const box = await left.boundingBox();
  const point = { x: box.x - 60, y: box.y + 10 };
  const before = await page.evaluate(() => ({ updates: window.__mock.updates.length, commits: window.__mock.commits.length }));
  const samples = page.evaluate(async () => {
    const button = document.querySelector('[data-testid="chunk-to-left-0"]');
    const values = [], end = performance.now() + 400;
    do {
      values.push(Number(getComputedStyle(button).opacity));
      await new Promise(requestAnimationFrame);
    } while (performance.now() < end);
    return values;
  });
  await page.mouse.move(point.x, point.y);
  assert.ok((await samples).some(value => value > 0 && value < 1), 'arrow fades in instead of appearing abruptly');
  assert.equal(await left.evaluate(el => getComputedStyle(el).opacity), '1');
  assert.equal(await right.evaluate(el => getComputedStyle(el).opacity), '0');
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-left-0"]')).backgroundColor === 'rgb(228, 245, 236)');
  await page.screenshot({ path: 'outputs/hover-transfer-soft.png' });

  // A drag selection must not make transfer buttons flash or intercept the pointer.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - 50, point.y + 8, { steps: 4 });
  assert.equal(await left.evaluate(el => el.classList.contains('is-visible')), false);
  assert.equal(await left.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  await page.mouse.up();
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-left-0"]')).opacity === '1');

  // The unchanged line between the two edits is not part of either hover target.
  await page.mouse.move(point.x, box.y + 30);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-left-0"]')).opacity === '0');
  assert.equal(await page.locator('.chunk-action.is-visible').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(point.x, point.y);
  assert.equal(await left.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(20, 20);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="chunk-to-left-0"]')).opacity === '0');
  assert.deepEqual(await page.evaluate(() => ({ updates: window.__mock.updates.length, commits: window.__mock.commits.length })), before);
};
