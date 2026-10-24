/** @file Regression coverage for launch 21 performance budgets: Launch 21 route and Core Web Vitals budgets. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const manifest = JSON.parse(readFileSync(path.resolve('quality/performance-budgets.json'), 'utf8')) as {
  limits: {
    largest_contentful_paint_ms: number;
    cumulative_layout_shift: number;
    interaction_to_next_paint_ms: number;
  };
};

type BrowserVitals = { cls: number; inp: number; lcp: number };

async function installVitalObservers(page: Page) {
  await page.addInitScript(() => {
    const vitals = { cls: 0, inp: 0, lcp: 0 };
    let clsSessionValue = 0;
    let clsSessionStart = 0;
    let clsSessionLast = 0;
    const interactionDurations = new Map<number, number>();
    Object.defineProperty(window, '__calibrateLaunch21Vitals', { value: vitals, configurable: true });
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const latest = entries.at(-1);
      if (latest) vitals.lcp = latest.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (shift.hadRecentInput) continue;
        const startsNewSession = clsSessionValue === 0
          || entry.startTime - clsSessionLast >= 1_000
          || entry.startTime - clsSessionStart >= 5_000;
        if (startsNewSession) {
          clsSessionValue = shift.value ?? 0;
          clsSessionStart = entry.startTime;
        } else {
          clsSessionValue += shift.value ?? 0;
        }
        clsSessionLast = entry.startTime;
        vitals.cls = Math.max(vitals.cls, clsSessionValue);
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const event = entry as PerformanceEntry & { duration: number; interactionId?: number };
        const interactionId = event.interactionId ?? 0;
        if (interactionId > 0) {
          interactionDurations.set(interactionId, Math.max(interactionDurations.get(interactionId) ?? 0, event.duration));
        }
      }
      const descending = [...interactionDurations.values()].sort((left, right) => right - left);
      if (descending.length > 0) vitals.inp = descending[Math.min(descending.length - 1, Math.floor(descending.length / 50))];
    }).observe({ type: 'event', buffered: true, durationThreshold: 0 } as PerformanceObserverInit);
  });
}

async function settleRoute(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[role="main"]:visible').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForTimeout(150);
}

async function readVitals(page: Page): Promise<BrowserVitals> {
  return page.evaluate(() => (
    window as typeof window & { __calibrateLaunch21Vitals: BrowserVitals }
  ).__calibrateLaunch21Vitals);
}

async function installAuthenticatedPerformanceApis(page: Page) {
  await page.route('**/api/v1/client-diagnostics', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, request_id: '33333333-3333-4333-8333-333333333333' }),
  }));
  await page.route('**/auth/sessions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      sessions: [{
        id: 'browser_11111111-1111-4111-8111-111111111111',
        kind: 'browser',
        device_label: null,
        created_at: '2026-07-20T10:00:00.000Z',
        last_activity_at: '2026-07-21T19:00:00.000Z',
        current: true,
      }],
    }),
  }));
}

async function expectRouteBudgets(page: Page, route: string) {
  await settleRoute(page);
  const vitals = await readVitals(page);
  expect(vitals.lcp, `${route} must produce an LCP entry`).toBeGreaterThan(0);
  expect(vitals.lcp, `${route} LCP`).toBeLessThanOrEqual(manifest.limits.largest_contentful_paint_ms);
  expect(vitals.cls, `${route} CLS`).toBeLessThanOrEqual(manifest.limits.cumulative_layout_shift);
}

test.describe('Launch 21 route and Core Web Vitals budgets', () => {
  // Measuring two cold navigations concurrently turns runner CPU contention into synthetic LCP.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chrome',
      'One deterministic desktop Chromium profile owns the CWV diagnostic.',
    );
    await installVitalObservers(page);
  });

  test('public entry and authentication interaction stay within LCP, CLS, and INP ceilings', async ({ page, ux }) => {
    await ux.install('signed-out');
    await page.goto('/');
    await expectRouteBudgets(page, '/');

    await page.goto('/login');
    await expectRouteBudgets(page, '/login');
    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    await email.click();
    await email.pressSequentially('a');
    await expect.poll(async () => (await readVitals(page)).inp).toBeGreaterThan(0);
    expect((await readVitals(page)).inp, '/login INP').toBeLessThanOrEqual(
      manifest.limits.interaction_to_next_paint_ms,
    );
  });

  test('authenticated representative routes stay within LCP and CLS ceilings', async ({ page, ux }) => {
    await ux.install('populated');
    await installAuthenticatedPerformanceApis(page);
    for (const route of ['/today', '/progress', '/settings']) {
      await page.goto(route);
      await expectRouteBudgets(page, route);
    }
  });
});

declare global {
  interface Window {
    __calibrateLaunch21Vitals: BrowserVitals;
  }
}
