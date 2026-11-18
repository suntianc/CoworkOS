import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

// The draft on screen is activated again once the page binds its backend, and
// again when the first project takes over the unbound new-conversation draft.
for (const firstProject of [false, true])
  test(`an in-flight upload survives a late activation of its own draft${
    firstProject ? " handed to the first project" : ""
  }`, async ({ page }) => {
    const dashboard = await startDashboard({
      modelEndpoint: "http://127.0.0.1:1/v1",
      defaultProject: firstProject
    });
    let releaseSession;
    const sessionGate = new Promise((resolve) => (releaseSession = resolve));
    let releaseUpload;
    const uploadGate = new Promise((resolve) => (releaseUpload = resolve));
    let uploading = false;
    const sends = [];
    try {
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (request.method() === "POST" && (url.pathname === "/api/tasks" || url.pathname.endsWith("/run")))
          sends.push(url.pathname);
      });
      await page.route("**/api/session", async (route) => {
        await sessionGate;
        await route.continue();
      });
      await page.route("**/api/uploads?name=late.txt", async (route) => {
        uploading = true;
        await uploadGate;
        await route.continue();
      });
      const bound = page.waitForRequest("**/api/models");
      await page.goto(dashboard.base);
      // The composer only accepts input after the page's first activation; the
      // session is still unbound, so the activation under test is a later one.
      await expect(page.locator("#composer-input")).toBeEditable();
      await page.locator("#file-input").setInputFiles({
        name: "late.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("late activation")
      });
      await expect.poll(() => uploading).toBe(true);
      releaseSession();
      await bound;
      if (firstProject) await expect(page.locator("#composer-project")).toBeVisible();
      // The kept upload still owns the composer: sending stays blocked until it lands.
      const send = page.locator("#send-button");
      await expect(send).toBeDisabled();
      await expect(send).toHaveAttribute("title", "正在读取附件…");
      await page.locator("#composer-input").fill("附件上传完成前不能发送");
      await page.locator("#composer-input").press("Enter");
      releaseUpload();
      const strip = page.locator("#attachment-strip");
      await expect(strip).toContainText("late.txt");
      await expect(strip.locator("[data-upload-preview]").first()).toBeVisible();
      await expect(send).toBeEnabled();
      await expect(send).toHaveAttribute("title", "发送（Enter）");
      expect(sends).toEqual([]);
    } finally {
      releaseSession();
      releaseUpload();
      await dashboard.stop();
    }
  });

// The catalog read that binds the backend and hands the unbound new-conversation
// draft to the first project can land after a rejected upload. Retiring the
// upload there must not take away its failure and retry.
test("a rejected upload keeps its retry when the startup binding lands afterwards", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  let releaseCatalog;
  const catalogGate = new Promise((resolve) => (releaseCatalog = resolve));
  let released = false;
  let rejectFirst = true;
  try {
    // Every catalog reader can hand the draft to the first project: the poll
    // read, the event snapshot and the replayed event stream. Hold all three.
    const hold = async (route) => {
      if (!released) await catalogGate;
      await route.continue().catch(() => {});
    };
    await page.route("**/api/events/snapshot", hold);
    await page.route("**/api/events/stream*", hold);
    await page.route("**/api/tasks", hold);
    await page.route("**/api/uploads?name=rejected.txt", (route) => {
      if (rejectFirst) {
        rejectFirst = false;
        return route.fulfill({ status: 503, json: { error: "fixture failure" } });
      }
      return route.continue();
    });
    await page.goto(dashboard.base);
    await page.locator("#file-input").setInputFiles({
      name: "rejected.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("rejected original")
    });
    await expect(page.locator("[data-upload-retry]")).toBeVisible();
    released = true;
    releaseCatalog();
    // The startup binding hands the draft to the first project, then keeps the
    // rejected file and its retry with that draft.
    await expect(page.locator("#composer-project")).toBeVisible();
    await expect(page.locator("[data-upload-retry]")).toBeVisible();
    await expect(page.locator("#upload-status")).toContainText("1 个文件未添加");
    await page.locator("[data-upload-retry]").click();
    await expect(page.locator("#attachment-strip")).toContainText("rejected.txt");
    await expect(page.locator("#upload-status")).toBeHidden();
  } finally {
    released = true;
    releaseCatalog();
    await dashboard.stop();
  }
});

test("an upload does not follow the person to another conversation", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const releases = new Map();
  try {
    for (const taskId of ["upload-a", "upload-b"])
      await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: taskId } });
    await page.route("**/api/uploads?name=*", async (route) => {
      const name = new URL(route.request().url()).searchParams.get("name");
      if (name === "pending.txt") await new Promise((resolve) => releases.set(name, resolve));
      await route.continue().catch(() => {});
    });
    await page.goto(dashboard.base);
    await page.locator('.conversation-item[data-task="upload-a"]').click();
    const pick = (name) =>
      page.locator("#file-input").setInputFiles({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from(name)
      });
    await pick("kept.txt");
    const strip = page.locator("#attachment-strip");
    await expect(strip).toContainText("kept.txt");
    await pick("pending.txt");
    await expect.poll(() => releases.has("pending.txt")).toBe(true);
    await page.locator('.conversation-item[data-task="upload-b"]').click();
    await expect(strip).toBeHidden();
    await expect(page.locator("#send-button")).toBeEnabled();
    await page.locator('.conversation-item[data-task="upload-a"]').click();
    await expect(strip).toContainText("kept.txt");
    await expect(strip).not.toContainText("pending.txt");
    releases.get("pending.txt")();
    await expect(page.locator("#upload-status")).toBeHidden();
    await page.locator('.conversation-item[data-task="upload-b"]').click();
    await expect(strip).toBeHidden();
  } finally {
    releases.get("pending.txt")?.();
    await dashboard.stop();
  }
});
