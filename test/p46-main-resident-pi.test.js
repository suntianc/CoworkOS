import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";

/**
 * Main as a resident process.
 *
 * One real Main Pi process serves a whole Run: a finished turn leaves it
 * running, later messages reach its Inbox, and only closing the session, the
 * idle timeout or a model request that cannot continue ends it. These tests
 * run the real Dashboard, the real launcher and real Pi processes against a
 * local provider; nothing here is an in-process stand-in.
 */

const IDLE_ENV = "COWORK_MAIN_IDLE_TIMEOUT_MS";

function stream(response, delta, finishReason = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "resident-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "resident-fixture",
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  );
}

function complete(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  stream(response, { role: "assistant", content: text });
  stream(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}

/** Answer with a tool call so one turn spans more than one model request. */
function toolCall(response, name, args) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  stream(response, { role: "assistant" });
  stream(response, {
    tool_calls: [
      { index: 0, id: "resident-call", type: "function", function: { name, arguments: JSON.stringify(args) } }
    ]
  });
  stream(response, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}

async function waitFor(check, label, timeout = 30_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= until) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** A real Dashboard, a recorded local provider and the HTTP helpers. */
async function fixture(t, { handle, idleTimeoutMs } = {}) {
  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "resident-fixture" }] }));
    }
    const body = JSON.parse(await readFixtureRequestBody(request));
    requests.push(body);
    await handle({ body, response, requests });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "resident-fixture",
    env: idleTimeoutMs === undefined ? {} : { [IDLE_ENV]: String(idleTimeoutMs) }
  });
  t.after(async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  const api = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }),
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json();
    assert.ok(response.ok, `${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  const detail = (taskId) => api(`/api/tasks/${taskId}`);
  const createTask = (taskId, goal) => api("/api/tasks", { taskId, goal });
  /** Wait until no turn is running; the process stays. */
  const settleTurn = async (taskId) => {
    await waitFor(async () => !(await detail(taskId)).runtime.active, `${taskId} turn to settle`, 60_000);
    return detail(taskId);
  };
  /** The process record of the newest Main this Task started. */
  const mainRecord = async (taskId) => {
    const runs = await readdir(join(dashboard.workspaceRoot, taskId, "runs")).catch(() => []);
    const records = [];
    for (const runId of runs) {
      const value = await readFile(
        join(dashboard.workspaceRoot, taskId, "runs", runId, "agents", "main", "process.json"),
        "utf8"
      )
        .then((text) => JSON.parse(text))
        .catch(() => undefined);
      if (value?.pid) records.push(value);
    }
    records.sort((left, right) => String(left.launchedAt).localeCompare(String(right.launchedAt)));
    return records.at(-1);
  };
  const inbox = (taskId, runId) =>
    join(dashboard.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json");
  const readInbox = async (taskId, runId) =>
    readFile(inbox(taskId, runId), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => []);
  const enqueue = async (taskId, runId, message) => {
    const path = inbox(taskId, runId);
    await mkdir(join(path, ".."), { recursive: true });
    const messages = await readInbox(taskId, runId);
    messages.push({
      recipientAgentId: "main",
      kind: "callback",
      eventId: `event-${message.messageId}`,
      priority: 50,
      state: "ready",
      createdAt: new Date().toISOString(),
      ...message
    });
    await writeFile(path, JSON.stringify(messages, null, 2));
  };
  return {
    dashboard,
    provider,
    requests,
    api,
    detail,
    createTask,
    settleTurn,
    mainRecord,
    readInbox,
    enqueue
  };
}

test(
  "AC1: a finished turn leaves the same Main running and the next message uses that process",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, {
      handle: ({ response, requests }) => complete(response, `answer ${requests.length}`)
    });
    await f.createTask("resident-turn", "First resident turn");
    const first = await f.api("/api/tasks/resident-turn/run", { prompt: "FIRST_RESIDENT_INPUT" });
    const settled = await f.settleTurn("resident-turn");
    assert.equal(settled.task.status, "completed");
    assert.equal(settled.runtime.active, false, "the turn is over");
    const record = await f.mainRecord("resident-turn");
    assert.equal(alive(record.pid), true, "the Main process is still running after its turn");
    assert.equal(settled.runtime.mainRunning, true, "the backend reports the resident Main");
    assert.equal(f.requests.length, 1);

    const second = await f.api("/api/tasks/resident-turn/run", { prompt: "SECOND_RESIDENT_INPUT" });
    assert.equal(second.runId, first.runId, "the message joins the Run this process already owns");
    const after = await f.settleTurn("resident-turn");
    assert.equal(after.task.status, "completed");
    const current = await f.mainRecord("resident-turn");
    assert.equal(current.pid, record.pid, "no new process was started for the second message");
    assert.equal(f.requests.length, 2);
    // One Pi session: the second request carries the first exchange.
    const secondBody = JSON.stringify(f.requests[1].messages);
    assert.match(secondBody, /FIRST_RESIDENT_INPUT/);
    assert.match(secondBody, /SECOND_RESIDENT_INPUT/);
    assert.equal(
      f.dashboard.workspaceRoot
        ? (await f.readInbox("resident-turn", first.runId)).filter(
            (message) => message.payload?.type === "human.message"
          ).length
        : 0,
      2,
      "both user turns were delivered through the durable Inbox"
    );
  }
);

test(
  "AC2: idle timeout exits with state preserved, and the next message continues the same session",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, {
      idleTimeoutMs: 1_200,
      handle: ({ response, requests }) => complete(response, `answer ${requests.length}`)
    });
    await f.createTask("resident-idle", "Idle resident");
    const first = await f.api("/api/tasks/resident-idle/run", { prompt: "IDLE_FIRST_INPUT" });
    const settled = await f.settleTurn("resident-idle");
    assert.equal(settled.task.status, "completed");
    const record = await f.mainRecord("resident-idle");
    assert.equal(alive(record.pid), true);

    // No turn, no subagent: the resident process exits and keeps its state.
    await waitFor(() => !alive(record.pid), "the idle Main to exit", 30_000);
    const idle = await f.detail("resident-idle");
    assert.equal(idle.runtime.active, false);
    assert.equal(idle.runtime.mainRunning, false);
    assert.equal(idle.task.status, "completed", "the Task keeps the state its last turn recorded");
    assert.equal(idle.task.activeRunId, first.runId);
    assert.ok(
      (await readdir(join(f.dashboard.workspaceRoot, "resident-idle", "sessions", "main", "pi"))).length > 0,
      "the Pi session file is kept"
    );

    // A later message starts Main again in the same session.
    await f.api("/api/tasks/resident-idle/run", { prompt: "IDLE_SECOND_INPUT" });
    await f.settleTurn("resident-idle");
    const restarted = await f.mainRecord("resident-idle");
    assert.notEqual(restarted.pid, record.pid, "a new process serves the new message");
    assert.equal(f.requests.length, 2);
    const continued = JSON.stringify(f.requests[1].messages);
    assert.match(continued, /IDLE_FIRST_INPUT/, "the session continued");
    assert.match(continued, /IDLE_SECOND_INPUT/);
  }
);

test("AC2: a pending delegated call keeps the idle Main alive", { timeout: 180_000 }, async (t) => {
  const f = await fixture(t, {
    idleTimeoutMs: 1_200,
    handle: ({ response }) => complete(response, "waiting on delegated work")
  });
  await f.createTask("resident-pending", "Pending delegation");
  const run = await f.api("/api/tasks/resident-pending/run", { prompt: "WATCH_PENDING_CALL" });
  await f.settleTurn("resident-pending");
  const record = await f.mainRecord("resident-pending");

  const { DurableScheduler } = await import("../dist/src/runtime/scheduler.js");
  const scheduler = new DurableScheduler(
    join(f.dashboard.workspaceRoot, "resident-pending", "runs", run.runId, "queue.json")
  );
  await scheduler.enqueue({
    stepId: "pending-call",
    taskId: "resident-pending",
    runId: run.runId,
    agentId: "subagent_1",
    importance: "normal",
    payload: { task: "hold this delegation", projectDirectory: f.dashboard.workspaceRoot },
    maxAttempts: 1
  });
  // Longer than two idle windows: the process must not leave while work is
  // still delegated to it.
  await delay(3_500);
  assert.equal(alive(record.pid), true, "a pending delegated call keeps Main resident");

  await scheduler.cancel("pending-call");
  await waitFor(() => !alive(record.pid), "the now-idle Main to exit", 30_000);
});

test(
  "AC3: pause stops new turns, keeps the process, and queued work waits for the resume",
  { timeout: 180_000 },
  async (t) => {
    let releaseStep;
    const held = new Promise((done) => {
      releaseStep = done;
    });
    let secondStep = false;
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) return toolCall(response, "bash", { command: "printf PAUSE_STEP" });
        if (requests.length === 2) {
          secondStep = true;
          await held;
          return complete(response, "paused at the step boundary");
        }
        return complete(response, "resumed with the queued callback");
      }
    });
    await f.createTask("resident-pause", "Pause resident");
    const run = await f.api("/api/tasks/resident-pause/run", { prompt: "PAUSE_FIRST_INPUT" });
    await waitFor(() => secondStep, "the second model request", 60_000);
    const record = await f.mainRecord("resident-pause");
    await f.api("/api/tasks/resident-pause/action", { action: "pause" });
    releaseStep();
    const paused = await waitFor(
      async () => {
        const value = await f.detail("resident-pause");
        return value.task.status === "paused" ? value : undefined;
      },
      "the pause to be recorded",
      60_000
    );
    assert.equal(paused.runtime.active, false);
    assert.equal(alive(record.pid), true, "pause does not end the process");

    // Work that arrives during the pause stays durable in the Inbox.
    await f.enqueue("resident-pause", run.runId, {
      messageId: "pause-callback",
      callId: "pause-call",
      payload: {
        type: "callback",
        callId: "pause-call",
        status: "succeeded",
        response: "PAUSE_CALLBACK_BODY"
      }
    });
    await delay(1_000);
    const queued = (await f.readInbox("resident-pause", run.runId)).find(
      (message) => message.messageId === "pause-callback"
    );
    assert.equal(queued.state, "ready", "a paused Main leaves arriving work queued");

    await f.api("/api/tasks/resident-pause/run", { resume: true });
    const resumed = await waitFor(
      async () => {
        const value = await f.detail("resident-pause");
        const delivered = (await f.readInbox("resident-pause", run.runId)).find(
          (message) => message.messageId === "pause-callback"
        );
        return !value.runtime.active && delivered?.state === "consumed" ? value : undefined;
      },
      "the queued callback after resume",
      60_000
    );
    assert.equal(resumed.task.status, "completed");
    assert.equal((await f.mainRecord("resident-pause")).pid, record.pid, "resume used the same process");
    assert.match(JSON.stringify(f.requests.at(-1).messages), /PAUSE_CALLBACK_BODY/);
  }
);

test(
  "AC3: cancel interrupts the turn without ending the process or cancelling delegated work",
  { timeout: 180_000 },
  async (t) => {
    let heldStarted = false;
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) {
          heldStarted = true;
          // Never answered: the turn stays in flight until it is interrupted.
          response.writeHead(200, { "content-type": "text/event-stream" });
          stream(response, { role: "assistant", content: "PARTIAL_BEFORE_INTERRUPT" });
          return;
        }
        return complete(response, "after the interrupted turn");
      }
    });
    await f.createTask("resident-interrupt", "Interrupt resident");
    const run = await f.api("/api/tasks/resident-interrupt/run", { prompt: "INTERRUPT_FIRST_INPUT" });
    await waitFor(() => heldStarted, "the in-flight model request", 60_000);
    const record = await f.mainRecord("resident-interrupt");
    const { DurableScheduler } = await import("../dist/src/runtime/scheduler.js");
    const scheduler = new DurableScheduler(
      join(f.dashboard.workspaceRoot, "resident-interrupt", "runs", run.runId, "queue.json")
    );
    await scheduler.enqueue({
      stepId: "kept-delegation",
      taskId: "resident-interrupt",
      runId: run.runId,
      agentId: "subagent_2",
      importance: "normal",
      payload: { task: "keep running", projectDirectory: f.dashboard.workspaceRoot },
      maxAttempts: 1
    });
    await f.api("/api/tasks/resident-interrupt/action", { action: "interrupt" });
    const interrupted = await waitFor(
      async () => {
        const value = await f.detail("resident-interrupt");
        return !value.runtime.active ? value : undefined;
      },
      "the interrupted turn to stop",
      60_000
    );
    assert.notEqual(interrupted.task.status, "cancelled", "an interrupt does not end the Task");
    assert.equal(alive(record.pid), true, "the process stays for the next message");
    assert.equal((await scheduler.list()).find((item) => item.stepId === "kept-delegation").status, "queued");
  }
);

test(
  "AC3: a backend restart adopts the running Main, and closing the session ends it",
  { timeout: 180_000 },
  async (t) => {
    let holdNext = false;
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (holdNext) {
          holdNext = false;
          await held;
          return complete(response, "released");
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-restart", "Restart resident");
    await f.api("/api/tasks/resident-restart/run", { prompt: "RESTART_FIRST_INPUT" });
    await f.settleTurn("resident-restart");
    const record = await f.mainRecord("resident-restart");

    // The backend restarts; the resident Main is not a child of it, so the new
    // backend finds it from the durable process record and keeps serving it.
    await f.dashboard.restart();
    const adopted = await f.detail("resident-restart");
    assert.equal(adopted.runtime.mainRunning, true, "the new backend reports the adopted Main");
    assert.equal(alive(record.pid), true);
    await f.api("/api/tasks/resident-restart/run", { prompt: "RESTART_SECOND_INPUT" });
    await f.settleTurn("resident-restart");
    assert.equal(
      (await f.mainRecord("resident-restart")).pid,
      record.pid,
      "the message reached the same process"
    );
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[1].messages), /RESTART_FIRST_INPUT/);

    // Closing the session is the manual exit: it ends the process and the
    // work it still owes, and does not wait for the turn to finish.
    holdNext = true;
    await f.api("/api/tasks/resident-restart/run", { prompt: "RESTART_THIRD_INPUT" });
    await waitFor(() => f.requests.length === 3, "the third model request", 60_000);
    const active = await f.detail("resident-restart");
    assert.equal(active.task.status, "running");
    const { DurableScheduler } = await import("../dist/src/runtime/scheduler.js");
    const runs = await readdir(join(f.dashboard.workspaceRoot, "resident-restart", "runs"));
    const runId = runs.sort().at(-1);
    const scheduler = new DurableScheduler(
      join(f.dashboard.workspaceRoot, "resident-restart", "runs", runId, "queue.json")
    );
    await scheduler.enqueue({
      stepId: "close-delegation",
      taskId: "resident-restart",
      runId,
      agentId: "subagent_3",
      importance: "normal",
      payload: { task: "open until the session closes", projectDirectory: f.dashboard.workspaceRoot },
      maxAttempts: 1
    });
    await f.api("/api/tasks/resident-restart/action", { action: "cancel" });
    const closed = await waitFor(
      async () => {
        const value = await f.detail("resident-restart");
        return value.task.status === "cancelled" ? value : undefined;
      },
      "the session to close",
      60_000
    );
    assert.equal(closed.runtime.mainRunning, false);
    await waitFor(() => !alive(record.pid), "the closed Main to exit", 30_000);
    assert.equal(
      (await scheduler.list()).find((item) => item.stepId === "close-delegation").status,
      "cancelled",
      "closing the session stops the work it still owes"
    );
    release();
  }
);
