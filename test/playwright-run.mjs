import { closeTestRun, openTestRun } from "../scripts/test-run-root.mjs";

/**
 * Playwright global setup: workers start after this, so they inherit the run's
 * TMPDIR; the returned teardown fails the run on a leaked backend (#35).
 */
export default async function setup() {
  const root = await openTestRun();
  process.env.TMPDIR = root;
  return async () => {
    const leaked = await closeTestRun(root);
    if (leaked.length) throw new Error(`${leaked.length} backend(s) were still running after the tests`);
  };
}
