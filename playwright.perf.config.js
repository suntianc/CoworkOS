import { defineConfig } from "@playwright/test";

// Rendering measurements (#17): one worker, so numbers are not shared with
// another browser; run with `npm run test:perf`, not in the regression suite.
export default defineConfig({
  testDir: "./e2e/perf",
  testMatch: "**/*.perf.js",
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
  reporter: "list"
});
