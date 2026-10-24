import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Page } from '@playwright/test';
import {
  DETERMINISTIC_CLOCK_STEP_MS,
  FROZEN_NOW,
  test,
  expect,
  UX_FIXTURE_STATES,
} from './fixtures';
import { PUBLIC_ROUTE_HEADINGS, ROUTE_MATRIX } from './route-matrix';
import {
  REGISTERED_ROUTE_PATHS,
  ROUTE_IDS,
  ROUTE_REGISTRY,
  getRouteByPath,
} from '../../mobile/src/navigation/routeRegistry';

const repoRoot = process.cwd();
const appRoot = path.join(repoRoot, 'mobile', 'app');
const AUTHENTICATED_DESTINATION_HEADINGS = Object.fromEntries(
  ROUTE_IDS.filter((routeId) => ROUTE_REGISTRY[routeId].shellPolicy === 'app')
    .map((routeId) => [ROUTE_REGISTRY[routeId].path, ROUTE_REGISTRY[routeId].title]),
);
const AUTHENTICATED_ROUTE_GROUPS = [
  { name: 'public and primary routes', routes: ROUTE_MATRIX.slice(0, 10) },
  { name: 'secondary and alias routes', routes: ROUTE_MATRIX.slice(10) },
];
const BARCODE_ROUTE_HEADING = /Checking camera|Camera permission|Camera access denied|Camera access blocked|Camera unavailable|Scan barcode|Food logging is unavailable/;

function waitForBarcodeFoodDay(page: Page) {
  return page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/v1/food-days'
    && response.request().method() === 'GET'
    && response.ok()
  ));
}

function collectRouteFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(absolutePath);
    return entry.isFile() ? [absolutePath] : [];
  });
}

function routePathFromFile(filePath: string): string | null {
  const relativePath = path.relative(appRoot, filePath).replaceAll('\\', '/');
  if (!relativePath.endsWith('.tsx')) return null;
  if (/(?:^|\/)_layout(?:\.web)?\.tsx$/.test(relativePath)) return null;
  if (relativePath === '+html.tsx' || relativePath === '+not-found.tsx') return null;

  const routeSegments = relativePath
    .replace(/(?:\.web)?\.tsx$/, '')
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment));
  if (routeSegments.at(-1) === 'index') routeSegments.pop();
  return `/${routeSegments.join('/')}`.replace(/\/$/, '') || '/';
}

test('route matrix declares every current browser route exactly once', () => {
  const sourceRoutes = [...new Set(
    collectRouteFiles(appRoot)
      .map(routePathFromFile)
      .filter((route): route is string => route !== null),
  )].sort();
  const declaredRoutes = ROUTE_MATRIX.map(({ path: routePath }) => routePath).sort();

  expect(declaredRoutes).toEqual(sourceRoutes);
  expect(declaredRoutes).toEqual([...REGISTERED_ROUTE_PATHS].sort());
  expect(new Set(declaredRoutes).size).toBe(ROUTE_MATRIX.length);
  for (const route of ROUTE_MATRIX) {
    expect(getRouteByPath(route.path)).not.toBeNull();
    expect(route.authentication).toMatch(/^(public|signed-out-only|authenticated)$/);
    expect(route.deepLink).toMatch(/^(render|session-redirect|alias-redirect)$/);
    expect(route.signedOutPath).toMatch(/^\//);
    expect(route.authenticatedPath).toMatch(/^\//);
    if (route.deepLink === 'render') expect(route.authenticatedPath).toBe(route.path);
    if (route.deepLink === 'alias-redirect') expect(route.authenticatedPath).not.toBe(route.path);
    expect(route.reload === 'preserve-redirect').toBe(route.deepLink !== 'render');
  }
});

test('signed-out direct entry and reload follow the declared route matrix', async ({ page, ux }) => {
  await ux.install('signed-out');

  for (const route of ROUTE_MATRIX) {
    const directResponse = await page.goto(route.path);
    expect(directResponse?.status(), `direct entry for ${route.path}`).toBe(200);
    await expect(page, `signed-out destination for ${route.path}`).toHaveURL((url) => (
      url.pathname === route.signedOutPath
    ));

    const heading = PUBLIC_ROUTE_HEADINGS[route.signedOutPath as keyof typeof PUBLIC_ROUTE_HEADINGS];
    if (heading) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    } else if (route.signedOutPath === '/') {
      await expect(page.getByText('Calibrate Health', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    }

    const reloadResponse = await page.reload();
    expect(reloadResponse?.status(), `reload for ${route.path}`).toBe(200);
    await expect(page, `reloaded destination for ${route.path}`).toHaveURL((url) => (
      url.pathname === route.signedOutPath
    ));
  }
});

for (const routeGroup of AUTHENTICATED_ROUTE_GROUPS) {
  test(`authenticated direct entry and reload cover ${routeGroup.name}`, async ({ page, ux }) => {
    await ux.install('populated');

    for (const route of routeGroup.routes) {
      const authRestored = route.authenticatedPath === '/barcode'
        ? page.waitForResponse((response) => (
            new URL(response.url()).pathname === '/auth/me'
            && response.request().method() === 'GET'
            && response.ok()
          ))
        : null;
      const barcodeFoodDayReady = route.authenticatedPath === '/barcode'
        ? waitForBarcodeFoodDay(page)
        : null;
      const directResponse = await page.goto(route.path);
      await authRestored;
      await barcodeFoodDayReady;
      expect(directResponse?.status(), `authenticated direct entry for ${route.path}`).toBe(200);
      await expect(page, `authenticated destination for ${route.path}`).toHaveURL((url) => (
        url.pathname === route.authenticatedPath
      ));

      const publicHeading = PUBLIC_ROUTE_HEADINGS[
        route.authenticatedPath as keyof typeof PUBLIC_ROUTE_HEADINGS
      ];
      const shellHeading = AUTHENTICATED_DESTINATION_HEADINGS[
        route.authenticatedPath as keyof typeof AUTHENTICATED_DESTINATION_HEADINGS
      ];
      if (route.path === '/log') {
        await expect(page.getByRole('dialog', { name: 'Add food', exact: true })).toBeVisible();
      } else if (publicHeading) {
        await expect(page.getByRole('heading', { name: publicHeading, exact: true })).toBeVisible();
      } else if (shellHeading) {
        await expect(page.getByRole('heading', { name: shellHeading, exact: true }).first()).toBeVisible();
      } else if (route.authenticatedPath === '/weight') {
        await expect(page.getByRole('dialog', { name: 'Weight entry', exact: true })).toBeVisible();
      } else if (route.authenticatedPath === '/barcode') {
        await expect(page.getByRole('heading', {
          name: BARCODE_ROUTE_HEADING,
        }).first()).toBeVisible();
      }

      const reloadResponse = await page.reload();
      expect(reloadResponse?.status(), `authenticated reload for ${route.path}`).toBe(200);
      await expect(page, `authenticated reloaded destination for ${route.path}`).toHaveURL((url) => (
        url.pathname === route.authenticatedPath
      ));
    }
  });
}

test('browser Back restores the previous auth route', async ({ page, ux }) => {
  await ux.install('signed-out');
  await page.goto('/login');
  await page.getByRole('link', { name: 'Create an account', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/register');

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === '/login');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('authenticated history and registered parent fallbacks return to the declared route', async ({ page, context, ux }) => {
  await ux.install('populated');

  await page.goto('/settings');
  await page.getByTestId('settings-open-connections').click();
  await expect(page).toHaveURL((url) => url.pathname === '/connections');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/activity');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/connections');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/settings');

  const trendPage = await context.newPage();
  await ux.installOnPage(trendPage);
  await trendPage.goto('/weight-trend');
  await trendPage.getByRole('button', { name: 'Back to Progress', exact: true }).click();
  await expect(trendPage).toHaveURL((url) => url.pathname === '/progress');
  await trendPage.close();

  const foodLogPage = await context.newPage();
  await ux.installOnPage(foodLogPage);
  await foodLogPage.goto('/food-log');
  await foodLogPage.getByRole('button', { name: 'Back to Today', exact: true }).click();
  await expect(foodLogPage).toHaveURL((url) => url.pathname === '/today');
  await foodLogPage.close();

  expect(ROUTE_MATRIX.find(({ path: routePath }) => routePath === '/activity')?.historyFallback).toBe('/connections');
  expect(ROUTE_MATRIX.find(({ path: routePath }) => routePath === '/my-foods')?.historyFallback).toBe('/data');
  expect(ROUTE_MATRIX.find(({ path: routePath }) => routePath === '/about')?.historyFallback).toBe('/help');
  expect(ROUTE_MATRIX.find(({ path: routePath }) => routePath === '/advanced')?.historyFallback).toBe('/help');
  for (const categoryPath of ['/profile', '/security', '/connections', '/data', '/help']) {
    expect(ROUTE_MATRIX.find(({ path: routePath }) => routePath === categoryPath)?.historyFallback)
      .toBe('/settings');
  }
  expect(ROUTE_MATRIX.find(({ path: routePath }) => routePath === '/weight-trend')?.historyFallback).toBe('/progress');
  expect(ROUTE_MATRIX.find(({ path: routePath }) => routePath === '/food-log')?.historyFallback).toBe('/today');
});

test('barcode preserves its direct route while authentication restoration is pending', async ({ page, ux }) => {
  await ux.install('populated');
  let restoreSession = () => {};
  const sessionRestored = new Promise<void>((resolve) => {
    restoreSession = resolve;
  });
  await page.route('**/auth/me', async (route) => {
    await sessionRestored;
    await route.fallback();
  });

  await page.goto('/barcode');
  await expect(page).toHaveURL((url) => url.pathname === '/barcode');
  await expect(page.getByText('Restoring session...', { exact: true })).toBeVisible();

  const restoredResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/auth/me'
    && response.request().method() === 'GET'
    && response.ok()
  ));
  const restoredFoodDay = waitForBarcodeFoodDay(page);
  restoreSession();
  await Promise.all([restoredResponse, restoredFoodDay]);
  await expect(page.getByText('Restoring session...', { exact: true })).toBeHidden();
  await expect(page).toHaveURL((url) => url.pathname === '/barcode');
  await expect(page.getByRole('heading', {
    name: BARCODE_ROUTE_HEADING,
  }).first()).toBeVisible();
});

test('unknown extensionless paths use the static-host fallback', async ({ page, ux }) => {
  await ux.install('signed-out');
  const directResponse = await page.goto('/release-fallback-probe');
  expect(directResponse?.status()).toBe(200);
  expect(directResponse?.headers()['x-calibrate-spa-fallback']).toBe('1');
  await expect(page).toHaveURL((url) => url.pathname === '/release-fallback-probe');

  const reloadResponse = await page.reload();
  expect(reloadResponse?.status()).toBe(200);
  expect(reloadResponse?.headers()['x-calibrate-spa-fallback']).toBe('1');
});

test('deterministic fixtures freeze dates and generated IDs', async ({ page, ux }) => {
  await ux.install('populated');
  await page.goto('/today');

  const deterministicInputs = await page.evaluate(() => ({
    firstNow: Date.now(),
    secondNow: Date.now(),
    constructedNow: new Date().getTime(),
    firstId: crypto.randomUUID(),
    secondId: crypto.randomUUID(),
  }));
  const frozenEpoch = Date.parse(FROZEN_NOW);
  expect((deterministicInputs.firstNow - frozenEpoch) % DETERMINISTIC_CLOCK_STEP_MS).toBe(0);
  expect(deterministicInputs.secondNow - deterministicInputs.firstNow).toBe(DETERMINISTIC_CLOCK_STEP_MS);
  expect(deterministicInputs.constructedNow - deterministicInputs.secondNow).toBe(DETERMINISTIC_CLOCK_STEP_MS);
  expect(deterministicInputs.firstId).toBe('00000000-0000-4000-8000-000000000001');
  expect(deterministicInputs.secondId).toBe('00000000-0000-4000-8000-000000000002');

  const reloadResponse = await page.reload();
  expect(reloadResponse?.status()).toBe(200);
  const thirdId = await page.evaluate(() => crypto.randomUUID());
  expect(thirdId).toBe('00000000-0000-4000-8000-000000000003');
});

test('empty, paused, loading, failed, stale, and offline states are named fixture contracts', () => {
  expect(UX_FIXTURE_STATES).toEqual([
    'signed-out',
    'populated',
    'empty',
    'paused',
    'loading',
    'failed-request',
    'stale',
    'offline',
  ]);
});
