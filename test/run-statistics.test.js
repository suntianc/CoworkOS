import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRunStatistics, runTiming } from "../dist/src/runtime/run-statistics.js";
import { formatRunDuration, renderRunOverview, runElapsed } from "../web/assets/run-overview.js";

const time = (seconds) => new Date(Date.UTC(2026, 8, 8, 0, 0, seconds)).toISOString();
const response = (
  id,
  usage = { input: 100, output: 20, cacheRead: 80, cacheWrite: 10, reasoning: 5, totalTokens: "[REDACTED]" }
) => ({
  type: "message_end",
  message: {
    role: "assistant",
    responseId: id,
    timestamp: id,
    usage,
    content: [{ type: "text", text: "done" }]
  }
});
const jsonl = (values) => values.map((value) => JSON.stringify(value)).join("\n") + "\n";
const task = {
  taskId: "task",
  activeRunId: "new",
  status: "completed",
  createdAt: time(0),
  updatedAt: time(40),
  completedAt: time(30),
  version: 1
};

async function fixture(t, queue = [{ stepId: "call-1", agentId: "subagent_1", status: "cancelled" }]) {
  const root = await mkdtemp(join(tmpdir(), "atria-statistics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, "task", "runs", "new");
  const trace = join(root, "task", "sessions", "subagent_1", "new.jsonl");
  await mkdir(run, { recursive: true });
  await mkdir(join(root, "task", "sessions", "subagent_1"), { recursive: true });
  await writeFile(join(run, "run.json"), JSON.stringify({ createdAt: time(10) }));
  await writeFile(join(run, "queue.json"), JSON.stringify(queue));
  await writeFile(
    join(run, "run_events.jsonl"),
    jsonl([
      { type: "main.run_spawned", occurredAt: time(10) },
      { type: "main.run_completed", occurredAt: time(30) }
    ])
  );
  const main = join(run, "runtime-output.log");
  return {
    root,
    trace,
    main,
    read: (extra = {}) =>
      readRunStatistics({ workspaceRoot: root, task, active: false, nowMs: Date.parse(time(60)), ...extra })
  };
}

test("conversation usage counts Main and Subagent responses once across every run, including failed/cancelled attempts", async (t) => {
  const f = await fixture(t, [
    { stepId: "call-1", agentId: "subagent_1" },
    { stepId: "retry", agentId: "subagent_1", status: "cancelled" }
  ]);
  const message = response("main");
  await writeFile(
    f.main,
    jsonl([
      message,
      { type: "message_update", message: message.message },
      { type: "turn_end", message: message.message },
      { type: "agent_end", messages: [message.message] },
      message
    ])
  );
  const failed = { ...response("failed"), message: { ...response("failed").message, stopReason: "error" } };
  await writeFile(f.trace, jsonl([{ payload: failed }, { payload: response("retry") }, { payload: failed }]));
  const old = join(f.root, "task", "runs", "old");
  await mkdir(old);
  await writeFile(join(old, "runtime-output.log"), jsonl([response("old")]));
  await writeFile(join(old, "run.json"), JSON.stringify({ createdAt: time(0) }));
  await writeFile(
    join(old, "run_events.jsonl"),
    jsonl([
      { type: "main.run_spawned", occurredAt: time(0) },
      { type: "main.run_completed", occurredAt: time(5) }
    ])
  );
  await appendFile(f.main, jsonl([response("old")]));
  const result = await f.read();
  assert.equal(result.scope, "conversation");
  assert.equal(result.runCount, 2);
  assert.equal(
    result.usage.totalTokens,
    840,
    "redacted totals are reconstructed; replayed history is not billed twice"
  );
  assert.equal(result.usage.output, 80);
  assert.equal(result.usage.responses, 4);
  assert.equal(result.usage.coverage, "complete");
  assert.equal(
    result.agents.length,
    2,
    "retries in the same agent trace must not duplicate the agent's total"
  );
  assert.equal(result.agents[1].name, "Ara");
  assert.equal(result.agents[1].usage.totalTokens, 420);
  assert.equal(result.elapsedMs, 25_000, "sum both runs, excluding idle gaps between them");
  assert.equal((await f.read({ nowMs: Date.parse(time(600)) })).elapsedMs, result.elapsedMs);
  assert.deepEqual((await f.read()).usage, result.usage, "polling does not recount trace contents");
});

test("follow-ups accumulate duration and usage, keep historical agents, and survive a fresh statistics reader", async (t) => {
  const f = await fixture(t);
  await writeFile(f.main, jsonl([response("first-main")]));
  await writeFile(f.trace, jsonl([{ payload: response("first-sub") }]));
  const first = await f.read();
  const next = join(f.root, "task", "runs", "follow-up");
  await mkdir(next);
  await writeFile(join(next, "run.json"), JSON.stringify({ createdAt: time(90) }));
  await writeFile(
    join(next, "run_events.jsonl"),
    jsonl([{ type: "main.run_spawned", occurredAt: time(90) }])
  );
  await writeFile(join(next, "runtime-output.log"), "");
  const input = {
    workspaceRoot: f.root,
    task: {
      ...task,
      activeRunId: "follow-up",
      status: "running",
      completedAt: undefined,
      updatedAt: time(90)
    },
    active: true,
    nowMs: Date.parse(time(100))
  };
  let result = await readRunStatistics(input);
  assert.equal(
    result.usage.totalTokens,
    first.usage.totalTokens,
    "starting a new response must preserve the entire previous total"
  );
  assert.equal(
    result.elapsedMs,
    30_000,
    "20 seconds from the first run + 10 active seconds, excluding 60 idle seconds"
  );
  assert.equal(result.active, true);
  assert.equal(result.agents.find((a) => a.agentId === "subagent_1").current, false);
  await appendFile(join(next, "runtime-output.log"), jsonl([response("follow-up")]));
  await appendFile(
    join(next, "run_events.jsonl"),
    jsonl([{ type: "main.run_completed", occurredAt: time(110) }])
  );
  input.active = false;
  input.nowMs = Date.parse(time(600));
  result = await readRunStatistics(input);
  assert.equal(result.usage.totalTokens, 630);
  assert.equal(result.agents.find((a) => a.agentId === "main").usage.totalTokens, 420);
  assert.equal(result.elapsedMs, 40_000);
  const fresh = await import(`../dist/src/runtime/run-statistics.js?reload=${Date.now()}`);
  assert.deepEqual(
    await fresh.readRunStatistics(input),
    result,
    "totals are recovered from durable logs after restart"
  );
  const html = renderRunOverview(result);
  assert.match(html, /整个会话累计/);
  assert.match(html, /2 轮/);
  assert.doesNotMatch(
    html,
    /data-usage-agent="call-1"/,
    "historical totals must not open an unrelated current trace"
  );
  assert.equal(await f.read({ task: { ...task, taskId: "another", activeRunId: undefined } }), null);
});

test("historical runs with missing exit records freeze at their own last evidence, not the current Task update", async (t) => {
  const f = await fixture(t, []);
  await writeFile(f.main, jsonl([response("current")]));
  const old = join(f.root, "task", "runs", "legacy");
  await mkdir(old);
  await writeFile(join(old, "run.json"), JSON.stringify({ createdAt: time(0) }));
  await writeFile(join(old, "runtime-output.log"), jsonl([response("legacy")]));
  await writeFile(
    join(old, "run_events.jsonl"),
    jsonl([
      { type: "main.run_spawned", occurredAt: time(0) },
      { type: "call.succeeded", occurredAt: time(5) }
    ])
  );
  const result = await f.read({ task: { ...task, completedAt: undefined, updatedAt: time(600) } });
  assert.equal(result.elapsedMs, 25_000);
  assert.equal(result.usage.totalTokens, 420);
  assert.equal((await f.read({ task: { ...task, updatedAt: time(6000) } })).elapsedMs, result.elapsedMs);
});

test("usage cache preserves partial JSON lines, reads append-only updates, and resets on replacement", async (t) => {
  const f = await fixture(t);
  await writeFile(f.main, jsonl([response("main")]));
  const line = JSON.stringify({ payload: response("sub") });
  await writeFile(f.trace, line.slice(0, 70));
  assert.equal((await f.read()).usage.totalTokens, 210);
  await appendFile(f.trace, line.slice(70) + "\n");
  const reads = await Promise.all([f.read(), f.read()]);
  assert.ok(reads.every((r) => r.usage.totalTokens === 420));
  await appendFile(f.trace, jsonl([{ payload: response("sub") }, { payload: response("sub-next") }]));
  assert.equal((await f.read()).usage.totalTokens, 630);
  await rm(f.trace);
  await writeFile(f.trace, jsonl([{ payload: response("replacement") }]));
  assert.equal((await f.read()).usage.totalTokens, 420);
});

test("unknown usage stays unknown and partial coverage is retained in data while the UI displays numeric totals", async (t) => {
  const f = await fixture(t, []);
  await writeFile(
    f.main,
    jsonl([response("no-report", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })])
  );
  let result = await f.read();
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.coverage, "unavailable");
  assert.match(renderRunOverview(result), /title="累计 Token">—<\/strong>/);
  await appendFile(f.main, jsonl([response("reported")]));
  result = await f.read();
  assert.equal(result.usage.totalTokens, 210);
  assert.equal(result.usage.coverage, "partial");
  assert.match(renderRunOverview(result), /title="210 Token">210<\/strong>/);
  assert.doesNotMatch(renderRunOverview(result), /≥|已上报|未返回|尚不完整/);
});

test("large legacy usage scans catch up without passing a tail sample off as a total", async (t) => {
  const f = await fixture(t, []);
  await writeFile(f.main, jsonl([response("first")]));
  const ignored = jsonl([{ type: "tool_execution_update", padding: "x".repeat(256 * 1024) }]);
  await appendFile(f.main, ignored.repeat(65) + jsonl([response("last")]));
  let result = await f.read();
  assert.equal(result.usage.totalTokens, 210);
  assert.equal(result.usage.scanning, true);
  assert.equal(result.usage.coverage, "partial");
  result = await f.read();
  assert.equal(result.usage.totalTokens, 420);
  assert.equal(result.usage.scanning, false);
  assert.equal(result.usage.coverage, "complete");
});

test("duration excludes the pause gap between spawn, paused and the resumed spawn", () => {
  const events = [
    { type: "main.run_spawned", occurredAt: time(10) },
    { type: "main.run_paused", occurredAt: time(30) },
    { type: "main.run_spawned", occurredAt: time(100) },
    { type: "main.run_completed", occurredAt: time(130) }
  ];
  const timing = runTiming({
    task: { ...task, completedAt: time(130), updatedAt: time(130) },
    createdAt: time(10),
    events,
    active: false,
    nowMs: Date.parse(time(200))
  });
  assert.equal(timing.elapsedMs, 50_000, "only 20s before the pause and 30s after continuing");
  assert.equal(timing.startedAt, time(10));
  assert.equal(timing.endedAt, time(130));
  const pausedOnly = runTiming({
    task: { ...task, completedAt: undefined, updatedAt: time(300) },
    createdAt: time(10),
    events: events.slice(0, 2),
    active: false,
    nowMs: Date.parse(time(400))
  });
  assert.equal(pausedOnly.elapsedMs, 20_000, "a later unrelated Task update cannot extend the pause");
  assert.equal(pausedOnly.endedAt, time(30));
  const resumed = runTiming({
    task,
    createdAt: time(10),
    events: events.slice(0, 3),
    active: true,
    nowMs: Date.parse(time(140))
  });
  assert.equal(resumed.elapsedMs, 60_000, "an active resumed run counts from the second spawn");
  assert.equal(resumed.active, true);
});

test("duration excludes idle gaps on resume and freezes after completion, failure, cancellation or inactivity", () => {
  const events = [
    { type: "main.run_spawned", occurredAt: time(10) },
    { type: "main.run_waiting", occurredAt: time(20) },
    { type: "main.run_spawned", occurredAt: time(50) }
  ];
  const input = { task, createdAt: time(10), events, active: true, nowMs: Date.parse(time(60)) };
  let timing = runTiming(input);
  assert.equal(timing.elapsedMs, 20_000);
  assert.equal(timing.active, true);
  for (const type of ["main.run_completed", "main.run_failed", "main.run_waiting"]) {
    timing = runTiming({ ...input, events: [...events, { type, occurredAt: time(55) }] });
    assert.equal(timing.elapsedMs, 15_000);
    assert.equal(timing.active, false);
  }
  timing = runTiming({ ...input, task: { ...task, completedAt: time(54) }, active: false });
  assert.equal(timing.elapsedMs, 14_000);
  timing = runTiming({
    ...input,
    task: { ...task, completedAt: undefined, updatedAt: time(56) },
    active: false
  });
  assert.equal(timing.elapsedMs, 16_000);
  assert.equal(runTiming({ ...input, createdAt: undefined, events: [] }).elapsedMs, null);
  assert.equal(runElapsed({ ...timing, observedAt: time(60) }, Date.parse(time(600))), 16_000);
  assert.equal(runElapsed({ ...timing, active: true, observedAt: time(60) }, Date.parse(time(62))), 18_000);
  assert.equal(formatRunDuration(3_661_000), "1:01:01");
});

test("cache coverage preserves explicit zero, unknown legacy zeros and partial totals across reload", async (t) => {
  const f = await fixture(t, []);
  const usage = {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    cacheReadReported: true,
    cacheWriteReported: true
  };
  await writeFile(f.main, jsonl([response("zero", usage)]));
  let result = await f.read();
  assert.equal(result.usage.cacheReadCoverage, "complete");
  assert.equal(result.usage.cacheReadReportedResponses, 1);
  assert.match(renderRunOverview(result), /输入缓存命中<\/dt><dd>0<\/dd>/);
  await appendFile(
    f.main,
    jsonl([response("missing", { ...usage, cacheReadReported: false, cacheWriteReported: false })])
  );
  result = await f.read();
  assert.equal(result.usage.totalTokens, 220);
  assert.equal(result.usage.cacheReadCoverage, "partial");
  assert.match(renderRunOverview(result), /输入缓存命中<\/dt><dd>0 <small>已报告 · 部分未知/);
  await appendFile(f.main, jsonl([response("hit", { ...usage, input: 60, cacheRead: 40 })]));
  result = await f.read();
  assert.equal(result.usage.cacheRead, 40);
  assert.equal(result.usage.cacheReadReportedResponses, 2);
  assert.equal(result.usage.totalTokens, 330);
  const fresh = await import(`../dist/src/runtime/run-statistics.js?cacheReload=${Date.now()}`);
  assert.deepEqual(
    await fresh.readRunStatistics({
      workspaceRoot: f.root,
      task,
      active: false,
      nowMs: Date.parse(time(60))
    }),
    result
  );
  await rm(f.main);
  await writeFile(
    f.main,
    jsonl([response("legacy", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })])
  );
  result = await f.read();
  assert.equal(result.usage.cacheReadCoverage, "unavailable");
  assert.match(renderRunOverview(result), /输入缓存命中<\/dt><dd>未报告<\/dd>/);
});

test("total usage coverage stays independent of cache-only reports, including all-zero totals and legacy records", async (t) => {
  const f = await fixture(t, []);
  const zero = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokenUsageReported: false,
    cacheReadReported: true,
    cacheWriteReported: true
  };
  await writeFile(f.main, jsonl([response("cache-zero", zero)]));
  let result = await f.read();
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.reportedResponses, 0);
  assert.equal(result.usage.cacheReadCoverage, "complete");
  await appendFile(f.main, jsonl([response("cache-hit", { ...zero, cacheRead: 40 })]));
  result = await f.read();
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.cacheRead, 40);
  assert.equal(result.usage.cacheReadReportedResponses, 2);
  await appendFile(f.main, jsonl([response("explicit-zero", { ...zero, tokenUsageReported: true })]));
  result = await f.read();
  assert.equal(result.usage.totalTokens, 40, "partial totals retain the known cache subtotal");
  assert.equal(result.usage.reportedResponses, 1);
  assert.equal(result.usage.coverage, "partial");
  const fresh = await import(`../dist/src/runtime/run-statistics.js?tokenReload=${Date.now()}`);
  assert.deepEqual(
    await fresh.readRunStatistics({
      workspaceRoot: f.root,
      task,
      active: false,
      nowMs: Date.parse(time(60))
    }),
    result
  );
  await appendFile(
    f.main,
    jsonl([
      response("legacy-zero", { input: 0, output: 0 }),
      response("legacy-positive", { input: 10, output: 0 })
    ])
  );
  result = await f.read();
  assert.equal(result.usage.totalTokens, 50);
  assert.equal(result.usage.reportedResponses, 2);
  assert.equal(result.usage.coverage, "partial");
});
