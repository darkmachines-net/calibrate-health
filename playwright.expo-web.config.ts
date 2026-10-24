/** @file Expo browser test projects, viewport coverage, server lifecycle, and artifact configuration. */

import { defineConfig } from '@playwright/test';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4174';
const callerOwnedBaseURL = process.env.CALIBRATE_EXPO_WEB_BASE_URL?.trim();
const baseURL = callerOwnedBaseURL || DEFAULT_BASE_URL;
const chromeExecutablePath = process.env.PLAYWRIGHT_CHROME_PATH?.trim();
const systemChrome = (() => {
  if (chromeExecutablePath) return { launchOptions: { executablePath: chromeExecutablePath } };
  if (process.env.CI) return {};
  return { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL ?? 'chrome' };
})();

if (callerOwnedBaseURL) {
  const parsed = new URL(callerOwnedBaseURL);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('CALIBRATE_EXPO_WEB_BASE_URL must target a loopback static preview.');
  }
}

export default defineConfig({
  testDir: './e2e/expo-web',
  testIgnore: [
    /launch-22-(?:accessibility|visual)\.spec\.ts/,
    ...(process.env.CI ? [/launch-21-performance-budgets\.spec\.ts/] : []),
    ...(process.env.CALIBRATE_INCLUDE_DATA_STATE_MATRIX === '1'
      ? []
      : [/launch-24-data-state-matrix\.spec\.ts/]),
  ],
  updateSnapshots: 'none',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: '.codex-screenshots/expo-web-playwright-results',
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    ...systemChrome,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'tablet-chrome',
      use: { viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
    {
      name: 'android-phone-chrome',
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    {
      name: 'compact-phone-chrome',
      use: { viewport: { width: 320, height: 720 }, hasTouch: true, isMobile: true },
    },
  ],
  webServer: callerOwnedBaseURL
    ? undefined
    : {
        command: 'node scripts/expo-web-static-server.mjs --port 4174',
        url: DEFAULT_BASE_URL,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
