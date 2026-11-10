import { defineConfig } from "@playwright/test";

// Desktop windows launched by tests draw normally but stay out of the foreground, the Dock
// and keyboard focus (desktop/background-mode.cjs). Set it to 0 to watch a desktop test run.
process.env.FORMICAND_DESKTOP_BACKGROUND ??= "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { browserName: "chromium", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  reporter: "list"
});
