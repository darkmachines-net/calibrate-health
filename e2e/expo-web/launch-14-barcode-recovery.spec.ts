/** @file Regression coverage for launch 14 barcode recovery: Barcode logging recovers through manual success, no result, offline, and safe provider failure. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route, TestInfo } from '@playwright/test';
import { expect, expectApiFailure, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-14');
const SELECTED_DATE = '2026-07-18';
const SELECTED_MEAL = 'DINNER';
const SUCCESS_BARCODE = '012345678905';
const NO_RESULT_BARCODE = '036000291452';
const OFFLINE_BARCODE = '5901234123457';
const PROVIDER_ERROR_BARCODE = '4006381333931';
const SUCCESS_FOOD_NAME = 'Launch Greek yogurt';
const PRIVATE_GATEWAY_TEXT = 'upstream gateway secret should stay private';
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

type BarcodeFixture = {
  lookups: string[];
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installBarcodeFixture(page: Page): Promise<BarcodeFixture> {
  const fixture: BarcodeFixture = { lookups: [] };
  await page.route('**/api/v1/food/search**', async (route) => {
    const url = new URL(route.request().url());
    const barcode = url.searchParams.get('barcode') ?? '';
    fixture.lookups.push(barcode);

    if (barcode === PROVIDER_ERROR_BARCODE) {
      return fulfillJson(route, {
        message: PRIVATE_GATEWAY_TEXT,
        code: 'BAD_GATEWAY',
        retryable: true,
        request_id: 'fixture-launch-14-provider-error',
      }, 502);
    }
    if (barcode !== SUCCESS_BARCODE) {
      return fulfillJson(route, {
        items: [],
        provider: 'openFoodFacts',
        supportsBarcodeLookup: true,
        attribution: 'Data from Open Food Facts',
      });
    }
    return fulfillJson(route, {
      items: [{
        id: 'launch-14-yogurt',
        source: 'openFoodFacts',
        description: SUCCESS_FOOD_NAME,
        brand: 'Evidence Dairy',
        barcode: SUCCESS_BARCODE,
        locale: 'en',
        availableMeasures: [{
          label: '1 container',
          gramWeight: 170,
          quantity: 1,
          unit: 'container',
        }],
        nutrientsPer100g: { calories: 59, protein: 10, fat: 0.4, carbs: 3.6 },
      }],
      provider: 'openFoodFacts',
      supportsBarcodeLookup: true,
      attribution: 'Data from Open Food Facts',
    });
  });
  return fixture;
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function expectMinimumTouchTarget(page: Page, name: string) {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  expect(box, `${name} should have a measurable touch target`).not.toBeNull();
  expect(box!.height, `${name} touch target height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${name} touch target width`).toBeGreaterThanOrEqual(44);
}

async function captureEvidence(page: Page, testInfo: TestInfo) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  const filename = testInfo.project.name === 'desktop-chrome'
    ? 'barcode-manual-success-desktop-1024x1000.png'
    : 'barcode-no-result-phone-320x568.png';
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((transientTitles) => {
    for (const notice of document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')) {
      const title = notice.querySelector('span span')?.textContent?.trim();
      if (title && transientTitles.includes(title)) notice.style.display = 'none';
    }
  }, [...TRANSIENT_PWA_TITLES]);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
}

async function openBarcodeRoute(page: Page) {
  const params = new URLSearchParams({
    date: SELECTED_DATE,
    meal: SELECTED_MEAL,
    returnTo: 'food-log',
  });
  await page.goto(`/barcode?${params}`);
  const input = page.getByLabel('EAN or UPC barcode');
  if (!(await input.isVisible())) {
    await page.getByRole('button', { name: 'Enter barcode', exact: true }).click();
  }
  await expect(input).toBeVisible();
}

async function resetToManualBarcode(page: Page) {
  await page.getByRole('button', { name: 'Scan again', exact: true }).click();
  await page.getByRole('button', { name: 'Enter barcode', exact: true }).click();
}

async function submitBarcode(page: Page, barcode: string) {
  await page.getByLabel('EAN or UPC barcode').fill(barcode);
  await page.getByRole('button', { name: 'Look up barcode', exact: true }).click();
}

test('Barcode logging recovers through manual success, no result, offline, and safe provider failure', async (
  { page, ux },
  testInfo,
) => {
  test.skip(
    !['desktop-chrome', 'compact-phone-chrome'].includes(testInfo.project.name),
    'One desktop workflow and one compact-phone frame bound the Launch 14 evidence pass.',
  );

  const isDesktop = testInfo.project.name === 'desktop-chrome';
  await page.setViewportSize(isDesktop ? { width: 1_024, height: 1_000 } : { width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const controller = await ux.install('populated', {
    foodEntriesByDate: { [SELECTED_DATE]: [] },
  });
  const barcodeFixture = await installBarcodeFixture(page);
  expectApiFailure(page, { method: 'GET', pathname: '/api/v1/food/search', status: 502 });
  await openBarcodeRoute(page);

  if (!isDesktop) {
    await submitBarcode(page, NO_RESULT_BARCODE);
    await expect(page.getByText(/No food matched this barcode/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search foods', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add manually', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try lookup again', exact: true })).toBeVisible();
    await expectMinimumTouchTarget(page, 'Search foods');
    await expectMinimumTouchTarget(page, 'Add manually');
    await expectNoHorizontalOverflow(page);
    await captureEvidence(page, testInfo);
    return;
  }

  await page.getByLabel('EAN or UPC barcode').fill(SUCCESS_BARCODE);
  await page.getByRole('button', { name: 'Look up barcode', exact: true }).evaluate((element) => {
    (element as HTMLElement).click();
    (element as HTMLElement).click();
  });
  await expect(page.getByText(`Found ${SUCCESS_FOOD_NAME}.`, { exact: true })).toBeVisible();
  expect(barcodeFixture.lookups.filter((barcode) => barcode === SUCCESS_BARCODE)).toHaveLength(1);
  await expect(page.getByText(SUCCESS_FOOD_NAME, { exact: true })).toBeVisible();
  await expect(page.getByText('Data from Open Food Facts', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Select meal' })).toContainText('Dinner');
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo);

  const foodLogRequestPromise = page.waitForRequest((request) => (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/food'
  ));
  await page.getByRole('button', { name: 'Add & close', exact: true }).click();
  const foodLogRequest = await foodLogRequestPromise;
  const payload = foodLogRequest.postDataJSON() as Record<string, unknown>;
  expect(payload).toMatchObject({
    date: SELECTED_DATE,
    meal_period: SELECTED_MEAL,
    name: SUCCESS_FOOD_NAME,
    external_source: 'openFoodFacts',
    external_id: 'launch-14-yogurt',
    brand: 'Evidence Dairy',
    locale: 'en',
    barcode: SUCCESS_BARCODE,
    measure_label: '1 container',
  });
  await expect(page).toHaveURL((url) => (
    url.pathname === '/food-log' && url.searchParams.get('date') === SELECTED_DATE
  ));

  await openBarcodeRoute(page);
  await submitBarcode(page, NO_RESULT_BARCODE);
  await expect(page.getByText(/No food matched this barcode/i)).toBeVisible();
  await page.getByRole('button', { name: 'Add manually', exact: true }).click();
  await expect(page.getByLabel('Food name')).toBeVisible();
  await expect(page.getByLabel('Calories')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Select meal' })).toContainText('Dinner');
  await page.getByRole('button', { name: 'Cancel manual entry', exact: true }).click();

  await resetToManualBarcode(page);
  await controller.activateOffline();
  await submitBarcode(page, OFFLINE_BARCODE);
  await expect(page.getByText('Connect to the internet to look up this barcode.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try lookup again', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Search foods', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add manually', exact: true })).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.getByText(/No food matched this barcode/i)).toBeVisible();

  await resetToManualBarcode(page);
  await submitBarcode(page, PROVIDER_ERROR_BARCODE);
  await expect(page.getByText('Food providers are unavailable right now. Try again in a moment.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Food providers are unavailable');
  await expect(page.getByText(PRIVATE_GATEWAY_TEXT, { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try lookup again', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Search foods', exact: true }).click();
  const addFoodDialog = page.getByRole('dialog', { name: 'Add food', exact: true });
  await expect(addFoodDialog).toBeVisible();
  await expect(addFoodDialog.getByRole('combobox', { name: 'Select meal' })).toContainText('Dinner');
  await expect(page).toHaveURL((url) => (
    url.pathname === '/food-log'
      && url.searchParams.get('date') === SELECTED_DATE
      && !url.searchParams.has('meal')
      && !url.searchParams.has('openAddFood')
  ));
});
