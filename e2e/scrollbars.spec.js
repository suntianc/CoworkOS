import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const reveal = (page) =>
  page.evaluate(() =>
    Number(getComputedStyle(document.querySelector("#scroll-probe")).getPropertyValue("--scroll-reveal"))
  );

test("a scrollbar fades in while the person scrolls, fades out after, and a reflow never shows it", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.id = "scroll-probe";
      probe.style.cssText =
        "position:fixed;left:300px;top:100px;width:300px;height:200px;overflow:auto;z-index:99";
      probe.innerHTML = `<div style="height:2000px"><div id="scroll-child" style="height:100px;overflow:auto"><div style="height:500px"></div></div></div>`;
      document.body.append(probe);
    });

    // Moving the position without any input (a panel reflowing the area) keeps it hidden.
    await page.waitForTimeout(1100);
    // A click (the toggle that opens a panel) ends before the reflow it causes.
    await page.mouse.click(450, 200);
    await page.evaluate(() => (document.querySelector("#scroll-probe").scrollTop = 300));
    await page.waitForTimeout(200);
    expect(await reveal(page)).toBe(0);

    // The person's wheel fades it in, with frames in between rather than a jump.
    await page.mouse.move(450, 200);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => reveal(page)).toBe(1);
    const thumb = await page.evaluate(
      () => getComputedStyle(document.querySelector("#scroll-probe")).scrollbarColor
    );
    expect(thumb).not.toMatch(/^transparent/);
    // A nested area does not inherit its parent's scrollbar.
    expect(
      await page.evaluate(() =>
        Number(getComputedStyle(document.querySelector("#scroll-child")).getPropertyValue("--scroll-reveal"))
      )
    ).toBe(0);

    // After it settles it fades out through partial values back to hidden.
    const samples = [];
    await expect
      .poll(
        async () => {
          const value = await reveal(page);
          samples.push(value);
          return value;
        },
        { intervals: [30], timeout: 3000 }
      )
      .toBe(0);
    expect(samples.some((value) => value > 0 && value < 1)).toBe(true);
  } finally {
    await dashboard.stop();
  }
});
