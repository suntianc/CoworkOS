import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { pageRequest, saveTestConnection } from "../test/model-provider-fixture.mjs";

// app.js attaches the file-input listener only after its top-level boot await, so a
// file chosen right after navigation can be dropped. Choose it again until the chip
// exists (never while one is already shown), then wait for the finished upload.
async function attachImage(page, name, buffer) {
  const strip = page.locator("#attachment-strip");
  await expect(async () => {
    if (!((await strip.textContent()) ?? "").includes(name))
      await page.locator("#file-input").setInputFiles({ name, mimeType: "image/png", buffer });
    await expect(strip).toContainText(name, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(
    strip.locator(".attachment-chip").filter({ hasText: name }).locator("[data-upload-preview]").first()
  ).toBeVisible();
}

for (const imageApi of ["openai-completions", "openai-responses"]) {
  test(`${imageApi}: image input to text-only and back preserves images and tool history without sending pixels to text models`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    let uploadId,
      pendingUploadId,
      phase = "images",
      imageCalls = 0,
      textCalls = 0;
    const imageConnection = await modelProtocolFixture(imageApi, () => {
      if (phase === "images" && ++imageCalls === 1)
        return { name: "read_attachment", arguments: { id: uploadId } };
      return { text: phase === "images" ? "视觉读取完成" : "视觉恢复完成" };
    });
    const textApi = imageApi === "openai-completions" ? "openai-responses" : "openai-completions";
    const text = await modelProtocolFixture(textApi, () => {
      if (++textCalls === 1) return { name: "read_attachment", arguments: { id: pendingUploadId } };
      return { text: "纯文本继续完成" };
    });
    const dashboard = await startDashboard();
    const image = await readFile("web/assets/atria-symbol.png");
    const pixels = image.toString("base64");
    const request = pageRequest(page, dashboard.base);
    const save = async (body) => {
      const result = await saveTestConnection(request, body);
      expect(result.status, result.error).toBe(200);
      return result;
    };
    const waitDone = async (message) => {
      await expect(page.locator("#conversation")).toContainText(message, { timeout: 30_000 });
      await expect(page.locator("#stop-button")).toBeHidden();
    };
    try {
      const first = await save({
        profileId: "",
        profileName: "视觉",
        baseUrl: imageConnection.baseUrl,
        api: imageApi,
        model: "same-model-name",
        apiKey: "local-image-key",
        supportsImages: true
      });
      await page.goto(dashboard.base);
      // Use the real upload composer path for the pending attachment as well.
      await attachImage(page, "history.png", image);
      // Capture its actual id; only task-attached inputs may be read by the tool.
      page.on("request", (req) => {
        if (req.method() === "POST" && /\/run$/.test(new URL(req.url()).pathname)) {
          const ids = req.postDataJSON()?.attachmentIds;
          if (phase === "images") uploadId = ids?.[0];
          else if (phase === "text") pendingUploadId = ids?.[0];
        }
      });
      await page.locator("#composer-input").fill("读取这张图片，并保留历史文字");
      await page.locator("#send-button").click();
      await waitDone("视觉读取完成");
      expect(imageConnection.requests.at(-1).body.model).toBe("same-model-name");
      expect(JSON.stringify(imageConnection.requests.at(-1).body)).toContain(pixels);
      await attachImage(page, "pending.png", image);
      await page.locator("#composer-input").fill("这是切换前的图片草稿");
      await save({
        profileId: "",
        profileName: "纯文本",
        baseUrl: text.baseUrl,
        api: textApi,
        model: "same-model-name",
        apiKey: "local-text-key",
        supportsImages: false,
        activate: true
      });
      phase = "text";
      await page.reload();
      await expect(page.locator("#attachment-strip")).toContainText("pending.png");
      await expect(page.locator("#composer-input")).toHaveValue("这是切换前的图片草稿");
      await page.locator("#send-button").click();
      await waitDone("纯文本继续完成");
      expect(textCalls).toBe(2);
      for (const request of text.requests) {
        const serialized = JSON.stringify(request.body);
        expect(serialized).not.toContain("data:image/");
        expect(serialized).not.toContain(pixels);
        expect(serialized).toContain("model does not support images");
        expect(serialized).toContain("视觉读取完成");
      }
      expect(JSON.stringify(text.requests.at(-1).body)).toContain("当前模型不支持图片");
      phase = "restored";
      const restored = await request("/api/model-settings/roles", {
        role: "main",
        profileId: first.profileId
      });
      expect(restored.status).toBe(200);
      await page.reload();
      await page.locator("#composer-input").fill("切回视觉后继续");
      await page.locator("#send-button").click();
      await waitDone("视觉恢复完成");
      const resumed = JSON.stringify(imageConnection.requests.at(-1).body);
      expect(resumed).toContain(pixels);
      expect(resumed).toContain("纯文本继续完成");
      expect(resumed).toContain("切回视觉后继续");
    } finally {
      await dashboard.stop();
      await imageConnection.close();
      await text.close();
    }
  });
}
