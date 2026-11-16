import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { HumanRequestStore } from "../dist/src/runtime/human.js";

const { createComposerDraftStore } = createRequire(import.meta.url)("../desktop/composer-drafts.cjs");
const preload = await readFile("desktop/preload.cjs", "utf8");

test("answered questions use a compact button with accessible full replies in both themes", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  try {
    await page.route("**/app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "// Isolated answered-question display." })
    );
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createConversationView } = await import("/assets/controllers/conversation-view.js");
      const { humanAnswerTurn } = await import("/assets/human-questions.js");
      const request = {
        requestId: "city",
        taskId: "answer-display",
        status: "answered",
        question: "你好！你想查询哪个城市或地区的天气？",
        answer: "上海"
      };
      const state = {
        selected: "answer-display",
        localMessages: [],
        executionHistoryOpen: new Map(),
        detail: {
          task: { taskId: "answer-display", status: "completed" },
          runtime: { active: false },
          runtimeEvents: [],
          humanRequests: [request]
        }
      };
      const view = createConversationView({
        state,
        $: (selector) => document.querySelector(selector),
        bindStarterPrompts() {},
        textContent: (content) => String(content || "")
      });
      const render = () =>
        view.renderConversation(
          [
            { role: "user", timestamp: 1, content: "你好，今天天气怎么样？" },
            {
              role: "assistant",
              timestamp: 2,
              stopReason: "stop",
              content: "你好！我还不知道你所在的位置，告诉我城市或地区即可。"
            },
            { role: "user", timestamp: 3, content: humanAnswerTurn(request.question, request.answer) },
            {
              role: "assistant",
              timestamp: 4,
              stopReason: "stop",
              content: "上海今天阴天，早晚稍凉，出门可以带一件薄外套。"
            }
          ],
          state.detail.task
        );
      window.answerDisplayFixture = {
        poll: render,
        long() {
          request.question = "你希望保留哪些内容？".repeat(24);
          request.answer = "**上海**\n\n" + "保留完整的多行回复与人工编辑。\n\n".repeat(30);
          render();
        }
      };
      render();
    });
    const disclosure = page.locator(".human-answer-details");
    const trigger = disclosure.locator("summary");
    await expect(trigger).toContainText("回答问题");
    await expect(page.locator(".human-answer-card")).toHaveCount(0);
    await expect(disclosure.locator(".human-answer-content")).toBeHidden();
    const compact = await trigger.boundingBox();
    const reply = await page.locator(".chat-message.main .message-copy").first().boundingBox();
    expect(Math.abs(compact.x - reply.x)).toBeLessThan(1);
    expect(compact.height).toBeLessThanOrEqual(34);
    expect(compact.width).toBeLessThan(170);
    for (const colorScheme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme });
      await page
        .locator("#conversation")
        .screenshot({ path: testInfo.outputPath(`answered-${colorScheme}-compact.png`) });
      await trigger.focus();
      await trigger.press("Enter");
      await expect(disclosure.locator(".human-answer-question")).toContainText("哪个城市或地区");
      await expect(disclosure.locator(".human-answer-value")).toHaveText("上海");
      await page.evaluate(() => window.answerDisplayFixture.poll());
      await expect(disclosure).toHaveAttribute("open", "");
      await expect(trigger).toBeFocused();
      await page
        .locator("#conversation")
        .screenshot({ path: testInfo.outputPath(`answered-${colorScheme}-expanded.png`) });
      await trigger.press("Enter");
    }
    await page.setViewportSize({ width: 320, height: 740 });
    await page.evaluate(() => window.answerDisplayFixture.long());
    await trigger.click();
    await expect(disclosure.locator(".human-answer-value strong")).toHaveText("上海");
    const geometry = await disclosure.locator(".human-answer-content").evaluate((node) => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      scroll: node.scrollHeight,
      height: node.clientHeight
    }));
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.scroll).toBeGreaterThan(geometry.height);
    await page.screenshot({ path: testInfo.outputPath("answered-narrow-expanded.png") });
  } finally {
    await dashboard.stop();
  }
});

async function nativeDrafts(page, store) {
  await page.exposeFunction("__persistHumanDrafts", (entries, origin) => store.save(entries, origin));
  await page.addInitScript({
    content: `(() => {
      const snapshot = ${JSON.stringify(store.snapshot())};
      const listeners = {};
      const electron = {
        contextBridge: { exposeInMainWorld: (name, value) => { window[name] = value; } },
        ipcRenderer: {
          sendSync: () => snapshot,
          on: (channel, handler) => { listeners[channel] = handler; },
          invoke: async (channel, ...args) => {
            if (channel === "bookman:save-composer-drafts") return window.__persistHumanDrafts(args[0], location.origin);
            if (channel === "bookman:documents-ready") window.__humanCloseAck = args[1];
          }
        }
      };
      window.__sendHumanNative = (channel, ...args) => listeners[channel]?.({}, ...args);
      (function(require, process) { ${preload} })((name) => electron, { platform: "darwin", env: {} });
    })();`
  });
}

async function questionFixture(page, base) {
  await page.route("**/app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "// Isolated human-question UI." })
  );
  await page.goto(base);
  await page.evaluate(async () => {
    const { createHumanQuestions } = await import("/assets/human-questions.js");
    document.querySelector("#conversation").replaceChildren();
    const request = {
      requestId: "question-one",
      question: "请选择验收报告格式",
      context: "确认后继续当前任务。",
      options: ["Markdown", "PDF"],
      recommended: 0,
      status: "pending"
    };
    let detail = { task: { taskId: "human-task", status: "running" }, humanRequests: [request] };
    const submissions = [];
    const controller = createHumanQuestions(document.querySelector("#human-questions"), {
      submit: (taskId, requestId, answer) => {
        submissions.push({ taskId, requestId, answer });
        return new Promise((resolve, reject) => {
          window.__humanResolve = resolve;
          window.__humanReject = reject;
        });
      },
      resume: async () => ({ status: "error", error: "合成恢复失败" }),
      onVisibility: (visible) => {
        document.querySelector(".composer").hidden = visible;
      }
    });
    window.bookmanDesktop?.onPrepareClose(async () => controller.flushDrafts?.() ?? true);
    window.humanFixture = {
      submissions,
      unanswered() {
        detail = { ...detail, humanRequests: [{ ...request, status: "unanswered" }] };
        controller.update(detail);
      },
      fail() {
        window.__humanReject(new Error("合成保存失败，请重试"));
      },
      answered() {
        detail = {
          ...detail,
          humanRequests: [{ ...request, status: "answered", answer: submissions.at(-1)?.answer }]
        };
        controller.update(detail);
        window.__humanResolve({ status: "running" });
      },
      changeTask(taskId) {
        detail = { task: { taskId, status: "running" }, humanRequests: [{ ...request }] };
        controller.update(detail);
      },
      longQuestion() {
        detail = {
          ...detail,
          humanRequests: [
            {
              ...request,
              question: "验收事项与当前模型约束".repeat(18),
              context: "需要确认导出尺寸、材料、模型版本和人工编辑的保留方式。".repeat(15),
              options: Array.from(
                { length: 7 },
                (_, index) => `方案 ${index + 1}：` + "保留当前模型并根据已确认的尺寸进行验证。".repeat(4)
              )
            }
          ]
        };
        controller.update(detail);
      }
    };
    controller.update(detail);
  });
}

test("human drafts keep focus through timeout and failed submission without replaying an answer", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await questionFixture(page, dashboard.base);
    const answer = page.getByRole("textbox", { name: "其他回答或补充说明" });
    const submit = page.getByRole("button", { name: "提交并继续", exact: true });
    await page.getByRole("radio", { name: "PDF", exact: true }).check();
    await answer.fill("保留原回答和插入位置");
    await answer.evaluate((node) => node.setSelectionRange(2, 5));
    await page.evaluate(() => window.humanFixture.unanswered());
    await expect(answer).toBeFocused();
    expect(await answer.evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([2, 5]);
    await submit.click();
    await expect(page.getByRole("button", { name: "正在提交…" })).toBeDisabled();
    await page.evaluate(() => window.humanFixture.fail());
    await expect(page.locator(".human-error")).toContainText("合成保存失败");
    await expect(answer).toHaveValue("保留原回答和插入位置");
    await expect(page.getByRole("radio", { name: "PDF", exact: true })).toBeChecked();
    await expect(submit).toBeFocused();
    await submit.press("Enter");
    await page.evaluate(() => window.humanFixture.answered());
    await expect(page.locator("#human-questions")).toBeHidden();
    expect(await page.evaluate(() => window.humanFixture.submissions)).toEqual([
      { taskId: "human-task", requestId: "question-one", answer: "PDF\n\n补充说明：保留原回答和插入位置" },
      { taskId: "human-task", requestId: "question-one", answer: "PDF\n\n补充说明：保留原回答和插入位置" }
    ]);
  } finally {
    await dashboard.stop();
  }
});

test("a late rejected submission cannot take focus from another task", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await questionFixture(page, dashboard.base);
    const answer = page.getByRole("textbox", { name: "其他回答或补充说明" });
    await page.getByRole("radio", { name: "PDF", exact: true }).check();
    await answer.fill("提交中的回复");
    await page.getByRole("button", { name: "提交并继续", exact: true }).click();
    await page.evaluate(() => window.humanFixture.changeTask("human-other"));
    await answer.fill("另一任务的回复");
    await answer.evaluate((node) => node.setSelectionRange(1, 3));
    await page.evaluate(() => window.humanFixture.fail());
    await expect(answer).toBeFocused();
    await expect(answer).toHaveValue("另一任务的回复");
    expect(await answer.evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([1, 3]);
    await expect(page.locator(".human-error")).toBeEmpty();
    expect(await page.evaluate(() => window.humanFixture.submissions.length)).toBe(1);
  } finally {
    await dashboard.stop();
  }
});

test("long human questions scroll inside the card and keep the submission control reachable on a narrow screen", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.setViewportSize({ width: 320, height: 700 });
    await questionFixture(page, dashboard.base);
    await page.evaluate(() => window.humanFixture.longQuestion());
    const card = page.locator("#human-questions");
    const submit = page.getByRole("button", { name: "提交并继续", exact: true });
    await expect(card).toBeVisible();
    await expect(submit).toBeInViewport();
    const geometry = await card.evaluate((node) => {
      const body = node.querySelector(".human-card-body");
      return {
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
        scroll: body.scrollHeight,
        height: body.clientHeight
      };
    });
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.scroll).toBeGreaterThan(geometry.height);
    const answer = page.getByRole("textbox", { name: "其他回答或补充说明" });
    await answer.fill("保留当前模型与人工编辑");
    await expect(submit).toBeEnabled();
    await expect(submit).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("human-question-320.png") });
  } finally {
    await dashboard.stop();
  }
});

test("the shipped app close handler refuses a memory-only human reply and saves it after storage recovers", async ({
  page
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-app-close-"));
  const dashboard = await startDashboard();
  const store = createComposerDraftStore(root);
  await store.load();
  try {
    await nativeDrafts(page, store);
    const taskId = "human-app-close";
    expect(
      (
        await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: "人工回复关闭验收" } })
      ).ok()
    ).toBe(true);
    await new HumanRequestStore(dashboard.workspaceRoot).create({
      taskId,
      runId: "human-run",
      question: "导出前需要保留什么？"
    });
    await page.goto(dashboard.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    const answer = page.getByRole("textbox", { name: "你的回答", exact: true });
    await expect(answer).toBeVisible();
    await page.evaluate(() => {
      window.__realHumanSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("atria.human.v1:")) throw new DOMException("quota fixture", "QuotaExceededError");
        return window.__realHumanSetItem.call(this, key, value);
      };
    });
    await answer.fill("最终应保留完整的中文回复 😀");
    await page.evaluate(() => window.__sendHumanNative("bookman:prepare-close", "app-close-refuse"));
    await expect.poll(() => page.evaluate(() => window.__humanCloseAck)).toBe(false);
    await expect(answer).toHaveValue("最终应保留完整的中文回复 😀");
    await page.evaluate(() => {
      Storage.prototype.setItem = window.__realHumanSetItem;
      window.__sendHumanNative("bookman:prepare-close", "app-close-saved");
    });
    await expect.poll(() => page.evaluate(() => window.__humanCloseAck)).toBe(true);
    expect(
      Object.values(store.snapshot().entries).some((value) => value.includes("最终应保留完整的中文回复 😀"))
    ).toBe(true);
  } finally {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop human draft and explicit choice survive a new origin and are removed only after accepted submission", async ({
  page,
  context
}) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-draft-profile-"));
  const first = await startDashboard();
  const second = await startDashboard();
  const store = createComposerDraftStore(root);
  await store.load();
  try {
    await nativeDrafts(page, store);
    await questionFixture(page, first.base);
    await page.getByRole("radio", { name: "PDF", exact: true }).check();
    await page.getByRole("textbox", { name: "其他回答或补充说明" }).fill("重启后继续完整的人工回复 😀");
    await page.evaluate(() => window.__sendHumanNative("bookman:prepare-close", "human-first-close"));
    await expect.poll(() => page.evaluate(() => window.__humanCloseAck)).toBe(true);
    const restartedStore = createComposerDraftStore(root);
    await restartedStore.load();
    const restored = await context.newPage();
    await nativeDrafts(restored, restartedStore);
    await questionFixture(restored, second.base);
    await expect(restored.getByRole("textbox", { name: "其他回答或补充说明" })).toHaveValue(
      "重启后继续完整的人工回复 😀"
    );
    await expect(restored.getByRole("radio", { name: "PDF", exact: true })).toBeChecked();
    await restored.getByRole("button", { name: "提交并继续" }).click();
    await restored.evaluate(() => window.humanFixture.answered());
    await expect(restored.locator("#human-questions")).toBeHidden();
    await restored.evaluate(() => window.__sendHumanNative("bookman:prepare-close", "human-accepted-close"));
    await expect.poll(() => restored.evaluate(() => window.__humanCloseAck)).toBe(true);
    expect(
      Object.keys(restartedStore.snapshot().entries).filter((key) => key.startsWith("atria.human.v1:"))
    ).toEqual([]);
  } finally {
    await first.stop();
    await second.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("human drafts belong to their task and memory-only changes refuse a desktop close", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-draft-quota-"));
  const dashboard = await startDashboard();
  const store = createComposerDraftStore(root);
  await store.load();
  try {
    await nativeDrafts(page, store);
    await questionFixture(page, dashboard.base);
    const answer = page.getByRole("textbox", { name: "其他回答或补充说明" });
    await answer.fill("A 的独立回复");
    await page.evaluate(() => window.humanFixture.changeTask("human-other"));
    await expect(answer).toHaveValue("");
    await answer.fill("B 的独立回复");
    await page.evaluate(() => window.humanFixture.changeTask("human-task"));
    await expect(answer).toHaveValue("A 的独立回复");
    await page.evaluate(() => {
      window.__realHumanSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("atria.human.v1:")) throw new DOMException("quota fixture", "QuotaExceededError");
        return window.__realHumanSetItem.call(this, key, value);
      };
    });
    await answer.fill("配额失败时保留的最新回复");
    await page.evaluate(() => window.__sendHumanNative("bookman:prepare-close", "human-quota-close"));
    await expect.poll(() => page.evaluate(() => window.__humanCloseAck)).toBe(false);
    await expect(answer).toHaveValue("配额失败时保留的最新回复");
    await page.evaluate(() => {
      Storage.prototype.setItem = window.__realHumanSetItem;
      window.__sendHumanNative("bookman:prepare-close", "human-quota-recovered");
    });
    await expect.poll(() => page.evaluate(() => window.__humanCloseAck)).toBe(true);
    expect(
      Object.values(store.snapshot().entries).some((value) => value.includes("配额失败时保留的最新回复"))
    ).toBe(true);
  } finally {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true });
  }
});
