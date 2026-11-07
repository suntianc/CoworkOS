import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";

test("host authorization recovery preserves drafts through backend switches and restart", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(150_000);
  const root = await mkdtemp(join(process.env.P2_NATIVE_ROOT || tmpdir(), "merge-combination-"));
  const profile = join(root, "profile");
  const otherHome = join(root, "other-backend");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_|NODE_OPTIONS$)/.test(name)
    )
  );
  const env = {
    ...inherited,
    HOME: join(root, "user-home"),
    COWORK_DESKTOP_DATA: profile,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    COWORK_DISABLE_WATCH_SUPERVISOR: "1"
  };
  const otherEnv = {
    ...inherited,
    HOME: env.HOME,
    ATRIA_HOME: otherHome,
    PI_CODING_AGENT_DIR: join(root, "other-pi"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    COWORK_HARNESS_ROOT: resolve("."),
    COWORK_WORKSPACE: join(root, "other-workspace"),
    COWORK_CONFIG: join(root, "other-config.json"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1"
  };
  await mkdir(env.HOME, { recursive: true });
  await mkdir(otherEnv.COWORK_WORKSPACE, { recursive: true });
  await writeFile(otherEnv.COWORK_CONFIG, "{}");
  const { startBackend, stopBackend } = await import("../dist/src/cli/backend.js");
  const started = await startBackend(otherEnv, resolve("."), process.execPath);
  const other = JSON.parse(await readFile(join(otherHome, "runtime/backend-instance.json"), "utf8"));
  expect(started.pid).toBe(other.pid);
  let native, page, primary;
  const errors = [];
  const closeModel = async () => {
    const model = page.getByRole("dialog", { name: "连接模型" });
    if (await model.isVisible()) await model.getByRole("button", { name: "关闭设置", exact: true }).click();
  };
  const launch = async () => {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 60_000
    });
    page = await native.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator("#composer-input")).toBeAttached();
    await expect(page.locator("[data-backend-status]")).not.toContainText("正在连接", { timeout: 30_000 });
    await closeModel();
    primary ??= JSON.parse(await readFile(join(profile, "runtime/backend-instance.json"), "utf8"));
    console.log(
      JSON.stringify({
        event: "started",
        candidate: process.env.P2_CANDIDATE_SHA,
        root,
        electron: native.process().pid,
        primary: primary.pid,
        other: other.pid
      })
    );
  };
  const selectBackend = async (directory, instance) => {
    await native.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, directory);
    await page.locator("#user-menu-button").click();
    await page.locator("[data-backend-open]").click();
    await page.locator("[data-backend-choose]").click();
    await page.waitForURL(`${instance.url}/**`, { timeout: 30_000 });
    await expect(page.locator("[data-backend-status]")).toContainText(
      instance.backendId.replace(/^backend_/, "").slice(0, 8),
      { timeout: 30_000 }
    );
    await closeModel();
  };
  try {
    await launch();
    const projectDir = join(root, "project-a");
    await mkdir(projectDir, { recursive: true });
    const post = async (path, body) => {
      const response = await fetch(primary.url + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atria-token": primary.token },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(201);
      return response.json();
    };
    const { project } = await post("/api/projects", {
      projectName: "Project A",
      projectDirectory: projectDir
    });
    await post("/api/tasks", { taskId: "recovery-task", goal: "Earlier task", projectId: project.projectId });
    await page.reload();
    await expect(page.locator('.conversation-item[data-task="recovery-task"]')).toBeVisible();
    await closeModel();
    await page.locator('.conversation-item[data-task="recovery-task"]').click();
    await page.evaluate(() => {
      localStorage.setItem(
        "atria.composer.v1:recovery-task",
        JSON.stringify({ text: "", attachments: [{ name: "held.txt", text: "held attachment" }] })
      );
      localStorage.setItem("atria.composer.v1:active", JSON.stringify("recovery-task"));
      window.bookmanDesktop.saveComposerDrafts();
    });
    await native.evaluate(({ ipcMain }) => {
      const channel = "bookman:authorize-backend";
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error("authorization handler unavailable");
      ipcMain.removeHandler(channel);
      const gate = new Promise((resolve) => {
        globalThis.releaseFixtureAuthorization = resolve;
      });
      ipcMain.handle(channel, async (...args) => {
        globalThis.fixtureAuthorizationWaiting = true;
        await gate;
        return original(...args);
      });
    });
    await page.reload();
    await expect
      .poll(() => native.evaluate(() => globalThis.fixtureAuthorizationWaiting || false))
      .toBe(true);
    await expect(page.getByRole("button", { name: "移除 held.txt" })).toBeVisible();
    await page.locator("#composer-input").fill("typed before host session");
    await expect(page.locator("#composer-input")).toHaveValue("typed before host session");
    console.log(
      JSON.stringify({
        event: "connecting-input",
        text: await page.locator("#composer-input").inputValue(),
        attachment: "held.txt"
      })
    );
    await native.evaluate(() => globalThis.releaseFixtureAuthorization());
    await expect(page.locator("[data-backend-status]")).toContainText(
      primary.backendId.replace(/^backend_/, "").slice(0, 8),
      { timeout: 30_000 }
    );
    await closeModel();
    await expect(page.locator("#composer-input")).toHaveValue("typed before host session");
    await expect(page.getByRole("button", { name: "移除 held.txt" })).toBeVisible();
    const oldNonce = await page.evaluate(() => window.bookmanDesktop.transportNonce);
    await selectBackend(otherHome, other);
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.getByRole("button", { name: "移除 held.txt" })).toHaveCount(0);
    const nonceCheck = await page.evaluate(async (old) => {
      const current = window.bookmanDesktop.transportNonce;
      const request = (nonce) =>
        fetch("/api/backend", { headers: { "x-cowork-desktop-nonce": nonce } }).then((r) => r.status);
      return {
        rotated: old !== current,
        old: await request(old),
        current: await request(current),
        rendererSessions: sessionStorage.getItem("cowork.management.sessions.v1")
      };
    }, oldNonce);
    expect(nonceCheck).toEqual({ rotated: true, old: 401, current: 200, rendererSessions: null });
    await page.locator("#composer-input").fill("draft for B");
    await page
      .locator("#file-input")
      .setInputFiles({ name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("backend B attachment") });
    await expect(page.getByRole("button", { name: "移除 b.txt" })).toBeVisible();
    await selectBackend(profile, primary);
    await expect(page.locator("#composer-input")).toHaveValue("typed before host session");
    await expect(page.getByRole("button", { name: "移除 held.txt" })).toBeVisible();
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("typed before host session");
    await expect(page.getByRole("button", { name: "移除 held.txt" })).toBeVisible();
    await selectBackend(otherHome, other);
    await expect(page.locator("#composer-input")).toHaveValue("draft for B");
    await expect(page.getByRole("button", { name: "移除 b.txt" })).toBeVisible();
    expect(errors).toEqual([]);
    console.log(
      JSON.stringify({
        event: "switch-restart",
        nonceCheck,
        a: "typed before host session",
        aAttachment: "held.txt",
        b: "draft for B",
        bAttachment: "b.txt"
      })
    );
  } finally {
    await native?.close();
    if (primary)
      console.log(
        JSON.stringify({
          event: "primary-stop",
          ...(await stopBackend({ ...env, ATRIA_HOME: profile }, primary)),
          pid: primary.pid
        })
      );
    console.log(
      JSON.stringify({ event: "other-stop", ...(await stopBackend(otherEnv, other)), pid: other.pid })
    );
  }
});
