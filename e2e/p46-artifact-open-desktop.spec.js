import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

test("桌面版用系统默认应用打开产物，并且只接受后端解析到的本地文件", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "atria-p46-artifact-desktop-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|EXA_|SERPER_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  let native;
  try {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env,
      timeout: 90_000
    });
    const page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toBeAttached();
    const close = page.locator("[data-model-close]");
    await close.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (await close.isVisible()) await close.click();

    // The host authorizes the renderer's requests once the selected backend is up.
    const created = await page.evaluate(async () => {
      const headers = { "content-type": "application/json" };
      const nonce = window.bookmanDesktop?.transportNonce;
      if (nonce) headers["x-cowork-desktop-nonce"] = nonce;
      let response;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        response = await fetch("/api/tasks", {
          method: "POST",
          headers,
          body: JSON.stringify({ taskId: "desktop-artifact", goal: "桌面产物验收" })
        });
        if (response.status !== 401) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      const text = await response.text();
      const detail = await fetch("/api/tasks/desktop-artifact", {
        headers: nonce ? { "x-cowork-desktop-nonce": nonce } : {}
      });
      return {
        status: response.status,
        body: text,
        detailStatus: detail.status,
        detail: await detail.text()
      };
    });
    expect(created.status, created.body).toBeLessThan(300);
    expect(created.detailStatus, created.detail).toBe(200);
    const storageRoot = JSON.parse(created.detail).storageRoot;
    const artifacts = join(storageRoot, "desktop-artifact", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "报告.md"), "# 桌面产物\n");

    // Record what the host hands to the system instead of launching an application.
    await native.evaluate(({ shell }) => {
      globalThis.openedPaths = [];
      shell.openPath = async (target) => {
        globalThis.openedPaths.push(target);
        return "";
      };
    });

    // The sidebar picks the new conversation up on its next catalog poll.
    await page.locator('button[data-task="desktop-artifact"]').click({ timeout: 20_000 });
    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");
    await expect(panel.locator('[data-artifact="报告.md"]')).toBeVisible();
    await panel.locator('[data-artifact="报告.md"]').click();
    const drawer = page.locator("#artifact-drawer");
    await expect(drawer).toBeVisible();
    const openSystem = drawer.locator("[data-open-system]");
    await expect(openSystem).toBeVisible();
    await openSystem.click();
    // The backend resolves the real path, so /var may already read as /private/var.
    const expectedFile = await realpath(join(artifacts, "报告.md"));
    await expect
      .poll(async () => (await native.evaluate(() => globalThis.openedPaths)).map((path) => path))
      .toEqual([expectedFile]);

    // A path the backend cannot resolve for this artifact is refused, not opened.
    const refused = await page.evaluate(async () => {
      try {
        await window.bookmanDesktop.openArtifact("desktop-artifact", "../../config.json");
        return "opened";
      } catch (error) {
        return error.message;
      }
    });
    expect(refused).not.toBe("opened");
    expect(await native.evaluate(() => globalThis.openedPaths)).toHaveLength(1);
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
