import { expect, test } from "@playwright/test";
import { createServer } from "node:net";
import { once } from "node:events";
import { startConfiguredDashboard, startDashboard } from "../test/dashboard-fixture.mjs";
import { createProject, createTask, markTaskRunning } from "./p45-work-helpers.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function createRequirement(page, dashboard, projectId, title) {
  const response = await page.request.post(`${dashboard.base}/api/projects/${projectId}/ledger`, {
    data: { action: "create", title, content: `${title}的说明`, source: { kind: "internal" } }
  });
  expect(response.ok()).toBe(true);
}

async function stopChild(dashboard, child) {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

const originOf = (dashboard) => new URL(dashboard.base).origin;

// Two real backends, a stop/restart and the full settings action set.
test.setTimeout(120_000);

test("two local nodes aggregate in observation while work stays on this machine", async ({ page }) => {
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const origins = `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`;
  const a = await startConfiguredDashboard({
    port: portA,
    defaultProject: false,
    env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
  });
  let b;
  const tokens = new Map();
  page.on("request", (request) => {
    const origin = new URL(request.url()).origin;
    const token = request.headers()["x-atria-token"];
    if (!token) return;
    if (!tokens.has(origin)) tokens.set(origin, new Set());
    tokens.get(origin).add(token);
  });
  try {
    b = await startDashboard({
      port: portB,
      defaultProject: false,
      env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
    });
    const localProject = await createProject(page, a, "本机项目", `${a.root}/local-project`);
    const remoteProject = await createProject(page, b, "远程项目", `${b.root}/remote-project`);
    await createTask(page, a, {
      taskId: "local-running",
      goal: "本机运行",
      projectId: localProject.projectId
    });
    await createTask(page, b, {
      taskId: "remote-running",
      goal: "远程运行",
      projectId: remoteProject.projectId
    });
    await markTaskRunning(a, { taskId: "local-running", runId: "run-local" });
    await markTaskRunning(b, { taskId: "remote-running", runId: "run-remote" });
    await createRequirement(page, a, localProject.projectId, "本机需求一");
    await createRequirement(page, a, localProject.projectId, "本机需求二");
    await createRequirement(page, b, remoteProject.projectId, "远程需求");

    await page.goto(a.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    // Add the second node from the settings page: address, name and scope.
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    await expect(page.locator("#settings-node-local")).toContainText("本机");
    await page.locator("#settings-node-add").click();
    const dialog = page.getByRole("dialog", { name: "添加节点" });
    await expect(dialog).toBeVisible();
    await dialog.locator("#node-address").fill(b.base);
    await dialog.locator("#node-name").fill("远程节点");
    await dialog.locator('[data-node-role="external"]').click();
    await dialog.locator("#node-submit").click();
    await expect(dialog).toBeHidden();
    const remoteRow = page.locator(`#settings-node-remote [data-node="${b.base}"]`);
    await expect(remoteRow).toContainText("远程节点");
    await expect(remoteRow).toContainText("对外");
    await expect(remoteRow).toContainText("在线");

    // The row menu carries the four node actions from the design board.
    await remoteRow.locator("[data-node-menu]").click();
    const menu = page.locator(".settings-node-menu");
    await expect(menu).toBeVisible();
    for (const name of ["重命名", "重新授权", "断开", "移除节点"])
      await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // Observation lists both nodes and both projects with aggregated counts.
    await page.locator("#settings-back").click();
    await page.getByRole("tab", { name: "观测", exact: true }).click();
    await expect(page.locator("button[data-observe-node]")).toHaveCount(2);
    await expect(page.locator(`button[data-observe-node="${a.base}"]`)).toContainText("本机");
    await expect(page.locator(`button[data-observe-node="${b.base}"]`)).toContainText("远程节点");
    await expect(page.locator("[data-observe-scope-list]")).toContainText("本机项目");
    await expect(page.locator("[data-observe-scope-list]")).toContainText("远程项目");
    await expect(page.locator('[data-observe-count="requirements"]')).toHaveText("3");
    await expect(page.locator('[data-observe-count="runs"]')).toHaveText("2");

    // Each node lists its own projects beneath it, and 全部 is current.
    await expect(page.locator("[data-observe-all]")).toHaveAttribute("aria-current", "true");
    await expect(
      page.locator(`button[data-observe-project-node="${b.base}"]`).filter({ hasText: "远程项目" })
    ).toHaveCount(1);
    await expect(
      page.locator(`button[data-observe-project-node="${a.base}"]`).filter({ hasText: "本机项目" })
    ).toHaveCount(1);

    // Selecting a node narrows the current view; it is the one current row.
    await page.locator(`button[data-observe-node="${b.base}"]`).click();
    await expect(page.locator(`button[data-observe-node="${b.base}"]`)).toHaveAttribute(
      "aria-current",
      "true"
    );
    await expect(page.locator('[data-observe-scope-list] [aria-current="true"]')).toHaveCount(1);
    await expect(page.locator('[data-observe-count="requirements"]')).toHaveText("1");
    await expect(page.locator("#observe-entry")).toHaveAttribute("data-observe-node", b.base);

    // Selecting a project scopes the views to it, on its node.
    await page.locator(`button[data-observe-project="${remoteProject.projectId}"]`).click();
    await expect(page.locator("#observe-entry")).toHaveAttribute("data-observe-node", b.base);
    await expect(page.locator('[data-observe-scope-list] [aria-current="true"]')).toHaveCount(1);
    await expect(page.locator("#observe-entry")).toHaveAttribute(
      "data-observe-project",
      remoteProject.projectId
    );
    await expect(page.locator('[data-observe-count="runs"]')).toHaveText("1");

    // A stopped node is offline without disturbing the local node; a restart
    // brings it back with a fresh snapshot.
    await page.locator("[data-observe-all]").click();
    // The list updates in place: a node going offline keeps the keyboard
    // focus on its own row instead of replacing the list.
    const remoteNodeRow = page.locator(`button[data-observe-node="${b.base}"]`);
    await remoteNodeRow.focus();
    await stopChild(b, b.child);
    await expect(remoteNodeRow).toContainText("离线", { timeout: 15_000 });
    await expect(remoteNodeRow).toBeFocused();
    await expect(page.locator(`button[data-observe-node="${a.base}"]`)).not.toContainText("离线");
    await expect(page.locator('[data-observe-count="requirements"]')).toHaveText("2");

    // The settings row keeps its last-online timestamp and the host's backend
    // row, and a notify never takes focus away from a row control.
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    const remoteSettingsRow = page.locator(`#settings-node-remote [data-node="${b.base}"]`);
    await expect(remoteSettingsRow).toContainText(/离线 · /);
    await expect(page.locator("#settings-node-local [data-backend-open]")).toHaveCount(1);
    const nodeMenuButton = remoteSettingsRow.locator("[data-node-menu]");
    await nodeMenuButton.focus();
    await b.restart();
    await expect(remoteNodeRow).not.toContainText("离线", { timeout: 20_000 });
    await expect(nodeMenuButton).toBeFocused();
    await page.locator('[data-settings-section="general"]').click();
    await page.locator('[data-settings-section="nodes"]').click();
    await expect(remoteSettingsRow).toContainText("在线");
    await expect(page.locator("#settings-node-local [data-backend-open]")).toHaveCount(1);
    await page.locator("#settings-back").click();
    await expect(page.locator("[data-observe-scope-list]")).toContainText("远程项目");
    await expect(page.locator('[data-observe-count="requirements"]')).toHaveText("3");

    // Rename, disconnect, reconnect, reauthorize and remove from the same page.
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    await page.locator(`[data-node-menu="${b.base}"]`).click();
    await page.locator('.settings-node-menu [data-node-action="rename"]').click();
    const renameDialog = page.getByRole("dialog", { name: "重命名节点" });
    await expect(renameDialog).toBeVisible();
    await renameDialog.locator("#node-name").fill("改名节点");
    await renameDialog.locator("#node-submit").click();
    await expect(renameDialog).toBeHidden();
    await expect(page.locator(`#settings-node-remote [data-node="${b.base}"]`)).toContainText("改名节点");

    await page.locator(`[data-node-menu="${b.base}"]`).click();
    await page.locator('.settings-node-menu [data-node-action="disconnect"]').click();
    await expect(page.locator(`#settings-node-remote [data-node="${b.base}"]`)).toContainText("已断开");
    await expect(page.locator("#settings-node-local [data-backend-open]")).toHaveCount(1);
    await page.locator("#settings-back").click();
    await expect(page.locator(`button[data-observe-node="${b.base}"]`)).toContainText("已断开");
    await expect(page.locator("[data-observe-scope-list]")).not.toContainText("远程项目");

    const authsBefore = tokens.get(originOf(b))?.size ?? 0;
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    await page.locator(`[data-reconnect="${b.base}"], [data-node-reconnect="${b.base}"]`).click();
    await expect(page.locator(`#settings-node-remote [data-node="${b.base}"]`)).toContainText("在线");
    await page.locator(`[data-node-menu="${b.base}"]`).click();
    await page.locator('.settings-node-menu [data-node-action="reauthorize"]').click();
    await expect(page.locator(`#settings-node-remote [data-node="${b.base}"]`)).toContainText("在线");
    await expect.poll(() => tokens.get(originOf(b))?.size ?? 0).toBeGreaterThan(authsBefore);

    // One node's token never travels to the other origin.
    const localTokens = tokens.get(originOf(a)) ?? new Set();
    const remoteTokens = tokens.get(originOf(b)) ?? new Set();
    expect(localTokens.size).toBeGreaterThan(0);
    expect(remoteTokens.size).toBeGreaterThan(0);
    for (const token of localTokens) expect(remoteTokens.has(token)).toBe(false);

    await page.locator(`[data-node-menu="${b.base}"]`).click();
    await page.locator('.settings-node-menu [data-node-action="remove"]').click();
    await expect(page.locator(`#settings-node-remote [data-node="${b.base}"]`)).toHaveCount(0);
    await expect(page.locator("#settings-node-local [data-backend-open]")).toHaveCount(1);
    await page.locator("#settings-back").click();
    await expect(page.locator(`button[data-observe-node="${b.base}"]`)).toHaveCount(0);
    await expect(page.locator("button[data-observe-node]")).toHaveCount(1);

    // The local node reports a stopped backend as offline and recovers.
    await stopChild(a, a.child);
    await expect(page.locator(`button[data-observe-node="${a.base}"]`)).toContainText("离线", {
      timeout: 20_000
    });
    await a.restart();
    await expect(page.locator(`button[data-observe-node="${a.base}"]`)).not.toContainText("离线", {
      timeout: 20_000
    });

    // Work still uses only this machine's node.
    await page.getByRole("tab", { name: "工作", exact: true }).click();
    await expect(page.locator("#project-list")).toContainText("本机项目");
    await expect(page.locator("#project-list")).not.toContainText("远程项目");
    await page.locator("#new-conversation").click();
    await expect(page.locator(".new-session-start")).toBeVisible();
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).origin === originOf(a) &&
        new URL(request.url()).pathname === "/api/tasks"
    );
    await page.locator("#composer-input").fill("只发给本机");
    await expect(page.locator("#send-button")).toBeEnabled();
    await page.locator("#send-button").click();
    const request = await created;
    const taskId = request.postDataJSON().taskId;
    expect(taskId).toBeTruthy();
    const remoteCatalog = await (await page.request.get(`${b.base}/api/tasks`)).json();
    expect(remoteCatalog.tasks.some((task) => task.taskId === taskId)).toBe(false);
  } finally {
    await b?.stop();
    await a.stop();
  }
});
