import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

/**
 * Scripted motion runs through the Web Animations API, so every call is
 * recorded with a description of its target; CSS motion is read back from
 * the computed style while it runs.
 */
const recordAnimations = () => {
  window.__animated = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const node = this;
    window.__animated.push({
      id: node.id,
      classes: String(node.className?.baseVal ?? node.className ?? ""),
      href: node.querySelector?.("use")?.getAttribute("href") ?? ""
    });
    return animate.apply(this, args);
  };
};
const animated = (page) => page.evaluate(() => window.__animated);
const reset = (page) => page.evaluate(() => (window.__animated = []));

test("interactions move: arrivals, copy, disclosures, dialogs and sidebar rows", async ({
  page,
  context
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(recordAnimations);
  const provider = await modelProtocolFixture("openai-completions", async () => ({
    text: "好的，已经处理完。"
  }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("第一条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.main").last()).toContainText("已经处理完", { timeout: 30000 });

    // A new conversation joins the sidebar by growing into place.
    expect((await animated(page)).some((entry) => entry.classes.includes("conversation-row"))).toBe(true);

    // A message sent into the open conversation slides in; earlier ones stay still.
    await reset(page);
    await page.locator("#composer-input").fill("第二条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.user")).toHaveCount(2);
    await expect(page.locator(".chat-message.main")).toHaveCount(2, { timeout: 30000 });
    const arrivals = (await animated(page)).filter((entry) => entry.classes.includes("chat-message"));
    expect(arrivals.some((entry) => entry.classes.includes("user"))).toBe(true);
    expect(arrivals.length).toBeLessThanOrEqual(3);

    // Copying a message turns its icon into a check that pops, then back.
    await reset(page);
    const message = page.locator(".chat-message.user").last();
    await message.hover();
    const copy = message.locator("[data-user-copy]");
    await copy.click();
    await expect(copy.locator("use")).toHaveAttribute("href", "#i-check");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("第二条消息");
    expect((await animated(page)).some((entry) => entry.href === "#i-check")).toBe(true);
    await expect(copy.locator("use")).toHaveAttribute("href", "#i-copy", { timeout: 3000 });

    // A disclosure eases its content open through intermediate heights.
    await page.evaluate(() => {
      const details = document.createElement("details");
      details.id = "motion-details";
      details.innerHTML = '<summary>展开</summary><div style="height:200px">内容</div>';
      document.querySelector("#conversation").append(details);
    });
    const details = page.locator("#motion-details");
    const closed = (await details.boundingBox()).height;
    await details.locator("summary").click();
    const heights = [];
    for (let frame = 0; frame < 12; frame += 1) {
      heights.push((await details.boundingBox()).height);
      await page.waitForTimeout(16);
    }
    await expect.poll(async () => (await details.boundingBox()).height).toBeGreaterThan(closed + 190);
    expect(heights.some((height) => height > closed + 1 && height < closed + 199)).toBe(true);

    // A dialog's card rises in over a fading backdrop.
    await reset(page);
    const settings = page.locator("[data-project-settings]").first();
    await settings.locator("..").hover();
    await settings.click();
    await page.getByRole("menuitem", { name: "重命名项目", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "重命名项目", exact: true })).toBeVisible();
    expect((await animated(page)).some((entry) => /modal-card|app-dialog/.test(entry.classes))).toBe(true);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("reduced motion keeps every interaction still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(recordAnimations);
  const provider = await modelProtocolFixture("openai-completions", async () => ({ text: "好的。" }));
  const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
  try {
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("第一条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.main").last()).toContainText("好的", { timeout: 30000 });
    await page.locator("#composer-input").fill("第二条消息");
    await page.locator("#send-button").click();
    await expect(page.locator(".chat-message.main")).toHaveCount(2, { timeout: 30000 });
    const moved = (await animated(page)).filter((entry) =>
      /chat-message|conversation-row|modal-card/.test(entry.classes)
    );
    expect(moved).toEqual([]);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
