import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const removedFrontEnd = [
  "web/assets/agent-galaxy.js",
  "web/assets/agent-galaxy.css",
  "web/assets/galaxy-space.js",
  "web/assets/agent-room.js",
  "web/assets/goal-view.js",
  "web/assets/goal.css",
  "web/assets/watch.css",
  "web/assets/controllers/goal-controller.js",
  "web/assets/controllers/goal-form.js",
  "web/assets/controllers/watch-controller.js",
  "web/assets/work-log.js",
  "web/assets/workbench/apps-panel.js"
];

const removedFrontEndTests = [
  "test/galaxy-space.test.js",
  "test/work-log.test.js",
  "e2e/appearance-galaxy.spec.js",
  "e2e/goal-workspace.spec.js",
  "e2e/long-term-goals.spec.js",
  "e2e/watchers.spec.js"
];

test("only the removed interfaces' front-end modules, styles and browser cases are gone", async () => {
  for (const path of removedFrontEnd)
    await assert.rejects(access(path), undefined, `${path} should no longer exist`);
  for (const path of removedFrontEndTests)
    await assert.rejects(access(path), undefined, `${path} should no longer exist`);

  const page = await readFile("web/index.html", "utf8");
  for (const marker of ["agent-galaxy", "galaxy-space", "goal.css", "watch.css", "apps-nav", "apps-panel"])
    assert.equal(page.includes(marker), false, `web/index.html still references ${marker}`);
});
