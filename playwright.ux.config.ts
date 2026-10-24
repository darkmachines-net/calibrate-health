/** @file Deterministic accessibility and visual-regression projects for the shared Expo browser surfaces. */

import { defineConfig } from '@playwright/test';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4176';
const callerOwnedBaseURL = (
  process.env.CALIBRATE_UX_BASE_URL
  ?? process.env.CALIBRATE_EXPO_WEB_BASE_URL
)?.trim();
const baseURL = callerOwnedBaseURL || DEFAULT_BASE_URL;

if (callerOwnedBaseURL) {
  const parsed = new URL(callerOwnedBaseURL);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('The UX preview URL must target a loopback static preview.');
  }
}

const visualOnly = /launch-22-visual\.spec\.ts/;
const semanticAndVisual = /launch-22-(?:accessibility|visual)\.spec\.ts/;

export default defineConfig({
  testDir: './e2e/expo-web',
  updateSnapshots: 'none',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.002,
      scale: 'css',
    },
  },
  reporter: 'list',
  outputDir: '.codex-screenshots/expo-web-ux-results',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-{platform}{ext}',
  use: {
    baseURL,
    browserName: 'chromium',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    reducedMotion: 'reduce',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'ux-phone-320',
      testMatch: semanticAndVisual,
      use: { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true },
    },
    {
      name: 'ux-phone-390',
      testMatch: visualOnly,
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    {
      name: 'ux-tablet-820',
      testMatch: visualOnly,
      use: { viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
    {
      name: 'ux-desktop-1024',
      testMatch: semanticAndVisual,
      use: { viewport: { width: 1024, height: 1000 } },
    },
    {
      name: 'ux-desktop-1440',
      testMatch: visualOnly,
      use: { viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: callerOwnedBaseURL
    ? undefined
    : {
        command: 'node scripts/expo-web-static-server.mjs --port 4176',
        url: DEFAULT_BASE_URL,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
