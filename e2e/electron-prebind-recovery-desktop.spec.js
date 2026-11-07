import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";

test("desktop restores drafts saved before the first backend binding", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(process.env.P2_NATIVE_ROOT || tmpdir(), "prebind-native-"));
  const profile = join(root, "profile");
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
  await mkdir(env.HOME, { recursive: true });
  const { stopBackend } = await import("../dist/src/cli/backend.js");
  let native, page, primary;
  const errors = [];
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
    const model = page.getByRole("dialog", { name: "连接模型" });
    if (await model.isVisible()) await model.getByRole("button", { name: "关闭设置", exact: true }).click();
    primary ??= JSON.parse(await readFile(join(profile, "runtime/backend-instance.json"), "utf8"));
    console.log(
      JSON.stringify({
        event: "started",
        candidate: process.env.P2_CANDIDATE_SHA,
        root,
        electron: native.process().pid,
        backend: primary.pid
      })
    );
  };
  try {
    await launch();
    // The production session runs in the real renderer and persists via the
    // native preload. We hold it unbound to exercise the connection-wait path.
    const saved = await page.evaluate(async () => {
      const { createComposerSession } = await import("/assets/controllers/composer-session.js");
      const fixture = () => {
        const input = { value: "", addEventListener() {} };
        let attachments = [];
        const session = createComposerSession({
          input,
          storage: localStorage,
          getAttachments: () => attachments,
          setAttachments: (next) => {
            attachments = next;
          },
          onPersist: () => window.bookmanDesktop.saveComposerDrafts()
        });
        return {
          input,
          session,
          files: (value) => {
            attachments = value;
          }
        };
      };
      localStorage.setItem("atria.composer.v1:new", JSON.stringify({ text: "legacy A", attachments: [] }));
      localStorage.setItem(
        "atria.composer.v1:fixture-a:new",
        JSON.stringify({ text: "existing A", attachments: [] })
      );
      const a = fixture();
      a.session.activate(null);
      a.session.setBackend("fixture-a");
      a.session.activate(null);
      const aClosed = a.session.prepareClose();
      const waiting = fixture();
      waiting.session.activate(null);
      waiting.session.activate(null, { projectId: "native-p1" });
      waiting.input.value = "native prebind project";
      waiting.files([{ name: "project.txt", text: "project attachment" }]);
      waiting.session.save();
      waiting.session.activate(null);
      waiting.input.value = "native prebind global";
      waiting.files([{ name: "global.txt", text: "global attachment" }]);
      waiting.session.save();
      const closed = waiting.session.prepareClose();
      return {
        aClosed,
        closed,
        staged: Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => key.includes(":__prebind__:"))
        )
      };
    });
    expect(saved.aClosed).toBe(true);
    expect(saved.closed).toBe(true);
    expect(Object.values(saved.staged).some((value) => value.includes("native prebind project"))).toBe(true);
    expect(Object.values(saved.staged).some((value) => value.includes("native prebind global"))).toBe(true);
    console.log(JSON.stringify({ event: "unbound-close", ...saved }));
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("native prebind global");
    await expect(page.getByRole("button", { name: "移除 global.txt" })).toBeVisible();
    const recovered = await page.evaluate(
      (backendId) => ({
        global: JSON.parse(localStorage.getItem(`atria.composer.v1:${backendId}:new`) || "null"),
        project: JSON.parse(localStorage.getItem(`atria.composer.v1:${backendId}:new:native-p1`) || "null"),
        legacySource: JSON.parse(localStorage.getItem("atria.composer.v1:new") || "null"),
        legacyDestination: JSON.parse(localStorage.getItem("atria.composer.v1:fixture-a:new") || "null"),
        staged: Object.keys(localStorage).filter((key) => key.includes(":__prebind__:"))
      }),
      primary.backendId
    );
    expect(recovered.global).toEqual({
      text: "native prebind global",
      attachments: [{ name: "global.txt", text: "global attachment" }]
    });
    expect(recovered.project).toEqual({
      text: "native prebind project",
      attachments: [{ name: "project.txt", text: "project attachment" }]
    });
    expect(recovered.legacySource.text).toBe("legacy A");
    expect(recovered.legacyDestination.text).toBe("existing A");
    expect(recovered.staged).toEqual([]);
    console.log(JSON.stringify({ event: "after-restart", ...recovered }));
    await page.locator("#composer-input").fill("");
    await page.getByRole("button", { name: "移除 global.txt" }).click();
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.getByRole("button", { name: "移除 global.txt" })).toHaveCount(0);
    const project = await page.evaluate(
      (backendId) =>
        JSON.parse(localStorage.getItem(`atria.composer.v1:${backendId}:new:native-p1`) || "null"),
      primary.backendId
    );
    expect(project.text).toBe("native prebind project");
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ event: "after-deletion-restart", global: "", project }));
  } finally {
    await native?.close();
    if (primary)
      console.log(
        JSON.stringify({
          event: "backend-stop",
          ...(await stopBackend({ ...env, ATRIA_HOME: profile }, primary)),
          pid: primary.pid
        })
      );
  }
});
