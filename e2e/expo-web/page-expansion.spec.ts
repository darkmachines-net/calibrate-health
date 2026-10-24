/** @file Regression coverage for page expansion: Food log expands below the date and restores its source, scroll and focus. */

import { expect, FROZEN_NOW, hideTransientPwaNotices, test } from './fixtures';
import { expectNoBlockingAccessibilityViolations } from './ux-a11y';
import { PLAN_CHECK_RECOMMENDATION_STATUS } from './plan-check.fixture';
import { applyTwoHundredPercentText } from './text-scaling';

// Animated.timing reads Date.now; a per-read fixture clock speeds it up with unrelated query work.
async function useElapsedAnimationClock(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const epoch = Date.now();
    const start = performance.now();
    Object.defineProperty(Date, 'now', {
      configurable: true,
      value: () => epoch + Math.floor(performance.now() - start),
    });
  });
}

async function expectLabeledBackHeader(pane: import('@playwright/test').Locator, title: string, backLabel: string) {
  const back = pane.getByRole('button', { name: backLabel, exact: true });
  await expect(back.getByText(backLabel, { exact: true })).toBeVisible();
  const heading = pane.getByRole('heading', { name: title, exact: true });
  const backBox = (await back.boundingBox())!;
  const headingBox = (await heading.boundingBox())!;
  const paneBox = (await pane.boundingBox())!;
  expect(backBox.height).toBeGreaterThanOrEqual(48);
  expect(backBox.y + backBox.height).toBeLessThanOrEqual(headingBox.y + 1);
  expect(backBox.x).toBeLessThanOrEqual(headingBox.x);
  expect(backBox.x + backBox.width / 2).toBeLessThan(paneBox.x + paneBox.width / 2);
}

test('Food log expands below the date and restores its source, scroll and focus', async ({ page, ux }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await ux.install('populated', { foodDayStatus: 'OPEN' });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const source = page.getByTestId('today-food-preview');
  const date = page.getByRole('toolbar', { name: 'Food log date' });
  const before = await source.boundingBox();
  const dateBefore = await date.boundingBox();
  await page.screenshot({ path: testInfo.outputPath('food-overview.png') });
  await source.click();
  const pane = page.getByTestId('expanded-food');
  await expect(pane).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Today' })).toBeFocused();
  await expectLabeledBackHeader(pane, 'Food log', 'Back to Today');
  const viewport = (await page.getByTestId('page-expansion-viewport').boundingBox())!;
  const bounds = (await pane.boundingBox())!;
  expect(Math.abs(bounds.y - viewport.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.height - viewport.height)).toBeLessThanOrEqual(1);
  expect(await date.boundingBox()).toEqual(dateBefore);
  await expect(page).toHaveURL(url => url.pathname === '/today');
  await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toHaveCount(0);
  await expect(pane.getByText('Fixture breakfast', { exact: true })).toBeVisible();
  await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'probe', surfaceId: 'expanded-food' });
  await page.screenshot({ path: testInfo.outputPath('food-expanded.png') });
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  await expect(page.getByTestId('adaptive-dialog-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(pane).toBeVisible();
  await page.getByRole('button', { name: 'Back to Today' }).click();
  await expect(pane).toHaveCount(0);
  expect(await source.boundingBox()).toEqual(before);
  await expect(source).toBeFocused();
});

test('Progress expansions use the whole pane and return a scrolled overview', async ({ page, ux }, testInfo) => {
  if (testInfo.project.name === 'compact-phone-chrome') await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  await page.route('**/api/v1/calibration/status', route => route.fulfill({ json: PLAN_CHECK_RECOMMENDATION_STATUS }));
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  await expect(page.getByTestId('progress-snapshot-card')).toBeVisible();
  for (const [name, id, selector] of [
    ['Trend', 'trend', 'weight-trend-preview-card'],
    ['Plan check', 'plan', 'plan-check-summary']
  ]) {
    const source = page.getByTestId(selector);
    await source.scrollIntoViewIfNeeded();
    const before = await source.boundingBox();
    const scroll = await page.getByTestId('fixed-page-scroll').evaluate(el => el.scrollTop);
    const chartAppearance = async (scope: typeof source) => scope.getByTestId('weight-trend-chart').evaluate(svg => ({
      readings: svg.querySelectorAll('[data-testid="weight-trend-measurement"]').length,
      band: Array.from(svg.querySelectorAll('[data-testid^="weight-trend-range-"]')).map(el => [el.getAttribute('fill'), el.getAttribute('stroke')]),
      trend: Array.from(svg.querySelectorAll('[data-testid^="weight-trend-smoothed-path-"]')).map(el => [el.getAttribute('stroke'), el.getAttribute('stroke-width')]),
      font: getComputedStyle(svg.querySelector('text')!).fontFamily,
    }));
    const overviewChart = id === 'trend' ? await chartAppearance(source) : null;
    await page.screenshot({ path: testInfo.outputPath(`${id}-overview.png`) });
    await source.click();
    const pane = page.getByTestId(`expanded-${id}`);
    await expect(page.getByRole('button', { name: 'Back to Progress' })).toBeFocused();
    await expectLabeledBackHeader(pane, name, 'Back to Progress');
    const viewport = (await page.getByTestId('page-expansion-viewport').boundingBox())!;
    const bounds = (await pane.boundingBox())!;
    expect(Math.abs(bounds.y - viewport.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.height - viewport.height)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('app-header-title')).toHaveText('Progress');
    if (id === 'trend') {
      await expect(pane.getByTestId('selected-trend-summary')).toBeVisible();
      expect(await chartAppearance(pane)).toEqual(overviewChart);
      await expect(pane.getByLabel('Chart legend', { exact: true })).toBeVisible();
    }
    else await expect(pane.getByRole('button', { name: 'Review suggested 1,750 calorie daily target' })).toBeAttached();
    await page.screenshot({ path: testInfo.outputPath(`${id}-expanded.png`) });
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'probe', surfaceId: `expanded-${id}` });
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    expect(await source.boundingBox()).toEqual(before);
    expect(await page.getByTestId('fixed-page-scroll').evaluate(el => el.scrollTop)).toEqual(scroll);
    await expect(source).toBeFocused();
  }
});

for (const section of [
  { route: '/today', name: 'Food log', backLabel: 'Back to Today', id: 'food', source: 'today-food-preview', above: 'calorie-balance-hero', below: null },
  { route: '/progress', name: 'Trend', backLabel: 'Back to Progress', id: 'trend', source: 'weight-trend-preview-card', above: 'progress-snapshot-card', below: 'plan-check-summary' },
  { route: '/progress', name: 'Plan check', backLabel: 'Back to Progress', id: 'plan', source: 'plan-check-summary', above: 'progress-snapshot-card', below: null },
]) {
  test(`${section.name} collapse shrinks back on every expansion cycle`, async ({ page, ux }, testInfo) => {
    test.skip(!['desktop-chrome', 'android-phone-chrome'].includes(testInfo.project.name), 'Measure repeated mouse and touch motion.');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await ux.install('populated');
    await page.route('**/api/v1/calibration/status', route => route.fulfill({ json: PLAN_CHECK_RECOMMENDATION_STATUS }));
    await page.goto(section.route);
    await hideTransientPwaNotices(page);
    await useElapsedAnimationClock(page);
    const source = page.getByTestId(section.source);
    await expect(source).toBeVisible();
    await source.scrollIntoViewIfNeeded();
    const before = await source.boundingBox();
    const sample = (selector: string) => page.locator(selector).evaluate((button, section) => new Promise<Array<{ top: number; height: number; above: number; below: number; opacity: number }>>(resolve => {
      const frames: Array<{ top: number; height: number; above: number; below: number; opacity: number }> = [];
      const start = performance.now();
      (button as HTMLElement).click();
      const capture = () => {
        const pane = document.querySelector(`[data-testid="expanded-${section.id}"]`);
        if (pane) {
          const bounds = pane.getBoundingClientRect();
          frames.push({
            top: bounds.y, height: bounds.height,
            above: document.querySelector(`[data-testid="${section.above}"]`)!.getBoundingClientRect().y,
            below: section.below ? document.querySelector(`[data-testid="${section.below}"]`)!.getBoundingClientRect().y : 0,
            opacity: Number(getComputedStyle(pane).opacity),
          });
        }
        if (performance.now() - start < 750) requestAnimationFrame(capture);
        else resolve(frames);
      };
      requestAnimationFrame(capture);
    }), section);
    for (let cycle = 1; cycle <= 3; cycle++) {
      await test.step(`Expansion/collapse cycle ${cycle}`, async () => {
        const opening = await sample(`[data-testid="${section.source}"]`);
        await expect(page.getByRole('button', { name: section.backLabel })).toBeFocused();
        const closing = await sample(`[aria-label="${section.backLabel}"]`);
        await testInfo.attach(`${section.id}-animation-cycle-${cycle}`, { body: JSON.stringify({ opening, closing }), contentType: 'application/json' });
        const fields = ['top', 'height', 'above', 'opacity'] as const;
        for (const frames of [opening, closing]) {
          for (const field of fields) {
            expect(new Set(frames.map(frame => Math.round(frame[field] * 100))).size, field).toBeGreaterThan(3);
          }
        }
        expect(closing.at(-1)!.top).toBeGreaterThan(closing[0].top);
        expect(closing.at(-1)!.height).toBeLessThan(closing[0].height);
        expect(closing.at(-1)!.above).toBeGreaterThan(closing[0].above);
        if (section.below) {
          expect(new Set(closing.map(frame => Math.round(frame.below))).size).toBeGreaterThan(3);
          expect(closing.at(-1)!.below).toBeLessThan(closing[0].below);
        }
        await expect(page.getByTestId(`expanded-${section.id}`)).toHaveCount(0);
        expect(await source.boundingBox()).toEqual(before);
        await expect(source).toBeFocused();
      });
    }
  });
}

for (const foodDayStatus of ['OPEN', 'COMPLETE'] as const) {
  test(`real motion keeps the ${foodDayStatus} day dock anchored while Add food expands`, async ({ page, ux }, testInfo) => {
    test.skip(!['desktop-chrome', 'android-phone-chrome'].includes(testInfo.project.name), 'Cover mouse and touch dock motion.');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await ux.install('populated', { foodDayStatus });
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    await useElapsedAnimationClock(page);
    const source = page.getByTestId('today-food-preview');
    await expect(source).toBeVisible();
    const dayActionLabel = foodDayStatus === 'COMPLETE' ? 'Day completed' : 'Complete day';
    const sample = async (selector: string) => page.locator(selector).evaluate((button, dayActionLabel) => new Promise<Array<{ top: number; height: number; above: number; dockY: number; addX: number; addY: number; addWidth: number; completeX: number; addCount: number }>>(resolve => {
      const frames: Array<{ top: number; height: number; above: number; dockY: number; addX: number; addY: number; addWidth: number; completeX: number; addCount: number }> = [];
      const start = performance.now();
      (button as HTMLElement).click();
      const capture = () => {
        const pane = document.querySelector('[data-testid="expanded-food"]')?.getBoundingClientRect();
        const above = document.querySelector('[data-testid="calorie-balance-hero"]')!.getBoundingClientRect().y;
        const dockY = document.querySelector('[data-testid="today-action-dock"]')!.getBoundingClientRect().y;
        const addButtons = document.querySelectorAll('[aria-label="Add food"]');
        const add = addButtons[0].getBoundingClientRect();
        const complete = document.querySelector(`[aria-label="${dayActionLabel}"]`)!.getBoundingClientRect();
        if (pane) frames.push({ top: pane.y, height: pane.height, above, dockY, addX: add.x, addY: add.y, addWidth: add.width, completeX: complete.x, addCount: addButtons.length });
        if (performance.now() - start < 650) requestAnimationFrame(capture);
        else resolve(frames);
      };
      requestAnimationFrame(capture);
    }), dayActionLabel);
    const opening = await sample('[data-testid="today-food-preview"]');
    for (const field of ['top', 'height', 'above', 'addWidth', 'completeX'] as const) {
      expect(new Set(opening.map(frame => Math.round(frame[field]))).size).toBeGreaterThan(3);
    }
    expect(opening.at(-1)!.top).toBeLessThan(opening[0].top);
    expect(opening.at(-1)!.height).toBeGreaterThan(opening[0].height);
    expect(opening.at(-1)!.above).toBeLessThan(opening[0].above);
    expect(opening.at(-1)!.addWidth).toBeGreaterThan(opening[0].addWidth);
    expect(opening.at(-1)!.completeX).toBeGreaterThan(opening[0].completeX);
    const dock = (await page.getByTestId('food-log-dock-actions').boundingBox())!;
    expect(opening.at(-1)!.addWidth).toBeCloseTo(dock.width, 0);
    expect(opening.at(-1)!.completeX).toBeGreaterThanOrEqual(dock.x + dock.width);
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toContainText('Add food');
    const closing = await sample('[aria-label="Back to Today"]');
    expect(new Set(closing.map(frame => Math.round(frame.top))).size).toBeGreaterThan(3);
    expect(closing.at(-1)!.top).toBeGreaterThan(closing[0].top);
    expect(closing.at(-1)!.addWidth).toBeLessThan(closing[0].addWidth);
    expect(closing.at(-1)!.completeX).toBeLessThan(closing[0].completeX);
    for (const frame of [...opening, ...closing]) {
      expect(frame.addCount).toBe(1);
      for (const field of ['dockY', 'addX', 'addY'] as const) {
        expect(Math.abs(frame[field] - opening[0][field]), field + ' remains anchored').toBeLessThanOrEqual(1);
      }
    }
    await expect(page.getByRole('button', { name: dayActionLabel, exact: true })).toBeVisible();
    await expect(page.getByTestId('expanded-food')).toHaveCount(0);
    await expect(source).toBeFocused();
    await testInfo.attach('expansion-animation-frames', { body: JSON.stringify({ opening, closing }), contentType: 'application/json' });
  });
}

test('weight slides beneath the date header without clipping at its old body boundary', async ({ page, ux }, testInfo) => {
  test.skip(!['desktop-chrome', 'android-phone-chrome'].includes(testInfo.project.name), 'Check contained layouts with mouse and touch.');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install({ time: new Date(FROZEN_NOW) });
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await useElapsedAnimationClock(page);
  const source = page.getByTestId('today-food-preview');
  const weight = page.getByTestId('today-weight-card');
  const collapse = page.getByRole('button', { name: 'Back to Today' });
  await expect(weight).toBeVisible();
  // Load the detail bundle and fonts before pausing time for reproducible screenshots.
  await source.click();
  await expect(page.getByTestId('expanded-food').getByText('Fixture breakfast', { exact: true })).toBeVisible();
  await expect(collapse).toBeFocused();
  await page.evaluate(() => document.fonts.ready);
  await collapse.click();
  await expect(source).toBeFocused();
  const restingWeight = (await weight.boundingBox())!;
  const viewport = (await page.getByTestId('page-expansion-viewport').boundingBox())!;
  await page.clock.pauseAt(new Date(Date.parse(FROZEN_NOW) + 60_000));

  const checkMovingWeight = async (direction: string) => {
    // Freeze an actual animation frame after the row has left its old container,
    // but before it reaches the retained date header. Bounding boxes alone miss clipping.
    let movingWeight = restingWeight;
    for (let frame = 0; frame < 40; frame++) {
      await page.clock.runFor(16);
      movingWeight = (await weight.boundingBox())!;
      if (movingWeight.y > viewport.y + 1 && movingWeight.y + movingWeight.height < restingWeight.y - 1) break;
    }
    expect(movingWeight.y).toBeGreaterThan(viewport.y + 1);
    expect(movingWeight.y + movingWeight.height).toBeLessThan(restingWeight.y - 1);
    const paintedHeight = await weight.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      let top = bounds.top;
      let bottom = bounds.bottom;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).overflowY === 'visible') continue;
        const clip = ancestor.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      return Math.max(0, bottom - top);
    });
    expect(await page.locator('[aria-label="Add food"]').evaluate(element => Boolean(element.closest('[inert]')))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`food-${direction}-weight.png`) });
    expect(paintedHeight, 'The entire weight row should remain visible until it meets the date header').toBeCloseTo(movingWeight.height, 0);
  };

  await source.click({ force: true });
  await checkMovingWeight('expanding');
  await page.clock.runFor(500);
  await expect(collapse).toBeFocused();
  await collapse.click({ force: true });
  await checkMovingWeight('collapsing');
  await page.clock.runFor(500);
  await expect(page.getByTestId('expanded-food')).toHaveCount(0);
  expect(await weight.boundingBox()).toEqual(restingWeight);
  await expect(source).toBeFocused();
});

test('expanded pages reflow after resizing and keep enlarged-text actions reachable', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'One short-screen reflow cross-cut.');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await ux.install('populated', { foodDayStatus: 'OPEN' });
  await page.route('**/api/v1/calibration/status', route => route.fulfill({ json: PLAN_CHECK_RECOMMENDATION_STATUS }));
  for (const [route, sourceId, id] of [
    ['/today', 'today-food-preview', 'food'],
    ['/progress', 'weight-trend-preview-card', 'trend'],
    ['/progress', 'plan-check-summary', 'plan']
  ]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route);
    await hideTransientPwaNotices(page);
    const source = page.getByTestId(sourceId);
    await source.click();
    const pane = page.getByTestId(`expanded-${id}`);
    const collapse = page.getByRole('button', { name: id === 'food' ? 'Back to Today' : 'Back to Progress' });
    await expect(collapse).toBeFocused();
    if (id === 'trend') await expect(pane.getByTestId('selected-trend-summary')).toBeVisible();
    if (id === 'food') await expect(pane.getByText('Fixture breakfast', { exact: true })).toBeVisible();
    if (id === 'plan') await expect(pane.getByRole('button', { name: 'Review suggested 1,750 calorie daily target' })).toBeVisible();
    await applyTwoHundredPercentText(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await expect.poll(async () => {
      const [paneBox, viewportBox] = await Promise.all([pane.boundingBox(), page.getByTestId('page-expansion-viewport').boundingBox()]);
      return Math.abs(paneBox!.height - viewportBox!.height);
    }).toBeLessThanOrEqual(1);
    await expect(collapse).toBeInViewport({ ratio: 1 });
    const lastAction = id === 'food' ? page.getByRole('button', { name: 'Add food', exact: true })
      : id === 'plan' ? pane.getByRole('button', { name: 'Review suggested 1,750 calorie daily target' })
        : pane.getByTestId('selected-trend-summary');
    await lastAction.scrollIntoViewIfNeeded();
    await expect(lastAction).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`${id}-expanded-large-text-dark.png`) });
    await collapse.click();
    await expect(pane).toHaveCount(0);
    await expect(source).toBeFocused();
    await source.click();
    await expect(collapse).toBeFocused();
    await collapse.click();
    await expect(pane).toHaveCount(0);
  }
});

test('expansion history coexists with tab navigation and repeated collapse', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One browser history cross-cut.');
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByTestId('today-food-preview').click();
    await expect(page.getByRole('button', { name: 'Back to Today' })).toBeFocused();
    await page.getByRole('button', { name: 'Back to Today' }).click();
    await expect(page.getByTestId('today-food-preview')).toBeFocused();
  }
  await page.getByTestId('today-food-preview').click();
  await expect(page.getByRole('button', { name: 'Back to Today' })).toBeFocused();
  await page.getByRole('tab', { name: 'Progress' }).click();
  await expect(page).toHaveURL(url => url.pathname === '/progress');
  await page.goBack();
  await expect(page).toHaveURL(url => url.pathname === '/today');
  await expect(page.getByTestId('expanded-food')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('expanded-food')).toHaveCount(0);
  await expect(page.getByTestId('today-food-preview')).toBeFocused();
});
