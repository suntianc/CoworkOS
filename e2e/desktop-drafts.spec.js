import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const { createComposerDraftStore } = createRequire(import.meta.url)("../desktop/composer-drafts.cjs");
const preload = await readFile("desktop/preload.cjs", "utf8");
const activeDraft = (store) => {
  const entries = store.snapshot().entries;
  const key = JSON.parse(entries["atria.composer.v1:active"] || '"new"');
  return entries[`atria.composer.v1:${key}`];
};

async function installNativeBridge(page, store, persist, seed = false) {
  await page.exposeFunction("__persistDrafts", persist);
  const snapshot = store.snapshot();
  await page.addInitScript({
    content: `(() => {
    const snapshot = ${JSON.stringify(snapshot)};
    if (${seed}) {
      localStorage.setItem("atria.composer.v1:obsolete", "old-origin-data");
      localStorage.setItem("other-preference", "keep-this-preference");
    }
    const listeners = {};
    const electron = {
      contextBridge: { exposeInMainWorld: (name, value) => { window[name] = value; } },
      ipcRenderer: {
        sendSync: () => snapshot,
        on: (channel, handler) => { listeners[channel] = handler; },
        invoke: async (channel, ...args) => {
          if (channel === "bookman:save-composer-drafts") return window.__persistDrafts(args[0], location.origin);
          if (channel === "bookman:model-status") return { baseUrl: "https://fixture.example", model: "fixture", configured: true };
          if (channel === "bookman:documents-ready") { window.__lastDraftAck = args[1]; return; }
        }
      }
    };
    window.__sendNative = (channel, ...args) => listeners[channel]?.({}, ...args);
    (function(require, process) { ${preload} })((name) => electron, { platform: "darwin", env: {} });
    const active = JSON.parse(localStorage.getItem("atria.composer.v1:active") || '"new"');
    window.__draftAtPreload = localStorage.getItem("atria.composer.v1:" + active);
  })();`
  });
}

test("desktop preload restores drafts before page modules on a new origin and refuses a failed close save", async ({
  page,
  context
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-chromium-draft-profile-"));
  const first = await startDashboard();
  const store = createComposerDraftStore(root);
  await store.load();
  let fail = false;
  const persist = async (entries, origin) => {
    if (fail) throw new Error("synthetic storage failure");
    await store.save(entries, origin);
  };
  try {
    await installNativeBridge(page, store, persist);
    await page.goto(first.base);
    await page.locator("#composer-input").fill("修改模型并重启服务后继续这份任务草稿");
    await expect.poll(() => activeDraft(store)).toContain("修改模型并重启服务");
    await page.evaluate(() => localStorage.setItem("other-source-setting", "do-not-transfer"));
    const originalOrigin = first.base;
    await page.close();
    await first.restart({ newPort: true });
    expect(first.base).not.toBe(originalOrigin);
    const restored = await context.newPage();
    await installNativeBridge(restored, store, persist, true);
    await restored.goto(first.base);
    await expect(restored.locator("#composer-input")).toHaveValue("修改模型并重启服务后继续这份任务草稿");
    expect(await restored.evaluate(() => JSON.parse(window.__draftAtPreload).text)).toContain(
      "修改模型并重启服务"
    );
    expect(await restored.evaluate(() => localStorage.getItem("atria.composer.v1:obsolete"))).toBeNull();
    expect(await restored.evaluate(() => localStorage.getItem("other-source-setting"))).toBeNull();
    expect(await restored.evaluate(() => localStorage.getItem("other-preference"))).toBe(
      "keep-this-preference"
    );
    fail = true;
    await restored.locator("#composer-input").fill("保存失败时必须留在当前窗口的草稿");
    await restored.evaluate(() => window.__sendNative("bookman:prepare-close", "draft-flush"));
    await expect.poll(() => restored.evaluate(() => window.__lastDraftAck)).toBe(false);
    await expect(restored.locator("#composer-input")).toHaveValue("保存失败时必须留在当前窗口的草稿");
  } finally {
    await first.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the native draft bridge captures async attachment saves and programmatic clearing without input events", async ({
  page
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-programmatic-drafts-"));
  const dashboard = await startDashboard();
  const store = createComposerDraftStore(root);
  await store.load();
  try {
    await installNativeBridge(page, store, (entries, origin) => store.save(entries, origin));
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      localStorage.setItem(
        "atria.composer.v1:new",
        JSON.stringify({
          text: "async attachment",
          attachments: [{ name: "read-later.txt", text: "attachment finished reading", size: 27 }]
        })
      );
      window.bookmanDesktop.saveComposerDrafts();
    });
    await expect.poll(() => store.snapshot().entries["atria.composer.v1:new"]).toContain("read-later.txt");
    await page.evaluate(() => {
      localStorage.removeItem("atria.composer.v1:new");
      window.bookmanDesktop.saveComposerDrafts();
    });
    await expect.poll(() => store.snapshot().entries["atria.composer.v1:new"]).toBeUndefined();
  } finally {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("real composer attachment changes reach the desktop mirror and memory-only drafts refuse closing", async ({
  page
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-composer-storage-recovery-"));
  const dashboard = await startDashboard();
  const store = createComposerDraftStore(root);
  await store.load();
  try {
    await installNativeBridge(page, store, (entries, origin) => store.save(entries, origin));
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("保留这份草稿");
    await page.locator("#file-input").setInputFiles({
      name: "async-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("异步读取的完整附件")
    });
    await expect.poll(() => activeDraft(store)).toContain("async-notes.txt");
    await page.getByRole("button", { name: "移除 async-notes.txt", exact: true }).click();
    await expect.poll(() => JSON.parse(activeDraft(store)).attachments.length).toBe(0);
    await page.evaluate(() => {
      window.__restoreStorageWrite = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("atria.composer.v1:"))
          throw new DOMException("quota fixture", "QuotaExceededError");
        return window.__restoreStorageWrite.call(this, key, value);
      };
    });
    await page.locator("#composer-input").fill("存储配额失败后的最新内存草稿");
    await page.evaluate(() => window.__sendNative("bookman:prepare-close", "quota-refuse-close"));
    await expect.poll(() => page.evaluate(() => window.__lastDraftAck)).toBe(false);
    await expect(page.locator("#composer-input")).toHaveValue("存储配额失败后的最新内存草稿");
    expect(activeDraft(store)).not.toContain("最新内存草稿");
    await page.evaluate(() => {
      Storage.prototype.setItem = window.__restoreStorageWrite;
      window.__sendNative("bookman:prepare-close", "quota-recovered-close");
    });
    await expect.poll(() => page.evaluate(() => window.__lastDraftAck)).toBe(true);
    expect(JSON.parse(activeDraft(store)).text).toBe("存储配额失败后的最新内存草稿");
  } finally {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an attachment still being read keeps the window open until its complete text can be saved", async ({
  page
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-pending-attachment-close-"));
  const dashboard = await startDashboard();
  const store = createComposerDraftStore(root);
  await store.load();
  try {
    await installNativeBridge(page, store, (entries, origin) => store.save(entries, origin));
    let release;
    const pending = new Promise((resolve) => (release = resolve));
    let received = false;
    await page.route("**/api/uploads?name=still-reading.txt", async (route) => {
      received = true;
      await pending;
      await route.continue();
    });
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("带完整附件的退出草稿");
    await page.locator("#file-input").setInputFiles({
      name: "still-reading.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("必须完整保存的附件首尾")
    });
    await expect.poll(() => received).toBe(true);
    await page.evaluate(() => window.__sendNative("bookman:prepare-close", "pending-attachment"));
    await expect.poll(() => page.evaluate(() => window.__lastDraftAck)).toBe(false);
    await expect(page.locator("#toast")).toContainText("附件仍在读取");
    await expect(page.locator("#composer-input")).toHaveValue("带完整附件的退出草稿");
    release();
    await expect(page.locator("#attachment-strip")).toContainText("still-reading.txt");
    await page.evaluate(() => window.__sendNative("bookman:prepare-close", "complete-attachment"));
    await expect.poll(() => page.evaluate(() => window.__lastDraftAck)).toBe(true);
    expect(JSON.parse(activeDraft(store))).toMatchObject({
      text: "带完整附件的退出草稿",
      attachments: [{ name: "still-reading.txt", kind: "text" }]
    });
    const savedFile = JSON.parse(activeDraft(store)).attachments[0];
    expect(
      (
        await (await page.request.get(`${dashboard.base}/api/uploads/${savedFile.uploadId}`)).body()
      ).toString()
    ).toBe("必须完整保存的附件首尾");
  } finally {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
