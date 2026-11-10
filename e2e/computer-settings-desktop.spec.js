import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";
import { createDashboardApplication } from "../dist/src/dashboard/application.js";
import {
  backendPaths,
  readBackendInstance,
  ensureBackendIdentity,
  removeBackendInstance,
  writeBackendInstance
} from "../dist/src/dashboard/backend-instance.js";

// Exercise the production routes and desktop IPC with an in-process native-auth dependency.
// No production environment switch or HTTP endpoint grants approval.
async function isolatedBackend(data, helper) {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env))
    if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(name)) delete process.env[name];
  Object.assign(process.env, {
    ATRIA_HOME: data,
    COWORK_HARNESS_ROOT: resolve("."),
    COWORK_CONFIG: join(data, "config.json"),
    COWORK_WORKSPACE: join(data, "workspace"),
    COWORK_API_TOKEN: "isolated-settings-fixture",
    COWORK_COMPUTER_USE_EXECUTABLE: helper,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const paths = backendPaths(data);
  const identity = await ensureBackendIdentity(paths);
  const startedAt = new Date().toISOString();
  let approvals = 0;
  const application = createDashboardApplication({
    projectRoot: resolve("."),
    port,
    backendIdentity: { backendId: identity.backendId, startedAt },
    computerApprovalAuthenticate: async () => (++approvals, true)
  });
  application.server.listen(port, "127.0.0.1");
  await once(application.server, "listening");
  await writeBackendInstance(paths, {
    ...identity,
    pid: process.pid,
    port,
    url: application.dashboardUrl,
    token: process.env.COWORK_API_TOKEN,
    startedAt
  });
  return {
    approvals: () => approvals,
    async close() {
      await application.stop();
      await removeBackendInstance(paths, { pid: process.pid });
      for (const name of Object.keys(process.env))
        if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(name)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  };
}

async function openWindowSettings(page) {
  await page.locator("#user-menu-button").click();
  await page.locator('[data-settings-section="tools"]').click();
  const section = page.locator("#settings-entry .computer-setting");
  if (!(await section.evaluate((element) => element.open))) await section.locator("summary").click();
}

async function isolatedDriver(data, windows, grant = true, confirmationDelay = 0) {
  const helper = join(data, "isolated-driver.cjs");
  const effects = join(data, "driver-effects.jsonl");
  const requests = join(data, "permission-requests.jsonl");
  const permissions = join(data, "permissions.json");
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await writeFile(
    permissions,
    JSON.stringify({ screenRecording: false, accessibility: false, postEventAccess: false })
  );
  await writeFile(
    helper,
    `#!${process.execPath}
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", c => raw += c);
process.stdin.on("end", async () => {
  const input = JSON.parse(raw);
  const operation = input.operation;
  if (operation === "act") fs.appendFileSync(${JSON.stringify(effects)}, JSON.stringify(input) + "\\n");
  if (operation === "permissions") {
    fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(input) + "\\n");
    await new Promise(resolve => setTimeout(resolve, ${confirmationDelay}));
    if (${grant}) {
      const updated = JSON.parse(fs.readFileSync(${JSON.stringify(permissions)}, "utf8"));
      updated[input.permission] = true;
      if (input.permission === "accessibility") updated.postEventAccess = true;
      fs.writeFileSync(${JSON.stringify(permissions)}, JSON.stringify(updated));
    }
  }
  const access = JSON.parse(fs.readFileSync(${JSON.stringify(permissions)}, "utf8"));
  const result = operation === "status" ? {available:true,...access,controlAvailable:access.accessibility && access.postEventAccess,windows:${JSON.stringify(windows)}}
    : operation === "permissions" ? {requested:true,screenRecording:access.screenRecording}
    : operation === "observe" ? {width:1,height:1,image:${JSON.stringify(image)},frame:{x:0,y:0,width:1,height:1},accessibilityText:"Synthetic isolated fixture"} : {};
  console.log(JSON.stringify(result));
});
`,
    { mode: 0o700 }
  );
  return { helper, effects, requests, permissions };
}

test("native three-button settings grant both windows to new tasks, persists across restart and revokes queued work", async () => {
  test.skip(process.platform !== "darwin", "Native settings acceptance requires macOS");
  test.setTimeout(120_000);
  const data = await mkdtemp(join(tmpdir(), "atria-computer-settings-"));
  const target = {
    pid: 11,
    windowId: 12,
    bundleId: "org.atria.fixture.one",
    application: "Fixture One",
    title: "First window"
  };
  const second = {
    pid: 21,
    windowId: 22,
    bundleId: "org.atria.fixture.two",
    application: "Fixture Two",
    title: "Second window"
  };
  // A person can take longer than both ordinary helper (15s) and IPC (20s)
  // deadlines to confirm macOS prompts. Exercise that actual waiting path.
  const { helper, effects, requests, permissions } = await isolatedDriver(
    data,
    [target, second],
    true,
    21_000
  );
  const backend = await isolatedBackend(data, helper);
  const env = { ...desktopSmokeEnvironment({ data }), COWORK_COMPUTER_USE_EXECUTABLE: helper };
  const packagedApp = process.env.ATRIA_DESKTOP_APP;
  const executablePath = packagedApp
    ? join(resolve(packagedApp), "Contents/MacOS/CoworkOS")
    : await developmentExecutable();
  let native;
  const launch = async () => {
    native = await electron.launch({
      executablePath,
      args: ["--use-mock-keychain", ...(packagedApp ? [] : [resolve(".")])],
      env,
      timeout: 60_000
    });
    await native.evaluate(({ app, BrowserWindow, shell }) => {
      app.hide();
      BrowserWindow.getAllWindows().forEach((window) => window.hide());
      globalThis.__permissionSettingsUrls = [];
      shell.openExternal = async (url) => {
        globalThis.__permissionSettingsUrls.push(url);
      };
    });
    const page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toBeAttached();
    const model = page.getByRole("dialog", { name: "连接模型", exact: true });
    await expect(model).toBeVisible();
    await model.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(model).toBeHidden();
    return page;
  };
  // Sign requests with the token this isolated backend published. A renderer fetch
  // cannot carry it without the host transport, so the test process talks to the
  // same origin the window is on.
  const call = async (page, path, body) => {
    const response = await fetch(new URL(path, page.url()), {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-atria-token": process.env.COWORK_API_TOKEN },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    let page = await launch();
    await openWindowSettings(page);
    const toggle = () => page.locator("#computer-access-enabled");
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect((await call(page, "/api/computer/access")).value.policy.enabled).toBe(false);
    expect((await call(page, "/api/computer/status")).value.screenRecording).toBe(false);
    await expect(readFile(requests, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(toggle()).toBeDisabled();
    // The host gate also rejects a forged enable with missing OS grants.
    expect(
      await page.evaluate(async () => {
        try {
          await window.bookmanDesktop.computerUse({ operation: "policy", enabled: true, mode: "control" });
          return "unexpected success";
        } catch (error) {
          return error.message;
        }
      })
    ).toContain("请先开启");
    const screen = page.locator('[data-computer-permission="screenRecording"]');
    const accessibility = page.locator('[data-computer-permission="accessibility"]');
    await screen.click();
    await expect(screen).toContainText("正在申请");
    await expect(toggle()).toBeDisabled();
    expect((await call(page, "/api/computer/access")).value.policy.enabled).toBe(false);
    await expect(screen).toHaveText("屏幕录制已开启", { timeout: 35_000 });
    await expect(screen).toBeDisabled();
    await expect(accessibility).toHaveText("开启辅助功能");
    await expect(toggle()).toBeDisabled();
    await accessibility.click();
    await expect(accessibility).toHaveText("辅助功能已开启", { timeout: 35_000 });
    await expect(accessibility).toBeDisabled();
    await expect(toggle()).toBeEnabled();
    expect((await call(page, "/api/computer/access")).value.policy.enabled).toBe(false);
    expect(backend.approvals()).toBe(0);
    await toggle().click();
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    expect(backend.approvals()).toBe(1);
    await expect(page.locator("[data-computer-permissions]")).toContainText("权限已开启");
    expect(await native.evaluate(() => globalThis.__permissionSettingsUrls)).toEqual([]);
    expect(
      (await readFile(requests, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).permission)
    ).toEqual(["screenRecording", "accessibility"]);
    expect((await call(page, "/api/computer/access")).value.policy).toEqual({
      enabled: true,
      mode: "control"
    });
    expect(JSON.parse(await readFile(join(data, "computer-policy.json"), "utf8")).policy).toEqual({
      enabled: true,
      mode: "control"
    });
    await page.screenshot({
      path: test.info().outputPath("native-window-access-settings.png"),
      fullPage: true,
      animations: "disabled"
    });
    await page.locator("#settings-back").click();
    let previousGrant, previousFrame;
    for (const [index, window] of [target, second].entries()) {
      const taskId = `settings-task-${index}`;
      expect((await call(page, "/api/tasks", { taskId, goal: "Isolated settings acceptance" })).status).toBe(
        201
      );
      expect((await call(page, `/api/tasks/${taskId}/computer/discover`, {})).value.windows).toHaveLength(2);
      const selected = await call(page, `/api/tasks/${taskId}/computer/select`, {
        pid: window.pid,
        windowId: window.windowId,
        mode: "control"
      });
      expect(selected.status).toBe(200);
      const grant = selected.value.session;
      expect(grant.source).toBe("global");
      const observed = await call(page, `/api/tasks/${taskId}/computer/observe`, {
        sessionId: grant.sessionId
      });
      expect(observed.status).toBe(200);
      const acted = await call(page, `/api/tasks/${taskId}/computer/act`, {
        sessionId: grant.sessionId,
        observationId: observed.value.observationId,
        action: { type: "type", text: `Synthetic window ${index}` }
      });
      expect(acted.status).toBe(200);
      expect(acted.value.dispatched).toBe(true);
      previousGrant = grant;
      previousFrame = observed.value;
      await page.reload();
      await page.locator("#user-menu-button").waitFor();
      const access = (await call(page, "/api/computer/access")).value;
      expect(access.policy.enabled).toBe(true);
      expect(access.paused).toBe(false);
      expect(access.owner).toBeNull();
      expect(
        (
          await call(page, `/api/tasks/${taskId}/computer/observe`, {
            sessionId: grant.sessionId
          })
        ).status
      ).toBe(403);
    }
    expect(
      (await readFile(effects, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).target.windowId)
    ).toEqual([12, 22]);
    const firstOrigin = page.url();
    await native.close();
    native = undefined;
    page = await launch();
    // The relaunched window reopens on the same backend; the selected task is restored separately.
    expect(new URL(page.url()).origin).toBe(new URL(firstOrigin).origin);
    await openWindowSettings(page);
    expect(backend.approvals()).toBe(1);
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect((await readFile(requests, "utf8")).trim().split("\n")).toHaveLength(2);
    const restored = (await call(page, "/api/computer/access")).value;
    expect(restored.policy).toEqual({ enabled: true, mode: "control" });
    expect(restored.owner).toBeNull();
    expect(
      (
        await call(page, "/api/tasks/settings-task-1/computer/act", {
          sessionId: previousGrant.sessionId,
          observationId: previousFrame.observationId,
          action: { type: "type", text: "must not arrive" }
        })
      ).status
    ).toBe(403);
    const selected = await call(page, "/api/tasks/settings-task-0/computer/select", {
      pid: target.pid,
      windowId: target.windowId,
      mode: "control"
    });
    expect(selected.status).toBe(200);
    const waiting = call(page, "/api/tasks/settings-task-1/computer/select", {
      pid: second.pid,
      windowId: second.windowId,
      mode: "control"
    });
    await expect
      .poll(async () => (await call(page, "/api/computer/access")).value.waitingTaskIds)
      .toEqual(["settings-task-1"]);
    await toggle().click();
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
    expect((await waiting).status).toBe(403);
    expect(
      (
        await call(page, "/api/tasks/settings-task-0/computer/observe", {
          sessionId: selected.value.session.sessionId
        })
      ).status
    ).toBe(403);
    expect((await call(page, "/api/tasks/settings-task-1/computer/discover", {})).status).toBe(403);
    await native.close();
    native = undefined;
    page = await launch();
    await openWindowSettings(page);
    await expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect((await call(page, "/api/computer/access")).value.policy.enabled).toBe(false);
    expect((await readFile(effects, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await readFile(requests, "utf8")).trim().split("\n")).toHaveLength(2);
    await toggle().click();
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => backend.approvals()).toBe(2);
    await expect
      .poll(async () => JSON.parse(await readFile(join(data, "computer-policy.json"), "utf8")).policy.enabled)
      .toBe(true);
    await expect.poll(async () => (await call(page, "/api/computer/access")).value.policy.enabled).toBe(true);
    await writeFile(
      permissions,
      JSON.stringify({ screenRecording: false, accessibility: true, postEventAccess: true })
    );
    await native.close();
    native = undefined;
    page = await launch();
    await openWindowSettings(page);
    await expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await expect(toggle()).toBeEnabled();
    expect((await call(page, "/api/computer/access")).value.policy.enabled).toBe(true);
    expect(JSON.parse(await readFile(join(data, "computer-policy.json"), "utf8")).policy.enabled).toBe(true);
    expect((await readFile(requests, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    await native?.close();
    await backend.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("denying either system permission keeps access disabled and opens only its settings pane", async () => {
  test.skip(process.platform !== "darwin", "Native settings acceptance requires macOS");
  test.setTimeout(90_000);
  const data = await mkdtemp(join(tmpdir(), "atria-computer-permission-denied-"));
  let native, backend;
  try {
    const { helper, requests } = await isolatedDriver(data, [], false);
    backend = await isolatedBackend(data, helper);
    const packagedApp = process.env.ATRIA_DESKTOP_APP;
    native = await electron.launch({
      executablePath: packagedApp
        ? join(resolve(packagedApp), "Contents/MacOS/CoworkOS")
        : await developmentExecutable(),
      args: ["--use-mock-keychain", ...(packagedApp ? [] : [resolve(".")])],
      env: { ...desktopSmokeEnvironment({ data }), COWORK_COMPUTER_USE_EXECUTABLE: helper },
      timeout: 60_000
    });
    await native.evaluate(({ app, BrowserWindow, shell }) => {
      app.hide();
      BrowserWindow.getAllWindows().forEach((window) => window.hide());
      globalThis.__permissionSettingsUrls = [];
      shell.openExternal = async (url) => {
        globalThis.__permissionSettingsUrls.push(url);
      };
    });
    const page = await native.firstWindow();
    const model = page.getByRole("dialog", { name: "连接模型", exact: true });
    await expect(model).toBeVisible();
    await model.getByRole("button", { name: "关闭设置", exact: true }).click();
    await openWindowSettings(page);
    const toggle = page.locator("#computer-access-enabled");
    const screen = page.locator('[data-computer-permission="screenRecording"]');
    const accessibility = page.locator('[data-computer-permission="accessibility"]');
    await expect(toggle).toBeDisabled();
    await screen.click();
    await expect
      .poll(async () => native.evaluate(() => globalThis.__permissionSettingsUrls))
      .toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
    await accessibility.click();
    await expect
      .poll(async () => native.evaluate(() => globalThis.__permissionSettingsUrls))
      .toEqual([
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      ]);
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(screen).toBeEnabled();
    await expect(accessibility).toBeEnabled();
    await expect(page.locator("[data-computer-request]")).toHaveCount(0);
    const post = (path, body) =>
      fetch(new URL(path, page.url()), {
        method: "POST",
        headers: { "content-type": "application/json", "x-atria-token": process.env.COWORK_API_TOKEN },
        body: JSON.stringify(body)
      });
    expect(
      (await post("/api/tasks", { taskId: "denied-task", goal: "Isolated denied permission" })).status
    ).toBe(201);
    const selectedStatus = (
      await post("/api/tasks/denied-task/computer/select", { pid: 11, windowId: 12, mode: "control" })
    ).status;
    expect(selectedStatus).toBe(403);
    expect((await readFile(requests, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(backend.approvals()).toBe(0);
  } finally {
    await native?.close();
    await backend?.close();
    await rm(data, { recursive: true, force: true });
  }
});
