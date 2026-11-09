import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { protocolStream } from "../test/model-protocol-fixture.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function recoveryFixture(
  page,
  dashboard,
  {
    reject = false,
    rejection,
    rejectStatus = 503,
    rejectMessage = "503 local recovery fixture unavailable",
    gate,
    failureKind,
    httpStatus,
    emptyHistory = false,
    retryUnavailable = false,
    errorMessage = "401 Authentication failed"
  } = {}
) {
  const runs = [];
  const details = new Map();
  for (const taskId of ["recovery-a", "recovery-b"]) {
    await page.request.post(`${dashboard.base}/api/tasks`, { data: { taskId, goal: taskId } });
    const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
    const original = {
      role: "user",
      timestamp: 1,
      content: `${taskId} 的原始请求\n\nAttached files:\nsource.txt\nORIGINAL_ATTACHMENT_BODY`
    };
    const failure = {
      role: "assistant",
      timestamp: 2,
      stopReason: "error",
      errorMessage,
      content: [{ type: "thinking", thinking: "已经检查输入，保留既有结果。" }]
    };
    details.set(taskId, {
      ...detail,
      task: {
        ...detail.task,
        status: "failed",
        activeRunId: "failed-fixture-run",
        lastError: failure.errorMessage
      },
      runtime: { active: false },
      retryRequest:
        failureKind === "main_process"
          ? undefined
          : { requestId: "00000000-0000-4000-8000-000000000021", model: "original-model" },
      retryRequestUnavailable: retryUnavailable,
      messages: emptyHistory ? [] : [original, failure],
      runtimeEvents: [],
      events: failureKind
        ? [
            {
              runId: "failed-fixture-run",
              type: "main.run_failed",
              payload: {
                failure: { kind: failureKind, ...(httpStatus ? { httpStatus } : {}) }
              }
            }
          ]
        : []
    });
    await page.route(`**/api/tasks/${taskId}`, (route) => route.fulfill({ json: details.get(taskId) }));
  }
  await page.route("**/run", async (route) => {
    const taskId = new URL(route.request().url()).pathname.split("/").at(-2);
    runs.push({ taskId, ...route.request().postDataJSON() });
    if (gate) await gate.promise;
    if (reject) {
      await route.fulfill({
        status: rejection?.status ?? rejectStatus,
        json: rejection ?? { error: rejectMessage }
      });
      return;
    }
    const detail = details.get(taskId);
    details.set(taskId, {
      ...detail,
      task: { ...detail.task, status: "running", activeRunId: "recovery-fixture-run" },
      runtime: { active: true }
    });
    await route.fulfill({ status: 202, json: { runId: "recovery-fixture-run", model: "browser-fixture" } });
  });
  await page.goto(dashboard.base);
  await page.locator('.conversation-item[data-task="recovery-a"]').click();
  await expect(page.getByRole("alert")).toBeVisible();
  return { runs, details };
}

async function draft(page, text, name = "draft.txt") {
  await page.locator("#composer-input").fill(text);
  await page.locator("#file-input").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("UNSENT_ATTACHMENT_BODY")
  });
  await expect(page.locator("#attachment-strip")).toContainText(name);
}

test("real recovery continues the saved Pi turn without adding a user message, including after reload", async ({
  page
}) => {
  const requests = [];
  let rejecting = true;
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "browser-fixture" }] }));
      return;
    }
    requests.push(JSON.parse(raw));
    if (rejecting) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic request rejection" } }));
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream("openai-completions", { text: "已接着原请求完成。" }));
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard;
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await draft(page, "只处理这条原始请求", "original.txt");
    await page.locator("#send-button").click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 });
    await draft(page, "这是下一条未发送的草稿", "next.txt");
    rejecting = false;
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("已接着原请求完成", {
      timeout: 20_000
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await expect(page.locator("#conversation .chat-message.user")).toHaveCount(1);
      await expect(page.locator(".message-attachments")).toHaveCount(1);
      await expect(page.locator("#composer-input")).toHaveValue("这是下一条未发送的草稿");
      await expect(page.locator("#attachment-strip")).toContainText("next.txt");
      await expect(page.locator("#conversation")).not.toContainText("继续刚才未完成的请求");
    }
  } finally {
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  }
});

test("retry resumes the failed request while preserving an unrelated draft and its attachment", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  try {
    const fixture = await recoveryFixture(page, dashboard);
    await draft(page, "这是下一条尚未发送的指令");
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect.poll(() => fixture.runs.length).toBe(1);
    expect(fixture.runs[0]).toMatchObject({
      taskId: "recovery-a",
      resume: true,
      retryRequestId: "00000000-0000-4000-8000-000000000021"
    });
    expect(fixture.runs[0]).not.toHaveProperty("prompt");
    expect(fixture.runs[0]).not.toHaveProperty("model");
    await expect(page.locator("#conversation .chat-message.user")).toHaveCount(1);
    await expect(page.locator("#composer-input")).toHaveValue("这是下一条尚未发送的指令");
    await expect(page.locator("#attachment-strip")).toContainText("draft.txt");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("changed execution ownership keeps the failed request and draft while explaining how to retry", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  try {
    const fixture = await recoveryFixture(page, dashboard, {
      reject: true,
      rejection: {
        status: 409,
        code: "main_retry_context_changed",
        error:
          "原请求的工作目录或应用资源归属已改变，不能重发到新目标。请恢复原绑定与目录后重试；原请求、历史和草稿已保留。"
      }
    });
    await draft(page, "改绑之后尚未发送的草稿");
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect.poll(() => fixture.runs.length).toBe(1);
    await expect(page.locator("#toast")).toContainText("请恢复原绑定与目录后重试");
    await expect(page.locator("#composer-input")).toHaveValue("改绑之后尚未发送的草稿");
    await expect(page.locator("#attachment-strip")).toContainText("draft.txt");
    await expect(page.locator("#conversation .chat-message.user")).toHaveCount(1);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "从中断步骤继续" })).toBeEnabled();
    expect(fixture.runs[0]).not.toHaveProperty("prompt");
    expect(fixture.details.get("recovery-a").task.activeRunId).toBe("failed-fixture-run");
  } finally {
    await dashboard.stop();
  }
});

test("reloading a failed launch with no saved transcript still exposes an honest recovery action", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  try {
    await recoveryFixture(page, dashboard, {
      emptyHistory: true,
      failureKind: "main_process",
      errorMessage: "spawn ENOENT synthetic-private-path"
    });
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("执行进程退出");
    await expect(page.locator(".welcome-empty")).toHaveCount(0);
    await expect(alert).not.toContainText("你发送的内容和已有过程已保留");
    await expect(alert).not.toContainText("synthetic-private-path");
    await page.reload();
    await expect(alert).toContainText("执行进程退出");
    await expect(page.getByRole("button", { name: "从中断步骤继续" })).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});

test("a typed Main-process exit offers manual continuation without blaming the model connection", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  try {
    const fixture = await recoveryFixture(page, dashboard, {
      failureKind: "main_process",
      errorMessage: "Main process exited with code=503 signal= synthetic-private-process-detail"
    });
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("执行进程退出");
    await expect(alert).not.toContainText("模型");
    await expect(alert).not.toContainText("503");
    await expect(page.getByRole("button", { name: "切换模型" })).toHaveCount(0);
    await draft(page, "执行失败后的草稿继续保留");
    await page.setViewportSize({ width: 320, height: 900 });
    await alert.screenshot({ path: testInfo.outputPath("main-process-recovery-320.png") });
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect.poll(() => fixture.runs.length).toBe(1);
    expect(fixture.runs[0]).toMatchObject({ resume: true });
    expect(fixture.runs[0]).not.toHaveProperty("prompt");
    await expect(page.locator("#composer-input")).toHaveValue("执行失败后的草稿继续保留");
  } finally {
    await dashboard.stop();
  }
});

for (const [httpStatus, message] of [
  [400, "请求参数"],
  [undefined, "原因尚未确定"]
])
  test(`typed model failure ${httpStatus ?? "unknown"} shows safe, evidence-based recovery`, async ({
    page
  }, testInfo) => {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    try {
      await recoveryFixture(page, dashboard, {
        failureKind: "model_request",
        httpStatus,
        errorMessage: "Provider refused Authorization: Bearer sk-test-synthetic-status-401-private"
      });
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("模型请求未完成");
      await expect(alert).toContainText(message);
      await expect(alert).not.toContainText("Bearer");
      await expect(alert).not.toContainText("sk-test-synthetic");
      if (!httpStatus) await expect(alert).not.toContainText("认证失败");
      await expect(page.getByRole("button", { name: "切换模型" })).toBeVisible();
      await alert.screenshot({ path: testInfo.outputPath(`model-recovery-${httpStatus ?? "unknown"}.png`) });
    } finally {
      await dashboard.stop();
    }
  });

test("a rejected retry preserves the draft and never exposes raw provider details", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  try {
    const fixture = await recoveryFixture(page, dashboard, { reject: true });
    await draft(page, "重试失败也不能发送或清空这段草稿");
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect.poll(() => fixture.runs.length).toBe(1);
    expect(fixture.runs[0]).not.toHaveProperty("prompt");
    await expect(page.locator("#send-button")).toBeEnabled();
    await expect(page.locator("#composer-input")).toHaveValue("重试失败也不能发送或清空这段草稿");
    await expect(page.locator("#attachment-strip")).toContainText("draft.txt");
    await expect(page.getByRole("alert")).toContainText("模型连接认证失败");
    await expect(page.getByRole("button", { name: "从中断步骤继续" })).toBeFocused();
    await expect(page.locator("#conversation")).not.toContainText("recovery fixture unavailable");
  } finally {
    await dashboard.stop();
  }
});

test("a delayed retry belongs to its original task without consuming either task's draft", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const gate = deferred();
  try {
    const fixture = await recoveryFixture(page, dashboard, { gate });
    await draft(page, "A 独立草稿", "a.txt");
    await page.evaluate(() => {
      window.staleRecoveryButton = document.querySelector("[data-retry-request]");
    });
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect.poll(() => fixture.runs.length).toBe(1);
    await expect(page.locator("#send-button")).toBeDisabled();
    await page.evaluate(() => {
      window.staleRecoveryButton.click();
      window.staleRecoveryButton.click();
    });
    expect(fixture.runs).toHaveLength(1);
    await page.locator('.conversation-item[data-task="recovery-b"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await draft(page, "B 独立草稿", "b.txt");
    await page.locator("#composer-input").focus();
    gate.resolve();
    await expect(page.locator("#send-button")).toBeEnabled();
    expect(fixture.runs[0]).toMatchObject({
      taskId: "recovery-a",
      resume: true,
      retryRequestId: "00000000-0000-4000-8000-000000000021"
    });
    expect(fixture.runs[0]).not.toHaveProperty("prompt");
    await expect(page.locator('.conversation-item[data-task="recovery-b"]')).toHaveClass(/active/);
    await expect(page.locator("#composer-input")).toHaveValue("B 独立草稿");
    await expect(page.locator("#attachment-strip")).toContainText("b.txt");
    await expect(page.locator("#composer-input")).toBeFocused();
    await page.locator('.conversation-item[data-task="recovery-a"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("A 独立草稿");
    await expect(page.locator("#attachment-strip")).toContainText("a.txt");
    expect(fixture.runs).toHaveLength(1);
  } finally {
    gate.resolve();
    await dashboard.stop();
  }
});

test("an empty composer retries by continuing saved history without duplicating the original attachment", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  try {
    const fixture = await recoveryFixture(page, dashboard);
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect.poll(() => fixture.runs.length).toBe(1);
    expect(fixture.runs[0]).toMatchObject({
      taskId: "recovery-a",
      resume: true,
      retryRequestId: "00000000-0000-4000-8000-000000000021"
    });
    expect(fixture.runs[0]).not.toHaveProperty("prompt");
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.locator("#attachment-strip")).toBeHidden();
    await expect(page.locator("#conversation .chat-message.user")).toHaveCount(1);
    await expect(page.locator(".message-attachments")).toHaveCount(1);
  } finally {
    await dashboard.stop();
  }
});

for (const httpStatus of [undefined, 400])
  test(`policy rejection remains actionable with ${httpStatus ?? "legacy"} status metadata`, async ({
    page
  }) => {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    try {
      await recoveryFixture(page, dashboard, {
        failureKind: "model_request",
        httpStatus,
        errorMessage: `cowork-glm API error (400): ${JSON.stringify({
          message:
            "This content was flagged for possible cybersecurity risk. " +
            "private-provider-detail ".repeat(20),
          type: "invalid_request",
          code: "cyber_policy"
        })}`
      });
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("模型服务安全策略拒绝");
      await expect(alert.locator("[data-error-type]")).toHaveText(
        "错误类型：内容安全策略拒绝 · HTTP 400 · cyber_policy"
      );
      await expect(alert).toContainText("历史上下文");
      await expect(alert).not.toContainText("检查连接");
      await expect(alert).not.toContainText("private-provider-detail");
      await expect(page.getByRole("button", { name: "切换模型" })).toHaveCount(0);
      await page.reload();
      await expect(alert).toContainText("cyber_policy");
      await expect(page.locator("#composer-input")).toBeVisible();
    } finally {
      await dashboard.stop();
    }
  });

test("unavailable exact request records preserve drafts and do not launch a regenerated user turn", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  try {
    const fixture = await recoveryFixture(page, dashboard, { retryUnavailable: true });
    await draft(page, "无法重试时仍保留草稿");
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    await expect(page.locator("#toast")).toContainText("重试记录不可用");
    expect(fixture.runs).toHaveLength(0);
    await expect(page.locator("#composer-input")).toHaveValue("无法重试时仍保留草稿");
    await expect(page.locator("#attachment-strip")).toContainText("draft.txt");
    await expect(page.locator("#conversation .chat-message.user")).toHaveCount(1);
  } finally {
    await dashboard.stop();
  }
});
test("an interrupted partial reply retries exact bytes after restart without duplicating the final answer", async ({
  page
}) => {
  const requests = [];
  let rejecting = true,
    dashboard;
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method !== "POST") return response.end(JSON.stringify({ data: [{ id: "browser-fixture" }] }));
    requests.push(raw);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (rejecting) {
      const chunk = (delta) =>
        `data: ${JSON.stringify({ id: "partial-fixture", object: "chat.completion.chunk", created: 1, model: "browser-fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
      response.write(chunk({ role: "assistant", content: "半句未完成" }));
      response.end('data: {"error":{"message":"fixture-stream-denied"}}\n\n');
    } else response.end(protocolStream("openai-completions", { text: "半句未完成，这是完整答案。" }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("请回答这条原始消息。");
    await page.locator("#send-button").click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-answer-kind="final"]')).toHaveCount(0);
    await draft(page, "保留未发送的下一条", "partial-next.txt");
    await dashboard.restart();
    await page.reload();
    await expect(page.getByRole("alert")).toBeVisible();
    rejecting = false;
    await page.getByRole("button", { name: "从中断步骤继续" }).click();
    const answer = page.locator('[data-answer-kind="final"]');
    await expect(answer).toHaveCount(1);
    await expect(answer.locator(".markdown-body")).toHaveText("半句未完成，这是完整答案。");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    await expect(page.locator("#conversation .chat-message.user")).toHaveCount(1);
    await expect(page.locator("#composer-input")).toHaveValue("保留未发送的下一条");
    await expect(page.locator("#attachment-strip")).toContainText("partial-next.txt");
    await page.screenshot({ path: test.info().outputPath("partial-retry.png"), fullPage: true });
  } finally {
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  }
});

for (const rejection of [
  {
    status: 409,
    code: "main_retry_context_changed",
    error: "原请求的应用绑定已变化，已有内容仍保留。请恢复原绑定后重试，或发送新消息。"
  },
  { status: 400, code: "main_retry_snapshot_invalid", error: "原请求快照损坏，已保留记录。请检查后重试。" }
])
  test(`retry displays actionable local validation for ${rejection.code} and retains the draft`, async ({
    page
  }) => {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    try {
      await recoveryFixture(page, dashboard, { reject: true, rejection });
      await draft(page, "不要丢失这条草稿", "guard-draft.txt");
      await page.getByRole("button", { name: "从中断步骤继续" }).click();
      await expect(page.locator("#toast")).toContainText(rejection.error);
      await expect(page.locator("#composer-input")).toHaveValue("不要丢失这条草稿");
      await expect(page.locator("#attachment-strip")).toContainText("guard-draft.txt");
      await expect(page.locator("#conversation .chat-message.user")).toHaveCount(1);
    } finally {
      await dashboard.stop();
    }
  });
