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
    try {
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
      releaseUpload();
      const strip = page.locator("#attachment-strip");
      await expect(strip).toContainText("late.txt");
      await expect(strip).toContainText("已添加");
    } finally {
      releaseSession();
      releaseUpload();
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
