import { defineConfig } from '@playwright/test';

/**
 * Electron behaviour tests arrive with the test-module subagent. The boundary
 * is kept here so `npm run test:e2e` is wired from the start; no specs exist
 * yet, so the runner reports "no tests found" until they are added.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
