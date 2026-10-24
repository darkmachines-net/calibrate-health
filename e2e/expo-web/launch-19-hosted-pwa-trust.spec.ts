/** @file Regression coverage for launch 19 hosted pwa trust: failed update remains dismissible and leaves app navigation reachable. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, expectApiFailure, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-19');
const LANDING_TITLE = 'Calibrate - Private calorie tracking';
const LANDING_DESCRIPTION = 'Track food, weight, activity, and goals with a private Calibrate account or your own compatible server.';
const PRIVACY_DESCRIPTION = 'Learn how Calibrate handles account, food, weight, activity, and technical information.';
const USER_CACHE_PREFIX = 'calibrate-expo-web-user-';
const SHELL_CACHE_PREFIX = 'calibrate-expo-web-shell-';

type MetadataExpectation = {
  title: string;
  description: string;
  canonicalPath: string | null;
  robots: 'index, follow' | 'noindex, nofollow';
};

async function expectRouteMetadata(page: Page, expected: MetadataExpectation) {
  await expect(page).toHaveTitle(expected.title);
  const descriptions = page.locator('meta[name="description"]');
  const robots = page.locator('meta[name="robots"]');
  await expect(descriptions).toHaveCount(1);
  await expect(descriptions).toHaveAttribute('content', expected.description);
  await expect(robots).toHaveCount(1);
  await expect(robots).toHaveAttribute('content', expected.robots);

  const canonical = page.locator('link[rel="canonical"]');
  if (expected.canonicalPath === null) {
    await expect(canonical).toHaveCount(0);
  } else {
    await expect(canonical).toHaveCount(1);
    const href = await canonical.getAttribute('href');
    expect(href).not.toBeNull();
    const canonicalUrl = new URL(href!, page.url());
    expect(canonicalUrl.origin).toBe(new URL(page.url()).origin);
    expect(canonicalUrl.pathname).toBe(expected.canonicalPath);
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.bodyWidth).toBeLessThanOrEqual(widths.clientWidth);
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function expectAxeStyleAccessibilityBaseline(page: Page) {
  const audit = await page.evaluate(() => {
    const visible = (element: Element) => {
      const node = element as HTMLElement;
      const style = getComputedStyle(node);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && !node.closest('[aria-hidden="true"]')
        && node.getClientRects().length > 0;
    };
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id]')).map((element) => element.id);
    const headings = Array.from(document.querySelectorAll<HTMLElement>(
      'h1, h2, h3, h4, h5, h6, [role="heading"]',
    )).filter(visible).map((heading) => {
      const nativeLevel = /^H([1-6])$/.exec(heading.tagName)?.[1];
      return Number(heading.getAttribute('aria-level') ?? nativeLevel ?? 0);
    }).filter((level) => level > 0);
    const unnamedInteractive = Array.from(document.querySelectorAll<HTMLElement>(
      'a[href], button, [role="button"], [role="link"]',
    )).filter(visible).filter((element) => !(
      element.getAttribute('aria-label')?.trim()
      || element.getAttribute('aria-labelledby')?.trim()
      || element.textContent?.trim()
      || element.getAttribute('title')?.trim()
    ));
    const headingSkips = headings.slice(1).filter((level, index) => level > headings[index] + 1);
    return {
      duplicateIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
      headingSkips,
      htmlLang: document.documentElement.lang,
      imageWithoutAltCount: Array.from(document.querySelectorAll('img')).filter((image) => !image.hasAttribute('alt')).length,
      mainCount: Array.from(document.querySelectorAll('[role="main"], main')).filter(visible).length,
      unnamedInteractiveCount: unnamedInteractive.length,
      visibleHeadingLevels: headings,
    };
  });

  expect(audit.htmlLang).toBe('en');
  expect(audit.duplicateIds).toEqual([]);
  expect(audit.headingSkips).toEqual([]);
  expect(audit.imageWithoutAltCount).toBe(0);
  expect(audit.mainCount).toBe(1);
  expect(audit.unnamedInteractiveCount).toBe(0);
  expect(audit.visibleHeadingLevels[0]).toBe(1);
}

async function expectManifestContract(page: Page) {
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    if (!response.ok) throw new Error(`Manifest returned ${response.status}.`);
    return response.json();
  }) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
    shortcuts: Array<{ name: string; url: string }>;
  };
  expect(manifest).toMatchObject({
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
  });
  await expect(page.locator('meta[name^="apple-mobile-web-app-"]')).toHaveCount(0);
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: './calibrate-icon-192.png', sizes: '192x192', purpose: 'any' }),
    expect.objectContaining({ src: './calibrate-icon-512.png', sizes: '512x512', purpose: 'any' }),
    expect.objectContaining({ src: './calibrate-icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' }),
  ]));
  expect(manifest.shortcuts).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Today', url: './today' }),
    expect.objectContaining({ name: 'Log food', url: './food-log' }),
    expect.objectContaining({ name: 'Log weight', url: './weight' }),
  ]));

  for (const icon of manifest.icons.filter(({ sizes }) => sizes !== 'any')) {
    const response = await page.request.get(new URL(icon.src, `${new URL(page.url()).origin}/manifest.webmanifest`).href);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/');
  }
}

async function installSettingsSessionsFixture(page: Page) {
  await page.route('**/auth/sessions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [] }),
  }));
}

async function installInstalledUpdateFixture(page: Page, registrationFails = false) {
  await page.addInitScript((failRegistration) => {
    const updateFoundListeners = new Set<() => void>();
    const controllerChangeListeners = new Set<() => void>();
    const workerStateListeners = new Set<() => void>();
    let lastWorkerMessage: unknown = null;
    const worker = {
      state: 'installed',
      postMessage(message: unknown) { lastWorkerMessage = message; },
      addEventListener(type: string, listener: () => void) {
        if (type === 'statechange') workerStateListeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === 'statechange') workerStateListeners.delete(listener);
      },
    };
    const registration = {
      waiting: null as typeof worker | null,
      installing: null as typeof worker | null,
      async update() {},
      addEventListener(type: string, listener: () => void) {
        if (type === 'updatefound') updateFoundListeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === 'updatefound') updateFoundListeners.delete(listener);
      },
    };
    const container = {
      controller: worker,
      async register() {
        if (failRegistration) throw new Error('Fixture update registration failed');
        return registration;
      },
      addEventListener(type: string, listener: () => void) {
        if (type === 'controllerchange') controllerChangeListeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === 'controllerchange') controllerChangeListeners.delete(listener);
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });

    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => {
      if (query !== '(display-mode: standalone)') return nativeMatchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => true,
      } as MediaQueryList;
    }) as typeof window.matchMedia;

    Object.defineProperty(window, '__launch19PwaFixture', {
      configurable: true,
      value: {
        showUpdate() {
          registration.installing = worker;
          updateFoundListeners.forEach((listener) => listener());
          workerStateListeners.forEach((listener) => listener());
        },
        getLastWorkerMessage: () => lastWorkerMessage,
      },
    });
  }, registrationFails);
}

test('failed update remains dismissible and leaves app navigation reachable', async ({ page, ux }) => {
  await installInstalledUpdateFixture(page, true);
  await ux.install('populated');
  await page.goto('/today');
  const notice = page.getByTestId('pwa-update-error');
  await expect(notice).toBeVisible();
  const notifications = page.getByRole('button', { name: /^Open notifications/ });
  await notifications.click();
  await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss update failed notification' }).click();
  await expect(notice).toBeHidden();
  await expectNoHorizontalOverflow(page);
});

async function showFixtureUpdate(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as unknown as {
      __launch19PwaFixture: { showUpdate(): void };
    }).__launch19PwaFixture;
    fixture.showUpdate();
  });
}

async function expectCompactNoticePlacement(page: Page, noticeTestId: string) {
  const box = await page.getByTestId(noticeTestId).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(16);
  expect(box!.x + box!.width).toBeLessThanOrEqual(304);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(480);
}

async function seedUserScopedCaches(page: Page) {
  await page.evaluate(async ({ prefix }) => {
    const entries = [
      [`${prefix}server-a-user-17`, '/cached/account-17'],
      [`${prefix}server-a-user-23`, '/cached/account-23'],
      [`${prefix}server-b-user-17`, '/cached/alternate-server'],
    ] as const;
    for (const [cacheName, key] of entries) {
      const cache = await caches.open(cacheName);
      await cache.put(key, new Response('private fixture'));
    }
  }, { prefix: USER_CACHE_PREFIX });
}

async function expectServiceWorkerCacheContract(page: Page) {
  const cacheState = await page.evaluate(async ({ userPrefix }) => {
    const cacheNames = await caches.keys();
    const requests = (await Promise.all(cacheNames.map(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((request) => request.url);
    }))).flat();
    return { cacheNames, requests, userPrefix };
  }, { userPrefix: USER_CACHE_PREFIX });
  expect(cacheState.cacheNames.some((name) => name.startsWith(SHELL_CACHE_PREFIX))).toBe(true);
  expect(cacheState.cacheNames.filter((name) => name.startsWith(cacheState.userPrefix))).toEqual([]);
  expect(cacheState.requests.some((url) => /\/(?:api|auth)(?:\/|$)/.test(new URL(url).pathname))).toBe(false);
  expect(cacheState.requests.some((url) => new URL(url).pathname.includes('missing-launch-19'))).toBe(false);
  const unexpectedPaths = cacheState.requests.map((url) => new URL(url).pathname).filter((pathname) => !(
    ['/index.html', '/manifest.webmanifest', '/calibrate-icon.svg', '/calibrate-icon-192.png',
      '/calibrate-icon-512.png', '/calibrate-icon-maskable-512.png'].includes(pathname)
    || /^\/_expo\/static\/(?:js|css)\/.+-[0-9a-f]{8,}\.(?:js|css)$/.test(pathname)
    || /^\/assets\/.+-[0-9a-f]{8,}\.[a-z0-9]+$/i.test(pathname)
  ));
  expect(unexpectedPaths).toEqual([]);
}

async function captureEvidence(
  page: Page,
  testInfo: TestInfo,
  state: 'landing' | 'installed-update',
) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  const filename = state === 'landing'
    ? 'hosted-landing-desktop-1024x1000.png'
    : 'installed-update-notice-phone-320x568.png';
  await page.evaluate(() => document.fonts.ready);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
  const viewport = page.viewportSize();
  if (state === 'landing') {
    expect(testInfo.project.name).toBe('desktop-chrome');
    expect(viewport).toEqual({ width: 1_024, height: 1_000 });
  } else {
    expect(testInfo.project.name).toBe('compact-phone-chrome');
    expect(viewport).toEqual({ width: 320, height: 568 });
  }
}

test('hosted and installed web keep public trust, route truth, and server-account caches isolated', async (
  { page, ux },
  testInfo,
) => {
  const project = testInfo.project.name;
  if (project === 'desktop-chrome') {
    await page.setViewportSize({ width: 1_024, height: 1_000 });
    await ux.install('signed-out');
    await page.goto('/');

    await expect(page.getByTestId('hosted-landing')).toBeVisible();
    await expect(page.getByTestId('hosted-landing-actions').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByTestId('hosted-landing-actions').getByRole('link', { name: 'Create account' })).toBeVisible();
    await expect(page.getByTestId('hosted-install-copy')).toContainText('install');
    await expect(page.getByTestId('hosted-trust-links')).toContainText('Privacy policy');
    await expect(page.getByTestId('hosted-trust-links')).toContainText('Terms of service');
    await expectRouteMetadata(page, {
      title: LANDING_TITLE,
      description: LANDING_DESCRIPTION,
      canonicalPath: '/',
      robots: 'index, follow',
    });
    await expectManifestContract(page);
    await expectAxeStyleAccessibilityBaseline(page);
    await expectNoHorizontalOverflow(page);
    await captureEvidence(page, testInfo, 'landing');

    await page.getByTestId('hosted-trust-links').getByRole('link', { name: 'Privacy policy' }).click();
    await expect(page.getByTestId('legal-public-shell')).toBeVisible();
    await expect(page.getByTestId('legal-page').getByRole('heading', { name: 'Privacy policy', level: 1 })).toBeVisible();
    await expectRouteMetadata(page, {
      title: 'Privacy policy - Calibrate',
      description: PRIVACY_DESCRIPTION,
      canonicalPath: '/privacy',
      robots: 'index, follow',
    });
    await expectAxeStyleAccessibilityBaseline(page);
    await expectNoHorizontalOverflow(page);
    return;
  }

  if (project === 'tablet-chrome') {
    await ux.install('populated');
    await page.goto('/');
    await expect(page).toHaveURL((url) => url.pathname === '/today');
    await expectRouteMetadata(page, {
      title: 'Today - Calibrate',
      description: 'Today in Calibrate, your private food, weight, activity, and goal tracker.',
      canonicalPath: '/today',
      robots: 'noindex, nofollow',
    });

    await page.goto('/privacy');
    await expect(page.getByTestId('legal-in-app-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Settings' })).toBeVisible();
    await expectAxeStyleAccessibilityBaseline(page);

    expectApiFailure(page, { method: 'GET', pathname: '/missing-launch-19-authenticated', status: 404 });
    await page.goto('/missing-launch-19-authenticated');
    await expect(page).toHaveURL((url) => url.pathname === '/today');
    await expectRouteMetadata(page, {
      title: 'Today - Calibrate',
      description: 'Today in Calibrate, your private food, weight, activity, and goal tracker.',
      canonicalPath: '/today',
      robots: 'noindex, nofollow',
    });
    await expectNoHorizontalOverflow(page);
    return;
  }

  if (project === 'android-phone-chrome') {
    await ux.install('populated');
    await installSettingsSessionsFixture(page);
    let signedOut = false;
    await page.route('**/auth/me', (route) => signedOut
      ? route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Not authenticated', code: 'NOT_AUTHENTICATED' }),
        })
      : route.fallback());
    await page.route('**/auth/logout', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Signed out' }),
    }));
    await page.goto('/settings');
    await page.getByTestId('settings-open-security').click();
    await expect(page).toHaveURL((url) => url.pathname === '/security');
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
    });
    await seedUserScopedCaches(page);
    signedOut = true;
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 401 });
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/login');
    await expect.poll(() => page.evaluate(async (prefix) => (
      (await caches.keys()).filter((name) => name.startsWith(prefix))
    ), USER_CACHE_PREFIX)).toEqual([]);
    await expectServiceWorkerCacheContract(page);

    expectApiFailure(page, { method: 'GET', pathname: '/missing-launch-19-signed-out', status: 404 });
    await page.goto('/missing-launch-19-signed-out');
    await expect(page).toHaveURL((url) => url.pathname === '/login');
    await expect(page.getByTestId('notifications-button')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    return;
  }

  await page.setViewportSize({ width: 320, height: 568 });
  await installInstalledUpdateFixture(page);
  const controller = await ux.install('populated');
  await installSettingsSessionsFixture(page);
  await page.goto('/settings');
  expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
  await expect(page.getByRole('main')).toBeVisible();
  await expectAxeStyleAccessibilityBaseline(page);
  await page.getByTestId('settings-open-help').click();
  await expect(page).toHaveURL((url) => url.pathname === '/help');
  await page.getByTestId('settings-advanced').click();
  await expect(page).toHaveURL((url) => url.pathname === '/advanced');
  const advanced = page.getByTestId('advanced-settings-page');
  await expect(advanced).toBeVisible();
  await expect(advanced.getByRole('textbox', { name: 'Server URL' })).toHaveCount(0);
  await expect(advanced).toContainText("A self-hosted service's operator is responsible for privacy, security, availability, backups, and support.");

  await controller.activateOffline();
  const offlineNotice = page.getByTestId('pwa-offline');
  await expect(advanced.getByRole('button', { name: 'Save connection' })).toHaveCount(0);
  await expect(offlineNotice).toContainText("You're offline");
  await expect(offlineNotice).toContainText('Some information may be out of date. Keep tracking locally; pending changes sync after reconnection.');
  await expect(offlineNotice.getByRole('button')).toHaveCount(0);
  await expectCompactNoticePlacement(page, 'pwa-offline');
  await expectNoHorizontalOverflow(page);

  await page.context().setOffline(false);
  await expect(page.getByTestId('pwa-back-online')).toContainText('Connection restored. Calibrate is refreshing account data.');
  await expectCompactNoticePlacement(page, 'pwa-back-online');
  await expect(page.getByTestId('pwa-back-online')).toBeHidden({ timeout: 6_000 });

  await showFixtureUpdate(page);
  const update = page.getByTestId('pwa-update-ready');
  await expect(update).toContainText('Update ready');
  await expect(update.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expectCompactNoticePlacement(page, 'pwa-update-ready');
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo, 'installed-update');
  await update.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('pwa-update-ready')).toContainText('Updating Calibrate');
  expect(await page.evaluate(() => (
    window as unknown as { __launch19PwaFixture: { getLastWorkerMessage(): unknown } }
  ).__launch19PwaFixture.getLastWorkerMessage())).toEqual({ type: 'SKIP_WAITING' });
  await expectNoHorizontalOverflow(page);
});
