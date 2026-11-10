import { test, expect, _electron as electron } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";

test("desktop keeps drafts and selected file bytes with their backend", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "cowork-native-drafts-"));
  const profile = join(root, "profile");
  const otherHome = join(root, "other-backend");
  const otherWorkspace = join(root, "other-workspace");
  const evidence = process.env.P2_NATIVE_EVIDENCE;
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
    COWORK_WORKSPACE: otherWorkspace,
    COWORK_CONFIG: join(root, "other-config.json"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1"
  };
  const { startBackend, stopBackend } = await import("../dist/src/cli/backend.js");
  await mkdir(env.HOME, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await writeFile(otherEnv.COWORK_CONFIG, "{}");
  const otherStarted = await startBackend(otherEnv, resolve("."), process.execPath);
  const other = JSON.parse(await readFile(join(otherHome, "runtime/backend-instance.json"), "utf8"));
  expect(otherStarted.pid).toBe(other.pid);
  let native;
  let primary;
  let page;
  const pids = { other: other.pid };
  const errors = [];
  const installDownloadCapture = () =>
    native.evaluate(({ session }, directory) => {
      globalThis.fixtureDownloads = [];
      session.defaultSession.on("will-download", (_event, item) => {
        const target = `${directory}/download-${globalThis.fixtureDownloads.length}.txt`;
        const record = { target, state: "started" };
        globalThis.fixtureDownloads.push(record);
        item.setSavePath(target);
        item.once("done", (_event, state) => {
          record.state = state;
        });
      });
    }, root);
  const downloadedFile = async (index) => {
    await expect
      .poll(() => native.evaluate((_electron, number) => globalThis.fixtureDownloads[number]?.state, index))
      .toBe("completed");
    const record = await native.evaluate((_electron, number) => globalThis.fixtureDownloads[number], index);
    return readFile(record.target);
  };
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
    pids.electron = native.process().pid;
    page = await native.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator("#composer-input")).toBeAttached();
    await expect(page.locator(".mic-button, #i-mic")).toHaveCount(0);
    expect(await page.evaluate(() => "voiceInput" in window.bookmanDesktop)).toBe(false);
    await expect(page.locator("[data-backend-status]")).not.toContainText("正在连接", { timeout: 30_000 });
    await closeModel();
    primary ??= JSON.parse(await readFile(join(profile, "runtime/backend-instance.json"), "utf8"));
    pids.primary = primary.pid;
    console.log(
      JSON.stringify({ event: "native-started", root, pids, candidate: process.env.P2_CANDIDATE_SHA })
    );
    return page;
  };
  const seed = async (instance, workspace, label) => {
    const projectDir = join(root, `project-${label}`);
    await mkdir(projectDir, { recursive: true });
    const post = async (path, body) => {
      const response = await fetch(instance.url + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atria-token": instance.token },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(201);
      return response.json();
    };
    const { project } = await post("/api/projects", {
      projectName: `Project ${label}`,
      projectDirectory: projectDir
    });
    await post("/api/tasks", { taskId: "shared-task", goal: `Task ${label}`, projectId: project.projectId });
    const artifacts = join(workspace, "shared-task", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "report.txt"), `artifact ${label}`);
  };
  const selectBackend = async (directory, instance) => {
    await native.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, directory);
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    await page.locator("[data-backend-open]").click();
    await page.locator("[data-backend-choose]").click();
    await page.waitForURL(`${instance.url}/**`, { timeout: 30_000 });
    // A switched backend without a connection shows the first-use dialog; close it
    // before reading the node row again.
    const setup = page.getByRole("dialog", { name: "连接模型" });
    await setup.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await closeModel();
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="nodes"]').click();
    await expect(page.locator("[data-backend-status]")).toContainText(
      instance.backendId.replace(/^backend_/, "").slice(0, 8),
      { timeout: 30_000 }
    );
    await page.locator("#settings-back").click();
    await closeModel();
  };
  try {
    await launch();
    await installDownloadCapture();
    await seed(primary, join(profile, "workspace"), "A");
    await seed(other, otherWorkspace, "B");
    await page.reload();
    await expect(page.getByRole("dialog", { name: "连接模型" })).toBeVisible();
    await closeModel();
    await page.locator('.conversation-item[data-task="shared-task"]').click();
    await page.locator("#composer-input").fill("draft A survives restart");
    const firstFile = join(root, "first", "same.txt");
    const secondFile = join(root, "second", "same.txt");
    await mkdir(join(root, "first"), { recursive: true });
    await mkdir(join(root, "second"), { recursive: true });
    await writeFile(firstFile, "native file A1");
    await writeFile(secondFile, "native file A2");
    if (evidence) {
      await writeFile(join(evidence, "input-a1.txt"), "native file A1");
      await writeFile(join(evidence, "input-a2.txt"), "native file A2");
      await writeFile(join(evidence, "input-b.txt"), "native file B");
    }
    const selection = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "添加文件" }).click();
    await (await selection).setFiles([firstFile, secondFile]);
    await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(2);
    const ids = await page
      .locator("#attachment-strip [data-upload-preview]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.uploadPreview));
    expect(ids[0]).not.toBe(ids[1]);
    for (const [index, id] of ids.entries()) {
      const response = await fetch(`${primary.url}/api/uploads/${id}`, {
        headers: { "x-atria-token": primary.token }
      });
      expect(await response.text()).toBe(`native file A${index + 1}`);
    }
    const cancelled = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "添加文件" }).click();
    await (await cancelled).setFiles([]);
    await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(2);
    await page.locator("#attachment-strip [data-upload-preview]").first().click();
    await expect(page.locator(".attachment-preview [data-preview-content]")).toContainText("native file A1");
    await page.locator(".attachment-preview [data-preview-close]").click();
    if (evidence) await page.screenshot({ path: join(evidence, "draft-a.png") });

    await selectBackend(otherHome, other);
    await page.locator('.conversation-item[data-task="shared-task"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(0);
    await page.locator("#composer-input").fill("draft B belongs to B");
    await page.locator("#file-input").setInputFiles({
      name: "same.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("native file B")
    });
    await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(1);
    await page.locator("#attachment-strip [data-upload-preview]").click();
    await expect(page.locator(".attachment-preview [data-preview-content]")).toContainText("native file B");
    await page.locator(".attachment-preview [data-preview-close]").click();
    await page.locator("#output-pane-toggle").click();
    await page.locator('[data-artifact="report.txt"]').click();
    const drawer = page.locator("#artifact-drawer");
    await expect(drawer).toContainText("artifact B");
    const windowPromise = native.waitForEvent("window");
    await drawer.getByRole("link", { name: "打开 ↗" }).click();
    const viewer = await windowPromise;
    await expect(viewer.locator("body")).toContainText("artifact B");
    await viewer.close();
    await drawer.getByRole("link", { name: "下载", exact: true }).click();
    const bytes = await downloadedFile(0);
    expect(bytes.toString()).toBe("artifact B");
    if (evidence) await writeFile(join(evidence, "download-artifact-b.txt"), bytes);
    console.log(
      JSON.stringify({ event: "download", sha256: createHash("sha256").update(bytes).digest("hex") })
    );
    for (const [index, kind] of ["blob", "data"].entries()) {
      await page.evaluate((scheme) => {
        const link = document.createElement("a");
        link.download = `${scheme}.txt`;
        link.href =
          scheme === "blob"
            ? URL.createObjectURL(new Blob(["local blob export"], { type: "text/plain" }))
            : "data:text/plain,local%20data%20export";
        document.body.append(link);
        link.click();
        link.remove();
      }, kind);
      const local = await downloadedFile(index + 1);
      expect(local.toString()).toBe(`local ${kind} export`);
      if (evidence) await writeFile(join(evidence, `download-${kind}.txt`), local);
    }
    if (evidence) await page.screenshot({ path: join(evidence, "artifact-b.png") });

    await drawer.getByRole("button", { name: "关闭预览" }).click();
    await selectBackend(profile, primary);
    await page.locator('.conversation-item[data-task="shared-task"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("draft A survives restart");
    await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(2);
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("draft A survives restart");
    await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(2);
    await page.locator("#composer-input").fill("");
    await page.getByRole("button", { name: "移除 same.txt" }).first().click();
    await page.getByRole("button", { name: "移除 same.txt" }).click();
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(0);

    await native.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        globalThis.fixtureSaveFailureShown = true;
        return { response: 0 };
      };
    });
    await chmod(profile, 0o500);
    await page.locator("#composer-input").fill("recover after native save failure");
    await native.evaluate(({ app }) => app.quit());
    await expect.poll(() => native.evaluate(() => globalThis.fixtureSaveFailureShown || false)).toBe(true);
    await expect(page.locator("#composer-input")).toHaveValue("recover after native save failure");
    await chmod(profile, 0o700);
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("recover after native save failure");
    expect(errors).toEqual([]);
  } finally {
    await chmod(profile, 0o700).catch(() => {});
    await native?.close();
    if (primary) {
      const result = await stopBackend({ ...env, ATRIA_HOME: profile }, primary);
      console.log(JSON.stringify({ event: "primary-stop", state: result.state, pid: primary.pid }));
    }
    const result = await stopBackend(otherEnv, other);
    console.log(JSON.stringify({ event: "other-stop", state: result.state, pid: other.pid }));
  }
});
