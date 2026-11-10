import { test, expect } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("compact binding rows stay readable, scrollable and keyboard focused during polling", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// isolated binding fixture" })
    );
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createBindingControl } = await import("/assets/workbench/binding.js");
      const { createMenu } = await import("/assets/ui/menu.js");
      const button = document.querySelector("#app-bind-select");
      const menu = document.querySelector("#app-bind-menu");
      const instances = Array.from({ length: 12 }, (_, i) => ({
        appInstanceId: `app-${i}`,
        resourceId: `res-${i}`,
        status: "open",
        appType: "cad",
        standalone: i !== 0,
        elsewhere: i !== 0,
        title: i === 0 ? "直列四缸四冲程发动机运动装配.cad.json" : `另一个对话的长文档名称-${i}.cad.json`,
        taskGoal: "帮我做一个介绍这个 harness 的解读和模型协作交互方案，然后继续完善文档"
      }));
      const snapshot = {
        instances,
        boundResourceId: "res-0",
        applications: [{ appType: "cad", displayName: "参数化 CAD" }]
      };
      const control = createBindingControl({
        button,
        menu,
        label: button.querySelector(".app-bind-name"),
        getTaskId: () => "task-a",
        api: {},
        onSelect() {}
      });
      createMenu(button, menu, { toggleOnClick: false });
      button.addEventListener("click", () => control.toggle());
      control.update(snapshot);
      window.bindingFixture = { control, snapshot };
    });
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.locator("#app-bind-select").click();
      const menu = page.locator("#app-bind-menu");
      await expect(menu).toBeVisible();
      const surface = await menu.evaluate((node) => {
        const sample = document.createElement("span");
        sample.style.backgroundColor = "var(--popover-fill)";
        node.append(sample);
        const color = getComputedStyle(sample).backgroundColor;
        sample.remove();
        return color;
      });
      const geometry = await menu.evaluate((node) => ({
        box: node.getBoundingClientRect().toJSON(),
        color: getComputedStyle(node).backgroundColor,
        scrollable: node.scrollHeight > node.clientHeight,
        rows: [...node.querySelectorAll("[data-bind-instance]")].map((row) => {
          const box = row.getBoundingClientRect();
          const content = row.querySelector(".model-option-name").getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, contentBottom: content.bottom };
        })
      }));
      expect(geometry.box.x).toBeGreaterThanOrEqual(0);
      expect(geometry.box.right).toBeLessThanOrEqual(width);
      expect(geometry.box.y).toBeGreaterThanOrEqual(0);
      expect(geometry.color).toBe(surface);
      expect(geometry.scrollable).toBe(true);
      for (let i = 0; i < geometry.rows.length; i++) {
        expect(geometry.rows[i].contentBottom).toBeLessThanOrEqual(geometry.rows[i].bottom);
        if (i) expect(geometry.rows[i].top).toBeGreaterThanOrEqual(geometry.rows[i - 1].bottom);
      }
      await page.locator("[data-bind-instance='app-6']").focus();
      const previous = await menu.evaluate((node) => node.scrollTop);
      await page.evaluate(() => window.bindingFixture.control.update(window.bindingFixture.snapshot));
      await expect(page.locator("[data-bind-instance='app-6']")).toBeFocused();
      expect(await menu.evaluate((node) => node.scrollTop)).toBe(previous);
      await page.keyboard.press("ArrowDown");
      await expect(page.locator("[data-bind-instance='app-7']")).toBeFocused();
      if (width === 1440) {
        await menu.evaluate((node) => {
          node.scrollTop = 0;
        });
        await mkdir(".tmp/binding-verification", { recursive: true });
        await menu.screenshot({ path: test.info().outputPath("menu.png") });
      }
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
  } finally {
    await dashboard.stop();
  }
});

/**
 * The conversation's binding menu is a real surface, but no application ships with
 * the product, so these cases open one through the architecture test adapter
 * (`COWORK_APPLICATION_DUMMY`), which is registered only for tests.
 */
const withApplication = () => startDashboard({ env: { COWORK_APPLICATION_DUMMY: "1" } });

async function openDocument(request, base, taskId, title) {
  const created = await request.post(`${base}/api/tasks/${taskId}/resources`, {
    data: { kind: "model/counter+json", title, initialContent: { counters: { [title]: 1 } } }
  });
  expect(created.status()).toBe(201);
  const { resource, appInstance } = await created.json();
  expect(
    (
      await request.post(`${base}/api/workbench/tabs`, {
        data: { kind: "application", resourceId: resource.resourceId, bindTo: taskId, activate: false }
      })
    ).ok()
  ).toBe(true);
  return { ...resource, appInstanceId: appInstance.appInstanceId };
}

test("a late binding response keeps the instance chosen before it resolves", async ({ page, request }) => {
  const dashboard = await withApplication();
  let release;
  try {
    const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    for (const id of ["binding-a", "binding-b"]) await store.createTask(id, { goal: id });
    const documents = [
      await openDocument(request, dashboard.base, "binding-a", "A第一份"),
      await openDocument(request, dashboard.base, "binding-a", "A第二份"),
      await openDocument(request, dashboard.base, "binding-b", "B自己的")
    ];
    await request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "application", resourceId: documents[0].resourceId, bindTo: "binding-a", activate: false }
    });
    await request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "conversation", taskId: "binding-a" }
    });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="binding-a"]').click();
    await expect(page.locator("#app-bind-select")).toContainText(documents[0].title);
    const gate = new Promise((done) => {
      release = done;
    });
    let received;
    const started = new Promise((done) => {
      received = done;
    });
    await page.route("**/api/workbench/load-instance", async (route) => {
      if (route.request().method() === "POST" && route.request().postDataJSON().taskId === "binding-a") {
        received();
        await gate;
      }
      await route.continue();
    });
    await page.locator("#app-bind-select").click();
    await page.locator(`[data-bind-instance="${documents[1].appInstanceId}"]`).click();
    await started;
    // While the instance loads, the page owns the window: the sidebar is gone, so a
    // comparison navigation is not reachable from here any more.
    await expect(page.locator("body")).toHaveClass(/app-fullbleed/);
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await expect(page.locator("#app-bind-select")).toBeDisabled();
    release();
    await expect(page.locator("#app-bind-select")).toBeEnabled();
    await expect(page.locator("#app-bind-select")).toContainText(documents[1].title);
    const summary = await (await request.get(`${dashboard.base}/api/tasks/binding-a/app-instances`)).json();
    expect(summary.boundResourceId).toBe(documents[1].resourceId);
  } finally {
    release?.();
    await dashboard.stop();
  }
});

test("binding choices refresh on open and reject instances closed after opening the menu", async ({
  page,
  request
}) => {
  const dashboard = await withApplication();
  try {
    const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    for (const id of ["binding-current", "binding-other"]) await store.createTask(id, { goal: id });
    const documents = [];
    for (const title of ["已关闭", "稍后关闭", "仍可关联", "已丢失"])
      documents.push(await openDocument(request, dashboard.base, "binding-other", title));
    await request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "conversation", taskId: "binding-current" }
    });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="binding-current"]').click();
    await page.locator("#app-bind-select").click();
    for (const document of documents)
      await expect(page.locator(`[data-bind-instance="${document.appInstanceId}"]`)).toBeVisible();
    await page.keyboard.press("Escape");
    // Another window closes a document between periodic polls.
    expect(
      (
        await request.delete(`${dashboard.base}/api/workbench/tabs`, {
          data: { tabId: `window:${documents[0].appInstanceId}` }
        })
      ).ok()
    ).toBe(true);
    // A missing resource can also leave a persisted tab behind.
    const { ApplicationService } = await import("../dist/src/applications/application-service.js");
    const service = new ApplicationService(dashboard.workspaceRoot);
    await rm(service.resources.resourceDirectory(documents[3].appType, documents[3].resourceId), {
      recursive: true
    });
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${documents[2].appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${documents[0].appInstanceId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-bind-instance="${documents[3].appInstanceId}"]`)).toHaveCount(0);
    const mutations = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/workbench/"))
        mutations.push(req.postDataJSON());
    });
    // The option was valid at menu-open time, but has since closed elsewhere.
    await request.patch(`${dashboard.base}/api/workbench/instances/${documents[1].appInstanceId}`, {
      data: { status: "closed" }
    });
    await page.locator(`[data-bind-instance="${documents[1].appInstanceId}"]`).click();
    await expect(page.locator("#toast")).toContainText("应用已关闭，请重新选择");
    expect(mutations.filter((entry) => entry.taskId === "binding-current")).toEqual([]);
    await expect(page.locator("#app-bind-select")).toBeEnabled();
    await page.locator("#app-bind-select").click();
    await page.locator(`[data-bind-instance="${documents[2].appInstanceId}"]`).click();
    await expect(page.locator("#app-bind-select")).toContainText(documents[2].title);
    const summary = await (
      await request.get(`${dashboard.base}/api/tasks/binding-current/app-instances`)
    ).json();
    expect(summary.boundResourceId).toBe(documents[2].resourceId);
    // Closing the view leaves the conversation loading the same instance.
    const closed = page.waitForResponse(
      (response) => response.url().endsWith("/api/workbench/tabs") && response.request().method() === "DELETE"
    );
    await page.locator(`[data-tab-rail] [data-close-tab="window:${documents[2].appInstanceId}"]`).click();
    expect((await closed).ok()).toBe(true);
    await expect(page.locator("#app-bind-select")).toContainText(documents[2].title);
    await expect(page.locator("#app-bind-select")).toBeVisible();
    const tabs = await (await request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    expect(tabs.tabs.filter((tab) => tab.kind === "application")).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("cached binding choices remain usable while an existing tab poll is waiting", async ({
  page,
  request
}) => {
  const dashboard = await withApplication();
  let release;
  try {
    const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
    await new LocalWorkspaceStore(dashboard.workspaceRoot).createTask("binding-cached", { goal: "加载应用" });
    const document = await openDocument(request, dashboard.base, "binding-cached", "设计草稿");
    await request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "conversation", taskId: "binding-cached" }
    });
    await page.goto(`${dashboard.base}/?task=binding-cached`);
    const button = page.locator("#app-bind-select");
    const menu = page.locator("#app-bind-menu");
    await button.click();
    await expect(menu.locator(`[data-bind-instance="${document.appInstanceId}"]`)).toBeVisible();
    await expect(menu).toHaveAttribute("aria-busy", "false");
    await page.keyboard.press("Escape");

    let reads = 0;
    let started;
    const pending = new Promise((resolve) => (started = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    await page.route("**/api/workbench/tabs", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      reads++;
      started();
      await gate;
      await route.continue();
    });
    await pending;
    await button.click();
    await expect(menu).toHaveAttribute("aria-busy", "true");
    await expect(menu.locator(`[data-bind-instance="${document.appInstanceId}"]`)).toBeVisible();
    await expect(menu.getByRole("status")).toHaveCount(0);
    expect(reads, "opening the menu reuses the in-flight tab poll").toBe(1);
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator("[data-bind-instance]").first()).toBeFocused();
    await page.keyboard.press("Escape");
    const refreshed = page.waitForResponse(
      (response) => response.url().endsWith("/api/workbench/tabs") && response.request().method() === "GET"
    );
    release();
    await refreshed;
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
  } finally {
    release?.();
    await dashboard.stop();
  }
});
