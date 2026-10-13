import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests of the web app against the real API and a real database.
 *
 * They run in CI only (the development machine has no database): the CI job
 * creates an empty database, applies the migrations and builds everything,
 * then this config starts the API and the Angular dev server (which proxies
 * `/api` to the API, see proxy.conf.json). The `seed` project creates the
 * first admin with the real CLI and the test data through the API; the
 * browser tests depend on it. The HTML report with a screenshot of every
 * test, and a trace of failures, is uploaded as a CI artifact.
 */
export default defineConfig({
  testDir: '.',
  outputDir: 'results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
  use: {
    // `localhost`, not 127.0.0.1: browsers accept the API's Secure session
    // cookie over plain http only on localhost.
    baseURL: 'http://localhost:4200',
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'seed', testMatch: /seed\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /\.e2e-spec\.ts/,
      dependencies: ['seed'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../../api',
      url: 'http://127.0.0.1:3000/api/v1/health',
      timeout: 60_000,
      stdout: 'pipe',
      // Every test signs in through the login form; lift the per-IP limit.
      env: { LOGIN_RATE_LIMIT: '1000' },
    },
    {
      command: 'npx ng serve --port 4200',
      cwd: '..',
      url: 'http://localhost:4200',
      timeout: 240_000,
    },
  ],
});
