import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCatalogEvents } from "../dist/src/dashboard/catalog-events.js";
import { EventLedger } from "../dist/src/dashboard/event-ledger.js";
import { createWorkspaceDirectory } from "../dist/src/dashboard/workspace-directory.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { ACTIVITY_SLICE_MS, readTaskActivity } from "../dist/src/runtime/activity-metrics.js";
import { createManagementEventClient } from "../web/assets/controllers/management-events.js";

/**
 * The bounds of the activity window.
 *
 * A Main can run for days, but a lane only ever draws a bounded window: the
 * samples keep the newest two hours, an unchanged Run publishes no events, and
 * a Task record on disk gains no new field. Clients written before the metrics
 * existed keep reading the same snapshot.
 */

const MINUTE = 60_000;

/** Main text plus one tool call every `everyMs`, for `spanMs` from `startMs`. */
function mainTrace({ startMs, spanMs, everyMs, text = "step" }) {
  const lines = [{ type: "turn_start" }];
  for (let at = startMs; at <= startMs + spanMs; at += everyMs) {
    lines.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], timestamp: at }
    });
    lines.push({ type: "tool_execution_start", toolCallId: `call-${at}`, toolName: "bash", args: {} });
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

async function runFixture(t, { startedMs, output }) {
  const root = await mkdtemp(join(tmpdir(), "atria-activity-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "workspace");
  const store = new LocalWorkspaceStore(storage);
  await store.createRun("task", "run");
  const runRoot = join(storage, "task", "runs", "run");
  await writeFile(
    join(runRoot, "run.json"),
    `${JSON.stringify({ taskId: "task", runId: "run", createdAt: new Date(startedMs).toISOString() })}\n`
  );
  await writeFile(join(runRoot, "runtime-output.log"), output);
  await writeFile(
    join(runRoot, "queue.json"),
    `${JSON.stringify([
      {
        stepId: "call-sub",
        taskId: "task",
        runId: "run",
        agentId: "subagent_1",
        importance: "normal",
        payload: { task: "Subagent work", delegation: { role: "executor" } },
        status: "leased",
        attempts: 1,
        createdAt: new Date(startedMs).toISOString(),
        updatedAt: new Date(startedMs).toISOString()
      }
    ])}\n`
  );
  await mkdir(join(storage, "task", "sessions", "subagent_1"), { recursive: true });
  const subagent = [
    {
      eventId: "trace_0",
      type: "trace.runtime",
      taskId: "task",
      runId: "run",
      agentId: "subagent_1",
      occurredAt: new Date(startedMs + MINUTE).toISOString(),
      payload: { type: "tool_execution_start", toolCallId: "sub-0", toolName: "read", args: {} }
    }
  ];
  await writeFile(
    join(storage, "task", "sessions", "subagent_1", "run.jsonl"),
    `${subagent.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
  return { root, storage, store, runRoot };
}

const busy = (agent) => agent.samples.filter((sample) => sample.toolCalls > 0 || sample.outputBytes > 0);

test(
  "a ten-hour Run keeps two hours of samples and stops growing after it ends",
  { timeout: 60_000 },
  async (t) => {
    const now = Date.now();
    const startedMs = now - 10 * 60 * MINUTE;
    const { storage, store, runRoot } = await runFixture(t, {
      startedMs,
      // The last step is ten minutes old: the Run is still open but quiet.
      output: mainTrace({ startMs: startedMs, spanMs: 10 * 60 * MINUTE - 10 * MINUTE, everyMs: 10 * MINUTE })
    });
    const task = await store.readTask("task");

    const activity = await readTaskActivity({ storageRoot: storage, task, nowMs: now });
    assert.ok(activity);
    assert.ok(activity.windowMs >= 2 * 60 * MINUTE, "the retained window covers at least two hours");
    assert.equal(activity.agents.length, 2, "Main and its Subagent are both described");
    for (const agent of activity.agents) {
      assert.equal(
        agent.samples.length,
        activity.windowMs / activity.sliceMs,
        "a lane keeps one window of samples however long the Run is"
      );
      assert.ok(agent.samples.length * activity.sliceMs >= 2 * 60 * MINUTE);
    }
    const main = activity.agents.find((agent) => agent.agentId === "main");
    assert.equal(main.stage, "idle", "ten quiet minutes are idle time, not work");
    assert.equal(main.state, "running");
    // Ten hours of history collapse into the newest two: the counts in the
    // window are the ones inside it, not the ones from the start of the Run.
    assert.ok(busy(main).length >= 11 && busy(main).length <= 13, `sampled ${busy(main).length} slices`);
    assert.ok(
      Date.parse(activity.from) > startedMs + 7 * 60 * MINUTE,
      "samples older than the window are dropped rather than kept"
    );
    const firstSize = JSON.stringify(activity).length;
    assert.ok(firstSize < 48 * 1024, `one Task's activity stays bounded: ${firstSize} bytes`);

    // Another five hours of the same Run: the window slides, the payload does not grow.
    await writeFile(
      join(runRoot, "runtime-output.log"),
      mainTrace({ startMs: startedMs, spanMs: 15 * 60 * MINUTE, everyMs: 10 * MINUTE })
    );
    const later = await readTaskActivity({
      storageRoot: storage,
      task: await store.readTask("task"),
      nowMs: now + 5 * 60 * MINUTE
    });
    assert.ok(later);
    assert.equal(
      later.agents.find((agent) => agent.agentId === "main").samples.length,
      activity.windowMs / activity.sliceMs,
      "five more hours of Run add no samples to a lane"
    );
    const laterSize = JSON.stringify(later).length;
    assert.ok(laterSize <= firstSize * 1.5, `a longer Run does not grow the payload: ${laterSize} bytes`);
    assert.ok(Date.parse(later.from) > Date.parse(activity.from), "the window slides forward");

    // Forty hours of Run later the answer is the same size: age costs nothing.
    await writeFile(
      join(runRoot, "runtime-output.log"),
      mainTrace({ startMs: startedMs, spanMs: 40 * 60 * MINUTE, everyMs: 10 * MINUTE })
    );
    const oldest = await readTaskActivity({
      storageRoot: storage,
      task: await store.readTask("task"),
      nowMs: now + 30 * 60 * MINUTE
    });
    assert.ok(oldest);
    assert.equal(
      oldest.agents.find((agent) => agent.agentId === "main").samples.length,
      activity.windowMs / activity.sliceMs,
      "a Run that has lasted a day still reports one window"
    );
    assert.ok(JSON.stringify(oldest).length <= firstSize * 1.5, "the payload stays the same size");
  }
);

test(
  "an unchanged Run publishes no events, and the metrics add no persisted field",
  { timeout: 60_000 },
  async (t) => {
    const now = Date.now();
    const startedMs = now - 20 * MINUTE;
    const { root, storage, store } = await runFixture(t, {
      startedMs,
      output: mainTrace({ startMs: startedMs, spanMs: 5 * MINUTE, everyMs: MINUTE })
    });
    // A finished Run has nothing left to sample, so every read must agree.
    await store.transitionTask("task", "completed");
    const index = join(root, "workspace.json");
    const directory = createWorkspaceDirectory(storage, index, () => "fixture");
    const ledger = EventLedger.open(join(root, "events"), "backend-bounds");
    const events = createCatalogEvents({ ledger, readCatalog: directory.globalTaskPayload });
    t.after(() => events.close());

    // The first read assigns the legacy Task to a project; measure the catalog
    // once that settlement is behind us.
    await events.snapshot();
    const snapshot = await events.snapshot();
    const task = snapshot.tasks.find((item) => item.taskId === "task");
    assert.ok(task?.activity, "the snapshot carries the Run's activity");
    // Every field an older client knows is still there, unchanged in meaning.
    for (const field of [
      "taskId",
      "status",
      "createdAt",
      "updatedAt",
      "version",
      "workspaceRoot",
      "storageRoot",
      "projectId",
      "projectName",
      "projectDirectory",
      "activeRunId"
    ])
      assert.ok(task[field] !== undefined, `${field} must survive the metrics`);
    assert.equal(task.status, "completed");
    assert.equal(typeof task.activity, "object");
    // The metrics are derived, so the durable record keeps its old shape and
    // needs no migration or backup rewrite.
    const persisted = JSON.parse(await readFile(join(storage, "task", "task.json"), "utf8"));
    assert.equal(persisted.activity, undefined);
    assert.equal(persisted.samples, undefined);

    const again = await events.snapshot();
    const third = await events.snapshot();
    assert.equal(again.cursor, snapshot.cursor, "re-reading a finished Run publishes nothing");
    assert.equal(third.cursor, snapshot.cursor);
    assert.deepEqual(again.tasks.find((item) => item.taskId === "task").activity, task.activity);

    // The shared client written before the metrics existed still reconciles it:
    // it adopts the snapshot, then applies one newer change that carries metrics.
    const record = await (
      await ledger
    ).publish({
      scope: "task",
      objectId: "task",
      type: "task.changed",
      payload: { ...task, updatedAt: new Date(now).toISOString() }
    });
    const frames = [`id: ${record.eventId}\ndata: ${JSON.stringify(record)}\n\n`];
    const enc = new TextEncoder();
    const fakeFetch = async (url) => {
      if (String(url).includes("/api/events/snapshot"))
        return new Response(JSON.stringify(snapshot), { headers: { "content-type": "application/json" } });
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) return new Promise(() => {});
            sent = true;
            controller.enqueue(enc.encode(frames.join("")));
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    };
    const view = { snapshots: [], applied: [] };
    const client = createManagementEventClient({
      backendId: "backend-bounds",
      fetch: fakeFetch,
      onSnapshot: (value) => view.snapshots.push(value),
      onEvent: (event) => view.applied.push(event)
    });
    t.after(() => client.stop());
    await client.start();
    assert.equal(view.snapshots.length, 1, "the old client still adopts the snapshot");
    assert.equal(view.snapshots[0].tasks.length, snapshot.tasks.length, "no Task is dropped");
    assert.deepEqual(
      view.snapshots[0].tasks.find((item) => item.taskId === "task").activity,
      task.activity,
      "an unknown field is simply carried"
    );
    const until = Date.now() + 10_000;
    while (view.applied.length < 1 && Date.now() < until) await new Promise((done) => setTimeout(done, 20));
    assert.equal(view.applied.length, 1, "a newer change is applied once");
    assert.equal(view.applied[0].payload.activity.version, 1);
  }
);

/**
 * One oversized record must not decide how much a trace may hold.
 *
 * A single tool result can be megabytes (an image, a whole file). The reader
 * parses line by line and carries an unterminated tail into the next read, so a
 * huge line appended while the Run is being read is exactly the case where an
 * unbounded tail would grow by one read budget per poll. The measurement runs in
 * its own process: it needs a cold cache and a forced collection to tell
 * retained memory from garbage.
 */
test("a record past the line budget is dropped instead of buffered", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-activity-huge-line-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = JSON.stringify(new URL("../dist/src/runtime/activity-metrics.js", import.meta.url).href);
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
        import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { readTaskActivity } from ${moduleUrl};
        const storage = await mkdtemp(join(tmpdir(), "atria-activity-huge-workspace-"));
        const runRoot = join(storage, "task", "runs", "run");
        await mkdir(runRoot, { recursive: true });
        const now = Date.now();
        const started = now - 10 * 60_000;
        await writeFile(join(runRoot, "run.json"), JSON.stringify({ taskId: "task", runId: "run", createdAt: new Date(started).toISOString() }));
        await writeFile(join(runRoot, "queue.json"), "[]");
        const line = (at, text) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], timestamp: at } }) + "\\n";
        const log = join(runRoot, "runtime-output.log");
        await writeFile(log, line(started, "first"));
        const task = {
          taskId: "task",
          status: "running",
          activeRunId: "run",
          createdAt: new Date(started).toISOString(),
          updatedAt: new Date(now).toISOString()
        };
        // Read once so the cursor sits before the record appended next: this is
        // the growing-file case, not a fresh read of an already huge log.
        await readTaskActivity({ storageRoot: storage, task, nowMs: started + 60_000 });
        await appendFile(log, line(started + 60_000, "x".repeat(64 * 1024 * 1024)));
        await appendFile(log, line(started + 120_000, "last"));
        const retained = () => {
          global.gc();
          global.gc();
          return process.memoryUsage().arrayBuffers;
        };
        const before = retained();
        // Stop while the oversized record is still unterminated: that is the
        // tail an unbounded reader would keep between polls.
        for (let attempt = 0; attempt < 4; attempt += 1)
          await readTaskActivity({ storageRoot: storage, task, nowMs: started + 300_000 });
        const partial = retained() - before;
        let activity;
        for (let attempt = 4; attempt < 12; attempt += 1)
          activity = await readTaskActivity({ storageRoot: storage, task, nowMs: started + 300_000 });
        console.log(
          JSON.stringify({
            tail: partial,
            retained: retained() - before,
            bytes: activity.agents[0].samples.reduce((sum, sample) => sum + sample.outputBytes, 0)
          })
        );
      `
    ],
    { cwd: root, encoding: "utf8" }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((done) => child.once("close", done));
  assert.equal(code, 0, stderr);
  const measured = JSON.parse(stdout.trim());
  assert.equal(
    measured.bytes,
    "first".length + "last".length,
    "records around the oversized one are counted and the oversized one is dropped"
  );
  assert.ok(
    measured.tail < 16 * 1024 * 1024,
    `an unterminated oversized record is not carried between reads: kept ${Math.round(measured.tail / 1024 / 1024)} MB`
  );
  assert.ok(
    measured.retained < 16 * 1024 * 1024,
    `nothing oversized stays resident after the walk: kept ${Math.round(measured.retained / 1024 / 1024)} MB`
  );
});

/**
 * Event cadence: a Run that writes continuously must not publish once per write.
 *
 * The catalog payload is what the ledger digests, so anything that changes per
 * record turns every reconcile tick into a `task.changed`. Progress is therefore
 * reported on the sample grid, and a subscriber sees one update per finished
 * slice (plus one when the stage itself changes).
 */
test("continuous output publishes at most one catalog change per slice", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-activity-cadence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "workspace");
  const store = new LocalWorkspaceStore(storage);
  await store.createRun("task", "run");
  const runRoot = join(storage, "task", "runs", "run");
  const startedMs = Date.now() - 2 * 60 * MINUTE;
  await writeFile(
    join(runRoot, "run.json"),
    `${JSON.stringify({ taskId: "task", runId: "run", createdAt: new Date(startedMs).toISOString() })}\n`
  );
  await writeFile(join(runRoot, "queue.json"), "[]\n");
  const logPath = join(runRoot, "runtime-output.log");
  await writeFile(logPath, "");
  const task = await store.readTask("task");
  const record = (at) =>
    `${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "step" }], timestamp: at }
    })}\n`;
  let nowMs = startedMs + MINUTE;
  await writeFile(logPath, record(nowMs));
  const events = createCatalogEvents({
    ledger: EventLedger.open(join(root, "events"), "backend-cadence"),
    readCatalog: async () => ({
      projects: [],
      tasks: [{ ...task, activity: await readTaskActivity({ storageRoot: storage, task, nowMs }) }]
    })
  });
  t.after(() => events.close());

  let cursor = (await events.snapshot()).cursor;
  const slices = 60;
  const ticks = slices * 4;
  let published = 0;
  for (let tick = 1; tick <= ticks; tick += 1) {
    nowMs += ACTIVITY_SLICE_MS / 4;
    await appendFile(logPath, record(nowMs));
    const snapshot = await events.snapshot();
    published += snapshot.cursor - cursor;
    cursor = snapshot.cursor;
  }
  assert.ok(published <= slices + 2, `${slices} slices of output must not publish ${published} changes`);
  assert.ok(published >= slices - 2, `each finished slice publishes its sample, got ${published}`);
});
