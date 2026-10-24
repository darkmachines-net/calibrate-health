/** @file Captures synthetic calibration-lab UI evidence into disposable local screenshot output. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const CAPTURE_ENABLED = process.env.CALIBRATE_CAPTURE_SCREENSHOTS === '1';
const LAB_URL = process.env.CALIBRATE_CALIBRATION_LAB_URL?.trim() || 'http://127.0.0.1:5173';
const OUTPUT_DIRECTORY = path.resolve('.codex-screenshots/plan-check');
const VIEWPORT = { width: 1440, height: 1100 };
const COMPACT_VIEWPORT = { width: 390, height: 844 };
const ACTION_SCENARIO_ID = 'target-too-high';

if (!CAPTURE_ENABLED) {
  throw new Error(
    'Set CALIBRATE_CAPTURE_SCREENSHOTS=1 to replace the reviewed Calibration lab evidence.',
  );
}

const scenarioResponse = await fetch(new URL('/api/scenarios', LAB_URL));
if (!scenarioResponse.ok) {
  throw new Error('Calibration lab returned ' + scenarioResponse.status + ' for /api/scenarios.');
}

const scenarios = await scenarioResponse.json();
if (!Array.isArray(scenarios) || scenarios.length === 0) {
  throw new Error('Calibration lab returned no screenshot scenarios.');
}

await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    viewport: VIEWPORT,
  });
  const page = await context.newPage();

  for (const [index, scenario] of scenarios.entries()) {
    if (!scenario || typeof scenario.id !== 'string' || typeof scenario.name !== 'string') {
      throw new Error('Scenario ' + (index + 1) + ' is missing a stable id or name.');
    }

    const scenarioUrl = new URL('/', LAB_URL);
    scenarioUrl.searchParams.set('scenario', scenario.id);
    await page.goto(scenarioUrl.href, { waitUntil: 'networkidle' });
    await page.locator('.preview-state', { hasText: 'Live preview' }).waitFor();
    await page.getByText('Plan check', { exact: true }).waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.addStyleTag({
      content: [
        '.workspace { display: none !important; }',
        'main { padding-bottom: 28px !important; }',
        '* { caret-color: transparent !important; }',
      ].join('\n'),
    });

    const sequence = String(index + 1).padStart(2, '0');
    const filename = sequence + '-' + scenario.id + '.png';
    await page.locator('main').screenshot({
      animations: 'disabled',
      path: path.join(OUTPUT_DIRECTORY, filename),
    });
    process.stdout.write('Captured ' + filename + ': ' + scenario.name + '\n');

    if (scenario.id === ACTION_SCENARIO_ID) {
      await page.getByText('Review adjustment', { exact: true }).click();
      await page.getByText('Review calorie target', { exact: true }).waitFor();
      const reviewFilename = '20-adjustment-review.png';
      await page.screenshot({
        animations: 'disabled',
        path: path.join(OUTPUT_DIRECTORY, reviewFilename),
      });
      process.stdout.write('Captured ' + reviewFilename + ': desktop adjustment review\n');
    }
  }

  const actionScenario = scenarios.find((scenario) => scenario?.id === ACTION_SCENARIO_ID);
  if (!actionScenario) {
    throw new Error('Calibration lab is missing the action scenario used for responsive evidence.');
  }
  await page.setViewportSize(COMPACT_VIEWPORT);
  const compactUrl = new URL('/', LAB_URL);
  compactUrl.searchParams.set('scenario', actionScenario.id);
  await page.goto(compactUrl.href, { waitUntil: 'networkidle' });
  await page.locator('.preview-state', { hasText: 'Live preview' }).waitFor();
  await page.getByText('Plan check', { exact: true }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content: [
      'header, .preview-heading, .workspace { display: none !important; }',
      'main, .preview-panel, .product-preview { padding: 0 !important; margin: 0 !important; }',
      '* { caret-color: transparent !important; }',
    ].join('\n'),
  });
  const compactFilename = '21-target-too-high-compact.png';
  await page.locator('.product-preview').screenshot({
    animations: 'disabled',
    path: path.join(OUTPUT_DIRECTORY, compactFilename),
  });
  process.stdout.write('Captured ' + compactFilename + ': compact actionable card\n');

  await page.getByText('Review adjustment', { exact: true }).click();
  await page.getByText('Review calorie target', { exact: true }).waitFor();
  const compactReviewFilename = '22-adjustment-review-compact.png';
  await page.screenshot({
    animations: 'disabled',
    path: path.join(OUTPUT_DIRECTORY, compactReviewFilename),
  });
  process.stdout.write('Captured ' + compactReviewFilename + ': compact adjustment review\n');

  await page.setViewportSize({ width: 320, height: COMPACT_VIEWPORT.height });
  const waitingUrl = new URL('/', LAB_URL);
  waitingUrl.searchParams.set('scenario', 'not-ready');
  await page.goto(waitingUrl.href, { waitUntil: 'networkidle' });
  await page.locator('.preview-state', { hasText: 'Live preview' }).waitFor();
  await page.getByText('Not enough history for a reliable plan check', { exact: true }).waitFor();
  await page.addStyleTag({
    content: [
      'header, .preview-heading, .workspace { display: none !important; }',
      'main, .preview-panel, .product-preview { padding: 0 !important; margin: 0 !important; }',
    ].join('\n'),
  });
  const waitingFilename = '23-waiting-narrow.png';
  await page.locator('.product-preview').screenshot({
    animations: 'disabled',
    path: path.join(OUTPUT_DIRECTORY, waitingFilename),
  });
  const overflows = await page.locator('[data-testid="plan-check-waiting"]').evaluate((panel) =>
    Array.from(panel.querySelectorAll('*')).some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right > window.innerWidth + 1 || rect.left < -1;
    }),
  );
  if (overflows) throw new Error('Waiting card content overflows the 320px viewport.');
  process.stdout.write('Captured ' + waitingFilename + ': narrow waiting card\n');

  await context.close();
} finally {
  await browser.close();
}

process.stdout.write(
  'Captured ' + scenarios.length + ' Plan check scenarios plus desktop and compact review evidence in ' +
    OUTPUT_DIRECTORY + '.\n',
);
