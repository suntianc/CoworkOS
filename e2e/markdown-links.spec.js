import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("a final local artifact link opens its indexed file and downloads it without leaving the draft", async ({
  page
}) => {
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
    await link.click();
    const drawer = page.locator("#artifact-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".artifact-download-card")).toContainText("光影 场景_01 & #?.blend");
    const download = page.waitForEvent("download");
    await drawer.locator("a.drawer-action[download]").first().click();
    const file = await download;
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
