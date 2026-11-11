import { test, expect } from "@playwright/test";
import { startConfiguredDashboard, startDashboard } from "../test/dashboard-fixture.mjs";

const section = (page, name) => page.locator(`[data-settings-panel="${name}"]`);
const navItem = (page, name) => page.locator(`[data-settings-section="${name}"]`);

async function openSettings(page) {
  await page.locator("#user-menu-button").click();
  await expect(page.locator("#settings-entry")).toBeVisible();
}

test("the six sections switch from one navigation, return to the entry and no settings dialog remains", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);

    await expect(page.locator("#app-layout")).toBeHidden();
    await expect(page.locator("#settings-entry .settings-nav-item")).toHaveCount(6);
    await expect(navItem(page, "general")).toHaveAttribute("aria-current", "page");
    await expect(section(page, "general")).toBeVisible();
    await expect(section(page, "general").getByRole("heading", { level: 1 })).toHaveText("通用");

    for (const [name, title] of [
      ["nodes", "节点连接"],
      ["models", "模型与角色"],
      ["capacity", "运行名额"],
      ["members", "成员与通道"],
      ["tools", "工具"]
    ]) {
      await navItem(page, name).click();
      await expect(navItem(page, name)).toHaveAttribute("aria-current", "page");
      await expect(section(page, name)).toBeVisible();
      await expect(section(page, name).getByRole("heading", { level: 1 })).toHaveText(title);
      for (const other of ["general", "nodes", "models", "capacity", "members", "tools"])
        if (other !== name) await expect(section(page, other)).toBeHidden();
    }

    // Arrow keys move the same selection the click does.
    await navItem(page, "tools").focus();
    await page.keyboard.press("ArrowUp");
    await expect(navItem(page, "members")).toHaveAttribute("aria-current", "page");
    await expect(section(page, "members")).toBeVisible();

    // Back leaves settings and returns focus to the entry that opened it.
    await page.locator("#settings-back").click();
    await expect(page.locator("#settings-entry")).toBeHidden();
    await expect(page.locator("#app-layout")).toBeVisible();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();

    // Escape is the same exit.
    await openSettings(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-entry")).toBeHidden();
    await expect(page.locator("#app-layout")).toBeVisible();

    await expect(page.locator("#profile-modal")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("general preferences take effect, survive a reload and stay in their sections", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    const response = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "settings-time", goal: "时间格式验收" }
    });
    expect(response.ok()).toBe(true);
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);

    // Theme.
    await page.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator('[data-appearance-value="light"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator('[data-appearance-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // A browser has no native window material, so the row is not offered.
    await expect(page.locator("#window-material-row")).toBeHidden();

    // Reduced motion: on stops rendered animation, off restores it, both persist.
    await page.locator('[data-reduced-motion-value="on"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    const reduced = await page.evaluate(() => {
      const panel = document.createElement("div");
      panel.className = "ui-panel";
      document.body.append(panel);
      const animation = getComputedStyle(panel).animationName;
      panel.remove();
      return animation;
    });
    expect(reduced).toBe("none");
    await page.locator('[data-reduced-motion-value="off"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "off");
    expect(
      await page.evaluate(() => {
        const panel = document.createElement("div");
        panel.className = "ui-panel";
        document.body.append(panel);
        const animation = getComputedStyle(panel).animationName;
        panel.remove();
        return animation;
      })
    ).toBe("formicand-panel-in");

    // Time format changes how the same record is written.
    await page.locator('[data-time-format-value="absolute"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-time-format", "absolute");
    await page.locator("#settings-back").click();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const result = page.locator(".search-result").first();
    await expect(result).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await page.keyboard.press("Escape");

    await openSettings(page);
    await page.locator('[data-time-format-value="relative"]').click();
    await page.locator("#settings-back").click();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-result").first()).not.toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await page.keyboard.press("Escape");

    // Every choice survives a reload.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "off");
    await expect(page.locator("html")).toHaveAttribute("data-time-format", "relative");
    await openSettings(page);
    await expect(page.locator('[data-appearance-value="dark"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-reduced-motion-value="off"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-time-format-value="relative"]')).toHaveAttribute("aria-checked", "true");

    // Language keeps its control and the about group keeps its update action.
    await expect(page.locator("#language-select")).toHaveValue("zh-CN");
    await expect(page.locator("#profile-settings-about")).toContainText("Formicand");
    await expect(page.locator("[data-update-action]")).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("model connections and the three roles are edited and saved from the settings page", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);
    await navItem(page, "models").click();
    await expect(section(page, "models")).toBeVisible();

    // An empty host still shows where a connection is added, never a fake one.
    await expect(page.locator("#profile-settings-connections")).toContainText("尚未配置模型连接");

    await page.locator("#settings-model-add").click();
    const form = page.getByRole("dialog", { name: "连接模型" });
    await expect(form).toBeVisible();
    await form.getByRole("textbox", { name: "配置名称", exact: false }).fill("验收连接");
    await form.getByRole("textbox", { name: "模型 ID", exact: true }).fill("acceptance-model");
    await form.getByRole("textbox", { name: "API 地址", exact: true }).fill("http://127.0.0.1:1/v1");
    await form.getByLabel("API Key").fill("test-key-not-echoed");
    await form.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(form).toBeHidden();

    const row = page.locator("#profile-settings-connections .settings-row").first();
    await expect(row).toContainText("验收连接");
    await expect(row).toContainText("当前启用");
    // The key never comes back to the page.
    expect(await page.locator("#settings-entry").innerText()).not.toContain("test-key-not-echoed");

    // Main/Executor/Reviewer each bind a connection through the existing roles API.
    for (const role of ["main", "executor", "reviewer"])
      await expect(page.locator(`[data-model-role="${role}"]`)).toBeVisible();
    await page.locator('[data-role-model="executor"]').selectOption({ label: "验收连接 / acceptance-model" });
    await expect
      .poll(async () => {
        const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
        return status.modelRoles.roles.find((entry) => entry.role === "executor")?.host?.profileId;
      })
      .not.toBeUndefined();
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    const bound = status.modelRoles.roles.find((entry) => entry.role === "executor");
    expect(bound.host.profileId).toBe(status.profiles[0].id);

    // Reopening the page reads the saved bindings back.
    await page.locator("#settings-back").click();
    await openSettings(page);
    await navItem(page, "models").click();
    await expect(page.locator('[data-role-model="executor"]')).toHaveValue(status.profiles[0].id);

    // Inference effort belongs to the connection both roles use.
    await page.locator('[data-role-effort="main"]').selectOption("high");
    await expect
      .poll(async () => {
        const value = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
        return value.profiles[0].reasoningEffort;
      })
      .toBe("high");
    await expect(page.locator('[data-role-effort="executor"]')).toHaveValue("high");

    // Each connection opens the same form for editing.
    await page.locator("[data-model-edit]").first().click();
    await expect(page.getByRole("dialog", { name: "连接模型" })).toBeVisible();
    await page.getByRole("button", { name: "返回设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "连接模型" })).toBeHidden();
    await expect(page.locator("#settings-entry")).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});

test("node connections, tools and members show only the information each section owns", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await openSettings(page);

    await navItem(page, "nodes").click();
    const local = page.locator("#settings-node-local .settings-row").first();
    await expect(local).toContainText("本机");
    await expect(local).toContainText("对内");
    await expect(local).toContainText("在线");
    await expect(page.locator("#settings-node-data")).toContainText("SQLite · 由本机提供");
    // The host appends its backend-switcher row to this box; rendering the
    // local node must not remove it.
    await expect(page.locator("#settings-node-local [data-backend-open]")).toHaveCount(1);
    await page.locator("#settings-node-local [data-backend-open]").click();
    await expect(page.getByRole("dialog", { name: "后端" })).toBeVisible();
    await page.locator("[data-backend-close]").click();
    await expect(page.getByRole("dialog", { name: "后端" })).toBeHidden();
    // No remote node is stored yet: the group only offers the add action.
    await expect(page.locator("#settings-node-remote-group")).toBeVisible();
    await expect(page.locator("#settings-node-add")).toBeVisible();
    await expect(page.locator("#settings-node-remote")).toBeHidden();
    await expect(page.locator("#settings-node-remote .settings-row")).toHaveCount(0);

    await navItem(page, "tools").click();
    const tools = page.locator("#profile-settings-tools");
    await expect(tools).toContainText("联网搜索");
    await expect(tools).toContainText("个人记忆");
    await expect(tools).toContainText("窗口访问");
    await tools.getByRole("button", { name: "管理联网搜索" }).click();
    await expect(page.getByRole("dialog", { name: "联网搜索" })).toBeVisible();
    await page.getByRole("button", { name: "返回设置", exact: true }).click();
    await expect(page.locator("#settings-entry")).toBeVisible();

    await navItem(page, "members").click();
    const members = page.locator("#settings-member-rows");
    await expect(members).toContainText("我");
    await expect(members.locator(".settings-chip.is-accent")).toHaveText("负责人");
  } finally {
    await dashboard.stop();
  }
});

test("a refused role change reports on its row and restores the saved connection", async ({ page }) => {
  const dashboard = await startConfiguredDashboard();
  try {
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    const connection = status.profiles[0];
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="models"]').click();
    const main = page.locator('[data-role-model="main"]');
    const row = page.locator('[data-model-role="main"]');
    await expect(main).toHaveValue("");

    // Save one binding so the refused change has a persisted value to return to.
    await main.selectOption(connection.id);
    await expect(main).toHaveValue(connection.id);

    await page.route("**/api/model-settings/roles", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "保存被拒绝：连接不可用" })
      })
    );
    await main.selectOption("");
    await expect(row.locator("[data-role-error]")).toHaveText(/保存被拒绝/);
    await expect(row).toHaveClass(/has-error/);
    await expect(main).toHaveValue(connection.id);
    // The failure belongs to the section, never to the closed connection form.
    expect(await page.locator("[data-model-error]").innerText()).toBe("");
  } finally {
    await dashboard.stop();
  }
});
