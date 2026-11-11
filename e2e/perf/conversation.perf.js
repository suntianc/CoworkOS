import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTask } from "../p45-work-helpers.js";
import { cloneRounds, longReply, startPerfDashboard } from "./fixture.js";

/**
 * The main panel on a long conversation (#17): opening it, idling while the
 * page polls, scrolling through it, and streaming a new reply at its end.
 *
 * Rounds come from one real round (two tool steps and a long reply with a
 * table, code and a task list) copied PERF_ROUNDS times on disk, so the page
 * reads them exactly as it reads a real history. Results are printed and
 * written to test-results/perf/. Nothing here asserts a budget yet; the
 * numbers are the baseline later changes are compared against.
 */
const ROUNDS = Number(process.env.PERF_ROUNDS || 200);
const STREAM_PIECES = Number(process.env.PERF_STREAM_PIECES || 400);
const LABEL = process.env.PERF_LABEL || "baseline";

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (value) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
    over33: sorted.filter((value) => value > 33.4).length,
    over50: sorted.filter((value) => value > 50).length
  };
};

async function mainThread(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const value = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return {
    task: value("TaskDuration") * 1000,
    script: value("ScriptDuration") * 1000,
    layout: value("LayoutDuration") * 1000,
    style: value("RecalcStyleDuration") * 1000,
    heap: value("JSHeapUsedSize") / 1048576,
    nodes: value("Nodes")
  };
}
const delta = (after, before) =>
  Object.fromEntries(
    ["task", "script", "layout", "style"].map((key) => [key, Math.round(after[key] - before[key])])
  );

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { longtasks: [], frames: [], recording: false };
    window.__perf = probe;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longtasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
    let last;
    const frame = (now) => {
      if (probe.recording && last !== undefined) probe.frames.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    probe.start = () => {
      probe.frames = [];
      probe.since = performance.now();
      probe.recording = true;
    };
    probe.stop = () => {
      probe.recording = false;
      const tasks = probe.longtasks.filter(([start]) => start >= probe.since);
      return {
        frames: probe.frames,
        longtasks: tasks.length,
        longtaskMs: Math.round(tasks.reduce((sum, [, duration]) => sum + duration, 0)),
        longestTask: Math.round(Math.max(0, ...tasks.map(([, duration]) => duration)))
      };
    };
  });
});

test(`a ${ROUNDS}-round conversation opens, idles, scrolls and streams`, async ({ page }) => {
  const local = await startPerfDashboard();
  const finals = page.locator('.chat-message.main[data-answer-kind="final"]');
  const report = { label: LABEL, rounds: ROUNDS, streamPieces: STREAM_PIECES, at: new Date().toISOString() };
  try {
    // One real round, then copies of it on disk.
    local.queue.push(
      { tool: { id: "step-1", command: "echo first step" } },
      { tool: { id: "step-2", command: "printf 'second\\nstep\\n'" } },
      { text: longReply(0) }
    );
    await createTask(page, local, { taskId: "perf", goal: "长会话性能", projectId: local.projectId });
    await createTask(page, local, { taskId: "other", goal: "另一个会话", projectId: local.projectId });
    await page.goto(local.base);
    await page.locator('.conversation-item[data-task="perf"]').click();
    await page.locator("#composer-input").fill("第一轮");
    await page.locator("#send-button").click();
    await expect(finals).toHaveCount(1);
    await expect(page.locator("#run-control")).toBeHidden();
    await cloneRounds(local.workspaceRoot, "perf", ROUNDS);

    // Opening: from a click on the row to every round in the page.
    await page.reload();
    await page.locator('.conversation-item[data-task="other"]').click();
    await expect(page.locator(".welcome-empty")).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    let before = await mainThread(cdp);
    await page.evaluate(() => window.__perf.start());
    const detail = page.waitForResponse((response) => response.url().endsWith("/api/tasks/perf"));
    // Timed in the page: from the click to the first frame with every round.
    const painted = page.evaluate(
      (rounds) =>
        new Promise((done) => {
          const started = performance.now();
          const check = () =>
            document.querySelectorAll('.chat-message.main[data-answer-kind="final"]').length >= rounds
              ? requestAnimationFrame(() => done(performance.now() - started))
              : requestAnimationFrame(check);
          check();
        }),
      ROUNDS
    );
    const clicked = Date.now();
    await page.locator('.conversation-item[data-task="perf"]').click();
    const response = await detail;
    await response.finished();
    const responded = Date.now();
    const openMs = await painted;
    const opened = clicked + openMs;
    await expect(finals).toHaveCount(ROUNDS);
    let probe = await page.evaluate(() => window.__perf.stop());
    let after = await mainThread(cdp);
    report.open = {
      totalMs: Math.round(openMs),
      detailMs: responded - clicked,
      detailBytes: (await (await page.request.get(response.url())).body()).length,
      renderMs: Math.round(opened - responded),
      mainThread: delta(after, before),
      longtasks: probe.longtasks,
      longestTask: probe.longestTask,
      domNodes: after.nodes,
      heapMb: Math.round(after.heap)
    };

    // Where the detail's bytes go, by top-level field and by runtime event kind.
    const body = await (await page.request.get(response.url())).json();
    const size = (value) => JSON.stringify(value ?? null).length;
    const events = {};
    for (const record of body.runtimeEvents || []) {
      const event = record.type === "runtime_event" ? record.payload : record;
      const key = [event?.type || record.type, event?.message?.role].filter(Boolean).join(":");
      events[key] = (events[key] || 0) + size(record);
    }
    const top = (entries) =>
      Object.fromEntries(
        entries
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([key, bytes]) => [key, Math.round(bytes / 1024)])
      );
    report.open.detailKb = {
      fields: top(Object.entries(body).map(([key, value]) => [key, size(value)])),
      runtimeEvents: top(Object.entries(events))
    };

    // Idle: the page keeps polling the open conversation.
    before = await mainThread(cdp);
    await page.evaluate(() => window.__perf.start());
    await page.waitForTimeout(10_000);
    probe = await page.evaluate(() => window.__perf.stop());
    after = await mainThread(cdp);
    report.idle10s = {
      mainThread: delta(after, before),
      longtasks: probe.longtasks,
      longtaskMs: probe.longtaskMs
    };

    // Scrolling from the top to the bottom, 120 px a frame.
    await page.locator("#conversation").evaluate((node) => (node.scrollTop = 0));
    before = await mainThread(cdp);
    await page.evaluate(() => window.__perf.start());
    await page.locator("#conversation").evaluate(
      (node) =>
        new Promise((done) => {
          const step = () => {
            node.scrollTop += 120;
            if (node.scrollTop + node.clientHeight >= node.scrollHeight - 1) done();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        })
    );
    probe = await page.evaluate(() => window.__perf.stop());
    after = await mainThread(cdp);
    report.scroll = {
      frames: summary(probe.frames),
      mainThread: delta(after, before),
      longtasks: probe.longtasks,
      scrollHeight: await page.locator("#conversation").evaluate((node) => node.scrollHeight)
    };

    // Streaming a reply in many small deltas at the end of the conversation.
    const stream = Array.from({ length: STREAM_PIECES }, (_, index) =>
      index % 40 === 39 ? `第 ${index} 段。\n\n` : `第 ${index} 段内容，`
    );
    local.queue.push({ stream, interval: 16 });
    before = await mainThread(cdp);
    await page.evaluate(() => window.__perf.start());
    const started = Date.now();
    await page.locator("#composer-input").fill("再来一轮");
    await page.locator("#send-button").click();
    await expect(finals).toHaveCount(ROUNDS + 1, { timeout: 120_000 });
    const streamed = Date.now();
    probe = await page.evaluate(() => window.__perf.stop());
    after = await mainThread(cdp);
    const busy = delta(after, before);
    report.stream = {
      wallMs: streamed - started,
      frames: summary(probe.frames),
      mainThread: busy,
      busyShare: Math.round((busy.task / (streamed - started)) * 100) / 100,
      longtasks: probe.longtasks,
      longtaskMs: probe.longtaskMs,
      longestTask: probe.longestTask
    };
  } finally {
    await local.stop();
  }
  console.log(JSON.stringify(report, null, 2));
  const directory = join("test-results", "perf");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `conversation-${LABEL}-${ROUNDS}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  );
});
