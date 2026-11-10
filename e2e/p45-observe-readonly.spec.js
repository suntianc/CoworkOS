import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedRequirement, servingBackendId } from "./p45-requirement-fixture.js";
import { createProject } from "./p45-work-helpers.js";
import { addNode, freePort, openObservation } from "./p45-observe-fixture.js";

/**
 * Observation watches a node without working on it.
 *
 * The remote node published a merge whose shared delivery has not been accepted
 * yet. Watching its records from the observation entry must leave that pending
 * fact where it is: the port marks every node request read-only, so the total,
 * requirement and run views can switch, dwell and refresh without the observed
 * node replaying its outbox for the viewer. The same read without the marker is
 * the work entry's and still completes the delivery, which is what the last
 * step proves the pending fact was real.
 */
test.setTimeout(240_000);

/** A requirement's ledger status, read without a marker because it never replays. */
async function ledgerStatus(page, dashboard, projectId, requirementId) {
  const response = await page.request.get(
    `${dashboard.base}/api/projects/${encodeURIComponent(projectId)}/ledger`
  );
  expect(response.ok(), await response.text()).toBe(true);
  const { requirements } = await response.json();
  return requirements.find((entry) => entry.requirementId === requirementId)?.status;
}

test("the three observation views read a node read-only and never replay its pending delivery", async ({
  page
}) => {
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const origins = `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`;
  const local = await startDashboard({
    port: portA,
    defaultProject: false,
    env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
  });
  let remoteOrigin = "";
  const reads = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!remoteOrigin || url.origin !== remoteOrigin) return;
    reads.push({
      method: request.method(),
      path: url.pathname,
      readOnly: request.headers()["x-cowork-read-only"]
    });
  });
  let remote;
  try {
    remote = await startDashboard({
      port: portB,
      defaultProject: false,
      env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
    });
    remoteOrigin = remote.base;
    const remoteProject = await createProject(page, remote, "远程项目", `${remote.root}/remote-project`);
    const owner = await servingBackendId(remote);
    // This host owns the merge entry, so the merged row is one it would
    // complete on its next read; nothing else on the node will do it.
    await configureMerge(page, remote, remoteProject, `${remote.root}/remote-project`, {
      executionBackendId: owner
    });
    const pending = await seedRequirement(page, remote, remoteProject, {
      phase: "merged",
      title: "远程待补投",
      executionBackendId: owner
    });
    const requirementId = pending.requirement.requirementId;
    const projectPath = `/api/projects/${encodeURIComponent(remoteProject.projectId)}`;
    expect(await ledgerStatus(page, remote, remoteProject.projectId, requirementId)).toBe("open");

    await page.goto(local.base);
    await addNode(page, { base: remote.base, name: "远程节点", role: "internal" });
    await openObservation(page);

    // The overview reads the node's lists as soon as it is shown, and the
    // merged row stays where its recorded facts put it.
    await expect(page.locator(`[data-observe-node-card="${remote.base}"]`)).toHaveAttribute(
      "data-status",
      "online"
    );
    const mergeCell = page.locator(
      `[data-observe-matrix-project="${remoteProject.projectId}"] [data-matrix-stage="merge"]`
    );
    await expect(mergeCell).toHaveText("1");

    // Switch through every view and dwell past the run view's refresh cycle.
    await page.locator('[data-observe-view="requirements"]').click();
    await expect(page.locator("[data-observe-requirement]").first()).toBeVisible();
    await page.locator('[data-observe-view="runs"]').click();
    await delay(11_000);
    await page.locator('[data-observe-view="overview"]').click();
    await expect(mergeCell).toHaveText("1");

    // Every request this page sent the node carried the port's marker, and the
    // three lists the views read were among them.
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads)
      expect(read.readOnly, `${read.method} ${read.path} was not marked read-only`).toBe("1");
    const paths = new Set(reads.map((read) => read.path));
    for (const suffix of ["/developments", "/merges", "/deliveries"])
      expect(paths.has(`${projectPath}${suffix}`), `${suffix} was never read`).toBe(true);

    // Nothing on the observed node wrote: the delivery is still missing and the
    // requirement is still waiting for it.
    expect(await ledgerStatus(page, remote, remoteProject.projectId, requirementId)).toBe("open");

    // The same read without the marker is the work entry's: it completes the
    // delivery, so the assertions above were about the marker, not an empty
    // outbox.
    const delivered = await page.request.get(`${remote.base}${projectPath}/deliveries`);
    expect(delivered.ok(), await delivered.text()).toBe(true);
    expect((await delivered.json()).deliveries.map((entry) => entry.mergeId)).toEqual([
      pending.merge.mergeId
    ]);
    expect(await ledgerStatus(page, remote, remoteProject.projectId, requirementId)).toBe("delivered");
  } finally {
    await remote?.stop();
    await local.stop();
  }
});
