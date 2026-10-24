/** @file Regression coverage for tablet layout. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';

for (const viewport of [{ width: 820, height: 1180 }, { width: 1180, height: 820 }]) {
  test(`tablet Add Food stays bounded at ${viewport.width}x${viewport.height}`, async ({ page, ux }, testInfo) => {
    test.skip(testInfo.project.name !== 'tablet-chrome', 'Tablet portrait and landscape evidence.');
    await page.setViewportSize(viewport);
    await ux.install('populated');
    await page.goto('/today');
    await page.getByRole('button', { name: 'Add food', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add food', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Quick', exact: true })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Search', exact: true })).toBeVisible();
    const panel = await page.getByTestId('adaptive-dialog-panel').boundingBox();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThan(0);
    expect(panel!.y).toBeGreaterThan(0);
    expect(panel!.width).toBeLessThanOrEqual(800);
    expect(panel!.x + panel!.width).toBeLessThan(viewport.width);
    expect(panel!.y + panel!.height).toBeLessThan(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(viewport.width);
    if (process.env.CALIBRATE_CAPTURE_EVIDENCE === '1') {
      const directory = path.resolve('.codex-screenshots/stack-review');
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `367-tablet-${viewport.width}x${viewport.height}.png`) });
    }
  });
}
