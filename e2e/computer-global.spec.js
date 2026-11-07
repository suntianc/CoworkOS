import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function openSettings(page) {
  await page.locator("#user-menu-button").click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
  const section = page.locator('details[aria-label="窗口访问"]');
  if (!(await section.evaluate((element) => element.open))) await section.locator("summary").click();
}

async function hostFixture(page) {
  const target = { pid: 11, windowId: 12, application: "Fixture", title: "Test window" };
  const state = {
    policy: { enabled: false, mode: "observe" },
    paused: false,
    blocked: false,
    disconnected: false,
    session: null,
    operations: [],
    status: { available: true, screenRecording: true, accessibility: true, controlAvailable: true }
  };
  await page.exposeFunction("__computerHost", async (input) => {
    state.operations.push(input);
    if (input.operation === "policy-status")
      return {
        ...(state.savedPolicy ?? state.policy),
        ...(state.approvalRequired ? { approvalRequired: true } : {})
      };
    if (input.operation === "policy") {
      if (state.save) return state.save(input);
      state.policy = { enabled: input.enabled, mode: input.mode };
      state.approvalRequired = false;
      state.session = null;
      state.paused = false;
      state.blocked = false;
      return state.policy;
    }
    if (input.operation === "pause") {
      state.paused = true;
      if (state.session) state.session.state = "paused";
      return state.session;
    }
    if (input.operation === "resume") {
      state.paused = false;
      state.blocked = false;
      if (state.session) state.session = { ...state.session, state: "active", sessionId: "resumed" };
      return {};
    }
    if (input.operation === "permissions") return state.requestPermission?.(input.permission) || {};
    throw new Error(`Unexpected host operation: ${input.operation}`);
  });
  await page.addInitScript(() => {
    window.bookmanDesktop = {
      computerUse: async (input) => {
        const result = await window.__computerHost(input);
        if (input.operation === "policy") window.__lastPolicyResult = result;
        return result;
      },
      modelStatus: async () => ({ configured: true, supportsImages: true }),
      onPrepareClose() {}
    };
  });
  await page.route("**/api/computer/access", (route) =>
    state.disconnected
      ? route.abort()
      : route.fulfill({
          json: {
            policy: state.policy,
            paused: state.paused,
            owner: state.session && state.session.state !== "ended" ? state.session : null,
            waitingTaskIds: []
          }
        })
  );
  await page.route("**/api/computer/status", (route) =>
    route.fulfill({ json: { ...state.status, windows: [target] } })
  );
  await page.route("**/api/tasks/*/computer", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      json: {
        session: state.session?.taskId === id ? state.session : null,
        access: { taskBlocked: state.blocked && id === "owner-task" }
      }
    });
  });
  state.takeControl = (taskId = "owner-task") => {
    state.session = { taskId, target, state: "active", mode: "control", source: "global" };
  };
  return state;
}

test("three settings buttons gate full access for all conversations and persists on reload", async ({
  page,
  request
}) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("保留未发送草稿");
    await openSettings(page);
    const toggle = page.locator("#computer-access-enabled");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect.poll(() => host.policy).toEqual({ enabled: true, mode: "control" });
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    expect(host.operations.filter((input) => input.operation === "policy")).toEqual([
      { operation: "policy", enabled: true, mode: "control" }
    ]);
    await expect(
      page.locator(
        "[data-computer-window], [data-computer-mode], [data-computer-global-mode], [data-computer-global-save], #computer-access-dialog"
      )
    ).toHaveCount(0);
    await page.locator("#profile-close").click();
    await expect(page.locator("#composer-input")).toHaveValue("保留未发送草稿");
    const tasks = (await (await request.get(`${dashboard.base}/api/tasks`)).json()).tasks;
    expect(tasks.filter((task) => task.taskId !== "workspace")).toHaveLength(0);
    await page.reload();
    await openSettings(page);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect.poll(() => host.policy.enabled).toBe(false);
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
  } finally {
    await dashboard.stop();
  }
});

test("saved window access waits for an explicit local confirmation", async ({ page }) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  host.savedPolicy = { enabled: true, mode: "control" };
  host.approvalRequired = true;
  try {
    await page.goto(dashboard.base);
    await openSettings(page);
    await expect(page.locator("[data-computer-state]")).toHaveText("等待本机确认");
    const toggle = page.locator("#computer-access-enabled");
    await expect(toggle).toHaveText("确认并开启窗口访问");
    expect(host.operations.some((input) => input.operation === "policy")).toBe(false);
    await toggle.click();
    await expect.poll(() => host.policy.enabled).toBe(true);
    await expect(page.locator("[data-computer-state]")).toHaveText("已开启");
  } finally {
    await dashboard.stop();
  }
});

test("the active owner stays visible across conversations; takeover needs explicit human resume", async ({
  page,
  request
}) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  host.policy = { enabled: true, mode: "control" };
  try {
    await request.post(`${dashboard.base}/api/tasks`, { data: { taskId: "owner-task", goal: "窗口任务" } });
    await page.goto(dashboard.base);
    host.takeControl();
    await expect(page.locator("[data-computer-label]")).toContainText("Fixture");
    await page.locator("[data-computer-pause]").click();
    await expect(page.locator(".computer-control-bar")).toHaveAttribute("data-state", "paused");
    await expect(page.locator("[data-computer-bar-resume]")).toBeVisible();
    await page.locator("[data-computer-bar-resume]").click();
    await expect.poll(() => host.paused).toBe(false);
    await expect(page.locator(".computer-control-bar")).toHaveAttribute("data-state", "active");
    await page.locator('#project-list [data-task="owner-task"]').click();
    host.session.state = "ended";
    host.blocked = true;
    await openSettings(page);
    await expect(page.locator("[data-computer-state]")).toContainText("当前对话已停止");
    host.takeControl("other-task");
    await expect(page.locator("[data-computer-label]")).toContainText("Fixture");
    await expect(page.locator("#computer-access-enabled")).toHaveText("恢复窗口访问");
    await page.locator("#computer-access-enabled").click();
    await expect.poll(() => host.blocked).toBe(false);
    await page.locator("#computer-access-enabled").click();
    await expect(page.locator(".computer-control-bar")).toBeHidden();
    expect(host.operations.some((input) => input.operation === "authorize")).toBe(false);
  } finally {
    await dashboard.stop();
  }
});

test("switching off while enable is pending ignores its late response", async ({ page }) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  let release, began;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    began = resolve;
  });
  host.save = async (input) => {
    if (input.enabled) {
      began();
      await held;
      return { enabled: true, mode: "control" };
    }
    return (host.policy = { enabled: false, mode: "control" });
  };
  try {
    await page.goto(dashboard.base);
    await openSettings(page);
    const toggle = page.locator("#computer-access-enabled");
    await toggle.click();
    await started;
    await toggle.click();
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
    release();
    await page.waitForFunction(() => window.__lastPolicyResult?.enabled === true);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
    await expect(page.locator(".computer-control-bar")).toBeHidden();
  } finally {
    release();
    await dashboard.stop();
  }
});

test("failed persistence restores the access button and keeps the save error visible", async ({ page }) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  host.save = async () => {
    throw new Error("测试磁盘无法写入");
  };
  try {
    await page.goto(dashboard.base);
    await openSettings(page);
    const toggle = page.locator("#computer-access-enabled");
    await toggle.click();
    await expect(page.locator("[data-computer-error]")).toContainText("测试磁盘无法写入");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(host.policy.enabled).toBe(false);
  } finally {
    await dashboard.stop();
  }
});

test("three buttons grant each OS permission independently and require a separate access click", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  host.status.screenRecording = false;
  host.status.accessibility = false;
  const requests = [];
  host.requestPermission = async (permission) => {
    requests.push(permission);
    return { requested: true };
  };
  try {
    await page.goto(dashboard.base);
    await openSettings(page);
    const access = page.locator("#computer-access-enabled");
    const screen = page.locator('[data-computer-permission="screenRecording"]');
    const accessibility = page.locator('[data-computer-permission="accessibility"]');
    await expect(page.locator(".computer-setting button")).toHaveCount(3);
    await expect(access).toBeDisabled();
    await screen.click();
    await expect.poll(() => requests).toEqual(["screenRecording"]);
    await expect(screen).toHaveText("开启屏幕录制");
    await expect(access).toBeDisabled();
    expect(host.policy.enabled).toBe(false);
    host.status.screenRecording = true;
    await expect(screen).toHaveText("屏幕录制已开启");
    await expect(screen).toBeDisabled();
    await expect(accessibility).toBeEnabled();
    await expect(access).toBeDisabled();
    await accessibility.click();
    await expect.poll(() => requests).toEqual(["screenRecording", "accessibility"]);
    host.status.accessibility = true;
    await expect(accessibility).toHaveText("辅助功能已开启");
    await expect(accessibility).toBeDisabled();
    await expect(access).toBeEnabled();
    await expect(access).toHaveAttribute("aria-pressed", "false");
    expect(host.policy.enabled).toBe(false);
    await access.click();
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    host.status.screenRecording = false;
    await expect(screen).toBeEnabled();
    await expect(page.locator("[data-computer-state]")).toHaveText("等待系统授权");
    await access.click();
    await expect(access).toHaveAttribute("aria-pressed", "false");
    await expect(access).toBeDisabled();
    expect(host.policy.enabled).toBe(false);
  } finally {
    await dashboard.stop();
  }
});

test("settings show each OS permission while the switch is off and refresh on return to CoworkOS", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  host.status.screenRecording = false;
  host.status.accessibility = true;
  try {
    await page.goto(dashboard.base);
    await openSettings(page);
    const status = page.locator("[data-computer-permissions]");
    await expect(status).toContainText("屏幕录制：未开启");
    await expect(status).toContainText("辅助功能：已开启");
    host.status.screenRecording = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(status).toContainText("权限已开启");
    await expect(page.locator("#computer-access-enabled")).toHaveAttribute("aria-pressed", "false");
    host.status.accessibility = false;
    await expect(status).toContainText("辅助功能：未开启");
    expect(host.operations.every((input) => input.operation === "policy-status")).toBe(true);
  } finally {
    await dashboard.stop();
  }
});

test("permission request failure stays retryable without enabling access", async ({ page }) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  host.status.screenRecording = false;
  host.requestPermission = async () => {
    throw new Error("系统申请超时");
  };
  try {
    await page.goto(dashboard.base);
    await openSettings(page);
    const screen = page.locator('[data-computer-permission="screenRecording"]');
    await screen.click();
    await expect(page.locator("[data-computer-error]")).toContainText("系统申请超时");
    await expect(screen).toBeEnabled();
    await expect(page.locator("#computer-access-enabled")).toBeDisabled();
    expect(host.policy.enabled).toBe(false);
    host.requestPermission = async () => {
      host.status.screenRecording = true;
    };
    await screen.click();
    await expect(screen).toHaveText("屏幕录制已开启");
    await expect(screen).toBeDisabled();
    await expect(page.locator("[data-computer-error]")).toBeHidden();
    expect(host.policy.enabled).toBe(false);
  } finally {
    await dashboard.stop();
  }
});

test("disconnect leaves native takeover usable and a cancelled read cannot revive the owner", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const host = await hostFixture(page);
  host.policy = { enabled: true, mode: "control" };
  try {
    await page.goto(dashboard.base);
    host.takeControl();
    await expect(page.locator("[data-computer-label]")).toContainText("Fixture");
    host.disconnected = true;
    await openSettings(page);
    await expect(page.locator("[data-computer-error]")).toContainText("连接中断");
    await expect(page.locator("[data-computer-pause]")).toBeEnabled();
    await page.locator("#profile-close").click();
    await page.locator("[data-computer-pause]").click();
    await expect.poll(() => host.paused).toBe(true);
    await expect(page.locator(".computer-control-bar")).toHaveAttribute("data-state", "paused");
  } finally {
    await dashboard.stop();
  }
});
