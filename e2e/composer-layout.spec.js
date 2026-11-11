import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const model = "Example-Model-with-a-very-long-provider-model-identifier";
const folder = "研究项目与团队协作的超长工作文件夹名称-示例项目";
const workspacePath = `/tmp/atria-layout/${folder}`;

async function configuredModel(page, models = [model]) {
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { configured: true, current: model, models } })
  );
}

async function checkToolbar(page, width) {
  await page.setViewportSize({ width, height: 800 });
  const composer = await page.locator(".composer").boundingBox();
  const contextVisible = await page.locator("[data-composer-context]").isVisible();
  expect(composer.height).toBeLessThanOrEqual(contextVisible ? 155 : 145);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await expect(page.locator(".mic-button, #i-mic")).toHaveCount(0);
  const centers = [];
  for (const selector of [".attach-button", "#model-select", "#send-button"]) {
    const control = page.locator(selector);
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(composer.x);
    expect(box.x + box.width, `${width}px ${selector}`).toBeLessThanOrEqual(composer.x + composer.width);
    expect(box.y + box.height).toBeLessThan(composer.y + composer.height);
    centers.push(box.y + box.height / 2);
  }
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
  const attach = await page.locator(".attach-button").boundingBox();
  const selectedModel = await page.locator("#model-select").boundingBox();
  const projectChip = page.locator("#composer-project");
  if (await projectChip.isVisible()) {
    const chip = await projectChip.boundingBox();
    expect(chip.x - attach.x - attach.width).toBeGreaterThanOrEqual(0);
    expect(chip.x - attach.x - attach.width).toBeLessThanOrEqual(8);
    expect(selectedModel.x - chip.x - chip.width).toBeGreaterThanOrEqual(0);
  } else {
    expect(selectedModel.x - attach.x - attach.width).toBeGreaterThanOrEqual(0);
    expect(selectedModel.x - attach.x - attach.width).toBeLessThanOrEqual(8);
  }
  await expect(page.locator(".composer #computer-access, .composer #task-capabilities")).toHaveCount(0);
  const name = await page
    .locator(".model-name")
    .evaluate((node) => ({ width: node.clientWidth, full: node.scrollWidth }));
  expect(name.width).toBeLessThan(name.full);
  await expect(page.locator("#model-select")).toHaveAttribute("title", `切换模型 · ${model}`);
}

test("the composer keeps one compact action row with long model and project names at desktop and narrow widths", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await configuredModel(page);
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          projects: body.projects.map((project) => ({
            ...project,
            projectName: folder,
            projectDirectory: workspacePath
          }))
        }
      });
    });
    await page.goto(dashboard.base);
    await expect(page.locator(".model-name")).toHaveText(model);
    await expect(page.locator("#app-bind-select")).toHaveClass(/is-empty/);
    await expect(page.locator("#app-bind-select")).toBeHidden();
    await expect(page.locator(".project-group.is-selected .project-name")).toHaveText(folder);
    await expect(page.locator(".project-group.is-selected .project-row")).toHaveAttribute(
      "title",
      workspacePath
    );
    await expect(page.locator("#workspace-button, #workspace-label")).toHaveCount(0);
    for (const width of [1440, 1280, 474, 320]) {
      await checkToolbar(page, width);
      await page.locator("#model-select").click();
      await expect(page.locator("#model-menu")).toBeVisible();
      const menu = await page.locator("#model-menu").boundingBox();
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(width);
      const anchor = await page.locator("#model-select").boundingBox();
      const bar = await page.locator(".composer-bar").boundingBox();
      expect(menu.x).toBeCloseTo(Math.max(bar.x, Math.min(anchor.x, bar.x + bar.width - menu.width)), 0);
      await page.locator("#model-menu [data-model]").click();
      if (process.env.COWORK_KEEP_COMPOSER_PROBE === "1") {
        await page.locator(".composer").screenshot({ path: test.info().outputPath(`toolbar-${width}.png`) });
        if (width === 1440) await page.screenshot({ path: test.info().outputPath("home-1440.png") });
        if (width === 320)
          await page.locator(".composer").screenshot({
            path: test.info().outputPath("composer-320.png")
          });
      }
    }
  } finally {
    await dashboard.stop();
  }
});

test("an unconfigured workspace shows a clear connection action without a placeholder model or empty application control", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#model-setup-button")).toBeVisible();
    await expect(page.locator("#model-select")).toBeHidden();
    await expect(page.locator("#app-bind-select")).toBeHidden();
    for (const width of [1440, 474, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const composer = await page.locator(".composer").boundingBox();
      expect(composer.height).toBeLessThanOrEqual(145);
      const connect = await page.locator("#model-setup-button").boundingBox();
      const send = await page.locator("#send-button").boundingBox();
      expect(Math.abs(connect.y + connect.height / 2 - send.y - send.height / 2)).toBeLessThanOrEqual(2);
      expect(send.x + send.width).toBeLessThan(composer.x + composer.width);
    }
  } finally {
    await dashboard.stop();
  }
});

test("the running composer switches one primary action and preserves the draft through cancellation", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const taskId = "stop-action-layout";
  let active = true;
  let detailReads = 0;
  const cancellations = [];
  const followUps = [];
  let releaseCancel;
  const cancelGate = new Promise((resolve) => {
    releaseCancel = resolve;
  });
  try {
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal: "停止按钮交互验收" }
    });
    const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
    await page.route("**/api/models", (route) =>
      route.fulfill({
        json: { configured: true, current: "Example-Model", models: ["Example-Model"] }
      })
    );
    await page.route(`**/api/tasks/${taskId}`, (route) => {
      detailReads += 1;
      return route.fulfill({
        json: {
          ...detail,
          task: { ...detail.task, status: active ? "running" : "cancelled" },
          runtime: { active }
        }
      });
    });
    await page.route(`**/api/tasks/${taskId}/action`, async (route) => {
      cancellations.push(route.request().postDataJSON());
      if (cancellations.length === 1) {
        await cancelGate;
        await route.fulfill({ status: 503, json: { error: "隔离取消失败" } });
      } else {
        active = false;
        await route.fulfill({ json: { ok: true } });
      }
    });
    await page.route(`**/api/tasks/${taskId}/interject`, (route) => {
      followUps.push(route.request().postDataJSON());
      return route.fulfill({ json: { messageId: `primary-action-${followUps.length}` } });
    });
    await page.goto(dashboard.base);
    const stop = page.locator("#stop-button");
    const send = page.locator("#send-button");
    const input = page.locator("#composer-input");
    await expect(stop).toBeVisible();
    await expect(send).toBeHidden();
    await expect(stop.locator("svg use")).toHaveAttribute("href", "#i-stop");
    expect((await stop.textContent()).trim()).toBe("");
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await stop.boundingBox();
      expect(box.width).toBe(32);
      expect(box.height).toBe(32);
      expect(await stop.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("50%");
      if (process.env.COWORK_KEEP_STOP_PROBE === "1")
        await page.locator(".composer").screenshot({
          path: test.info().outputPath(`composer-stop-${width}.png`)
        });
      await input.fill("   ");
      await expect(send).toBeHidden();
      await expect(stop).toBeVisible();
      await input.fill("补充要求，保留这条草稿");
      await expect(send).toBeVisible();
      await expect(stop).toBeHidden();
      const sendBox = await send.boundingBox();
      expect(Math.abs(sendBox.x - box.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(sendBox.y - box.y)).toBeLessThanOrEqual(2);
      expect(
        await send.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })
      ).toBe(true);
      if (process.env.COWORK_KEEP_STOP_PROBE === "1" && [1440, 320].includes(width))
        await page.locator(".composer").screenshot({
          path: test.info().outputPath(`composer-steer-${width}.png`)
        });
      await input.fill("");
      await expect(stop).toBeVisible();
      await expect(send).toBeHidden();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#file-input").setInputFiles({
      name: "attachment-only-follow-up.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("ISOLATED_ATTACHMENT_FOLLOW_UP")
    });
    await expect(page.locator(".attachment-chip")).toHaveCount(1);
    await expect(input).toHaveValue("");
    await expect(send).toBeVisible();
    await expect(stop).toBeHidden();
    await send.click();
    await expect.poll(() => followUps.length).toBe(1);
    expect(followUps[0].delivery).toBe("followUp");
    expect(followUps[0].message).toBe("请查看这些附件。");
    expect(followUps[0].attachmentIds).toHaveLength(1);
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    await expect(stop).toBeVisible();
    await expect(send).toBeHidden();
    await input.fill("运行中排队的文字补充");
    await expect(send).toBeVisible();
    await expect(stop).toBeHidden();
    await send.click();
    await expect.poll(() => followUps.length).toBe(2);
    expect(followUps[1]).toEqual({
      message: "运行中排队的文字补充",
      delivery: "followUp",
      attachmentIds: []
    });
    await expect(input).toHaveValue("");
    await expect(stop).toBeVisible();
    await expect(send).toBeHidden();
    await stop.click();
    await expect(stop).toHaveAttribute("aria-label", "正在停止任务");
    await expect(stop).toBeDisabled();
    await expect(stop).toHaveAttribute("aria-busy", "true");
    await input.fill("停止等待期间写的草稿");
    await input.press("Enter");
    await expect(input).toHaveValue("停止等待期间写的草稿");
    await expect(send).toBeHidden();
    const readsBeforePoll = detailReads;
    await expect.poll(() => detailReads).toBeGreaterThan(readsBeforePoll);
    await expect(stop).toBeVisible();
    await expect(stop).toBeDisabled();
    await expect(stop.locator("svg use")).toHaveAttribute("href", "#i-stop");
    expect(followUps).toHaveLength(2);
    expect(cancellations).toEqual([{ action: "cancel" }]);
    if (process.env.COWORK_KEEP_STOP_PROBE === "1")
      await page.locator(".composer").screenshot({
        path: test.info().outputPath("composer-stopping-draft-1440.png")
      });
    releaseCancel();
    await expect(page.locator("#toast")).toContainText("隔离取消失败");
    await expect(stop).toBeHidden();
    await expect(stop).toHaveAttribute("aria-busy", "false");
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(input).toHaveValue("停止等待期间写的草稿");
    await page.locator(`[data-task="${taskId}"]`).hover();
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click({ button: "right" });
    await page.locator('[data-session-action="stop"]').click();
    await expect(page.locator("#toast")).toContainText("任务已停止");
    await expect(stop).toBeHidden();
    await expect(send).toBeVisible();
    await expect(send).toHaveAttribute("aria-label", "发送");
    await expect(input).toHaveValue("停止等待期间写的草稿");
    expect(followUps).toHaveLength(2);
    expect(cancellations).toEqual([{ action: "cancel" }, { action: "cancel" }]);
  } finally {
    releaseCancel();
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});
