/** @file Regression coverage for adaptive forms: Add Food uses a centered wide dialog at the desktop breakpoint. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-06');

async function captureEvidence(page: Page, filename: string) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, filename),
    fullPage: false,
  });
}

async function openAddFood(page: Page) {
  await page.goto('/today');
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  const dialog = page.getByTestId('adaptive-dialog-panel');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Add food', exact: true })).toHaveCount(1);
  await expect(dialog.getByRole('heading', { name: 'Add food', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close add food', exact: true })).toBeVisible();
  return dialog;
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function enlargeLeafText(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const hasDirectText = Array.from(element.childNodes).some((node) => (
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
      ));
      if (!hasDirectText) continue;
      const computed = getComputedStyle(element);
      const fontSize = Number.parseFloat(computed.fontSize);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      if (Number.isFinite(fontSize)) element.style.fontSize = `${fontSize * 2}px`;
      if (Number.isFinite(lineHeight)) element.style.lineHeight = `${lineHeight * 2}px`;
    }
  });
}

test('Add Food uses a centered wide dialog at the desktop breakpoint', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'The centered wide-dialog contract applies only at the desktop breakpoint.');
  await page.setViewportSize({ width: 1_024, height: 1_000 });
  await ux.install('populated');
  const dialog = await openAddFood(page);
  const box = await dialog.boundingBox();

  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(790);
  expect(box!.width).toBeLessThanOrEqual(800);
  expect(Math.abs(box!.x - ((1_024 - box!.width) / 2))).toBeLessThanOrEqual(2);
  expect(box!.y).toBeGreaterThan(0);
  expect(box!.y + box!.height).toBeLessThan(1_000);
  await expectNoHorizontalOverflow(page);

  const mealTrigger = dialog.getByRole('combobox', { name: 'Select meal', exact: true });
  await mealTrigger.click();
  const dialogPanels = page.getByTestId('adaptive-dialog-panel');
  await expect(dialogPanels).toHaveCount(2);
  await expect.poll(() => dialogPanels.last().evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialogPanels).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Add food', exact: true })).toHaveCount(1);
  await expect(mealTrigger).toBeFocused();

  await captureEvidence(page, 'add-food-desktop-1024x1000.png');
});

test('Add Food uses a phone sheet, reflows at 200% text, and guards dirty dismissal', async ({ page, ux }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  const dialog = await openAddFood(page);
  const box = await dialog.boundingBox();

  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeLessThanOrEqual(320);
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(567);

  await dialog.getByRole('radio', { name: 'Quick', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Calories', exact: true }).fill('240');
  page.once('dialog', async (confirmation) => confirmation.dismiss());
  await dialog.getByRole('button', { name: 'Close add food', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Add food', exact: true })).toHaveCount(1);

  await enlargeLeafText(page);
  await expectNoHorizontalOverflow(page);
  await expect(dialog.getByRole('button', { name: 'Add & close', exact: true })).toBeVisible();

  await captureEvidence(page, 'add-food-phone-320x568-200-percent-text.png');
});
