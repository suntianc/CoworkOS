import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";

test("desktop lets users recover separate unbound drafts to chosen projects", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(process.env.P2_NATIVE_ROOT || tmpdir(), "draft-picker-"));
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
  async function launch() {
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
  }
  try {
    await launch();
    const projects = [];
    for (const name of ["Current one", "Current two", "Old one", "Old two"]) {
      const directory = join(root, name.replaceAll(" ", "-"));
      await mkdir(directory);
      const response = await fetch(primary.url + "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-atria-token": primary.token },
        body: JSON.stringify({ projectName: name, projectDirectory: directory })
      });
      expect(response.status).toBe(201);
      projects.push((await response.json()).project);
    }
    const staged = await page.evaluate(async (projects) => {
      const { createComposerSession } = await import("/assets/controllers/composer-session.js");
      async function fixture(project, text) {
        const input = { value: "", addEventListener() {} };
        let attachments = [];
        const session = createComposerSession({
          input,
          storage: localStorage,
          getAttachments: () => attachments,
          setAttachments: (files) => {
            attachments = files;
          },
          onPersist: () => window.bookmanDesktop.saveComposerDrafts()
        });
        await session.ready;
        session.activate(null, { projectId: project.projectId });
        input.value = text;
        attachments = [{ name: text + ".txt", text: text + " bytes" }];
        session.save();
        return session;
      }
      const one = await fixture(projects[0], "current one");
      const two = await fixture(projects[1], "current two");
      const closed = [one.prepareClose(), two.prepareClose()];
      const observerInput = { value: "", addEventListener() {} };
      let observerFiles = [];
      const observer = createComposerSession({
        input: observerInput,
        storage: localStorage,
        getAttachments: () => observerFiles,
        setAttachments: (files) => {
          observerFiles = files;
        }
      });
      await observer.ready;
      observer.activate(null);
      observer.setBackend("other-backend");
      observer.activate(null, { projectId: projects[0].projectId });
      const occupied = {
        text: observerInput.value,
        files: observerFiles,
        available: await observer.listRecoverableDrafts()
      };
      await observer.dispose();
      await one.dispose();
      await two.dispose();
      // Same unmarked format as 90b7bfd0's successfully closed drafts.
      for (const [id, index, text] of [
        ["1".repeat(32), 2, "old one"],
        ["2".repeat(32), 3, "old two"]
      ]) {
        localStorage.setItem(
          `atria.composer.v1:__prebind__:${id}:new:${encodeURIComponent(projects[index].projectId)}`,
          JSON.stringify({ text, attachments: [{ name: text + ".txt", text: text + " bytes" }] })
        );
      }
      window.bookmanDesktop.saveComposerDrafts();
      return {
        closed,
        occupied,
        records: Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => key.includes(":__prebind__:"))
        )
      };
    }, projects);
    expect(staged.closed).toEqual([true, true]);
    expect(staged.occupied).toEqual({ text: "", files: [], available: [] });
    console.log(JSON.stringify({ event: "staged", ...staged }));
    await native.close();
    native = undefined;
    await launch();
    const button = page.locator("#recover-drafts");
    await expect(button).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "恢复草稿" });
    const source = dialog.getByLabel("待恢复草稿");
    const target = dialog.getByLabel("目标项目");
    for (const [index, text] of ["current one", "current two", "old one", "old two"].entries()) {
      await button.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("目标后端")).toHaveValue(primary.backendId);
      const sourceValue = await source.locator("option").filter({ hasText: text }).getAttribute("value");
      expect(sourceValue).toBeTruthy();
      await source.selectOption(sourceValue);
      if (index === 1) {
        await target.selectOption({ label: projects[0].projectName });
        await dialog.getByRole("button", { name: "恢复草稿", exact: true }).click();
        await expect(dialog.getByRole("alert")).toHaveText("目标已有草稿，请选择其他项目");
      }
      await target.selectOption({ label: projects[index].projectName });
      await dialog.getByRole("button", { name: "恢复草稿", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator("#composer-input")).toHaveValue(text);
      await expect(page.getByRole("button", { name: `移除 ${text}.txt` })).toBeVisible();
      console.log(
        JSON.stringify({
          event: "restored",
          backend: primary.backendId,
          project: projects[index].projectId,
          text,
          attachment: text + ".txt"
        })
      );
    }
    await page.locator("#composer-input").fill("");
    await page.getByRole("button", { name: "移除 old two.txt" }).click();
    await native.close();
    native = undefined;
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.getByRole("button", { name: "移除 old two.txt" })).toHaveCount(0);
    const final = await page.evaluate(
      ({ backend, projects }) => ({
        destinations: projects.map((project) =>
          JSON.parse(
            localStorage.getItem(
              `atria.composer.v1:${backend}:new:${encodeURIComponent(project.projectId)}`
            ) || "null"
          )
        ),
        sources: Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => key.includes(":__prebind__:"))
        )
      }),
      { backend: primary.backendId, projects }
    );
    expect(final.destinations.map((draft) => draft?.text || "")).toEqual([
      "current one",
      "current two",
      "old one",
      ""
    ]);
    expect(Object.values(final.sources).some((value) => value.includes("old one"))).toBe(true);
    expect(Object.values(final.sources).some((value) => value.includes("old two"))).toBe(true);
    console.log(JSON.stringify({ event: "deleted-after-restart", project: projects[3].projectId, ...final }));
    expect(errors).toEqual([]);
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
