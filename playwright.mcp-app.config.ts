/** @file Browser validation for the bundled MCP App with a deterministic protocol host and no live account. */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/mcp-app',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  timeout: 30_000,
  reporter: 'list',
  outputDir: '.codex-screenshots/mcp-app-results',
  use: {
    viewport: { width: 1050, height: 1050 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {})
  }
});
