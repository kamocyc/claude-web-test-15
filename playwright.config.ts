import { defineConfig, devices } from '@playwright/test';

import { BASE_PATH } from './vite.config';

/**
 * Chromium is preinstalled in this environment at /opt/pw-browsers/chromium
 * (build 141.0.7390.37). We point `executablePath` at it explicitly so
 * Playwright neither validates its own expected revision nor tries to download
 * a browser. Never run `playwright install` here.
 */
const CHROMIUM = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

/**
 * The preview server serves the built app under `base`, not at the root, so
 * both the readiness probe and every navigation have to include it. Pointing
 * either at `/` gets an index page whose asset URLs all 404 — the app never
 * boots, and every spec fails in `waitReady` with no clue why.
 */
const ORIGIN = 'http://127.0.0.1:4173';
const APP_URL = `${ORIGIN}${BASE_PATH}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: APP_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1600, height: 1000 },
    launchOptions: { executablePath: CHROMIUM },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: APP_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
