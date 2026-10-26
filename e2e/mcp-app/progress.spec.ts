/** @file Acceptance coverage for focused MCP data views, optional detail, contextual chat, and incomplete evidence. */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { hostTraffic, installHost, progressFixture } from './fixtures';

test('shows progress and sends a contextual question only after a user action', async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  const app = await installHost(page);
  await expect(app.getByRole('region', { name: 'Current goal' })).toBeVisible();
  await expect(app.locator('#weight-chart')).toBeVisible();
  await expect(app.locator('#food-chart')).toHaveCount(0);
  await expect(app.locator('[data-question]')).toHaveCount(2);
  await expect(app.getByLabel('From', { exact: true })).not.toBeVisible();
  expect((await hostTraffic(page)).messages).toHaveLength(0);
  await app.getByRole('button', { name: 'Goal progress' }).click();
  await expect(app.getByRole('status')).toHaveText('Question added to chat. Continue the conversation there.');
  const traffic = await hostTraffic(page);
  expect(traffic.messages).toHaveLength(1);
  expect(traffic.messages[0].content[0].text).toContain('2026-07-27 through 2026-10-24 (America/Los_Angeles)');
  expect(traffic.contexts).toHaveLength(1);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: '.codex-screenshots/mcp-app-desktop-light.png', fullPage: true });
  await app.getByRole('button', { name: 'Intake', exact: true }).click();
  await expect(app.getByText('78 of 90 days complete')).toBeVisible();
  await expect(app.getByText('Complete-day average', { exact: true })).toBeVisible();
  await expect(app.locator('#weight-chart')).toHaveCount(0);
  await expect(app.locator('[data-question]')).toHaveCount(2);
});

test('loads old custom dates and compares the preceding period through read-only tools', async ({ page }) => {
  const app = await installHost(page);
  await app.getByLabel('Period', { exact: true }).selectOption('custom');
  await app.getByLabel('From', { exact: true }).fill('2024-02-01');
  await app.getByLabel('Through', { exact: true }).fill('2024-02-29');
  await app.getByRole('button', { name: 'Apply period' }).click();
  await expect(app.getByRole('status')).toContainText('Period updated');
  await expect(app.getByRole('button', { name: 'Apply period' })).toBeFocused();
  await app.locator('#view-compare').click();
  await app.locator('#compare-periods').click();
  await expect(app.getByRole('heading', { name: 'Comparison period', exact: true })).toBeVisible();
  await expect(app.locator('#compare-periods')).toBeFocused();
  const traffic = await hostTraffic(page);
  expect(traffic.calls[0]).toMatchObject({ name: 'get_progress_summary', arguments: { start_date: '2024-02-01', end_date: '2024-02-29' } });
  expect(traffic.calls[1]).toMatchObject({ name: 'compare_progress_periods', arguments: { first: { start_date: '2024-02-01', end_date: '2024-02-29' }, second: { start_date: '2024-01-03', end_date: '2024-01-31' } } });
  await app.getByRole('button', { name: 'Discuss this comparison' }).click();
  await expect(app.getByRole('status')).toContainText('Question added');
  expect((await hostTraffic(page)).messages[0].content[0].text).toContain('Compare with 2024-01-03 through 2024-01-31');
});

test('rejects oversized ranges without sending a server request and preserves the last view on failure', async ({ page }) => {
  const app = await installHost(page, { failTools: true });
  await app.getByLabel('Period', { exact: true }).selectOption('custom');
  await app.getByLabel('From', { exact: true }).fill('2020-01-01');
  await app.getByRole('button', { name: 'Apply period' }).click();
  await expect(app.getByRole('status')).toContainText('1 to 365 days');
  expect((await hostTraffic(page)).calls).toHaveLength(0);
  await app.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(app.getByRole('status')).toContainText('previous view is still available');
  await expect(app.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  await expect(app.getByRole('region', { name: 'Current goal' })).toBeVisible();
});

test('offers a copyable prompt when the host lacks messages or declines a message', async ({ page }) => {
  const app = await installHost(page, { messaging: false });
  await app.getByRole('button', { name: 'Goal progress' }).click();
  await expect(app.getByLabel('Question to copy into chat')).toHaveValue(/How am I progressing/);
  expect((await hostTraffic(page)).messages).toHaveLength(0);
  await installHost(page, { rejectMessage: true });
  await app.getByRole('button', { name: 'Goal progress' }).click();
  await expect(app.getByLabel('Question to copy into chat')).toHaveValue(/2026-07-27/);
});

test('renders partial permissions and maintenance without a projection date', async ({ page }) => {
  const fixture = progressFixture();
  fixture.food = null; fixture.granted_sections.food = false;
  fixture.current_goal!.direction = 'maintenance'; fixture.current_goal!.projection_status = 'maintenance';
  fixture.current_goal!.configured_daily_deficit_kcal = 0;
  const app = await installHost(page, { snapshot: fixture });
  await app.getByText('About this data', { exact: true }).click();
  await expect(app.getByText('Maintenance focuses on stability over time.')).toBeVisible();
  await expect(app.getByText(/Steady-rate plan projection/)).toHaveCount(0);
  await expect(app.getByRole('progressbar')).toHaveCount(0);
  await app.getByRole('button', { name: 'Intake', exact: true }).click();
  await expect(app.getByText('Food access is not available for this connection.')).toBeVisible();
});

test('handles empty stale evidence, escapes text, and remains usable at 320px in dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const fixture = progressFixture();
  fixture.weight!.points = []; fixture.weight!.period_summary.observation_count = 0;
  fixture.weight!.trend.freshness = 'outdated'; fixture.weight!.trend.weekly_rate = null;
  fixture.weight!.trend.latest_trend = null;
  fixture.interpretation_notes.push('<img src=x onerror="window.injected=true">');
  const app = await installHost(page, { theme: 'dark', snapshot: fixture });
  await expect(app.getByText('No weight observations in this period.', { exact: false })).toBeVisible();
  await expect(app.getByText('Model evidence is outdated as of', { exact: false })).toBeVisible();
  await app.getByText('About this data', { exact: true }).click();
  await expect(app.locator('li').last()).toHaveText('<img src=x onerror="window.injected=true">');
  await expect(app.locator('img')).toHaveCount(0);
  const frame = page.frames().find((item) => item.parentFrame() !== null)!;
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: '.codex-screenshots/mcp-app-narrow-dark.png', fullPage: true });
});

test('navigates adjacent windows and requests expansion only from capable hosts', async ({ page }) => {
  const app = await installHost(page, { expand: true });
  await app.locator('#period-details > summary').click();
  await expect(app.getByRole('button', { name: 'Next period', exact: true })).toBeDisabled();
  await app.getByRole('button', { name: 'Previous period', exact: true }).click();
  await expect(app.getByRole('status')).toContainText('Period updated');
  await app.getByRole('button', { name: 'Next period', exact: true }).click();
  await expect(app.getByRole('status')).toContainText('Period updated');
  expect((await hostTraffic(page)).calls[1].arguments).toEqual({ start_date: '2026-07-27', end_date: '2026-10-24' });
  await app.getByRole('button', { name: 'Expand view', exact: true }).click();
  await app.getByRole('button', { name: 'Exit expanded view', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Expand view', exact: true })).toBeVisible();
  expect((await hostTraffic(page)).displayModes).toEqual(['fullscreen', 'inline']);
});

test('prevents duplicate question submission and restores usable controls after sending', async ({ page }) => {
  const app = await installHost(page, { messageDelay: 1000 });
  await app.getByRole('button', { name: 'Goal progress' }).click();
  await expect(app.getByRole('status')).toHaveText('Adding your question to chat...');
  await app.locator('#chat-0').evaluate((button) => {
    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  });
  await expect(app.getByRole('status')).toContainText('Question added');
  expect((await hostTraffic(page)).messages).toHaveLength(1);
  await expect(app.getByLabel('Period', { exact: true })).toBeEnabled();
  await expect(app.getByRole('button', { name: 'Goal progress' })).toBeFocused();
});

test('preset periods load immediately and view changes keep dates without fetching again', async ({ page }) => {
  const app = await installHost(page);
  await app.getByLabel('Period', { exact: true }).selectOption('30');
  await expect(app.getByRole('status')).toContainText('Period updated');
  await expect(app.getByLabel('Period', { exact: true })).toBeFocused();
  await app.getByRole('button', { name: 'Intake', exact: true }).click();
  await expect(app.locator('#food-chart')).toBeVisible();
  const calls = (await hostTraffic(page)).calls;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: 'get_progress_summary', arguments: { start_date: '2026-09-25', end_date: '2026-10-24' } });
  await expect(app.getByLabel('From', { exact: true })).not.toBeVisible();
});

test('keeps the populated narrow overview short with just one chart and two chat entrypoints', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const app = await installHost(page, { theme: 'dark' });
  await expect(app.locator('#weight-chart')).toBeVisible();
  await expect(app.locator('[data-question]')).toHaveCount(2);
  const frame = page.frames().find((item) => item.parentFrame() !== null)!;
  const bounds = await frame.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.querySelector('main')!.getBoundingClientRect().height }));
  expect(bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.height).toBeLessThan(900);
  await page.screenshot({ path: '.codex-screenshots/mcp-app-compact-dark.png', fullPage: true });
});
