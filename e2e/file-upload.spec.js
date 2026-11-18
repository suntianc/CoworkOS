import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

for (const width of [1440, 900, 640])
  test(`local originals, previews and attachment-only messages at ${width}px`, async ({ page }) => {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    const errors = [];
    let submitted;
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(dashboard.base);
      await expect(page.locator("#composer-input")).toBeVisible();
      const text = "完整 UTF-8 😀\n" + "x".repeat(15000) + "\nFILE_END";
      await page
        .locator("#file-input")
        .setInputFiles({ name: "示例.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
      await expect(page.locator("#attachment-strip").locator("[data-upload-preview]").first()).toBeVisible();
      // A short name shows whole; the one-line chip is as wide as it needs.
      expect(
        await page
          .locator("#attachment-strip .attachment-name")
          .evaluate((node) => node.scrollWidth <= node.clientWidth && node.clientWidth > 0)
      ).toBe(true);
      await page.locator("[data-upload-preview]").click();
      await expect(page.locator(".attachment-preview")).toBeVisible();
      await expect(page.locator("[data-preview-content]")).toContainText("完整 UTF-8 😀");
      await expect(page.locator("[data-preview-content]")).toContainText("12,000");
      const original = await (
        await page.request.get(
          new URL(await page.locator("[data-preview-download]").getAttribute("href"), dashboard.base).href
        )
      ).body();
      expect(original.toString()).toBe(text);
      await page.keyboard.press("Escape");
      await expect(page.locator(".attachment-preview")).toBeHidden();
      const image = await readFile("web/assets/atria-symbol.png");
      await page
        .locator("#file-input")
        .setInputFiles({ name: "截图.png", mimeType: "image/png", buffer: image });
      await expect(page.locator("#attachment-strip .attachment-chip")).toHaveCount(2);
      await page.reload();
      await expect(page.locator("#attachment-strip")).toContainText("截图.png");
      await expect(page.locator("#attachment-strip")).toContainText("示例.txt");
      await page.locator("#attachment-strip [data-upload-preview]").nth(1).click();
      await expect(page.locator("[data-preview-content] img")).toBeVisible();
      await expect
        .poll(() => page.locator("[data-preview-content] img").evaluate((img) => img.naturalWidth))
        .toBeGreaterThan(0);
      // An image previews alone: no title, download or frame, only a small toolbar.
      const viewer = page.locator(".attachment-preview");
      const picture = page.locator("[data-preview-content] img");
      const level = page.locator(".preview-zoom-level");
      await expect(viewer).toHaveAttribute("data-kind", "image");
      await expect(viewer).toHaveCSS("background-color", "rgba(0, 0, 0, 0.7)");
      for (const selector of ["#attachment-preview-title", "[data-preview-download]", "[data-preview-close]"])
        await expect(page.locator(selector)).toBeHidden();
      expect(
        await page
          .locator(".attachment-preview-card")
          .evaluate((node) => getComputedStyle(node).backgroundColor)
      ).toBe("rgba(0, 0, 0, 0)");
      await expect(page.locator("[data-preview-tools]")).toBeVisible();
      await expect(level).toHaveText("100%");
      // A click on the image or around it does not close it.
      await picture.click();
      await page.mouse.click(10, 300);
      await expect(viewer).toBeVisible();
      // The toolbar zooms in steps and the level returns to fit.
      await page.getByRole("button", { name: "放大", exact: true }).click();
      await expect(level).toHaveText("125%");
      await page.getByRole("button", { name: "缩小", exact: true }).click();
      await page.getByRole("button", { name: "缩小", exact: true }).click();
      await expect(level).toHaveText("80%");
      await level.click();
      await expect(level).toHaveText("100%");
      // A double click toggles 2x around the pointer; a zoomed image drags.
      const box = await picture.boundingBox();
      await picture.dblclick();
      await expect(level).toHaveText("200%");
      const before = await picture.evaluate((node) => node.style.transform);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 });
      await page.mouse.up();
      expect(await picture.evaluate((node) => node.style.transform)).not.toBe(before);
      // The wheel zooms; keys reach the same steps.
      await page.mouse.wheel(0, 400);
      await expect.poll(async () => parseInt(await level.textContent(), 10)).toBeLessThan(200);
      await page.keyboard.press("0");
      await expect(level).toHaveText("100%");
      // The close key at the top right closes it.
      await page.getByRole("button", { name: "关闭图片预览" }).click();
      await expect(viewer).toBeHidden();
      // A text file keeps its card with the name and the download.
      await page.locator("#attachment-strip [data-upload-preview]").nth(0).click();
      await expect(page.locator(".attachment-preview")).toHaveAttribute("data-kind", "file");
      await expect(page.locator("[data-preview-download]")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.route("**/run", (route) => {
        submitted = route.request().postDataJSON();
        return route.fulfill({ status: 202, json: { runId: "fixture-run" } });
      });
      await page.locator("#send-button").click();
      await expect.poll(() => submitted?.attachmentIds?.length).toBe(2);
      // Attachments alone go as they are; nothing is typed on the person's behalf.
      expect(submitted.prompt).toBe("");
      // With no words, the new session is named by its files.
      await expect(page.locator(".conversation-item.active")).toContainText("截图.png");
      const chips = page.locator("#attachment-strip");
      await expect(chips).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await dashboard.stop();
    }
  });

test("a sent image is hydrated from the bound session without exposing upload metadata", async ({ page }) => {
  const model = await modelProtocolFixture("openai-completions");
  let dashboard;
  try {
    dashboard = await startDashboard({ modelEndpoint: model.baseUrl });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("查看图片");
    await page.locator("#file-input").setInputFiles({
      name: "截图.png",
      mimeType: "image/png",
      buffer: await readFile("web/assets/atria-symbol.png")
    });
    await expect(page.locator("#attachment-strip")).toContainText("截图.png");
    await page.locator("#send-button").click();
    const attachment = page.locator(".chat-message.user .message-attachments").first();
    const thumbnail = attachment.locator("img[data-upload-src]");
    await expect(attachment).toContainText("截图.png", { timeout: 30_000 });
    await expect(thumbnail).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => thumbnail.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator(".chat-message.user").first()).not.toContainText("atria_uploaded_files");
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("协议会话验证成功", {
      timeout: 30_000
    });
  } finally {
    await dashboard?.stop();
    await model.close();
  }
});

test("drop, paste, retry, cancel and navigation keep files with their own draft", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  let rejectFirst = true;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let received = false;
  try {
    await page.goto(dashboard.base);
    await page.route("**/api/uploads?name=retry.txt", (route) => {
      if (rejectFirst) {
        rejectFirst = false;
        return route.fulfill({ status: 503, json: { error: "fixture retry" } });
      }
      return route.continue();
    });
    await page
      .locator("#file-input")
      .setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry original") });
    await expect(page.locator("[data-upload-retry]")).toBeVisible();
    await page.locator("[data-upload-retry]").click();
    await expect(page.locator("#attachment-strip")).toContainText("retry.txt");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["drop original"], "drop.txt", { type: "text/plain" }));
      document
        .querySelector(".composer")
        .dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator("#attachment-strip")).toContainText("drop.txt");
    const bytes = await readFile("web/assets/atria-symbol.png");
    await page.evaluate(
      (bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }));
        document
          .querySelector("#composer-input")
          .dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
          );
      },
      [...bytes]
    );
    await expect(page.locator("#attachment-strip")).toContainText("paste.png");
    await page.route("**/api/uploads?name=pending.txt", async (route) => {
      received = true;
      await gate;
      await route.fulfill({ status: 503, json: { error: "cancelled fixture" } }).catch(() => {});
    });
    await page
      .locator("#file-input")
      .setInputFiles({ name: "pending.txt", mimeType: "text/plain", buffer: Buffer.from("pending") });
    await expect.poll(() => received).toBe(true);
    await expect(page.locator("#send-button")).toBeDisabled();
    await page.locator("[data-upload-cancel]").click();
    release();
    await expect(page.locator("#send-button")).toBeEnabled();
    await expect(page.locator("#attachment-strip")).not.toContainText("pending.txt");
    await page
      .locator("#file-input")
      .setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not PNG") });
    await expect(page.locator("[data-upload-retry]")).toBeVisible();
    await expect(page.locator("#attachment-strip")).not.toContainText("invalid.png");
  } finally {
    release();
    await dashboard.stop();
  }
});
