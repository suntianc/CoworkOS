import { test, expect } from "@playwright/test";
import { startConfiguredDashboard as startDashboard } from "../test/dashboard-fixture.mjs";

async function nativeBridge(page) {
  await page.addInitScript(() => {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
    window.__voiceCalls = [];
    let listener;
    window.__voiceEvent = (event) => listener?.(event);
    window.bookmanDesktop = {
      platform: "darwin",
      onPrepareClose() {},
      voiceInput: {
        supported: true,
        onEvent(handler) {
          listener = handler;
          return () => {
            listener = undefined;
          };
        },
        start(options) {
          window.__voiceCalls.push({ operation: "start", ...options });
          return new Promise(() => {});
        },
        stop(options) {
          window.__voiceCalls.push({ operation: "stop", ...options });
          return Promise.resolve();
        },
        cancel(options) {
          window.__voiceCalls.push({ operation: "cancel", ...options });
          return Promise.resolve();
        }
      }
    };
  });
}

test("Mac voice bridge works without browser speech and persists its final text as a draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await nativeBridge(page);
    await page.goto(dashboard.base);
    const microphone = page.locator(".mic-button");
    const input = page.locator("#composer-input");
    await expect(microphone).toBeEnabled();
    await input.fill("保留原有文字");
    await microphone.click();
    await expect(microphone).toHaveAttribute("data-voice-state", "starting");
    const sessionId = await page.evaluate(() => window.__voiceCalls[0].sessionId);
    await page.evaluate((sessionId) => window.__voiceEvent({ sessionId, type: "started" }), sessionId);
    await expect(microphone).toHaveAttribute("data-voice-state", "listening");
    await input.fill("保留原有文字，还在手动输入");
    await microphone.click();
    await expect.poll(() => page.evaluate(() => window.__voiceCalls.at(-1).operation)).toBe("stop");
    await page.evaluate((sessionId) => {
      window.__voiceEvent({ sessionId, type: "result", transcript: "补充中文语音" });
      window.__voiceEvent({ sessionId, type: "result", transcript: "补充中文语音" });
      window.__voiceEvent({ sessionId, type: "ended" });
    }, sessionId);
    await expect(input).toHaveValue("保留原有文字，还在手动输入\n补充中文语音");
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#send-button")).toBeEnabled();
    await page.reload();
    await expect(input).toHaveValue("保留原有文字，还在手动输入\n补充中文语音");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("Mac voice permission wait is canceled by navigation, and denial preserves the new draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    for (const taskId of ["voice-a", "voice-b"])
      await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: taskId } });
    await nativeBridge(page);
    await page.goto(dashboard.base);
    await page.locator('[data-task="voice-a"].conversation-item').click();
    const microphone = page.locator(".mic-button");
    const input = page.locator("#composer-input");
    await input.fill("会话 A 的草稿");
    await microphone.click();
    const oldSession = await page.evaluate(() => window.__voiceCalls[0].sessionId);
    await page.locator('[data-task="voice-b"].conversation-item').click();
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    await input.fill("会话 B 的草稿");
    await expect.poll(() => page.evaluate(() => window.__voiceCalls.at(-1).operation)).toBe("cancel");
    await page.evaluate((sessionId) => {
      window.__voiceEvent({ sessionId, type: "started" });
      window.__voiceEvent({ sessionId, type: "result", transcript: "不属于 B 的结果" });
    }, oldSession);
    await expect(input).toHaveValue("会话 B 的草稿");
    await microphone.click();
    const currentSession = await page.evaluate(() => window.__voiceCalls.at(-1).sessionId);
    await page.evaluate(
      (sessionId) =>
        window.__voiceEvent({
          sessionId,
          type: "error",
          code: "microphone-denied",
          message: "请在系统设置的隐私与安全性中允许 CoworkOS 使用麦克风"
        }),
      currentSession
    );
    await expect(page.locator("#toast")).toContainText("系统设置");
    await expect(microphone).toHaveAttribute("aria-pressed", "false");
    await expect(input).toHaveValue("会话 B 的草稿");
    await microphone.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__voiceCalls.filter((call) => call.operation === "start").length)
      )
      .toBe(3);
  } finally {
    await dashboard.stop();
  }
});

test("browser speech network failure does not masquerade as a microphone permission failure", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.addInitScript(() => {
      window.SpeechRecognition = class {
        constructor() {
          window.__recognizer = this;
        }
        start() {
          this.onstart();
        }
        stop() {
          this.onend();
        }
        abort() {
          this.onend();
        }
      };
    });
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("出错时保留草稿");
    await page.locator(".mic-button").click();
    await page.evaluate(() => window.__recognizer.onerror({ error: "network" }));
    await expect(page.locator("#toast")).toContainText("语音识别服务");
    await expect(page.locator("#toast")).not.toContainText("麦克风权限");
    await expect(page.locator(".mic-button")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#composer-input")).toHaveValue("出错时保留草稿");
  } finally {
    await dashboard.stop();
  }
});
