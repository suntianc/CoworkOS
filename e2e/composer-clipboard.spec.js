import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const pasteKey = process.platform === "darwin" ? "Meta+v" : "Control+v";

async function writeClipboard(page, { text, html, image = false }) {
  await page.evaluate(
    async ({ text, html, image }) => {
      const formats = {};
      if (text !== undefined) {
        formats["text/plain"] = new Blob([text], { type: "text/plain" });
        formats["text/html"] = new Blob([`<p>${text}</p>`], { type: "text/html" });
      }
      if (html !== undefined) formats["text/html"] = new Blob([html], { type: "text/html" });
      if (image) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 2;
        const context = canvas.getContext("2d");
        context.fillStyle = `rgb(${(window.clipboardImageIndex = (window.clipboardImageIndex || 0) + 1)}, 0, 0)`;
        context.fillRect(0, 0, 2, 2);
        formats["image/png"] = await new Promise((resolve) => canvas.toBlob(resolve));
      }
      await navigator.clipboard.write([new ClipboardItem(formats)]);
    },
    { text, html, image }
  );
}

test("trusted keyboard paste keeps mixed text, selections and per-session drafts, while images remain attachments", async ({
  page,
  context
}) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    for (const taskId of ["clipboard-first", "clipboard-second"])
      await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: taskId } });
    await page.route("**/api/models", (route) =>
      route.fulfill({ json: { configured: true, current: "fixture", models: ["fixture"] } })
    );
    await page.goto(dashboard.base);
    await page.locator('[data-task="clipboard-first"]').click();
    const input = page.locator("#composer-input");
    await input.evaluate((element) => {
      window.pastes = [];
      element.addEventListener("paste", (event) =>
        queueMicrotask(() =>
          window.pastes.push({
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
            text: event.clipboardData.getData("text/plain")
          })
        )
      );
    });
    await input.fill("已有草稿尾部");
    await input.evaluate((element) => element.setSelectionRange(4, 6));
    const text = "复制文字\n第二行";
    await writeClipboard(page, { text, image: true });
    await input.press(pasteKey);
    await expect(input).toHaveValue(`已有草稿${text}`);
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    await expect(page.locator("#send-button")).toBeEnabled();
    await input.press(pasteKey);
    await expect(input).toHaveValue(`已有草稿${text}${text}`);
    await page.locator('[data-task="clipboard-second"]').click();
    await expect(input).toHaveValue("");
    await writeClipboard(page, { text: "纯文字\n第三行" });
    await input.press(pasteKey);
    await expect(input).toHaveValue("纯文字\n第三行");
    await page.locator('[data-task="clipboard-first"]').click();
    await expect(input).toHaveValue(`已有草稿${text}${text}`);
    await writeClipboard(page, { image: true });
    await input.press(pasteKey);
    await expect(page.locator(".attachment-chip")).toHaveCount(1);
    await expect(input).toHaveValue(`已有草稿${text}${text}`);
    expect(await page.evaluate(() => window.pastes)).toEqual([
      { trusted: true, prevented: false, text },
      { trusted: true, prevented: false, text },
      { trusted: true, prevented: false, text: "纯文字\n第三行" },
      { trusted: true, prevented: true, text: "" }
    ]);
    await page.reload();
    await expect(input).toHaveValue(`已有草稿${text}${text}`);
    await expect(page.locator(".attachment-chip")).toHaveCount(1);
    await input.evaluate((el) => {
      window.pastes = [];
      el.addEventListener("paste", (event) =>
        queueMicrotask(() =>
          window.pastes.push({
            trusted: event.isTrusted,
            text: event.clipboardData.getData("text/plain"),
            html: event.clipboardData.getData("text/html"),
            prevented: event.defaultPrevented,
            items: Array.from(event.clipboardData.items).map((item) => [item.kind, item.type])
          })
        )
      );
    });
    let resourceRequests = 0;
    await page.route("https://clipboard.invalid/**", (route) => {
      resourceRequests++;
      return route.abort();
    });
    await input.fill("前缀替换后缀");
    await input.evaluate((element) => element.setSelectionRange(2, 4));
    await writeClipboard(page, {
      html: '<p>HTML第一行<br>第二行</p><div>第三行</div><img src="https://clipboard.invalid/image.png"><script>window.clipboardExecuted = true</script>',
      image: true
    });
    await input.press(pasteKey);
    await expect(input).toHaveValue("前缀HTML第一行\n第二行\n第三行后缀");
    await expect(page.locator(".attachment-chip")).toHaveCount(1);
    await page.locator('[data-task="clipboard-second"]').click();
    await expect(input).toHaveValue("纯文字\n第三行");
    await page.locator('[data-task="clipboard-first"]').click();
    await expect(input).toHaveValue("前缀HTML第一行\n第二行\n第三行后缀");
    await page.locator("[data-remove-attachment]").click();
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    await writeClipboard(page, { html: '<img src="https://clipboard.invalid/image.png">', image: true });
    await input.press(pasteKey);
    await expect(page.locator(".attachment-chip")).toHaveCount(1);
    await expect(input).toHaveValue("前缀HTML第一行\n第二行\n第三行后缀");
    expect(
      await page.evaluate(() =>
        window.pastes.map(({ trusted, text, prevented, items }) => ({
          trusted,
          text,
          prevented,
          hasImage: items.some(([kind, type]) => kind === "file" && type === "image/png")
        }))
      )
    ).toEqual([
      { trusted: true, text: "", prevented: true, hasImage: true },
      { trusted: true, text: "", prevented: true, hasImage: true }
    ]);
    expect(resourceRequests).toBe(0);
    expect(await page.evaluate(() => window.clipboardExecuted)).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("the same screenshot pasted twice becomes two numbered one-line attachments", async ({
  page,
  context
}, testInfo) => {
  const dashboard = await startDashboard();
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(dashboard.base);
    const input = page.locator("#composer-input");
    await writeClipboard(page, { image: true });
    for (let count = 1; count <= 2; count += 1) {
      await input.press(pasteKey);
      await expect(page.locator("#attachment-strip [data-upload-preview]")).toHaveCount(count);
    }
    await expect(page.locator("#attachment-strip .attachment-name")).toHaveText([
      "image-1.png",
      "image-2.png"
    ]);
    // Each attachment is one line: an icon, its name and its size, with no thumbnail or status.
    const chips = page.locator("#attachment-strip .attachment-chip");
    for (const chip of await chips.all()) {
      expect((await chip.boundingBox()).height).toBeLessThanOrEqual(32);
      await expect(chip.locator("img")).toHaveCount(0);
      await expect(chip.locator("small")).toHaveText(/^\d+(\.\d+)? (B|KB|MB)$/);
    }
    // Hovering the name lights nothing up: the chip is one control.
    const name = chips.first().locator(".attachment-name");
    const resting = await name.evaluate((node) => getComputedStyle(node).color);
    await name.hover();
    await expect(name).toHaveCSS("color", resting);
    await expect(name).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // Anywhere on the chip opens the preview, not only its name.
    const icon = chips.first().locator(".attachment-chip-icon");
    await icon.click();
    await expect(page.locator(".attachment-preview:not([hidden])")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".attachment-preview:not([hidden])")).toHaveCount(0);
    await chips.first().locator("small").click();
    await expect(page.locator(".attachment-preview:not([hidden])")).toBeVisible();
    await page.keyboard.press("Escape");
    // Removing the first frees its number for the next paste.
    await chips.first().locator("[data-remove-attachment]").click();
    await input.press(pasteKey);
    await expect(page.locator("#attachment-strip .attachment-name")).toHaveText([
      "image-2.png",
      "image-1.png"
    ]);
    await page.locator(".composer").screenshot({ path: testInfo.outputPath("pasted-images.png") });
  } finally {
    await dashboard.stop();
  }
});
