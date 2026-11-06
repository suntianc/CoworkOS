import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const paths = ["/api/tasks", "/api/workbench/tabs", "/api/workbench/revisions"];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function visibility(page, hidden) {
  await page.evaluate((hidden) => {
    window.pollingHidden = hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
async function instrument(page) {
  await page.addInitScript(() => {
    window.pollingHidden = false;
    Object.defineProperty(document, "hidden", { get: () => window.pollingHidden, configurable: true });
  });
  await page.clock.install();
  const counts = Object.fromEntries(paths.map((path) => [path, 0]));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path in counts) counts[path]++;
  });
  return counts;
}
async function post(page, base, path, data) {
  const response = await page.request.post(base + path, { data });
  expect(response.ok()).toBe(true);
  return response.json();
}

test("a task catalog slower than the polling period still applies and preserves the later draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const gate = deferred();
  let reads = 0;
  try {
    await post(page, dashboard.base, "/api/tasks", { taskId: "slow-a", goal: "慢响应会话" });
    await instrument(page);
    await page.goto(`${dashboard.base}/?task=slow-a`);
    await expect(page.locator("#topbar-task")).toHaveText("慢响应会话");
    await expect(page.locator("#new-conversation")).toBeEnabled();
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      reads++;
      const response = await route.fetch();
      await gate.promise;
      await route.fulfill({ response });
    });
    await page.clock.fastForward(4000);
    await expect.poll(() => reads).toBe(1);
    await page.clock.fastForward(12000);
    expect(reads, "slow automatic catalogs must share their in-flight read").toBe(1);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("等待期间写下的新草稿");
    gate.resolve();
    await expect(page.locator('[data-task="slow-a"]')).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("等待期间写下的新草稿");
    await expect(page.locator("#topbar-task")).toHaveText("新任务");
    await expect(page.locator('[data-task="slow-a"]')).not.toHaveClass(/active/);
    await page.evaluate(() => {
      window.pollingDraftPrompt = document.querySelector("#conversation .starter-prompts button");
    });
    const next = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tasks");
    await page.clock.fastForward(4000);
    await (await next).finished();
    await expect.poll(() => page.evaluate(() => window.pollingDraftPrompt.isConnected)).toBe(true);
    await expect(page.locator("#composer-input")).toHaveValue("等待期间写下的新草稿");
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("unchanged detail polls retain current controls and a collapsed output pane catches up when opened", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await post(page, dashboard.base, "/api/tasks", { taskId: "stable-a", goal: "界面保持稳定" });
    await post(page, dashboard.base, "/api/tasks/stable-a/resources", {
      kind: "text/plain",
      title: "开始.txt",
      initialContent: "保留内容"
    });
    await instrument(page);
    await page.goto(`${dashboard.base}/?task=stable-a`);
    await expect(page.locator("#topbar-task")).toHaveText("界面保持稳定");
    await expect(page.locator("#output-pane-toggle")).toBeVisible();
    await expect(page.locator("#output-list [data-resource-row]")).toHaveCount(0);
    await page.locator("#output-pane-toggle").click();
    await expect(page.locator("#output-list [data-resource-row]")).toHaveCount(1);
    await page.evaluate(() => {
      window.pollingNodes = [
        document.querySelector("#conversation .starter-prompts button"),
        document.querySelector("#output-list [data-resource-row]")
      ];
    });
    const detail = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/tasks/stable-a"
    );
    await page.clock.fastForward(4000);
    await (await detail).finished();
    await expect
      .poll(() => page.evaluate(() => window.pollingNodes.every((node) => node.isConnected)))
      .toBe(true);
    await page.locator("#output-pane-toggle").click();
    await post(page, dashboard.base, "/api/tasks/stable-a/resources", {
      kind: "text/plain",
      title: "后来.txt",
      initialContent: "新内容"
    });
    const updated = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/tasks/stable-a"
    );
    await page.clock.fastForward(4000);
    await (await updated).finished();
    await expect(page.locator("#output-list [data-resource-row]")).toHaveCount(1);
    await page.locator("#output-pane-toggle").click();
    await expect(page.locator("#output-list [data-resource-row]")).toHaveCount(2);
  } finally {
    await dashboard.stop();
  }
});

test("streamed replies received while hidden appear on return and a late old stream cannot replace the next conversation's draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const records = [];
  try {
    for (const taskId of ["stream-a", "stream-b"])
      await post(page, dashboard.base, "/api/tasks", { taskId, goal: taskId });
    await instrument(page);
    // Run streams are read through the shared client's fetch transport so the
    // session header and the bound backend travel with them; EventSource is only
    // the fallback. This stub is the same fake stream in that shape.
    await page.addInitScript(() => {
      window.pollingStreams = [];
      const original = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = String(input?.url ?? input);
        if (!/\/api\/tasks\/[^/]+\/stream$/.test(new URL(url, location.href).pathname))
          return original(input, init);
        const encoder = new TextEncoder();
        let controller;
        const stream = {
          url,
          closed: false,
          emit(record) {
            if (!stream.closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(record)}\n\n`));
          },
          close() {
            stream.closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };
        const body = new ReadableStream({
          start(next) {
            controller = next;
          }
        });
        init.signal?.addEventListener("abort", () => stream.close(), { once: true });
        window.pollingStreams.push(stream);
        return Promise.resolve(
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
        );
      };
    });
    await page.route("**/api/tasks/stream-a", async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({
        response,
        json: {
          ...detail,
          task: { ...detail.task, status: "running", activeRunId: "fixture-stream" },
          runtime: { active: true, runId: "fixture-stream" },
          messages: [{ role: "user", content: "合成流式请求", timestamp: 1000 }],
          runtimeEvents: records
        }
      });
    });
    await page.goto(`${dashboard.base}/?task=stream-a`);
    await expect(page.locator("#conversation")).toContainText("合成流式请求");
    await page.evaluate(() => {
      window.pollingActiveStream = window.pollingStreams.findLast((stream) => !stream.closed);
    });
    await page.locator("#composer-input").fill("A 的未发送草稿");
    await visibility(page, true);
    const event = {
      type: "runtime_event",
      eventId: "fixture-record-1",
      runId: "fixture-stream",
      taskId: "stream-a",
      agentId: "main",
      payload: {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 2000,
          stopReason: "stop",
          content: [{ type: "text", text: "隐藏期间收到的回复" }]
        }
      }
    };
    await page.evaluate((record) => window.pollingActiveStream.emit(record), event);
    await visibility(page, false);
    await page.clock.runFor(50);
    await expect(page.locator("#conversation")).toContainText("隐藏期间收到的回复");
    records.push(event);
    await visibility(page, true);
    await page.locator('[data-task="stream-b"]').click();
    await page.locator("#composer-input").fill("B 的未发送草稿");
    await page.evaluate(
      (record) =>
        window.pollingActiveStream.emit({
          ...record,
          eventId: "late-record",
          payload: {
            ...record.payload,
            message: { ...record.payload.message, content: [{ type: "text", text: "旧会话晚到回复" }] }
          }
        }),
      event
    );
    await visibility(page, false);
    await page.clock.runFor(50);
    await expect(page.locator("#topbar-task")).toHaveText("stream-b");
    await expect(page.locator("#composer-input")).toHaveValue("B 的未发送草稿");
    await expect(page.locator("#conversation")).not.toContainText("旧会话晚到回复");
    await page.locator('[data-task="stream-a"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("A 的未发送草稿");
    await expect(page.locator("#conversation")).toContainText("隐藏期间收到的回复");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("idle catalog polls skip full history while task changes and the fallback still refresh it", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await post(page, dashboard.base, "/api/tasks", { taskId: "idle-history", goal: "闲置会话" });
    await instrument(page);
    let details = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === "/api/tasks/idle-history")
        details++;
    });
    await page.goto(`${dashboard.base}/?task=idle-history`);
    await expect(page.locator("#topbar-task")).toHaveText("闲置会话");
    const initial = details;
    for (let i = 0; i < 3; i++) {
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tasks");
      await page.clock.fastForward(3500);
      await (await response).finished();
    }
    expect(details).toBe(initial);
    const renamed = await page.request.patch(`${dashboard.base}/api/tasks/idle-history`, {
      data: { title: "外部更新" }
    });
    expect(renamed.ok()).toBe(true);
    await page.clock.fastForward(3500);
    await expect(page.locator("#topbar-task")).toHaveText("外部更新");
    expect(details).toBeGreaterThan(initial);
    const beforeFallback = details;
    const fallback = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/tasks/idle-history"
    );
    await page.clock.fastForward(15000);
    await (await fallback).finished();
    expect(details).toBeGreaterThan(beforeFallback);
  } finally {
    await dashboard.stop();
  }
});
