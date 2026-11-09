import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";

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

test("goal and monitoring backends stay mounted after their interface entries were removed", async () => {
  const dashboard = await startDashboard({ monitoring: true });
  try {
    const goals = await fetch(`${dashboard.base}/api/goals`);
    assert.equal(goals.status, 200);
    const goalBody = await goals.json();
    assert.ok(Array.isArray(goalBody.goals), "the goal list endpoint still answers");
    assert.ok("scheduler" in goalBody, "goal scheduling state is still reported");

    const activity = await fetch(`${dashboard.base}/api/goals/activity?offset=0`);
    assert.equal(activity.status, 200);
    const feed = await activity.json();
    assert.ok(Array.isArray(feed.notifications));
    assert.equal(typeof feed.total, "number");

    const monitors = await fetch(`${dashboard.base}/api/monitors`);
    assert.equal(monitors.status, 200);
    const monitorBody = await monitors.json();
    assert.ok(Array.isArray(monitorBody.monitors), "the monitoring endpoint still answers");
    assert.ok(Array.isArray(monitorBody.templates));
    assert.ok(monitorBody.scheduler, "monitoring health is still reported");
  } finally {
    await dashboard.stop();
  }
});

test("only the removed interfaces' front-end modules, styles and browser cases are gone", async () => {
  for (const path of removedFrontEnd)
    await assert.rejects(access(path), undefined, `${path} should no longer exist`);
  for (const path of removedFrontEndTests)
    await assert.rejects(access(path), undefined, `${path} should no longer exist`);

  // Backend coverage for the retained capability stays in place.
  for (const path of [
    "test/long-term-goals.test.js",
    "test/goal-tools.test.js",
    "test/watch-reliability.test.js",
    "test/monitoring-pause.test.js"
  ])
    await access(path);

  const page = await readFile("web/index.html", "utf8");
  for (const marker of ["agent-galaxy", "galaxy-space", "goal.css", "watch.css", "apps-nav", "apps-panel"])
    assert.equal(page.includes(marker), false, `web/index.html still references ${marker}`);
});
