import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";

test("Electron editable context menu uses native clipboard editing and saves the selected draft", async () => {
  test.skip(process.platform !== "darwin", "Native desktop test requires macOS");
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "atria-clipboard-desktop-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)
    )
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1",
    COWORK_DISABLE_WATCH_SUPERVISOR: "1"
  });
  let native;
  const errors = [];
  try {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env
    });
    const page = await native.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    // Observe the real native Menu.popup after an actual renderer right click.
    await native.evaluate(({ Menu }) => {
      const original = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        globalThis.editMenu = this;
        globalThis.editMenuShows = (globalThis.editMenuShows || 0) + 1;
        return original.call(this, options);
      };
    });
    const input = page.locator("#composer-input");
    await input.fill("旧草稿尾部");
    await input.evaluate((element) => element.setSelectionRange(3, 5));
    // The main process owns the platform clipboard the menu reads; a renderer copy in
    // the same moment is what makes Chromium report it as pasteable.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() =>
      navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob(["混合文字\n第二行"], { type: "text/plain" }),
          "text/html": new Blob(["<p>混合文字<br>第二行</p>"], { type: "text/html" })
        })
      ])
    );
    await native.evaluate(({ clipboard }) => {
      clipboard.write({ text: "混合文字\n第二行", html: "<p>混合文字<br>第二行</p>" });
    });
    await page.bringToFront();
    await input.click({ button: "right" });
    await expect.poll(() => native.evaluate(() => globalThis.editMenuShows || 0)).toBe(1);
    const items = await native.evaluate(() => {
      const items = globalThis.editMenu.items.map(({ label, enabled }) => ({ label, enabled }));
      globalThis.editMenu.closePopup();
      return items;
    });
    for (const label of ["剪切", "复制", "全选"])
      expect(items.find((item) => item.label === label)?.enabled, label).toBe(true);
    // Paste stays in the menu whatever the host pasteboard reports as readable; the
    // commands below prove it edits through Chromium rather than a DOM fake.
    for (const label of ["粘贴", "粘贴为纯文本"])
      expect(
        items.map((item) => item.label),
        label
      ).toContain(label);
    // Invoke the captured menu item's callback: real webContents editing, no DOM fake paste.
    await native.evaluate(({ BrowserWindow }) =>
      globalThis.editMenu.items
        .find((item) => item.label === "粘贴为纯文本")
        .click({}, BrowserWindow.getAllWindows()[0])
    );
    await expect(input).toHaveValue("旧草稿混合文字\n第二行");
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    await input.press("Meta+v");
    await expect(input).toHaveValue("旧草稿混合文字\n第二行混合文字\n第二行");
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    await input.fill("");
    await input.click({ button: "right" });
    await expect.poll(() => native.evaluate(() => globalThis.editMenuShows)).toBe(2);

    expect(
      await native.evaluate(() => globalThis.editMenu.items.find((item) => item.label === "剪切").enabled)
    ).toBe(false);
    await native.evaluate(() => globalThis.editMenu.closePopup());
    await input.fill("旧草稿混合文字\n第二行混合文字\n第二行");
    await page.reload();
    await expect(input).toHaveValue("旧草稿混合文字\n第二行混合文字\n第二行");
    expect(errors).toEqual([]);
  } finally {
    await native?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
