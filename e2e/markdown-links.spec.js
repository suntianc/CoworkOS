import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("a final local artifact link downloads its indexed file without leaving the draft", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const taskId = "markdown_task";
  const path = "exports/res_scene/光影 场景_01 & #?.blend";
  const bytes = Buffer.from("ISOLATED_SYNTHETIC_BLEND_LINK_CONTENT");
  const errors = [];
  const artifactRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/artifact?")) artifactRequests.push(new URL(request.url()));
  });
  try {
    const projectDirectory = join(dashboard.root, "separate-project");
    await mkdir(projectDirectory);
    const { project } = await (
      await page.request.post(`${dashboard.base}/api/projects`, {
        data: { projectName: "文件链接项目", projectDirectory }
      })
    ).json();
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal: "合成本地链接验收", projectId: project.projectId }
    });
    const root = join(dashboard.workspaceRoot, taskId, "artifacts");
    await mkdir(join(root, "exports", "res_scene"), { recursive: true });
    await writeFile(join(root, path), bytes);
    const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.workspaceRoot).toBe(projectDirectory);
    expect(detail.storageRoot).toBe(dashboard.workspaceRoot);
    const absolute = join(root, path);
    const unknown = "/Users/fixture/sample_project/private_scene.blend";
    const otherTask = join(dashboard.workspaceRoot, "other_task", "artifacts", path);
    const text = [
      `[原生 Blender 工程](<${absolute}>)`,
      `[未登记](<${unknown}>)`,
      `[另一任务](<${otherTask}>)`,
      '[<img src=x onerror="globalThis.injected=1">](javascript:globalThis.injected=1)'
    ].join("\n\n");
    await page.route(`**/api/tasks/${taskId}`, (route) =>
      route.fulfill({
        json: {
          ...detail,
          task: {
            ...detail.task,
            status: "completed",
            completion: { policy: "natural", signal: "natural_stop" }
          },
          runtime: { active: false },
          messages: [
            { role: "user", content: "生成合成工程", timestamp: 1 },
            { role: "assistant", content: text, timestamp: 2, stopReason: "stop" }
          ]
        }
      })
    );
    await page.goto(dashboard.base);
    // Filling before the first catalog types into the new-conversation draft;
    // this case is about the restored conversation keeping its own draft.
    await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", taskId);
    await page.locator("#composer-input").fill("点击导出后仍保留的草稿");
    await page.locator("#file-input").setInputFiles({
      name: "draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("UNSENT_ATTACHMENT")
    });
    const final = page.locator('[data-answer-kind="final"]');
    const link = final.getByRole("link", { name: "原生 Blender 工程", exact: true });
    await expect(final.locator("a")).toHaveCount(1);
    await expect(final).toContainText(unknown);
    await expect(final).toContainText(otherTask);
    const href = new URL(await link.getAttribute("href"), dashboard.base);
    expect(href.pathname).toBe(`/api/tasks/${taskId}/artifact`);
    expect(href.searchParams.get("path")).toBe(path);
    expect(href.searchParams.get("download")).toBe("1");
    // Capture the settled URL: the link itself must not navigate or reselect.
    const beforeUrl = page.url();
    // A file the preview cannot show downloads straight away; it never opens
    // the artifact drawer.
    const download = page.waitForEvent("download");
    await link.click();
    const file = await download;
    await expect(page.locator("#artifact-drawer")).toBeHidden();
    // Chromium sanitizes '?' in a suggested download filename; the request
    // below must still address the original indexed path and original bytes.
    expect(file.suggestedFilename()).toBe("光影 场景_01 & #_.blend");
    expect(await readFile(await file.path())).toEqual(bytes);
    expect(page.url()).toBe(beforeUrl);
    await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", taskId);
    await expect(page.locator("#composer-input")).toHaveValue("点击导出后仍保留的草稿");
    await expect(page.locator("#attachment-strip")).toContainText("draft.txt");
    await expect(final.locator(".markdown-body img, .markdown-body script, .markdown-body svg")).toHaveCount(
      0
    );
    expect(await page.evaluate(() => globalThis.injected)).toBeUndefined();
    expect(artifactRequests.length).toBeGreaterThanOrEqual(1);
    // The page's own client fetches the bytes (session header, bound backend)
    // and hands the browser a blob, so the backend request is the one to check.
    const downloadUrl = artifactRequests.find((url) => url.searchParams.get("download") === "1");
    expect(downloadUrl).toBeTruthy();
    for (const url of artifactRequests) {
      expect(url.pathname).toBe(`/api/tasks/${taskId}/artifact`);
      expect(url.searchParams.get("path")).toBe(path);
    }
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("HTTP link punctuation and escaped labels remain inert in the production browser renderer", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const result = await page.evaluate(async () => {
      const { renderMarkdown } = await import("/assets/markdown.js");
      const destination =
        'https://example.invalid/sample_project/res_scene/file__final**.glb?x=" onmouseover="globalThis.injected=1';
      const section = document.createElement("section");
      section.id = "markdown-security-fixture";
      section.innerHTML = renderMarkdown(
        `[<img src=x onerror="globalThis.injected=1">](<${destination}>)\n\n[unsafe](javascript:globalThis.injected=1)`
      );
      document.body.appendChild(section);
      const link = section.querySelector("a");
      link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return {
        destination,
        href: link.getAttribute("href"),
        label: link.textContent,
        handlers: [...link.attributes].filter((attribute) => attribute.name.startsWith("on")).length,
        links: section.querySelectorAll("a").length,
        executable: section.querySelectorAll("img, script, svg, iframe").length,
        injected: globalThis.injected
      };
    });
    expect(result.href).toBe(result.destination);
    expect(result.label).toBe('<img src=x onerror="globalThis.injected=1">');
    expect(result.handlers).toBe(0);
    expect(result.links).toBe(1);
    expect(result.executable).toBe(0);
    expect(result.injected).toBeUndefined();
  } finally {
    await dashboard.stop();
  }
});

// The flake this file kept producing: the composer becomes editable before the
// first catalog lands, so typing there raced the page restoring the default
// conversation over it. Holding the catalog until the typing happened makes
// that ordering independent of machine speed.
test("a draft typed while the first catalog loads stays in the composer", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  let releaseCatalog;
  const catalogHeld = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  try {
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "catalog_task", goal: "catalog arrives after the typing" }
    });
    // Both first-catalog paths: the event client's snapshot and the fallback read.
    await page.route(/\/api\/(tasks|events\/snapshot)$/, async (route) => {
      const response = await route.fetch();
      await catalogHeld;
      await route.fulfill({ response });
    });
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("catalog 到达前输入的草稿");
    releaseCatalog();
    await expect(page.locator('.conversation-item[data-task="catalog_task"]')).toHaveCount(1);
    await expect(page.locator("#composer-input")).toHaveValue("catalog 到达前输入的草稿");
  } finally {
    releaseCatalog();
    await dashboard.stop();
  }
});

// The upload is the composer's content too, even before its attachment exists:
// a catalog restored on top of it would retire the upload.
test("an upload in flight when the first catalog loads keeps its attachment", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  let releaseCatalog;
  let releaseUpload;
  let uploadReached;
  const catalogHeld = new Promise((resolve) => (releaseCatalog = resolve));
  const uploadHeld = new Promise((resolve) => (releaseUpload = resolve));
  const uploading = new Promise((resolve) => (uploadReached = resolve));
  try {
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "catalog_task", goal: "catalog arrives mid-upload" }
    });
    await page.route(/\/api\/(tasks|events\/snapshot)$/, async (route) => {
      const response = await route.fetch();
      await catalogHeld;
      await route.fulfill({ response });
    });
    await page.route(/\/api\/uploads\?/, async (route) => {
      uploadReached();
      const response = await route.fetch();
      await uploadHeld;
      await route.fulfill({ response });
    });
    const backendBound = page.waitForRequest(/\/api\/models$/);
    await page.goto(dashboard.base);
    await backendBound;
    await page.locator("#file-input").setInputFiles({
      name: "held.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("UPLOAD_HELD_BY_THE_FIRST_CATALOG")
    });
    await uploading;
    // The catalog lands while the attachment is still uploading.
    releaseCatalog();
    await expect(page.locator('.conversation-item[data-task="catalog_task"]')).toHaveCount(1);
    releaseUpload();
    await expect(page.locator("#attachment-strip")).toContainText("held.txt");
  } finally {
    releaseCatalog();
    releaseUpload();
    await dashboard.stop();
  }
});

// Between the backend bind and the first catalog the composer must stay on the
// conversation the link names, or typing goes into another conversation's draft.
test("a conversation link keeps typing that lands before the catalog", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  let releaseCatalog;
  const catalogHeld = new Promise((resolve) => (releaseCatalog = resolve));
  try {
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "linked_task", goal: "the linked conversation" }
    });
    await page.route(/\/api\/(tasks|events\/snapshot)$/, async (route) => {
      const response = await route.fetch();
      await catalogHeld;
      await route.fulfill({ response });
    });
    const backendBound = page.waitForRequest(/\/api\/models$/);
    await page.goto(`${dashboard.base}/?task=linked_task`);
    // The model read follows the bind, so drafts already belong to the backend.
    await backendBound;
    await page.locator("#composer-input").fill("绑定后、目录前输入的草稿");
    releaseCatalog();
    await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", "linked_task");
    await expect(page.locator("#composer-input")).toHaveValue("绑定后、目录前输入的草稿");
  } finally {
    releaseCatalog();
    await dashboard.stop();
  }
});

// A conversation link the catalog no longer lists must not hand typed text to
// another conversation's draft, where it would be saved but never shown again.
test("a stale conversation link keeps early typing in the composer", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  let releaseCatalog;
  let releaseSession;
  const catalogHeld = new Promise((resolve) => (releaseCatalog = resolve));
  const sessionHeld = new Promise((resolve) => (releaseSession = resolve));
  try {
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId: "other_task", goal: "the fallback conversation" }
    });
    await page.route(/\/api\/session$/, async (route) => {
      const response = await route.fetch();
      await sessionHeld;
      await route.fulfill({ response });
    });
    await page.route(/\/api\/(tasks|events\/snapshot)$/, async (route) => {
      const response = await route.fetch();
      await catalogHeld;
      await route.fulfill({ response });
    });
    await page.goto(`${dashboard.base}/?task=deleted_task`);
    // Typed before the backend bind, exactly as when a page opens and someone
    // starts writing immediately.
    await page.locator("#composer-input").fill("过期链接下输入的草稿");
    releaseSession();
    releaseCatalog();
    await expect(page.locator('.conversation-item[data-task="other_task"]')).toHaveCount(1);
    await expect(page.locator(".conversation-item.active")).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue("过期链接下输入的草稿");
  } finally {
    releaseSession();
    releaseCatalog();
    await dashboard.stop();
  }
});
