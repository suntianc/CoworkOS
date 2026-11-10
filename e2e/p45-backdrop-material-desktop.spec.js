import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

const layers = (page) =>
  page.evaluate(() => {
    const read = (selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return { color: style.backgroundColor, image: style.backgroundImage };
    };
    const conversation = getComputedStyle(document.querySelector(".chat-pane"));
    const taskPanel = getComputedStyle(document.querySelector(".agent-pane"));
    return {
      material: window.bookmanDesktop.windowMaterial,
      html: read("html"),
      body: read("body"),
      shell: read(".app-shell"),
      conversation: { blur: conversation.backdropFilter, image: conversation.backgroundImage },
      taskPanel: { blur: taskPanel.backdropFilter, image: taskPanel.backgroundImage }
    };
  });

const expectClearPage = (value) => {
  for (const layer of [value.html, value.body, value.shell]) {
    expect(layer.color).toBe("rgba(0, 0, 0, 0)");
    expect(layer.image).toBe("none");
  }
  for (const panel of [value.conversation, value.taskPanel]) {
    expect(panel.blur).toContain("blur(");
    expect(panel.image).toContain("linear-gradient");
  }
};

test("macOS window material shows the desktop through the page and keeps the glass panels", async () => {
  test.skip(process.platform !== "darwin", "Native window material acceptance requires macOS");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "atria-backdrop-material-"));
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
  let native;
  try {
    native = await electron.launch({
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
    await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");

    // The real host exposes the material and switches appearance through IPC.
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => window.bookmanDesktop.appearance.set(value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-window-material", "under-window");
      const value = await layers(page);
      expect(value.material).toEqual({ material: "under-window" });
      expectClearPage(value);
    }
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await rm(root, { recursive: true, force: true });
  }
});
