import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  // CI machines are smaller, and full rooms of browsers were starving each other there.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run -s build && node dist/server/index.js',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      // A throwaway folder, so test games never mix with local ones.
      DATA_DIR: mkdtempSync(join(tmpdir(), 'trip-party-e2e-')),
      ADMIN_PASSWORD: 'e2e-test-password',
      SESSION_SECRET: 'e2e-test-session-secret-long-enough',
    },
  },
});
