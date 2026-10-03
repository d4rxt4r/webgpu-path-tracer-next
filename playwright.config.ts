import { defineConfig } from "@playwright/test";

export default defineConfig({
  // Cold compilation of the shared textured PT/SPPM shaders can exceed 5s on Intel.
  expect: { timeout: 10000 },
  testDir: "./tests/browser",
  workers: 1,
  use: { channel: "chrome", headless: true, baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
  },
});
