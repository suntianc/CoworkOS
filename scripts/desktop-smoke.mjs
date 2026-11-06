import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, access, cp, writeFile, mkdir, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { startNativeApplicationMonitor } from "./native-application-monitor.mjs";
import { desktopSmokeEnvironment } from "./desktop-smoke-env.mjs";
import { signAsync } from "@electron/osx-sign";

import { HumanRequestStore } from "../dist/src/runtime/human.js";
const appPath = resolve(process.env.ATRIA_DESKTOP_APP || ".tmp/release/mac-arm64/CoworkOS.app");
const executablePath = join(appPath, "Contents/MacOS/CoworkOS");
const packagedMetadata = JSON.parse(
  await readFile(join(appPath, "Contents/Resources/app/package.json"), "utf8")
);
const originalVersion = packagedMetadata.version;
await access(executablePath);
const plist = await readFile(join(appPath, "Contents/Info.plist"), "utf8");
const iconFile = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
expect(iconFile).toBeTruthy();
// Verify the actual Finder icon bytes in the package, not just the builder setting.
expect(await readFile(join(appPath, "Contents/Resources", basename(iconFile)))).toEqual(
  await readFile(resolve("build/atria.icns"))
);
const root = await realpath(await mkdtemp(join(tmpdir(), "atria-packaged-smoke-")));
const data = join(root, "user-data");
const projectDirectory = join(root, "project");
await mkdir(projectDirectory);
const requests = [];
const deferred = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const reasoningGates = [deferred(), deferred()];
const reasoningText = ["先检查工作区文件的完整内容。", "继续确认中文与 Emoji 的保存结果。"];
let reasoningStarted = false;
let computerTarget;
let applicationMonitor;
const desktopPids = new Set();
const keychainPids = new Set();
let hold = false;
const held = [];
const model = createServer(async (req, res) => {
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "desktop-fixture" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
  requests.push(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (hold) {
    held.push(res);
    return;
  }
  const send = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: `desktop-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "desktop-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    );
  send({ role: "assistant" });
  if (
    !reasoningStarted &&
    request.tools?.some((tool) => tool.function.name === "read") &&
    !request.messages.some((message) => message.role === "tool")
  ) {
    reasoningStarted = true;
    send({ reasoning_content: reasoningText[0] });
    await reasoningGates[0].promise;
    send({ reasoning_content: reasoningText[1] });
    await reasoningGates[1].promise;
  }
  const computerPrompt = JSON.stringify(
    request.messages.findLast((message) => message.role === "user")?.content
  ).includes("检查电脑操作");
  if (computerPrompt) {
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const calls = request.messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? []);
    const previous = request.messages.findLast((message) => message.role === "tool");
    const result = previous && JSON.parse(previous.content);
    if (calls.some((call) => call.function.name === "computer_observe")) {
      if (
        result?.mimeType !== "image/png" ||
        !result?.observationId ||
        result?.visualFeedback?.delivered !== false
      )
        throw new Error("Desktop computer observation failed");
      send({ content: "电脑操作观察验证成功" });
      send({}, "stop");
    } else {
      const name = !calls.some((call) => call.function.name === "computer_status")
        ? "computer_status"
        : !calls.some((call) => call.function.name === "computer_discover")
          ? "computer_discover"
          : !calls.some((call) => call.function.name === "computer_select")
            ? "computer_select"
            : "computer_observe";
      if (name === "computer_select")
        expect(
          result.windows.some(
            (window) => window.pid === computerTarget.pid && window.windowId === computerTarget.windowId
          )
        ).toBe(true);
      const parameters =
        name === "computer_select"
          ? { pid: computerTarget.pid, windowId: computerTarget.windowId, mode: "control" }
          : name === "computer_observe"
            ? { sessionId: result.session.sessionId }
            : {};
      send({
        tool_calls: [
          {
            index: 0,
            id: `desktop-${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(parameters) }
          }
        ]
      });
      send({}, "tool_calls");
    }
    res.end("data: [DONE]\n\n");
    return;
  }
  if (request.messages.some((message) => message.role === "tool")) {
    send({ content: "桌面模型验证成功" });
    send({}, "stop");
  } else if (request.tools?.some((tool) => tool.function.name === "read")) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "desktop-read",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: join(projectDirectory, "desktop-input.txt") })
          }
        }
      ]
    });
    send({}, "tool_calls");
  } else {
    send({ content: "通用文件工具未加载" });
    send({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const endpoint = `http://127.0.0.1:${model.address().port}/v1`;
let native;
const launch = async (app = executablePath) => {
  const env = desktopSmokeEnvironment({ data });
  native = await electron.launch({
    executablePath: app,
    args: ["--use-mock-keychain"],
    env,
    timeout: 30_000
  });
  desktopPids.add(native.process().pid);
  native.process().stderr.on("data", (chunk) => console.error(String(chunk).trim().slice(-2000)));
  const page = await native.firstWindow();
  await expect(page.locator(".app-topbar")).toBeVisible({ timeout: 30_000 });
  // Application recovery may intentionally keep navigation behind the task
  // panel. Wait for initialization without changing the restored sidebar view.
  await expect(page.locator("#apps-nav")).toHaveJSProperty("hidden", false, { timeout: 30_000 });
  // Renderer errors fail the GUI check even if its first paint happened.
  page.on("pageerror", (error) => {
    throw error;
  });
  await recordKeychainWorkers();
  return page;
};
async function recordKeychainWorkers() {
  const workers = await native.evaluate(() =>
    process
      ._getActiveHandles()
      .filter((handle) => handle.spawnargs?.includes("--atria-keychain-worker"))
      .map((child) => child.pid)
  );
  for (const pid of workers) keychainPids.add(pid);
}
function unexpectedApplications() {
  // Known beta limitation: the explicitly identified Keychain process still
  // uses the main Electron bundle and can briefly register a Dock application.
  return applicationMonitor.registrations.filter(
    (app) =>
      !desktopPids.has(app.pid) &&
      !keychainPids.has(app.pid) &&
      app.parents.some((pid) => desktopPids.has(pid))
  );
}
async function verifyBackgroundApplications() {
  await recordKeychainWorkers();
  const applications = await applicationMonitor.snapshot();
  const own = applications.find((app) => app.pid === native.process().pid);
  expect(own?.policy, "the main CoworkOS application keeps its normal Dock identity").toBe(0);
  expect(
    unexpectedApplications(),
    "only the known Keychain worker may register a second application"
  ).toEqual([]);
}
const quit = async () => {
  await recordKeychainWorkers();
  const current = native;
  const process = current.process();
  const page = current.windows()[0];
  const origin = new URL(page.url()).origin;
  const exited = process.exitCode === null ? once(process, "exit") : Promise.resolve();
  await current
    .evaluate(({ app }) => {
      app.quit();
    })
    .catch(() => {});
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Native quit timed out")), 12000).unref())
  ]);
  await current.close();
  native = undefined;
  await expect
    .poll(async () => {
      try {
        await fetch(`${origin}/api/tasks`, { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
};
async function showNavigation(page) {
  if (await page.locator("body").evaluate((node) => node.classList.contains("sidebar-collapsed")))
    await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  const navigation = page.locator('[data-sidebar-view="navigation"]');
  if (await navigation.isVisible()) await navigation.click();
  await expect(page.locator("#conversation-sidebar")).toBeVisible();
}
async function focusConversation(page, taskId) {
  await showNavigation(page);
  const conversation = page.locator(`.conversation-item[data-task="${taskId}"]`);
  const collapsed = conversation.locator(
    "xpath=ancestor::*[contains(@class,'project-group') and contains(@class,'collapsed')]"
  );
  if (await collapsed.count()) await collapsed.locator(".project-row").click();
  await conversation.click();
  // A human request intentionally replaces the composer with its answer form.
  await expect(page.locator("#composer-input:visible, #human-questions:visible")).toHaveCount(1);
  if (await page.locator("#composer-input").isVisible()) await page.locator("#composer-input").focus();
}
async function verifyNativeChrome(page) {
  console.log("Desktop smoke: model icon and integrated native window chrome");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-desktop-platform", "darwin");
  await expect(root).toHaveAttribute("data-desktop-fullscreen", "false");
  await expect(page.locator(".traffic")).toHaveCount(0);
  const refreshedDockIcons = await native.evaluate(({ app, nativeImage, BrowserWindow }) => {
    const calls = [];
    const original = app.dock.setIcon;
    app.dock.setIcon = function (value) {
      const image = typeof value === "string" ? nativeImage.createFromPath(value) : value;
      const size = image.getSize();
      const pixels = image.toBitmap();
      calls.push({
        size,
        outerCornerAlpha: pixels[3],
        tileCornerAlpha: pixels[(100 * size.width + 100) * 4 + 3]
      });
      return original.call(this, value);
    };
    try {
      app.emit("activate");
      BrowserWindow.getAllWindows()[0].emit("focus");
    } finally {
      app.dock.setIcon = original;
    }
    return calls;
  });
  // Exercise the packaged main-process event wiring and the image supplied to Dock.
  expect(refreshedDockIcons.length).toBeGreaterThanOrEqual(2);
  for (const icon of refreshedDockIcons) {
    expect(icon.size).toEqual({ width: 1024, height: 1024 });
    expect(icon.outerCornerAlpha).toBe(0);
    expect(icon.tileCornerAlpha).toBe(0);
  }
  const geometry = await native.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      bounds: win.getBounds(),
      content: win.getContentBounds(),
      lights: win.getWindowButtonPosition()
    };
  });
  // Native controls share the content header; there is no second titlebar above it.
  expect(geometry.content).toEqual(geometry.bounds);
  expect(geometry.lights).toEqual({ x: 18, y: 25 });
  const topbar = page.locator(".app-topbar");
  expect(await topbar.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe(
    "drag"
  );
  const sidebar = page.getByRole("button", { name: "切换侧栏", exact: true });
  expect(await sidebar.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe(
    "no-drag"
  );
  await sidebar.click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await sidebar.click();
  await expect(page.locator("body")).not.toHaveClass(/sidebar-collapsed/);
  const settingsTrigger = page.locator("#user-menu-button");
  await settingsTrigger.click();
  await expect(page.locator("#profile-close")).toBeFocused();
  await page.locator("#profile-close").press("Escape");
  await expect(page.locator("#profile-modal")).toBeHidden();
  await expect(settingsTrigger).toBeFocused();

  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(752, 700));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(752);
  const layout = await page.evaluate(() => {
    const header = document.querySelector(".app-topbar").getBoundingClientRect();
    return {
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll(".app-topbar button")].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom - header.top };
      })
    };
  });
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  for (const button of layout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(104);
    expect(button.right).toBeLessThanOrEqual(layout.width);
    expect(button.bottom).toBeLessThanOrEqual(64);
  }
  await native.evaluate(
    ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
    geometry.bounds
  );
  const desktopState = await page.evaluate(async () => (await fetch("/api/computer/status")).json());
  if (desktopState.controlAvailable === false && /锁定/.test(desktopState.reason || "")) {
    console.log(`Desktop smoke: fullscreen/minimize/restore SKIPPED (${desktopState.reason})`);
    return;
  }
  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  await expect(root).toHaveAttribute("data-desktop-fullscreen", "true", { timeout: 15_000 });
  expect(await topbar.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))).toBeLessThan(104);
  await sidebar.click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await sidebar.click();
  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await expect(root).toHaveAttribute("data-desktop-fullscreen", "false", { timeout: 15_000 });
  expect(await topbar.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("104px");
  await native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expect
    .poll(() => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    .toBe(true);
  await native.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.restore();
    win.focus();
  });
  await expect
    .poll(() => native.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    .toBe(false);
}
try {
  applicationMonitor = await startNativeApplicationMonitor(root, {
    moduleCacheDirectory: process.env.ATRIA_SWIFT_MODULE_CACHE || undefined
  });
  expect(applicationMonitor.initial.monitorPolicy).toBe(2);
  console.log("Desktop smoke: first install");
  let page = await launch();
  await expect(page.getByRole("heading", { name: "连接模型" })).toBeVisible();
  expect((await fetch(`${new URL(page.url()).origin}/api/tasks`)).status).toBe(401);
  await page.locator("[data-model-close]").click();
  const setupDraft = "连接模型之前准备的任务草稿 😀";
  await page.locator("#composer-input").fill(setupDraft);
  await page.locator("#model-setup-button").click();
  await page.locator('[name="baseUrl"]').fill(endpoint);
  await page.locator('[name="model"]').fill("desktop-fixture");
  await page.locator('[name="apiKey"]').fill("desktop-fake-key");
  await page.locator('[name="api"]').selectOption("openai-completions");
  const oldUrl = page.url();
  await page.getByRole("button", { name: "保存连接" }).click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toBe(oldUrl);
  await expect(page.locator("#apps-nav")).toBeHidden();
  await expect(page.getByRole("heading", { name: "连接模型" })).not.toBeVisible();
  await expect(page.locator("#composer-input")).toHaveValue(setupDraft);
  const modelStatus = await page.evaluate(() => window.bookmanDesktop.modelStatus());
  const expectedConnection = {
    api: "openai-completions",
    baseUrl: endpoint,
    model: "desktop-fixture",
    configured: true,
    supportsImages: false,
    reasoningEffort: "off",
    supportsReasoningEffort: false,
    supportsPromptCacheKey: false,
    thinkingFormat: "auto",
    contextWindow: 256000,
    mainMaxTokens: 8192,
    subagentMaxTokens: 8192
  };
  expect(modelStatus).toEqual({
    ...expectedConnection,
    activeProfileId: expect.any(String),
    visionProfileId: "",
    profiles: [
      {
        ...expectedConnection,
        id: modelStatus.activeProfileId,
        name: "新配置",
        active: true,
        vision: false
      }
    ]
  });
  await verifyNativeChrome(page);
  // Fresh installs require an explicit project and application destination.
  // Create the project through the UI and register its own application workspace.
  await page.locator("#new-project").click();
  const projectDialog = page.getByRole("dialog", { name: "新建项目", exact: true });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("textbox", { name: "项目名称", exact: true }).fill("桌面验收项目");
  await projectDialog.getByRole("textbox", { name: "工作文件夹", exact: true }).fill(projectDirectory);
  await projectDialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(projectDialog).toBeHidden();
  await writeFile(join(projectDirectory, "desktop-input.txt"), "桌面内测内容\n中文与 Emoji 😀\n");
  await page.locator("#composer-input").fill("请读取 desktop-input.txt 并确认内容。");
  await page.locator("#send-button").click();
  const reasoning = page.locator(".reasoning-details").filter({ hasText: reasoningText[0] }).first();
  await expect(reasoning).toBeVisible({ timeout: 40_000 });
  if (!(await reasoning.evaluate((element) => element.open))) await reasoning.locator("summary").click();
  await expect(reasoning).toHaveAttribute("open", "");
  reasoningGates[0].release();
  await expect(reasoning).toContainText(reasoningText[1]);
  await expect(reasoning).toHaveAttribute("open", "");
  reasoningGates[1].release();
  await expect(page.getByText("桌面模型验证成功", { exact: true }).first()).toBeVisible({ timeout: 40_000 });
  await verifyBackgroundApplications();
  expect(JSON.stringify(requests)).toContain("桌面内测内容");
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await (await fetch("/api/tasks")).json()).tasks
            .filter((task) => task.taskId !== "workspace")
            .map((task) => task.status)
        ),
      { timeout: 20_000 }
    )
    .toEqual(["completed"]);
  const tasks = await page.evaluate(async () => (await (await fetch("/api/tasks")).json()).tasks);
  const taskId = tasks.find((task) => task.taskId !== "workspace").taskId;
  console.log("Desktop smoke: Computer Use trusted IPC and real Pi observation");
  expect(await page.evaluate(() => typeof window.bookmanDesktop.computerUse)).toBe("function");
  const computerStatus = await page.evaluate(async () => (await fetch("/api/computer/status")).json());
  const ownWindow = computerStatus.windows.find((window) => window.pid === native.process().pid);
  if (
    computerStatus.available &&
    computerStatus.screenRecording &&
    ownWindow &&
    computerStatus.controlAvailable !== false
  ) {
    computerTarget = ownWindow;
    const openWindowSettings = async () => {
      if (await page.locator("#profile-modal").isHidden()) {
        await showNavigation(page);
        await page.locator("#user-menu-button").click();
      }
      await expect(page.locator("#profile-modal")).toBeVisible();
      const access = page.locator("#profile-modal .computer-setting");
      if (!(await access.evaluate((element) => element.open))) await access.locator("summary").click();
    };
    const closeWindowSettings = async () => {
      await page.locator("#profile-close").click();
      await expect(page.locator("#profile-modal")).toBeHidden();
    };
    await openWindowSettings();
    const windowAccess = page.locator("#computer-access-enabled");
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    expect(
      await page.evaluate(async () => (await (await fetch("/api/computer/access")).json()).policy)
    ).toEqual({ enabled: true, mode: "control" });
    await closeWindowSettings();
    await page.locator("#composer-input").fill("检查电脑操作");
    await page.locator("#send-button").click();
    await expect(page.getByText("电脑操作观察验证成功", { exact: true }).first()).toBeVisible({
      timeout: 40_000
    });
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const session = (await (await fetch(`/api/tasks/${id}/computer`)).json()).session;
          return {
            taskId: session?.taskId,
            source: session?.source,
            state: session?.state,
            observed: session?.activity.some(
              (event) => event.operation === "observe" && event.outcome === "completed"
            )
          };
        }, taskId)
      )
      .toEqual({ taskId, source: "global", state: "ended", observed: true });
    const selectOwnWindow = async () => {
      // macOS may replace a window ID across native transitions. Rediscover
      // this fixture's PID rather than reusing the first observation's ID.
      let target;
      await expect
        .poll(
          async () => {
            target = await page.evaluate(
              async (pid) =>
                (await (await fetch("/api/computer/status")).json()).windows.find(
                  (window) => window.pid === pid
                ),
              native.process().pid
            );
            return Boolean(target);
          },
          { timeout: 15000 }
        )
        .toBe(true);
      return page.evaluate(
        async ({ id, target }) => {
          const response = await fetch(`/api/tasks/${id}/computer/select`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pid: target.pid, windowId: target.windowId, mode: "control" })
          });
          if (!response.ok)
            throw new Error(
              `Select own window failed: ${response.status} ${JSON.stringify(await response.json())}`
            );
          return response.json();
        },
        { id: taskId, target }
      );
    };
    await selectOwnWindow();
    await page.locator("[data-computer-pause]").click();
    await expect(page.locator("[data-computer-label]")).toContainText("已暂停");
    await page.locator("[data-computer-bar-resume]").click();
    await expect(page.locator(".computer-control-bar")).toHaveAttribute("data-state", "active");
    await openWindowSettings();
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
    await expect(page.locator(".computer-control-bar")).toBeHidden();
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    await closeWindowSettings();
    await selectOwnWindow();
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const access = await (await fetch("/api/computer/access")).json();
          return { enabled: access.policy.enabled, paused: access.paused, owner: access.owner };
        })
      )
      .toEqual({ enabled: true, paused: false, owner: null });
    await expect(page.locator(".computer-control-bar")).toBeHidden();
    expect((await page.evaluate(() => window.bookmanDesktop.modelStatus())).configured).toBe(true);
    await openWindowSettings();
    await expect(windowAccess).toHaveText("关闭窗口访问");
    await expect(page.locator("[data-computer-state]")).toContainText("已开启");
    await windowAccess.click();
    await expect(windowAccess).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-computer-state]")).toContainText("已关闭");
    await closeWindowSettings();
    await expect(page.locator(".computer-control-bar")).toBeHidden();
  } else
    console.log(
      `Desktop smoke: native observation skipped (${computerStatus.reason || "screen permission or own visible window unavailable"})`
    );
  const conversationDraft = "退出并重新打开后保留的后续要求 😀";
  const draftAttachment = "这份未发送的附件需要在新的本机服务端口恢复。";
  await focusConversation(page, taskId);
  await page.locator("#composer-input").fill(conversationDraft);
  await page.locator("#file-input").setInputFiles({
    name: "未发送的说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(draftAttachment)
  });
  await expect(page.getByRole("button", { name: "移除 未发送的说明.txt", exact: true })).toBeVisible();
  await quit();
  console.log("Desktop smoke: restart");
  page = await launch();
  await expect(page.getByRole("heading", { name: "连接模型" })).not.toBeVisible();
  await focusConversation(page, taskId);
  await expect(page.locator("#composer-input")).toHaveValue(conversationDraft);
  await expect(page.getByRole("button", { name: "移除 未发送的说明.txt", exact: true })).toBeVisible();
  const mirroredDrafts = JSON.parse(await readFile(join(data, "composer-drafts.json"), "utf8"));
  const restoredDraft = JSON.parse(mirroredDrafts.entries[`atria.composer.v1:${taskId}`]);
  expect(restoredDraft).toMatchObject({
    text: conversationDraft,
    attachments: [{ name: "未发送的说明.txt", kind: "text" }]
  });
  const restoredUpload = restoredDraft.attachments[0].uploadId;
  expect(restoredUpload).toMatch(/^upload-[a-f0-9-]{36}$/);
  expect(await page.evaluate(async (id) => (await fetch(`/api/uploads/${id}`)).text(), restoredUpload)).toBe(
    draftAttachment
  );
  // A real pending request is rendered by the packaged UI, then retained by
  // the native close handshake across a changed localhost origin.
  const humanTask = taskId;
  const humanDetail = await page.evaluate(
    async (taskId) => (await fetch(`/api/tasks/${taskId}`)).json(),
    humanTask
  );
  expect(humanDetail.workspaceRoot.startsWith(root)).toBe(true);
  expect(humanDetail.storageRoot.startsWith(root)).toBe(true);
  expect(humanDetail.task.activeRunId).toBeTruthy();
  const humanStore = new HumanRequestStore(humanDetail.storageRoot);
  const humanRequest = await humanStore.create({
    taskId: humanTask,
    runId: humanDetail.task.activeRunId,
    question: "请选择导出格式",
    options: ["Markdown", "PDF"],
    recommended: 0
  });
  await focusConversation(page, humanTask);
  const humanReply = "保留重启后的中文回复 😀 和显式选择";
  await page.getByRole("radio", { name: "PDF", exact: true }).check();
  await page.getByRole("textbox", { name: "其他回答或补充说明" }).fill(humanReply);
  await quit();
  page = await launch();
  await focusConversation(page, humanTask);
  await expect(page.getByRole("textbox", { name: "其他回答或补充说明" })).toHaveValue(humanReply);
  await expect(page.getByRole("radio", { name: "PDF", exact: true })).toBeChecked();
  const humanDraftPath = join(data, "composer-drafts.json");
  expect((await stat(humanDraftPath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(humanDraftPath, "utf8")).version).toBe(3);
  const humanSubmission = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/human/${humanRequest.requestId}/answer`) &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "提交并继续", exact: true }).click();
  const humanResponse = await humanSubmission;
  expect(humanResponse.ok()).toBe(true);
  expect((await humanResponse.json()).resume.status).toBe("running");
  await expect
    .poll(async () => (await humanStore.read(humanTask, humanRequest.requestId)).status)
    .toBe("answered");
  expect((await humanStore.read(humanTask, humanRequest.requestId)).answer).toBe(
    `PDF\n\n补充说明：${humanReply}`
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          async (taskId) => (await (await fetch(`/api/tasks/${taskId}`)).json()).task.status,
          humanTask
        ),
      { timeout: 40_000 }
    )
    .toBe("completed");
  await expect(page.locator("#human-questions")).toBeHidden();
  await expect
    .poll(
      async () =>
        Object.keys(JSON.parse(await readFile(humanDraftPath, "utf8")).entries).filter((key) =>
          key.startsWith("atria.human.v1:")
        ).length
    )
    .toBe(0);
  console.log(
    "Desktop human reply PASS: private draft and explicit choice restored after quit/new origin, accepted answer persisted and draft removed."
  );
  // Simulate a new installed release in a different directory, retaining only user data.
  await quit();
  const next = join(root, "next-release/CoworkOS.app");
  await cp(appPath, next, { recursive: true, verbatimSymlinks: true });
  const packagePath = join(next, "Contents/Resources/app/package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const [major, minor, patch] = originalVersion.split(/[+-]/, 1)[0].split(".").map(Number);
  pkg.version = `${major}.${minor}.${patch + 1}`;
  await writeFile(packagePath, JSON.stringify(pkg));
  const nextInfo = join(next, "Contents/Info.plist");
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"])
    await promisify(execFile)("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${pkg.version}`, nextInfo]);
  // Changing a sealed resource invalidates the original signature. Only this
  // disposable upgraded copy is recursively re-signed; the fixed candidate stays intact.
  await signAsync({
    app: next,
    identity: "-",
    identityValidation: false,
    platform: "darwin",
    type: "distribution",
    strictVerify: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      entitlements: resolve("desktop/entitlements.mac.plist"),
      hardenedRuntime: true
    })
  });
  await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", next]);
  console.log("Desktop smoke: upgraded/recovered launch");
  page = await launch(join(next, "Contents/MacOS/CoworkOS"));
  expect(JSON.parse(await readFile(join(data, "data-version.json"), "utf8"))).toMatchObject({
    createdWith: originalVersion,
    lastOpenedWith: pkg.version
  });
  // Quit while a real Pi model request is active; restart should expose a resumable task.
  hold = true;
  await focusConversation(page, taskId);
  await page.locator("#composer-input").fill("等待退出恢复验证");
  await page.locator("#send-button").click();
  await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const configError = await page.evaluate(async () => {
    try {
      await window.bookmanDesktop.saveModel({ baseUrl: "https://invalid.example", model: "other" });
      return "unexpected success";
    } catch (error) {
      return error.message;
    }
  });
  expect(configError).toContain("正在运行");
  await quit();
  for (const response of held) response.destroy();
  hold = false;
  console.log("Desktop smoke: upgraded/recovered launch");
  page = await launch(join(next, "Contents/MacOS/CoworkOS"));
  const restored = await page.evaluate(
    async (id) => (await (await fetch("/api/tasks")).json()).tasks.find((task) => task.taskId === id),
    taskId
  );
  expect(restored.status).toBe("waiting");
  await focusConversation(page, taskId);
  await page.locator("#composer-input").fill("继续已保存的任务");
  await page.locator("#send-button").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          async (id) =>
            (await (await fetch("/api/tasks")).json()).tasks.find((task) => task.taskId === id)?.status,
          taskId
        ),
      { timeout: 40_000 }
    )
    .toBe("completed");
  // Conversation rows expose the current status through their accessible description.
  await focusConversation(page, taskId);
  await expect(page.locator(`.conversation-item[data-task="${taskId}"]`)).toHaveAttribute(
    "aria-description",
    "已完成"
  );
  const proof = process.env.ATRIA_DESKTOP_PROOF;
  if (proof) await page.screenshot({ path: resolve(proof) });
  await quit();
  const log = await readFile(join(data, "logs/dashboard.log"), "utf8");
  // All launches and their descendants remain under observation through file reads,
  // ordinary prompts, Computer Use and relocated restarts.
  expect(unexpectedApplications(), "no unexpected background application registrations").toEqual([]);
  console.log(
    "Desktop smoke known limitation: Keychain workers may briefly appear in Dock; registrations:",
    applicationMonitor.registrations.filter((app) => keychainPids.has(app.pid)).length
  );
  expect(log).not.toContain("desktop-fake-key");
  console.log(
    "Packaged Mac smoke PASS: app icon, native chrome, configuration, authenticated API, real Pi with a local model fixture, text editing and export, graceful quit, restart, upgrade and interrupted run recovery. No system Node used."
  );
} catch (error) {
  console.error("Packaged Mac smoke failed:", (error.stack || error.message).slice(0, 3500));
  if (error.code !== undefined || error.signal !== undefined || error.killed !== undefined)
    console.error("Smoke process failure:", {
      code: error.code,
      signal: error.signal,
      killed: error.killed
    });
  if (native) {
    const page = native.windows()[0];
    console.error(
      "Renderer state:",
      await page
        .evaluate(() => ({
          active: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
          computerState: document.querySelector("[data-computer-state]")?.textContent,
          computerError: document.querySelector("[data-computer-error]")?.textContent,
          mounts: [...document.querySelectorAll("[data-app-mount]")].map((element) => ({
            tab: element.dataset.appMount,
            hidden: element.hidden,
            text: element.textContent.slice(0, 600)
          }))
        }))
        .catch(() => "Renderer unavailable")
    );
    await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
  }
  console.error(
    (await readFile(join(data, "logs/dashboard.log"), "utf8").catch(() => "No backend log")).slice(-4000)
  );
  process.exitCode = 1;
} finally {
  for (const gate of reasoningGates) gate.release();
  if (native) await native.close().catch(() => {});
  await applicationMonitor?.stop().catch(() => {});
  for (const response of held) response.destroy();
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  if (process.env.ATRIA_KEEP_SMOKE_DATA) console.log("Smoke data:", root);
  else {
    // Native launches register relocated test apps even after their bundles are removed.
    await promisify(execFile)(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-u", join(root, "next-release/CoworkOS.app")]
    ).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
