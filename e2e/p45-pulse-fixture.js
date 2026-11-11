import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/**
 * Real Tasks, real durable logs: the Runs view is read from the same files a
 * Main writes, so the fixture writes those files instead of rewriting the API's
 * answer. A Task's activity is derived from `runtime-output.log` and each
 * Subagent's trace, exactly as it is in a running product.
 */

const MINUTE = 60_000;

/** A minute-aligned clock so every written record lands in a finished slice. */
export function pulseClock(now = Date.now()) {
  const base = Math.floor(now / MINUTE) * MINUTE;
  return {
    base,
    /** Milliseconds at `offset` minutes from the clock, inside that slice. */
    at: (offset) => base + offset * MINUTE + 5_000,
    ago: (offset) => base + offset * MINUTE
  };
}

function activityRecords(clock, { from, to, every = 1, toolCalls = 2, outputBytes = 900 }) {
  const records = [];
  for (let offset = from; offset < to; offset += every) {
    const time = new Date(clock.at(offset)).toISOString();
    const hash = Math.imul(offset - from + 97, 2654435761) >>> 0;
    // A few quiet slices keep the drawn line from looking like a sine wave.
    if (hash % 7 === 0) continue;
    const calls = 1 + (hash % 3);
    const bytes = 120 + (hash % outputBytes);
    for (let index = 0; index < Math.min(toolCalls, calls); index += 1)
      records.push({ type: "tool_execution_start", occurredAt: time });
    records.push({
      type: "message_end",
      occurredAt: time,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(bytes) }]
      }
    });
  }
  return records;
}

async function writeTrace(path, records) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

/**
 * Give one session's Task the durable files of a running Main.
 *
 * `main` and each Subagent carry the minute range they wrote in; slices outside
 * it stay quiet, which is what the pulse draws as a flat stretch.
 */
export async function seedPulseLane(
  dashboard,
  {
    taskId,
    runId,
    createdAt,
    title,
    main,
    subagents = [],
    activeRunId = true,
    clock = pulseClock(),
    status = "running",
    completedAt
  }
) {
  const taskPath = join(dashboard.workspaceRoot, taskId, "task.json");
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  await writeFile(
    taskPath,
    `${JSON.stringify(
      {
        ...task,
        ...(title ? { title } : {}),
        status,
        ...(activeRunId ? { activeRunId: runId } : {}),
        createdAt: new Date(createdAt).toISOString(),
        updatedAt: new Date(completedAt ?? clock.base).toISOString(),
        ...(completedAt ? { completedAt: new Date(completedAt).toISOString() } : {})
      },
      null,
      2
    )}\n`
  );
  const runRoot = join(dashboard.workspaceRoot, taskId, "runs", runId);
  await mkdir(runRoot, { recursive: true });
  await writeFile(
    join(runRoot, "run.json"),
    `${JSON.stringify({ createdAt: new Date(createdAt).toISOString() })}\n`
  );
  await writeTrace(join(runRoot, "runtime-output.log"), activityRecords(clock, main));
  if (subagents.length) {
    await writeFile(
      join(runRoot, "queue.json"),
      `${JSON.stringify(
        subagents.map((subagent) => ({
          stepId: `call-${subagent.agentId}`,
          agentId: subagent.agentId,
          status: subagent.state,
          createdAt: new Date(clock.at(subagent.from)).toISOString(),
          updatedAt: new Date(clock.at(subagent.to - 1)).toISOString(),
          payload: { delegation: { role: subagent.role } }
        })),
        null,
        2
      )}\n`
    );
    for (const subagent of subagents)
      await writeTrace(
        join(dashboard.workspaceRoot, taskId, "sessions", subagent.agentId, `${runId}.jsonl`),
        activityRecords(clock, subagent)
      );
  }
  return clock;
}

/** One Main session through the public contract; it creates the Task container. */
export async function createPulseSession(
  page,
  dashboard,
  { projectId, title, requirementId, entryKind = "internal", kind = "regular" }
) {
  const response = await page.request.post(`${dashboard.base}/api/projects/${projectId}/main-sessions`, {
    data: { action: "create", title, requirementId, entryKind, kind }
  });
  if (!response.ok()) throw new Error(`session creation failed: ${response.status()}`);
  return (await response.json()).session;
}

/** One requirement through the public ledger contract. */
export async function createPulseRequirement(page, dashboard, projectId, title) {
  const response = await page.request.post(`${dashboard.base}/api/projects/${projectId}/ledger`, {
    data: { action: "create", title, content: `${title}的说明`, source: { kind: "internal" } }
  });
  if (!response.ok()) throw new Error(`requirement creation failed: ${response.status()}`);
  return (await response.json()).requirement;
}

/**
 * Seed the host's slot claims, the same durable fact a dispatched Main leaves.
 *
 * The pid belongs to the test process and is alive, so the host's own
 * reconciliation keeps the claim. The Runs view must read occupancy from these
 * slots, not from the lanes the current filter happens to display.
 */
export async function seedCapacitySlots(dashboard, slots) {
  const directory = join(dashboard.root, "main-capacity");
  const path = join(directory, "state.json");
  let state = { version: 1, externalTasks: [], slots: [], queue: [] };
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  state.slots = [
    ...(Array.isArray(state.slots) ? state.slots : []),
    ...slots.map((slot) => ({
      requestId: `request-${slot.taskId}`,
      projectId: slot.projectId,
      sessionId: slot.sessionId,
      taskId: slot.taskId,
      runId: slot.runId,
      kind: slot.kind,
      ...(slot.requirementId ? { requirementId: slot.requirementId } : {}),
      host: hostname(),
      pid: process.pid,
      startedAt: new Date(slot.startedAt).toISOString()
    }))
  ];
  state.updatedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}
