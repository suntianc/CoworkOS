import { test, expect, _electron as electron } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";

test("desktop draft migration, switching and recovery survive restart", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(process.env.P2_NATIVE_ROOT || tmpdir(), "draft-rework-"));
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
  let native;
  let primary;
  let page;
  const errors = [];
  const closeModel = async () => {
    const model = page.getByRole("dialog", { name: "连接模型" });
    // The first-use dialog opens once the window learns there is no model connection,
    // which can land after navigation; give it a moment, then make sure nothing covers
    // the page before the next click.
    await model.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (await model.isVisible()) await model.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(model).toBeHidden();
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
        root,
        candidate: process.env.P2_CANDIDATE_SHA,
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
    await page.locator("#composer-input").fill("native draft A");
    await selectBackend(otherHome, other);
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("native draft B");
    await selectBackend(profile, primary);
    await expect(page.locator("#composer-input")).toHaveValue("native draft A");

    // Exercise the production session in the real renderer and native profile.
    // Only the first project destination write is faulted; all other storage and
    // native save operations use the actual Chromium and Electron APIs.
    const migration = await page.evaluate(async () => {
      const { createComposerSession } = await import("/assets/controllers/composer-session.js");
      let fail = false;
      const target = "atria.composer.v1:native-probe-a:new:p1";
      const storage = {
        get length() {
          return localStorage.length;
        },
        key: (index) => localStorage.key(index),
        getItem: (key) => localStorage.getItem(key),
        setItem(key, value) {
          if (fail && key === target) throw new DOMException("injected quota failure", "QuotaExceededError");
          localStorage.setItem(key, value);
        },
        removeItem: (key) => localStorage.removeItem(key)
      };
      const input = { value: "", addEventListener() {} };
      let attachments = [];
      const session = createComposerSession({
        input,
        storage,
        getAttachments: () => attachments,
        setAttachments: (next) => {
          attachments = next;
        },
        onPersist: () => window.bookmanDesktop.saveComposerDrafts()
      });
      session.setBackend("native-probe-a");
      session.activate(null);
      input.value = "migrating source";
      attachments = [{ name: "fixture.txt", text: "attachment" }];
      session.save();
      fail = true;
      session.activate(null, { projectId: "p1" });
      const beforeRecovery = {
        source: JSON.parse(localStorage.getItem("atria.composer.v1:native-probe-a:new")),
        destination: localStorage.getItem(target)
      };
      session.setBackend("native-probe-b");
      session.activate(null);
      fail = false;
      const recovered = session.prepareClose();
      session.setBackend("native-probe-a");
      session.activate(null, { projectId: "p1" });
      const restored = { text: input.value, attachments };
      input.value = "";
      attachments = [];
      session.save();
      const deleted = session.prepareClose();
      return {
        beforeRecovery,
        recovered,
        restored,
        deleted,
        source: localStorage.getItem("atria.composer.v1:native-probe-a:new"),
        destination: localStorage.getItem(target)
      };
    });
    expect(migration.beforeRecovery.source.text).toBe("migrating source");
    expect(migration.beforeRecovery.destination).toBeNull();
    expect(migration.recovered).toBe(true);
    expect(migration.restored).toEqual({
      text: "migrating source",
      attachments: [{ name: "fixture.txt", text: "attachment" }]
    });
    expect(migration.deleted).toBe(true);
    expect(migration.source).toBeNull();
    expect(migration.destination).toBeNull();
    console.log(JSON.stringify({ event: "migration-recovered-and-deleted", ...migration }));

    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("native draft A");
    const afterRestart = await page.evaluate(async () => {
      const { createComposerSession } = await import("/assets/controllers/composer-session.js");
      const input = { value: "", addEventListener() {} };
      let attachments = [];
      const session = createComposerSession({
        input,
        storage: localStorage,
        getAttachments: () => attachments,
        setAttachments: (next) => {
          attachments = next;
        }
      });
      session.setBackend("native-probe-a");
      session.activate(null, { projectId: "p1" });
      const project = { text: input.value, attachments };
      session.activate(null);
      const global = { text: input.value, attachments };
      session.activate(null, { projectId: "p2" });
      return { project, global, otherProject: { text: input.value, attachments } };
    });
    for (const draft of Object.values(afterRestart)) expect(draft).toEqual({ text: "", attachments: [] });
    console.log(JSON.stringify({ event: "migration-after-restart", ...afterRestart }));
    await page.locator("#composer-input").fill("");
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await native.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        globalThis.fixtureSaveFailureShown = true;
        return { response: 0 };
      };
    });
    await chmod(profile, 0o500);
    await page.locator("#composer-input").fill("native save failure recovery");
    await native.evaluate(({ app }) => app.quit());
    await expect.poll(() => native.evaluate(() => globalThis.fixtureSaveFailureShown || false)).toBe(true);
    await expect(page.locator("#composer-input")).toHaveValue("native save failure recovery");
    await chmod(profile, 0o700);
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("native save failure recovery");
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ event: "native-save-recovered", text: "native save failure recovery" }));
  } finally {
    await chmod(profile, 0o700).catch(() => {});
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
