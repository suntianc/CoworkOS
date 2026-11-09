import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function palette(page) {
  return page.locator("html").evaluate((node) => {
    const sample = document.createElement("span");
    node.append(sample);
    const color = (token) => {
      sample.style.color = `var(${token})`;
      return getComputedStyle(sample).color;
    };
    const result = { panel: color("--ui-panel"), text: color("--ui-text"), accent: color("--ui-accent") };
    sample.remove();
    return result;
  });
}

test("human replies use the shared palette and retain answers through a visible submission error", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// Mount the shipped reply controller." })
    );
    // Follow the system appearance so emulated color schemes drive both themes.
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createHumanQuestions } = await import("/assets/human-questions.js");
      const questions = createHumanQuestions(document.querySelector("#human-questions"), {
        submit: async () => {
          throw new Error("测试回复暂未送达，请重试");
        },
        resume: async () => {},
        onVisibility: (visible) => {
          document.querySelector(".composer").hidden = visible;
        },
        onError: () => {}
      });
      questions.update({
        task: { taskId: "surface-human", status: "waiting" },
        humanRequests: [
          {
            requestId: "format",
            status: "pending",
            question: "希望如何保留报告中的内容？",
            context: "你可以先选择一个方案，再补充自己的要求。",
            options: ["保留完整内容和格式", "只保留要点"],
            recommended: 0
          }
        ]
      });
    });
    const card = page.locator("#human-questions");
    const answer = card.getByRole("textbox");
    const submit = card.getByRole("button", { name: "提交并继续", exact: true });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const colors = await palette(page);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 760 });
        await expect(card).toHaveCSS("background-color", colors.panel);
        await expect(card).toHaveCSS("color", colors.text);
        await expect(submit).toHaveCSS("background-color", colors.accent);
        await expect(answer).toHaveCSS("font-size", "14px");
        await expect(submit).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`reply-${theme}-${width}.png`) });
      }
    }
    await answer.fill("保留图表与引用");
    await submit.click();
    await expect(card.locator(".human-error")).toContainText("测试回复暂未送达");
    await expect(answer).toHaveValue("保留图表与引用");
    await expect(submit).toBeEnabled();
  } finally {
    await dashboard.stop();
  }
});
