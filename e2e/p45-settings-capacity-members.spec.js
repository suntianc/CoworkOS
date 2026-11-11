import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const NODES = [
  { origin: "https://cloud.example.test", name: "云端", role: "external", state: "online" },
  { origin: "https://lab.example.test", name: "测试机", role: "internal", state: "offline" }
];

test("runtime capacity lists remote external nodes only and saves both quotas", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript((nodes) => {
      localStorage.setItem("formicand.nodes.v1", JSON.stringify(nodes));
    }, NODES);
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    await expect(page.locator("#settings-node-local")).toContainText("本机");
    await expect(page.locator("#settings-node-remote")).toContainText("云端");
    await expect(page.locator("#settings-node-remote")).toContainText("对外");
    await expect(page.locator("#settings-node-remote")).toContainText("测试机");
    await expect(page.locator("#settings-node-remote")).toContainText("离线");

    await page.locator('[data-settings-section="capacity"]').click();
    const groups = page.locator("#settings-capacity-nodes [data-capacity-node]");
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toContainText("云端");
    await expect(page.locator("#settings-capacity-nodes")).not.toContainText("本机");
    await expect(page.locator("#settings-capacity-nodes")).not.toContainText("测试机");

    const resident = page.locator('[data-capacity-kind="regular"]');
    const continuation = page.locator('[data-capacity-kind="continuation"]');
    await expect(resident.locator("[data-capacity-value]")).toHaveText("1");
    await expect(continuation.locator("[data-capacity-value]")).toHaveText("0");

    await resident.getByRole("button", { name: "增加常驻 Main" }).click();
    await resident.getByRole("button", { name: "增加常驻 Main" }).click();
    await resident.getByRole("button", { name: "增加常驻 Main" }).click();
    await continuation.getByRole("button", { name: "增加接续 Main" }).click();
    await expect(resident.locator("[data-capacity-value]")).toHaveText("4");
    await expect(continuation.locator("[data-capacity-value]")).toHaveText("1");

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => {
        const view = await (await page.request.get(`${dashboard.base}/api/main-capacity`)).json();
        return view.settings;
      })
      .toEqual({ resident: 4, continuation: 1 });

    // 还原 returns the edited numbers to the saved ones without another write.
    await resident.getByRole("button", { name: "增加常驻 Main" }).click();
    await expect(resident.locator("[data-capacity-value]")).toHaveText("5");
    await page.getByRole("button", { name: "还原", exact: true }).click();
    await expect(page.locator('[data-capacity-kind="regular"] [data-capacity-value]')).toHaveText("4");
    await expect(page.locator('[data-capacity-kind="continuation"] [data-capacity-value]')).toHaveText("1");
  } finally {
    await dashboard.stop();
  }
});

test("members show the owner and the notification channels and callbacks stay placeholders", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="members"]').click();
    const members = page.locator("#settings-member-rows");
    await expect(members).toContainText("我");
    await expect(members.locator(".settings-chip.is-accent")).toHaveText("负责人");
    await expect(page.locator("#settings-member-add")).toHaveCount(0);

    const placeholder = page.locator('[data-settings-panel="members"] .is-placeholder');
    await expect(placeholder).toHaveCount(2);
    await expect(placeholder.first()).toContainText("P5 开放");
    await expect(placeholder.last()).toContainText("P5 开放");

    // Channels and callbacks are visible for orientation but cannot be operated.
    for (const button of await page.locator('[data-settings-panel="members"] .settings-outline-button').all())
      await expect(button).toBeDisabled();
    await expect(page.locator('[aria-label="回访间隔"]')).toBeDisabled();
    await expect(page.locator('[data-settings-panel="members"]')).toContainText("项目负责人");
    expect(
      await page.locator('[data-settings-panel="members"] :is(button, select, input):not([disabled])').count()
    ).toBe(0);
  } finally {
    await dashboard.stop();
  }
});
