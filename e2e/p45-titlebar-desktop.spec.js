import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

const taskId = "titlebar-task";
const taskGoal = "标题栏验收会话";

async function bootDesktop() {
  const root = await mkdtemp(join(tmpdir(), "atria-p45-titlebar-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:COWORK_|ATRIA_|PI_|EXA_|SERPER_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(key)
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  const executablePath = await developmentExecutable();
  const native = await electron.launch({
    executablePath,
    args: ["--use-mock-keychain", resolve(".")],
    env,
    timeout: 90_000
  });
  await native.evaluate(({ app, BrowserWindow }) => {
    app.hide();
    BrowserWindow.getAllWindows().forEach((window) => window.hide());
  });
  const page = await native.firstWindow();
  await expect(page.locator("#composer-input")).toBeAttached();
  await dismissModelSetup(page);
  return { native, page, root };
}

async function dismissModelSetup(page) {
  const close = page.locator("[data-model-close]");
  await close.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await close.isVisible()) await close.click();
  await expect(page.locator(".settings-backdrop:not([hidden])")).toHaveCount(0);
}

async function createTaskThroughHost(page) {
  // The host attaches its session through the window capability once the
  // selected backend is up, so retry until authorization reports success.
  const result = await page.evaluate(
    async ({ taskId, goal }) => {
      const headers = { "content-type": "application/json" };
      const nonce = window.bookmanDesktop?.transportNonce;
      if (nonce) headers["x-cowork-desktop-nonce"] = nonce;
      let response;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        response = await fetch("/api/tasks", {
          method: "POST",
          headers,
          body: JSON.stringify({ taskId, goal })
        });
        if (response.status !== 401) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { status: response.status, body: await response.text() };
    },
    { taskId, goal: taskGoal }
  );
  expect(result.status, result.body).toBeLessThan(300);
}

test("the desktop window has no title bar, panels reach the top and traffic lights clear the brand", async () => {
  test.skip(process.platform !== "darwin", "macOS traffic lights are the acceptance target");
  test.setTimeout(180_000);
  const { native, page, root } = await bootDesktop();
  try {
    await createTaskThroughHost(page);
    await page.reload();
    await dismissModelSetup(page);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await expect(page.locator("#topbar-task")).toHaveText(taskGoal);

    await expect(page.locator(".app-topbar")).toHaveCount(0);
    await expect(page.locator(".window-nav")).toHaveCount(0);
    await expect(page.locator("#project-context")).toHaveCount(0);

    const boxes = await page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };
      return {
        sidebar: box("#conversation-sidebar"),
        brand: box(".sidebar-header"),
        main: box("#work-entry"),
        header: box(".session-header"),
        title: box("#topbar-task"),
        panel: box("#agent-pane")
      };
    });
    expect(boxes.sidebar).toMatchObject({ x: 0, y: 10 });
    expect(boxes.main).toMatchObject({ x: 258, y: 10 });
    expect(boxes.header.y).toBeLessThanOrEqual(boxes.main.y + 1);
    expect(boxes.title.x).toBeGreaterThan(boxes.main.x);
    expect(boxes.title.y).toBeGreaterThan(boxes.main.y);
    // macOS draws the traffic lights at y≈18..32; the brand row must start below them.
    expect(boxes.brand.y).toBeGreaterThanOrEqual(40);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector(".conversation-sidebar")).paddingTop)
    ).toBe("44px");

    await page.locator("#output-pane-toggle").click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("#agent-pane")).transform === "none"
    );
    const panel = await page.locator("#agent-pane").boundingBox();
    expect(Math.round(panel.y)).toBe(10);
    expect(Math.round(panel.height)).toBe(boxes.sidebar.height);

    const regions = await page.evaluate(() =>
      Object.fromEntries(
        [
          ".app-shell",
          ".app-layout",
          "#conversation-sidebar",
          "#conversation-sidebar .window-drag-band",
          ".sidebar-header",
          ".session-header",
          "#output-pane-toggle",
          "#work-entry",
          ".chat-body",
          "#agent-pane"
        ].map((selector) => [
          selector,
          getComputedStyle(document.querySelector(selector)).getPropertyValue("-webkit-app-region")
        ])
      )
    );
    expect(regions[".app-shell"]).toBe("drag");
    expect(regions[".app-layout"]).toBe("drag");
    expect(regions["#conversation-sidebar"]).toBe("no-drag");
    // The top band drags the window; its controls and the pane content do not.
    expect(regions["#conversation-sidebar .window-drag-band"]).toBe("drag");
    expect(regions[".sidebar-header"]).toBe("drag");
    expect(regions[".session-header"]).toBe("drag");
    expect(regions["#output-pane-toggle"]).toBe("no-drag");
    expect(regions["#work-entry"]).toBe("no-drag");
    // Electron inherits the pane's region into its content.
    expect(regions[".chat-body"]).toBe("no-drag");
    expect(regions["#agent-pane"]).toBe("no-drag");

    await page.locator(`.conversation-item[data-task="${taskId}"]`).click({ button: "right" });
    await expect(page.locator("#session-menu")).toBeVisible();
    await expect(page.locator('#session-menu [data-session-action="rename"]')).toBeEnabled();
    await expect(page.locator('#session-menu [data-session-action="archive"]')).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.locator("#session-menu")).toBeHidden();

    const materials = await page.evaluate(() => ({
      material: document.documentElement.dataset.windowMaterial,
      platform: document.documentElement.dataset.desktopPlatform
    }));
    expect(materials).toEqual({ material: "under-window", platform: "darwin" });
  } finally {
    await native.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the browser keeps its design margin and reserves nothing for native window controls", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#entry-work")).toBeVisible();
    const metrics = await page.evaluate(() => {
      const sidebar = document.querySelector("#conversation-sidebar");
      const brand = document.querySelector(".sidebar-header").getBoundingClientRect();
      const main = document.querySelector("#work-entry").getBoundingClientRect();
      return {
        platform: document.documentElement.dataset.desktopPlatform ?? null,
        paddingTop: getComputedStyle(sidebar).paddingTop,
        brandY: Math.round(brand.y),
        mainX: Math.round(main.x),
        mainY: Math.round(main.y)
      };
    });
    expect(metrics.platform).toBeNull();
    expect(metrics.paddingTop).toBe("16px");
    expect(metrics.brandY).toBe(26);
    expect(metrics.mainX).toBe(258);
    expect(metrics.mainY).toBe(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  } finally {
    await dashboard.stop();
  }
});
