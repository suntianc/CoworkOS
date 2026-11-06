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
        sample.style.backgroundColor = "var(--ui-panel)";
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

test("a late binding response cannot change the conversation or binding opened since the click", async ({
  page,
  request
}) => {
  const dashboard = await startDashboard();
  let release;
  try {
    const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    for (const id of ["binding-a", "binding-b"]) await store.createTask(id, { goal: id });
    const documents = [];
    for (const [taskId, title] of [
      ["binding-a", "A第一份.txt"],
      ["binding-a", "A第二份.txt"],
      ["binding-b", "B自己的.txt"]
    ]) {
      const created = await request.post(`${dashboard.base}/api/tasks/${taskId}/resources`, {
        data: { kind: "text/plain", title, initialContent: title }
      });
      expect(created.status()).toBe(201);
      const { resource, appInstance } = await created.json();
      documents.push({ ...resource, appInstanceId: appInstance.appInstanceId });
      expect(
        (
          await request.post(`${dashboard.base}/api/workbench/tabs`, {
            data: { kind: "application", resourceId: resource.resourceId, bindTo: taskId, activate: false }
          })
        ).ok()
      ).toBe(true);
    }
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
    await expect(page.locator("#app-bind-select")).toBeDisabled();
    await page.locator('#project-list [data-task="binding-b"]').click();
    await page.locator("#composer-input").fill("保留 B 的草稿");
    release();
    await expect(page.locator("#app-bind-select")).toBeEnabled();
    await expect(page.locator("#app-bind-select")).toContainText(documents[2].title);
    await expect(page.locator("#composer-input")).toHaveValue("保留 B 的草稿");
    await expect(page.locator("#project-list [data-task='binding-b']")).toHaveClass(/active/);
    const summary = await (await request.get(`${dashboard.base}/api/tasks/binding-a/app-instances`)).json();
    expect(summary.boundResourceId).toBe(documents[1].resourceId);
  } finally {
    release?.();
    await dashboard.stop();
  }
});

test("binding choices refresh on open and reject documents closed after opening the menu", async ({
  page,
  request
}) => {
  const dashboard = await startDashboard();
  try {
    const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    for (const id of ["binding-current", "binding-other"]) await store.createTask(id, { goal: id });
    const documents = [];
    for (const title of ["已关闭.txt", "稍后关闭.txt", "仍可关联.txt", "已丢失.txt"]) {
      const created = await request.post(`${dashboard.base}/api/tasks/binding-other/resources`, {
        data: { kind: "text/plain", title, initialContent: title }
      });
      expect(created.status()).toBe(201);
      const { resource, appInstance } = await created.json();
      documents.push({ ...resource, appInstanceId: appInstance.appInstanceId });
      await request.post(`${dashboard.base}/api/workbench/tabs`, {
        data: { kind: "application", resourceId: resource.resourceId, activate: false }
      });
    }
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
    const close = async (resource) => {
      expect(
        (
          await request.delete(`${dashboard.base}/api/workbench/tabs`, {
            data: { tabId: `window:${resource.appInstanceId}` }
          })
        ).ok()
      ).toBe(true);
    };
    await close(documents[0]);
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
  const dashboard = await startDashboard();
  let release;
  try {
    const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
    await new LocalWorkspaceStore(dashboard.workspaceRoot).createTask("binding-cached", { goal: "加载应用" });
    const created = await request.post(`${dashboard.base}/api/tasks/binding-cached/resources`, {
      data: { kind: "text/plain", title: "设计草稿.txt", initialContent: "草稿" }
    });
    expect(created.status()).toBe(201);
    const { resource, appInstance } = await created.json();
    await request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "application", resourceId: resource.resourceId, activate: false }
    });
    await request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "conversation", taskId: "binding-cached" }
    });
    await page.goto(`${dashboard.base}/?task=binding-cached`);
    const button = page.locator("#app-bind-select");
    const menu = page.locator("#app-bind-menu");
    await button.click();
    await expect(menu.locator(`[data-bind-instance="${appInstance.appInstanceId}"]`)).toBeVisible();
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
    await expect(menu.locator(`[data-bind-instance="${appInstance.appInstanceId}"]`)).toBeVisible();
    await expect(menu.getByRole("status")).toHaveCount(0);
    expect(reads, "opening the menu reuses the in-flight tab poll").toBe(1);
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator("[data-bind-instance]").first()).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("cached-menu.png") });
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
