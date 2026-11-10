import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

for (const visionApi of ["openai-completions", "openai-responses"]) {
  test(`${visionApi}: vision to text and back preserves images and tool history without sending pixels to text models`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    let uploadId,
      pendingUploadId,
      phase = "vision",
      visionCalls = 0,
      textCalls = 0;
    const vision = await modelProtocolFixture(visionApi, () => {
      if (phase === "vision" && ++visionCalls === 1)
        return { name: "read_attachment", arguments: { id: uploadId } };
      return { text: phase === "vision" ? "视觉读取完成" : "视觉恢复完成" };
    });
    const textApi = visionApi === "openai-completions" ? "openai-responses" : "openai-completions";
    const text = await modelProtocolFixture(textApi, () => {
      if (++textCalls === 1) return { name: "read_attachment", arguments: { id: pendingUploadId } };
      return { text: "纯文本继续完成" };
    });
    const dashboard = await startDashboard();
    const image = await readFile("web/assets/atria-symbol.png");
    const pixels = image.toString("base64");
    const status = async () => (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    const save = async (body) => {
      const result = await page.request.post(`${dashboard.base}/api/model-settings`, { data: body });
      expect(result.ok(), await result.text()).toBe(true);
      return result.json();
    };
    const waitDone = async (message) => {
      await expect(page.locator("#conversation")).toContainText(message, { timeout: 30_000 });
      await expect(page.locator("#stop-button")).toBeHidden();
    };
    try {
      await save({
        profileId: "",
        profileName: "视觉",
        baseUrl: vision.baseUrl,
        api: visionApi,
        model: "same-model-name",
        apiKey: "local-vision-key",
        supportsImages: true
      });
      await page.goto(dashboard.base);
      // Use the real upload composer path for the pending attachment as well.
      const historyUpload = page.waitForResponse(
        (response) =>
          response.url().includes("/api/uploads") && response.request().method() === "POST" && response.ok()
      );
      await page
        .locator("#file-input")
        .setInputFiles({ name: "history.png", mimeType: "image/png", buffer: image });
      await historyUpload;
      await expect(page.locator("#attachment-strip")).toContainText("history.png");
      // Capture its actual id; only task-attached inputs may be read by the tool.
      page.on("request", (req) => {
        if (req.method() === "POST" && /\/run$/.test(new URL(req.url()).pathname)) {
          const ids = req.postDataJSON()?.attachmentIds;
          if (phase === "vision") uploadId = ids?.[0];
          else if (phase === "text") pendingUploadId = ids?.[0];
        }
      });
      await page.locator("#composer-input").fill("读取这张图片，并保留历史文字");
      await page.locator("#send-button").click();
      await waitDone("视觉读取完成");
      expect(vision.requests.at(-1).body.model).toBe("same-model-name");
      expect(JSON.stringify(vision.requests.at(-1).body)).toContain(pixels);
      const first = (await status()).profiles[0];
      const pendingUpload = page.waitForResponse(
        (response) =>
          response.url().includes("/api/uploads") && response.request().method() === "POST" && response.ok()
      );
      await page
        .locator("#file-input")
        .setInputFiles({ name: "pending.png", mimeType: "image/png", buffer: image });
      await pendingUpload;
      await expect(page.locator("#attachment-strip")).toContainText("pending.png");
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
      expect(JSON.stringify(text.requests.at(-1).body)).toContain("当前模型未启用图像输入");
      phase = "restored";
      await save({ ...first, profileId: first.id, activate: true });
      await page.reload();
      await page.locator("#composer-input").fill("切回视觉后继续");
      await page.locator("#send-button").click();
      await waitDone("视觉恢复完成");
      const restored = JSON.stringify(vision.requests.at(-1).body);
      expect(restored).toContain(pixels);
      expect(restored).toContain("纯文本继续完成");
      expect(restored).toContain("切回视觉后继续");
    } finally {
      await dashboard.stop();
      await vision.close();
      await text.close();
    }
  });
}
