/** @file Regression coverage for design review. */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test, hideTransientPwaNotices } from './fixtures';
import { UX_ACCESSIBILITY_ROUTE_CASES, UX_ACCESSIBILITY_OVERLAY_CASES } from './ux-matrix';
import { installAccessibilityApiExtensions, locatorForContract, waitForReadySurface } from './ux-surface-fixtures';

// Opt-in atlas for a human design pass, separate from approved regression baselines.
const outputDirectory = process.env.CALIBRATE_DESIGN_REVIEW_DIR;
test.use({ serviceWorkers: 'block' });

async function captureSurface(page: Page, testInfo: TestInfo, id: string, scheme: string) {
  // Public routes can render their static light shell before client appearance hydration.
  await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(scheme);
  const directory = path.resolve(outputDirectory!, testInfo.project.name, scheme, id);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, 'top.png'), animations: 'disabled' });
  const geometry = await page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && !element.closest('[aria-hidden="true"], [inert]');
    };
    const targets = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], input, [role="combobox"]'))
      .filter(visible).map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label') || element.textContent?.trim(), x, y, width, height };
      });
    const overflow = Array.from(document.querySelectorAll<HTMLElement>('main, [role="dialog"], [data-testid]'))
      .filter(visible).filter(element => element.scrollWidth > element.clientWidth + 2)
      .map(element => ({ name: element.getAttribute('data-testid') || element.getAttribute('aria-label') || element.tagName,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    const scrollAreas = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(element => {
      const style = getComputedStyle(element);
      return visible(element) && /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
    });
    const lengths = scrollAreas.map(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
    scrollAreas.forEach(element => { element.scrollTop = element.scrollHeight; });
    const mainBackgrounds = Array.from(document.querySelectorAll<HTMLElement>('main, [role="main"]'))
      .filter(visible).map(element => getComputedStyle(element).backgroundColor);
    return { colorScheme: document.documentElement.style.colorScheme, mainBackgrounds, targets, overflow, scrollAreas: lengths };
  });
  await page.screenshot({ path: path.join(directory, 'bottom.png'), animations: 'disabled' });
  await writeFile(path.join(directory, 'geometry.json'), JSON.stringify(geometry, null, 2));
}

if (outputDirectory) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const route of UX_ACCESSIBILITY_ROUTE_CASES) {
      test(`design route ${route.id} ${scheme}`, async ({ page, ux }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        await ux.install(route.fixtureState);
        await installAccessibilityApiExtensions(page, route.id, route.id);
        await page.goto(route.path);
        await hideTransientPwaNotices(page);
        await waitForReadySurface(page, route.ready);
        await captureSurface(page, testInfo, `route-${route.id}`, scheme);
      });
    }
    for (const overlay of UX_ACCESSIBILITY_OVERLAY_CASES) {
      test(`design overlay ${overlay.id} ${scheme}`, async ({ page, ux }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        await ux.install(overlay.fixtureState);
        await installAccessibilityApiExtensions(page, overlay.routeId, overlay.id);
        await page.goto(overlay.path);
        await hideTransientPwaNotices(page);
        for (const action of overlay.open) {
          const trigger = locatorForContract(page, action).first();
          await expect(trigger).toBeVisible();
          await trigger.click();
        }
        await waitForReadySurface(page, overlay.ready);
        await captureSurface(page, testInfo, `overlay-${overlay.id}`, scheme);
      });
    }
  }
}
