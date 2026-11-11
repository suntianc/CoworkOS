import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { createCatalogEvents } from "../dist/src/dashboard/catalog-events.js";
import { EventLedger } from "../dist/src/dashboard/event-ledger.js";
import { readTaskActivity } from "../dist/src/runtime/activity-metrics.js";
import { createWorkspaceDirectory } from "../dist/src/dashboard/workspace-directory.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

/**
 * Activity metrics for a running Main and its Subagents.
 *
 * The shape these tests pin down is what the pulse lanes draw: a fixed grid of
 * tool-call counts and output bytes per agent, the stage the agent is in and
 * when it changed, and the last moment it produced anything. One test drives a
 * real Main and a real Subagent with a local fake model, because the numbers
 * come from the logs those processes actually write; the others hold the clock
 * still so idle slices and the retained window can be observed.
 */

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const systemText = (body) =>
  body.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map(messageText)
    .join("\n");

async function api(dashboard, path, body) {
  const response = await fetch(`${dashboard.base}${path}`, {
    ...(body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(payload)}`);
  return payload;
}

/** Collect catalog events from the real stream, decoding SSE frames as they arrive. */
function readCatalogStream(dashboard, cursor) {
  const controller = new AbortController();
  const events = [];
  const reading = fetch(`${dashboard.base}/api/events/stream?cursor=${cursor}`, {
    signal: controller.signal
  }).then(async (response) => {
    assert.equal(response.status, 200, "the subscription must be admitted at the snapshot cursor");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");
        if (data) events.push(JSON.parse(data));
      }
    }
  });
  return {
    events,
    async close() {
      controller.abort();
      // The read loop ends through the aborted signal, which it surfaces as a
      // rejected fetch; nothing else owns that promise.
      await reading.catch(() => undefined);
    }
  };
}

const activityOf = (snapshot, taskId) => snapshot.tasks.find((task) => task.taskId === taskId)?.activity;
const mainOf = (activity) => activity.agents.find((agent) => agent.agentId === "main");
const busyOf = (agent) => agent.samples.filter((sample) => sample.toolCalls > 0 || sample.outputBytes > 0);

test(
  "a real Main and its Subagent publish sampled activity through the snapshot and the event stream",
  { timeout: 120_000 },
  async (t) => {
    const requests = { main: 0, subagent: 0 };
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      const subagent = systemText(body).includes("You are a CoworkOS Subagent");
      const tools = (body.messages ?? []).filter((message) => message.role === "tool");
      if (subagent) {
        requests.subagent += 1;
        if (tools.length === 0)
          return { name: "bash", arguments: { command: "printf 'subagent-tool-output\\n'" } };
        return { text: "Subagent finished after one tool call." };
      }
      requests.main += 1;
      if (tools.length === 0)
        return { name: "call_subagent", arguments: { task: "Check the fixture project", mode: "sync" } };
      return { text: "Main finished after the delegate." };
    });
    t.after(() => provider.close());
    const dashboard = await startDashboard({
      modelEndpoint: provider.baseUrl,
      model: "protocol-fixture",
      // Catalog diffs are what carry the metrics; publish them quickly.
      env: { COWORK_EVENT_RECONCILE_MS: "200" }
    });
    t.after(() => dashboard.stop());

    await api(dashboard, "/api/tasks", { taskId: "activity-run", goal: "Check the fixture project." });
    const before = await api(dashboard, "/api/events/snapshot");
    assert.equal(activityOf(before, "activity-run"), undefined, "a Task that never ran has no activity");
    const stream = readCatalogStream(dashboard, before.cursor);
    t.after(() => stream.close());

    await api(dashboard, "/api/tasks/activity-run/run", { prompt: "Check the fixture project." });
    const until = Date.now() + 60_000;
    let detail;
    while (Date.now() < until) {
      detail = await api(dashboard, "/api/tasks/activity-run");
      if (!detail.runtime.active) break;
      await delay(50);
    }
    assert.equal(detail?.runtime.active, false, "Main must settle for the metrics to be frozen");
    assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
    assert.equal(requests.subagent, 2, "the delegate ran a tool call and then answered");

    const snapshot = await api(dashboard, "/api/events/snapshot");
    const activity = activityOf(snapshot, "activity-run");
    assert.ok(activity, "the management snapshot carries activity for a Run inside the window");
    assert.equal(activity.version, 1);
    assert.equal(activity.sliceMs, 60_000);
    assert.ok(activity.windowMs >= 2 * 60 * 60_000, "the retained window covers two hours");
    assert.equal(activity.active, false);
    assert.equal(new Date(activity.from).getTime() % activity.sliceMs, 0, "samples sit on the slice grid");

    const main = activity.agents.find((agent) => agent.role === "main");
    const subagent = activity.agents.find((agent) => agent.role === "subagent");
    assert.ok(main, "Main is on its own lane");
    assert.ok(subagent, "the delegated work item is a branch of that lane");
    assert.equal(main.agentId, "main");
    assert.equal(main.state, "completed");
    assert.equal(main.stage, "completed");
    assert.equal(subagent.state, "completed");
    assert.equal(subagent.stage, "completed");
    assert.equal(subagent.workRole, "executor");
    assert.ok(subagent.callId, "a branch names the durable work item it is");
    assert.ok(subagent.name);

    const slices = main.samples.length;
    assert.ok(slices >= 1, "a finished Run keeps at least the slice it ran in");
    for (const agent of activity.agents) assert.equal(agent.samples.length, slices, "lanes share one grid");
    const toolCallsOf = (agent) => agent.samples.reduce((sum, sample) => sum + sample.toolCalls, 0);
    assert.ok(toolCallsOf(main) >= 1, "Main's delegation is a tool call in its samples");
    assert.equal(toolCallsOf(subagent), 1, "the Subagent's shell execution is a tool call in its samples");
    const outputOf = (agent) => agent.samples.reduce((sum, sample) => sum + sample.outputBytes, 0);
    assert.ok(outputOf(main) > 0, "Main's own reply contributes output volume");
    assert.ok(outputOf(subagent) > 0, "the Subagent's reply and tool output contribute output volume");
    assert.ok(main.lastProgressAt, "the last moment a record was written is visible");
    assert.ok(Date.parse(main.stageChangedAt) >= Date.parse(main.lastProgressAt));
    assert.ok(subagent.lastProgressAt);

    // Counts, stages and times only: no transcript, arguments or credentials.
    const serialized = JSON.stringify(activity);
    for (const secret of ["subagent-tool-output", "Check the fixture project", "Main finished"])
      assert.equal(serialized.includes(secret), false, `activity must not carry ${secret}`);

    // The same Run is described by the event stream, and the frozen samples do
    // not grow once the Run ended.
    await delay(1_500);
    const later = activityOf(await api(dashboard, "/api/events/snapshot"), "activity-run");
    assert.deepEqual(later, activity, "a finished Run neither grows nor changes its samples");

    await stream.close();
    const taskEvents = stream.events.filter(
      (event) => event.scope === "task" && event.objectId === "activity-run"
    );
    assert.ok(taskEvents.length > 0, "the stream reported the Run's catalog changes");
    assert.equal(
      new Set(taskEvents.map((event) => event.eventId)).size,
      taskEvents.length,
      "each change is published once"
    );
    const withMetrics = taskEvents.filter((event) => event.payload.activity !== undefined);
    assert.ok(withMetrics.length > 0, "catalog events carry the activity they describe");
    assert.equal(withMetrics.at(-1).payload.activity.active, false);
    assert.ok(
      withMetrics
        .at(-1)
        .payload.activity.agents.some((agent) =>
          agent.samples.some((sample) => sample.toolCalls > 0 || sample.outputBytes > 0)
        ),
      "the last published copy has the Run's samples"
    );
    for (const event of taskEvents)
      assert.equal(
        JSON.stringify(event.payload).includes("subagent-tool-output"),
        false,
        "events carry metrics, never transcript content"
      );
  }
);

/**
 * A durable Run on disk whose agents produced activity at the given moments.
 *
 * `activity` entries are `[epoch ms, tool calls started, text bytes written]`;
 * Main's log is the bare Pi event stream, where only messages carry a time of
 * their own, exactly as the real one does.
 */
async function traceFixture(t, { startedMs, activity, subagentActivity = [] }) {
  const root = await mkdtemp(join(tmpdir(), "atria-activity-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "workspace");
  const store = new LocalWorkspaceStore(storage);
  await store.createRun("task", "run");
  const runRoot = join(storage, "task", "runs", "run");
  await writeFile(
    join(runRoot, "run.json"),
    `${JSON.stringify({ taskId: "task", runId: "run", createdAt: new Date(startedMs).toISOString() })}\n`
  );
  const mainLines = [{ type: "turn_start" }];
  for (const [at, toolCalls, text] of activity) {
    mainLines.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], timestamp: at }
    });
    for (let index = 0; index < toolCalls; index += 1)
      mainLines.push({
        type: "tool_execution_start",
        toolCallId: `main-${at}-${index}`,
        toolName: "bash",
        args: {}
      });
  }
  await writeFile(
    join(runRoot, "runtime-output.log"),
    `${mainLines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
  const lastActivityMs = activity.at(-1)?.[0] ?? startedMs;
  await writeFile(
    join(runRoot, "queue.json"),
    `${JSON.stringify([
      {
        stepId: "call-sub",
        taskId: "task",
        runId: "run",
        agentId: "subagent_1",
        importance: "normal",
        payload: { task: "Subagent work", delegation: { role: "reviewer" } },
        status: "completed",
        attempts: 1,
        createdAt: new Date(startedMs).toISOString(),
        updatedAt: new Date(subagentActivity.at(-1)?.[0] ?? lastActivityMs).toISOString()
      }
    ])}\n`
  );
  await mkdir(join(storage, "task", "sessions", "subagent_1"), { recursive: true });
  const subagentLines = subagentActivity.flatMap(([at, toolCalls]) => [
    ...Array.from({ length: toolCalls }, (_value, index) => ({
      type: "tool_execution_start",
      toolCallId: `sub-${at}-${index}`,
      toolName: "read",
      args: {}
    })),
    { type: "message_end", message: { role: "assistant", content: "subagent text" } }
  ]);
  await writeFile(
    join(storage, "task", "sessions", "subagent_1", "run.jsonl"),
    `${subagentLines
      .map((payload, index) => {
        const at = subagentActivity[0]?.[0] ?? startedMs;
        return JSON.stringify({
          eventId: `trace_${index}`,
          type: "trace.runtime",
          taskId: "task",
          runId: "run",
          agentId: "subagent_1",
          occurredAt: new Date(at).toISOString(),
          payload
        });
      })
      .join("\n")}\n`
  );
  return { root, storage, store };
}

test("idle time is sampled as zero and the retained window is bounded", { timeout: 30_000 }, async (t) => {
  const now = Date.now();
  const startedMs = now - 4 * 60 * 60_000;
  const recentMs = now - 90 * 60_000;
  const { storage, store } = await traceFixture(t, {
    startedMs,
    // The first stretch is four hours old: outside the retained window.
    activity: [
      [startedMs, 2, "early work"],
      [recentMs, 1, "recent work"]
    ],
    subagentActivity: [[recentMs, 1]]
  });
  const task = await store.readTask("task");

  const activity = await readTaskActivity({ storageRoot: storage, task, nowMs: now });
  assert.ok(activity);
  const main = mainOf(activity);
  const subagent = activity.agents.find((agent) => agent.agentId === "subagent_1");
  assert.ok(main && subagent);

  // The window is a fixed number of slices ending at the last finished slice.
  assert.equal(activity.windowMs, 2 * 60 * 60_000, "at least two hours are retained");
  assert.equal(main.samples.length, activity.windowMs / activity.sliceMs);
  const covered = now - Date.parse(activity.from);
  assert.ok(
    covered >= activity.windowMs && covered < activity.windowMs + activity.sliceMs,
    "the grid ends at the newest finished slice"
  );
  // Activity older than the window is gone, the recent one is counted.
  assert.equal(busyOf(main).length, 1, "only the activity inside the window is sampled");
  assert.equal(busyOf(main)[0].toolCalls, 1);
  assert.equal(
    Date.parse(main.lastProgressAt),
    recentMs,
    "the four-hour-old stretch is outside the retained window"
  );
  // Idle time is present and zero, one idle slice after the last record.
  assert.equal(main.stage, "idle");
  assert.equal(main.state, "running");
  assert.equal(Date.parse(main.stageChangedAt), recentMs + activity.sliceMs);
  assert.equal(main.samples.at(-1).toolCalls, 0);
  assert.equal(main.samples.at(-1).outputBytes, 0);
  assert.deepEqual(
    main.samples.slice(-60).filter((sample) => sample.toolCalls || sample.outputBytes),
    [],
    "the quiet tail is sampled as zeros"
  );
  assert.equal(subagent.samples.length, main.samples.length, "branches share Main's grid");
  assert.equal(busyOf(subagent).length, 1);
  assert.equal(subagent.workRole, "reviewer");

  // A Run that ended stops growing: the same two reads hours apart are identical.
  const taskFile = join(storage, "task", "task.json");
  const completedAt = new Date(recentMs + activity.sliceMs).toISOString();
  await writeFile(
    taskFile,
    JSON.stringify({ ...JSON.parse(await readFile(taskFile, "utf8")), status: "completed", completedAt })
  );
  const ended = await store.readTask("task");
  const first = await readTaskActivity({ storageRoot: storage, task: ended, nowMs: now });
  const second = await readTaskActivity({
    storageRoot: storage,
    task: ended,
    nowMs: recentMs + 100 * 60_000
  });
  assert.deepEqual(second, first, "a finished Run neither grows nor moves its samples");
  assert.equal(first.active, false);
  assert.equal(mainOf(first).stage, "completed");
  assert.equal(mainOf(first).lastProgressAt, main.lastProgressAt);
});

test("a reconnecting reader rebuilds the same window from disk", { timeout: 30_000 }, async (t) => {
  const now = Date.now();
  const startedMs = now - 30 * 60_000;
  const recentMs = startedMs + 2 * 60_000;
  const { root, storage } = await traceFixture(t, {
    startedMs,
    activity: [[recentMs, 1, "recent work"]],
    subagentActivity: [[recentMs, 1]]
  });
  const index = join(root, "workspace.json");
  const openEvents = (ledgerDirectory) =>
    createCatalogEvents({
      ledger: EventLedger.open(ledgerDirectory, "backend-activity"),
      readCatalog: createWorkspaceDirectory(storage, index, () => "fixture").globalTaskPayload
    });
  const first = openEvents(join(root, "events"));
  t.after(() => first.close());
  const firstSnapshot = await first.snapshot();
  const firstActivity = activityOf(firstSnapshot, "task");
  assert.ok(firstActivity, "the first snapshot carries the Run that is still open");
  assert.equal(firstActivity.active, true, "Main is still running in the fixture");
  assert.equal(busyOf(mainOf(firstActivity)).length, 1, "activity older than the reader is backfilled");

  // A second backend over the same workspace, with no memory of the first,
  // must publish the same window: nothing lives only in this process.
  const restarted = openEvents(join(root, "events"));
  t.after(() => restarted.close());
  const resumedActivity = activityOf(await restarted.snapshot(), "task");
  assert.ok(resumedActivity);
  const resumedMain = mainOf(resumedActivity);
  assert.ok(Math.abs(resumedMain.samples.length - mainOf(firstActivity).samples.length) <= 1);
  assert.deepEqual(busyOf(resumedMain), busyOf(mainOf(firstActivity)));
  assert.equal(resumedMain.stage, mainOf(firstActivity).stage);
  assert.equal(resumedMain.lastProgressAt, mainOf(firstActivity).lastProgressAt);
});
