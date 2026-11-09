import assert from "node:assert/strict";
import { test } from "node:test";
import { executionElapsedMs, formatExecutionDuration } from "../web/assets/execution-time.js";

const origin = Date.parse("2026-10-08T00:00:00.000Z");
const runtime = (...runIds) => runIds.map((runId) => ({ type: "runtime_event", runId, payload: {} }));
const boundary = (runId, type, ms) => ({
  eventId: `${runId}-${type}-${ms}`,
  runId,
  type: `main.run_${type}`,
  occurredAt: new Date(origin + ms).toISOString()
});

test("execution duration uses matching run boundaries rather than Task age or message timestamps", () => {
  const records = runtime("current");
  records[0].payload.timestamp = origin - 60_000;
  const ledger = [
    boundary("old", "spawned", -500_000),
    boundary("old", "completed", -400_000),
    { runId: "current", type: "task.created", occurredAt: new Date(origin - 60_000).toISOString() },
    boundary("current", "spawned", 2000),
    { runId: "current", type: "run.started", occurredAt: "invalid", payload: { timeoutMs: 120_000 } },
    boundary("current", "completed", 10_000)
  ];
  assert.equal(executionElapsedMs(records, ledger), 8000);
  assert.deepEqual(
    records,
    runtime("current").map((record) => ({
      ...record,
      payload: { timestamp: origin - 60_000 }
    }))
  );
});

test("wake intervals on the same run exclude the paused time", () => {
  assert.equal(
    executionElapsedMs(runtime("resumed"), [
      boundary("resumed", "spawned", 0),
      boundary("resumed", "waiting", 3000),
      boundary("resumed", "spawned", 103_000),
      boundary("resumed", "waiting", 108_000),
      boundary("resumed", "spawned", 200_000),
      boundary("resumed", "completed", 209_000)
    ]),
    17_000
  );
});

test("pause closes an interval and resume opens a new one for the same run", () => {
  assert.equal(
    executionElapsedMs(runtime("paused"), [
      boundary("paused", "spawned", 0),
      boundary("paused", "paused", 3000),
      boundary("paused", "spawned", 100_000),
      boundary("paused", "completed", 108_000)
    ]),
    11_000
  );
});

test("multiple runs sum actual execution and exclude idle gaps between runs", () => {
  const ledger = [
    boundary("one", "spawned", 0),
    boundary("one", "failed", 8000),
    boundary("two", "spawned", 100_000),
    boundary("two", "completed", 110_000)
  ];
  assert.equal(executionElapsedMs(runtime("one", "one", "two"), ledger), 18_000);
  assert.equal(executionElapsedMs(runtime("two"), ledger), 10_000);
});

test("duplicate and unordered ledger events never count an interval twice", () => {
  const start = boundary("one", "spawned", 1000);
  const stop = boundary("one", "completed", 9000);
  const ledger = [stop, start, { ...start }, { ...stop }, boundary("one", "waiting", 9000)];
  const original = structuredClone(ledger);
  assert.equal(executionElapsedMs(runtime("one", "one"), ledger), 8000);
  assert.deepEqual(ledger, original, "do not reorder or mutate caller-owned history");
});

test("repeated failure finalizers close only the original interval", () => {
  assert.equal(
    executionElapsedMs(runtime("one"), [
      boundary("one", "spawned", 0),
      boundary("one", "failed", 1000),
      boundary("one", "failed", 1200),
      boundary("one", "spawned", 2000),
      boundary("one", "completed", 5000)
    ]),
    4000
  );
});

test("every referenced run must have both an explicit start and a stop", () => {
  const complete = [boundary("known", "spawned", 0), boundary("known", "completed", 1000)];
  for (const incomplete of [
    [],
    [boundary("unknown", "spawned", 0)],
    [boundary("unknown", "completed", 1000)],
    [
      boundary("unknown", "spawned", 0),
      boundary("unknown", "waiting", 1000),
      boundary("unknown", "spawned", 2000)
    ]
  ]) {
    assert.equal(executionElapsedMs(runtime("known", "unknown"), [...complete, ...incomplete]), null);
  }
});

test("saved conversation timestamps and timeout values cannot supply missing lifecycle times", () => {
  const stop = boundary("one", "completed", 10_000);
  for (const occurredAt of [undefined, null, "", "invalid", "120000", 120_000, "2026-10-08"]) {
    assert.equal(
      executionElapsedMs(runtime("one"), [
        { ...boundary("one", "spawned", 0), occurredAt, timestamp: origin, payload: { timeoutMs: 10_000 } },
        stop
      ]),
      null
    );
  }
  assert.equal(executionElapsedMs([{ payload: { runId: "one", timestamp: origin } }], [stop]), null);
  assert.equal(executionElapsedMs([{ type: "message_end", message: { timestamp: origin } }], [stop]), null);
});

test("contradictory or unclosed intervals remain unknown", () => {
  for (const ledger of [
    [boundary("one", "spawned", 1000), boundary("one", "completed", 0)],
    [boundary("one", "spawned", 0), boundary("one", "spawned", 1000), boundary("one", "completed", 2000)],
    [boundary("one", "spawned", 0), { ...boundary("one", "completed", 1000), occurredAt: "invalid" }]
  ]) {
    assert.equal(executionElapsedMs(runtime("one"), ledger), null);
  }
});

test("invalid unrelated ledger events do not poison the current exchange", () => {
  assert.equal(
    executionElapsedMs(runtime("one"), [
      boundary("one", "spawned", 0),
      { runId: "other", type: "main.run_completed", occurredAt: "invalid" },
      null,
      boundary("one", "waiting", 0)
    ]),
    0
  );
});

test("missing runtime identities or non-array inputs mean unknown", () => {
  for (const [records, ledger] of [
    [[], []],
    [null, []],
    [[], null],
    [{}, []],
    [[null, {}], []]
  ]) {
    assert.equal(executionElapsedMs(records, ledger), null);
  }
});

test("duration formatting uses whole seconds and rejects invalid values", () => {
  for (const [ms, label] of [
    [8000, "8秒"],
    [181_000, "3分钟1秒"],
    [180_000, "3分钟"],
    [0, "0秒"],
    [999, "0秒"],
    [1999, "1秒"],
    [3_600_000, "60分钟"]
  ]) {
    assert.equal(formatExecutionDuration(ms), label);
  }
  for (const ms of [null, undefined, "8000", NaN, Infinity, -Infinity, -1, {}, []]) {
    assert.equal(formatExecutionDuration(ms), "");
  }
});
