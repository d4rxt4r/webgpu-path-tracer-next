import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', workers: 1,
  use: { channel: 'chrome', headless: true, baseURL: 'http://127.0.0.1:5173' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: false },
});
