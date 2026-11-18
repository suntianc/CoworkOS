import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
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
async function fixture(t, { handle, idleTimeoutMs, env = {} } = {}) {
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
    env: { ...env, ...(idleTimeoutMs === undefined ? {} : { [IDLE_ENV]: String(idleTimeoutMs) }) }
  });
  t.after(async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  const api = async (path, body) => {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(`${dashboard.base}${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      const cause = error?.cause;
      assert.fail(
        `${path} failed after ${Date.now() - startedAt}ms; backend ${
          dashboard.child.exitCode ?? "alive"
        }; cause ${cause?.code ?? cause?.message ?? "none"}`
      );
    }
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
  "a settled turn records its terminal Run event while the process stays alive",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, {
      handle: ({ response, requests }) => complete(response, `answer ${requests.length}`)
    });
    await f.createTask("resident-run-event", "Terminal Run event");
    const first = await f.api("/api/tasks/resident-run-event/run", { prompt: "FIRST_RUN_EVENT_INPUT" });
    await f.settleTurn("resident-run-event");
    // The conversation reads a settled exchange's final answer from this log,
    // so a turn that ends while its process lives must close the Run's interval
    // here — the exit that used to write it never happens for a resident Main.
    const completed = await runEvents(f, "resident-run-event", first.runId, "main.run_completed");
    assert.equal(completed.length, 1, JSON.stringify(completed));
    assert.equal(alive((await f.mainRecord("resident-run-event")).pid), true, "the Main process still runs");

    await f.api("/api/tasks/resident-run-event/run", { prompt: "SECOND_RUN_EVENT_INPUT" });
    await f.settleTurn("resident-run-event");
    assert.equal(
      (await runEvents(f, "resident-run-event", first.runId, "main.run_completed")).length,
      2,
      "every settled turn closes its own interval"
    );
    assert.equal(
      (await runEvents(f, "resident-run-event", first.runId, "main.run_stopped")).length,
      0,
      "the Run is not settled as exited while its Main still runs"
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
    // The backend reports it gone only once the exit is projected, so wait for
    // that observation rather than for the pid alone.
    const idle = await waitFor(
      async () => {
        const value = await f.detail("resident-idle");
        return !value.runtime.mainRunning && !alive(record.pid) ? value : undefined;
      },
      "the idle Main to exit",
      30_000
    );
    assert.equal(idle.runtime.active, false);
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
    payload: {
      task: "hold this delegation",
      projectDirectory: f.dashboard.workspaceRoot,
      // The backend starts any runnable item; this one waits on a prerequisite
      // that never exists so it stays outstanding for the idle-timeout check.
      dependsOn: ["pending-prerequisite"]
    },
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
  "AC3: stop ends the turn and cancels delegated work without ending the session, and the cancellation wakes no one",
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
      payload: {
        task: "keep running",
        projectDirectory: f.dashboard.workspaceRoot,
        // Outstanding but not runnable: only the stop settles it.
        dependsOn: ["kept-prerequisite"]
      },
      maxAttempts: 1
    });
    const stop = await f.api("/api/tasks/resident-interrupt/action", { action: "stop" });
    assert.equal(stop.subagents, 1);
    const stopped = await waitFor(
      async () => {
        const value = await f.detail("resident-interrupt");
        return !value.runtime.active ? value : undefined;
      },
      "the stopped turn to end",
      60_000
    );
    assert.notEqual(stopped.task.status, "cancelled", "a stop does not end the session");
    assert.equal(alive(record.pid), true, "the process stays for the next message");
    await waitFor(
      async () =>
        (await scheduler.list()).find((item) => item.stepId === "kept-delegation").status === "cancelled",
      "the stop to cancel the delegated work",
      30_000
    );
    const events = await readFile(
      join(f.dashboard.workspaceRoot, "resident-interrupt", "runs", run.runId, "run_events.jsonl"),
      "utf8"
    );
    assert.match(events, /"type":"main\.run_stopped"/);
    // The cancelled work's callback is a record of the stop, not a new turn.
    await new Promise((done) => setTimeout(done, 3_000));
    assert.equal(f.requests.length, 1, "the cancellation does not wake Main");
    await f.api("/api/tasks/resident-interrupt/run", { prompt: "AFTER_STOP_INPUT" });
    await f.settleTurn("resident-interrupt");
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[1].messages), /AFTER_STOP_INPUT/);
    assert.match(
      JSON.stringify(f.requests[1].messages),
      /cancelled/,
      "Main reads the cancellation with the next turn"
    );
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
      payload: {
        task: "open until the session closes",
        projectDirectory: f.dashboard.workspaceRoot,
        dependsOn: ["close-window-prerequisite"]
      },
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

/** End the recorded Main's whole process group, the way a crash would. */
function killMain(record) {
  try {
    process.kill(-record.pid, "SIGKILL");
  } catch {
    /* the group already exited */
  }
}

/** Every Run event of one type, read from the durable log. */
async function runEvents(f, taskId, runId, type) {
  const text = await readFile(
    join(f.dashboard.workspaceRoot, taskId, "runs", runId, "run_events.jsonl"),
    "utf8"
  ).catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((event) => event?.type === type);
}

test(
  "a backend restart adopts the running Main, and its turn state still comes from the durable record",
  { timeout: 180_000 },
  async (t) => {
    let heldStarted = false;
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) {
          heldStarted = true;
          await held;
          return complete(response, "released after the interrupt");
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-adopted-turn", "Adopted turn state");
    await f.api("/api/tasks/resident-adopted-turn/run", { prompt: "ADOPTED_FIRST_INPUT" });
    await waitFor(() => heldStarted, "the in-flight model request", 60_000);
    const record = await f.mainRecord("resident-adopted-turn");

    // The restart leaves the turn running in the same process, and the new
    // backend takes that process over before any message names it.
    await f.dashboard.restart();
    assert.equal(alive(record.pid), true);
    assert.equal((await f.detail("resident-adopted-turn")).runtime.mainRunning, true);

    // An insertion reaches the adopted process too: the target comes from the
    // process record, not from a process this backend spawned.
    const injected = await f.api("/api/tasks/resident-adopted-turn/interject", {
      message: "ADOPTED_INTERJECT",
      delivery: "steer"
    });
    assert.equal(injected.delivered, true);

    // Stopping must find the in-flight turn even though this backend never
    // saw its stdout: the process's heartbeat is the durable turn record.
    const stopped = await f.api("/api/tasks/resident-adopted-turn/action", { action: "stop" });
    assert.equal(stopped.stopped, true);
    const idle = await waitFor(
      async () => {
        const value = await f.detail("resident-adopted-turn");
        return value.runtime.active === false ? value : undefined;
      },
      "the adopted turn to settle",
      60_000
    );
    assert.equal(alive(record.pid), true, "the process stays after the stop");
    assert.notEqual(idle.task.status, "cancelled");
    // With the turn over, the adopted process must read as idle rather than
    // staying "active" for the life of the process.
    await f.api("/api/tasks/resident-adopted-turn/action", { action: "stop" }).then(
      () => assert.fail("an idle adopted Main has no turn to stop"),
      (error) => assert.match(error.message, /409|没有正在运行的回合/)
    );
    release();
  }
);

test(
  "an insertion delivered after the turn ended opens a turn and is answered",
  { timeout: 180_000 },
  async (t) => {
    const { InboxStore } = await import("../dist/src/runtime/scheduler.js");
    const f = await fixture(t, {
      handle: ({ response, requests }) => complete(response, `answer ${requests.length}`)
    });
    await f.createTask("resident-late-insertion", "Late insertion");
    const first = await f.api("/api/tasks/resident-late-insertion/run", { prompt: "LATE_FIRST_INPUT" });
    const settled = await f.settleTurn("resident-late-insertion");
    assert.equal(settled.task.status, "completed");
    // A person typed this while the first turn was running; its delivery lands
    // after that turn has ended. It must be answered, not appended silently.
    const inbox = new InboxStore(
      join(
        f.dashboard.workspaceRoot,
        "resident-late-insertion",
        "runs",
        first.runId,
        "agents",
        "main",
        "inbox-store.json"
      )
    );
    await inbox.enqueue({
      messageId: "late-insertion",
      recipientAgentId: "main",
      kind: "human_command",
      eventId: "late-insertion-event",
      priority: 120,
      state: "ready",
      payload: { type: "human.message", message: "LATE_INSERTION_INPUT", delivery: "steer" },
      createdAt: new Date().toISOString()
    });
    const answered = await waitFor(
      async () => {
        const value = await f.detail("resident-late-insertion");
        return value.runtime.active === false && f.requests.length === 2 ? value : undefined;
      },
      "the late insertion to open a turn and be answered",
      60_000
    );
    assert.match(JSON.stringify(f.requests[1].messages), /LATE_INSERTION_INPUT/);
    assert.equal(
      (await inbox.list("main")).find((message) => message.messageId === "late-insertion").state,
      "consumed"
    );
    assert.equal(answered.task.status, "completed");
  }
);

test(
  "a Main that dies mid-turn after a restart settles as failed, not as an idle stop",
  { timeout: 180_000 },
  async (t) => {
    let heldStarted = false;
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) {
          heldStarted = true;
          response.writeHead(200, { "content-type": "text/event-stream" });
          stream(response, { role: "assistant", content: "PARTIAL_BEFORE_CRASH" });
          // Never finishes: the process is killed with the request open.
          return;
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-crash", "Crash mid-turn");
    await f.api("/api/tasks/resident-crash/run", { prompt: "CRASH_FIRST_INPUT" });
    await waitFor(() => heldStarted, "the in-flight model request", 60_000);
    const record = await f.mainRecord("resident-crash");
    const runId = (await f.detail("resident-crash")).task.activeRunId;

    await f.dashboard.restart();
    assert.equal(alive(record.pid), true);
    killMain(record);

    const failed = await waitFor(
      async () => {
        const value = await f.detail("resident-crash");
        return value.task.status === "failed" ? value : undefined;
      },
      "the mid-turn death to settle as failed",
      60_000
    );
    assert.equal(failed.runtime.active, false);
    assert.equal(failed.runtime.mainRunning, false);
    assert.equal((await runEvents(f, "resident-crash", runId, "main.run_failed")).length, 1);
    assert.equal(
      (await runEvents(f, "resident-crash", runId, "main.run_stopped")).length,
      0,
      "a crash is not reported as an idle stop"
    );
    // The failed request remains replayable: that is the recovery surface.
    assert.ok(failed.retryRequest, "the failed request is offered for an exact retry");
  }
);

test(
  "after a restart, a pause reaches the adopted Main and is recorded at its step boundary",
  { timeout: 180_000 },
  async (t) => {
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    let secondStep = false;
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) return toolCall(response, "bash", { command: "printf ADOPTED_PAUSE" });
        secondStep = true;
        await held;
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-pause-adopted", "Adopted pause");
    await f.api("/api/tasks/resident-pause-adopted/run", { prompt: "ADOPTED_PAUSE_INPUT" });
    await waitFor(() => secondStep, "the in-flight second request", 60_000);
    const record = await f.mainRecord("resident-pause-adopted");

    await f.dashboard.restart();
    // No new message names the process: the pause itself must reach it.
    const pauseRequested = await f.api("/api/tasks/resident-pause-adopted/action", { action: "pause" });
    assert.equal(pauseRequested.status, "running", "the pause request is recorded first");
    release();
    const paused = await waitFor(
      async () => {
        const value = await f.detail("resident-pause-adopted");
        return value.task.status === "paused" ? value : undefined;
      },
      "the adopted turn to pause",
      60_000
    );
    assert.equal(paused.runtime.active, false);
    assert.equal(paused.task.pause.pausedAt !== undefined, true);
    assert.equal(alive(record.pid), true, "pause keeps the adopted process");
  }
);

test(
  "after a restart, closing the session ends the adopted Main and its pending delegation",
  { timeout: 180_000 },
  async (t) => {
    let heldStarted = false;
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (!heldStarted) {
          heldStarted = true;
          await held;
          return complete(response, "released by the close");
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-close-adopted", "Adopted close");
    const run = await f.api("/api/tasks/resident-close-adopted/run", { prompt: "ADOPTED_CLOSE_INPUT" });
    await waitFor(() => heldStarted, "the in-flight request", 60_000);
    const record = await f.mainRecord("resident-close-adopted");
    const { DurableScheduler } = await import("../dist/src/runtime/scheduler.js");
    const scheduler = new DurableScheduler(
      join(f.dashboard.workspaceRoot, "resident-close-adopted", "runs", run.runId, "queue.json")
    );
    await scheduler.enqueue({
      stepId: "adopted-close-delegation",
      taskId: "resident-close-adopted",
      runId: run.runId,
      agentId: "subagent_4",
      importance: "normal",
      payload: {
        task: "open until the session closes",
        projectDirectory: f.dashboard.workspaceRoot,
        dependsOn: ["adopted-close-prerequisite"]
      },
      maxAttempts: 1
    });

    await f.dashboard.restart();
    await f.api("/api/tasks/resident-close-adopted/action", { action: "cancel" });
    const closed = await waitFor(
      async () => {
        const value = await f.detail("resident-close-adopted");
        return value.task.status === "cancelled" ? value : undefined;
      },
      "the adopted session to close",
      60_000
    );
    assert.equal(closed.runtime.mainRunning, false);
    await waitFor(() => !alive(record.pid), "the adopted Main to exit", 30_000);
    assert.equal(
      (await scheduler.list()).find((item) => item.stepId === "adopted-close-delegation").status,
      "cancelled"
    );
    release();
  }
);

test(
  "a finished session archives at once, closing the Main it left resident and keeping its outcome",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, { handle: async ({ response }) => complete(response, "finished answer") });
    await f.createTask("resident-archivable", "Archivable session");
    await f.api("/api/tasks/resident-archivable/run", { prompt: "ARCHIVABLE_INPUT" });
    await waitFor(
      async () => (await f.detail("resident-archivable")).task.status === "completed",
      "the round to finish",
      60_000
    );
    const record = await f.mainRecord("resident-archivable");
    assert.equal(alive(record.pid), true, "the finished round leaves its Main resident");
    const archived = await fetch(`${f.dashboard.base}/api/tasks/resident-archivable`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true })
    });
    assert.equal(archived.status, 200);
    // The archive answers before the Main has finished closing; the close
    // settles behind it and must not take the archive flag back.
    assert.equal((await archived.json()).archived, true);
    await waitFor(() => !alive(record.pid), "the idle Main to exit", 30_000);
    const detail = await f.detail("resident-archivable");
    assert.equal(detail.task.archived, true);
    assert.equal(detail.task.status, "completed");
  }
);

test(
  "a session whose idle Main exited archives, while one with a Subagent at work does not",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, {
      idleTimeoutMs: 1_200,
      handle: ({ response }) => complete(response, "done for now")
    });
    await f.createTask("resident-idle-archive", "Idle exit then archive");
    const run = await f.api("/api/tasks/resident-idle-archive/run", { prompt: "IDLE_ARCHIVE_INPUT" });
    await f.settleTurn("resident-idle-archive");
    const record = await f.mainRecord("resident-idle-archive");
    await waitFor(() => !alive(record.pid), "the idle Main to exit", 30_000);

    const { DurableScheduler } = await import("../dist/src/runtime/scheduler.js");
    const scheduler = new DurableScheduler(
      join(f.dashboard.workspaceRoot, "resident-idle-archive", "runs", run.runId, "queue.json")
    );
    await scheduler.enqueue({
      stepId: "still-working",
      taskId: "resident-idle-archive",
      runId: run.runId,
      agentId: "subagent_1",
      importance: "normal",
      payload: {
        task: "outstanding work",
        projectDirectory: f.dashboard.workspaceRoot,
        dependsOn: ["never-arrives"]
      },
      maxAttempts: 1
    });
    const archive = () =>
      fetch(`${f.dashboard.base}/api/tasks/resident-idle-archive`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true })
      });
    assert.equal((await archive()).status, 400, "a Subagent at work keeps the round open");
    await scheduler.cancel("still-working");
    assert.equal((await archive()).status, 200);
    assert.equal((await f.detail("resident-idle-archive")).task.archived, true);
  }
);

test(
  "a session whose Main was adopted after a restart is not deletable or archivable",
  { timeout: 180_000 },
  async (t) => {
    let heldStarted = false;
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (!heldStarted) {
          heldStarted = true;
          await held;
          return complete(response, "released");
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-undeletable", "Undeletable session");
    await f.api("/api/tasks/resident-undeletable/run", { prompt: "UNDELETABLE_INPUT" });
    await waitFor(() => heldStarted, "the in-flight request", 60_000);
    const record = await f.mainRecord("resident-undeletable");

    await f.dashboard.restart();
    // The adopted Main still owns the session, so deleting or archiving it is
    // the same destructive act it is while this backend spawned the process.
    const removed = await fetch(`${f.dashboard.base}/api/tasks/resident-undeletable`, { method: "DELETE" });
    assert.equal(removed.status, 400);
    const archived = await fetch(`${f.dashboard.base}/api/tasks/resident-undeletable`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true })
    });
    assert.equal(archived.status, 400);
    assert.equal(alive(record.pid), true, "the adopted Main is untouched");

    await f.api("/api/tasks/resident-undeletable/action", { action: "cancel" });
    await waitFor(() => !alive(record.pid), "the closed Main to exit", 30_000);
    release();
  }
);

/** Hold a process record's settlement lock so no observer can finish it yet. */
async function holdSettlementLock(recordPath) {
  const lockPath = `${recordPath}.settle.lock`;
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({
      token: `held-${process.pid}`,
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString()
    })
  );
  return () => rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

/** A process record for a Main that already died, to keep the sweep busy. */
async function writeDeadMainRecord(workspaceRoot, taskId, runId) {
  const { agentProcessRecordPath } = await import("../dist/src/runtime/agent-process.js");
  const recordPath = agentProcessRecordPath(workspaceRoot, taskId, runId, "main", "main");
  await mkdir(join(recordPath, ".."), { recursive: true });
  await writeFile(
    recordPath,
    JSON.stringify({
      version: 1,
      taskId,
      runId,
      callId: runId,
      agentId: "main",
      role: "main",
      pid: 2 ** 31 - 1,
      host: hostname(),
      startedAt: "gone",
      token: "dead",
      launchedAt: new Date().toISOString(),
      workingDirectory: workspaceRoot,
      sessionDirectory: join(workspaceRoot, taskId, "sessions", "main", "pi"),
      resultPath: join(recordPath, "..", "process-result.json"),
      stdoutPath: join(recordPath, "..", "agent-output.log"),
      stderrPath: join(recordPath, "..", "agent-stderr.log")
    })
  );
  return recordPath;
}

test("closing is not ordered behind the startup adoption sweep", { timeout: 180_000 }, async (t) => {
  let heldStarted = false;
  let release;
  const held = new Promise((done) => {
    release = done;
  });
  const f = await fixture(t, {
    handle: async ({ response, requests }) => {
      if (!heldStarted) {
        heldStarted = true;
        await held;
        return complete(response, "released");
      }
      return complete(response, `answer ${requests.length}`);
    }
  });
  await f.createTask("z-close-window", "Close before adoption");
  const run = await f.api("/api/tasks/z-close-window/run", { prompt: "CLOSE_WINDOW_INPUT" });
  await waitFor(() => heldStarted, "the in-flight request", 60_000);
  const record = await f.mainRecord("z-close-window");
  const { DurableScheduler } = await import("../dist/src/runtime/scheduler.js");
  const scheduler = new DurableScheduler(
    join(f.dashboard.workspaceRoot, "z-close-window", "runs", run.runId, "queue.json")
  );
  await scheduler.enqueue({
    stepId: "close-window-delegation",
    taskId: "z-close-window",
    runId: run.runId,
    agentId: "subagent_5",
    importance: "normal",
    payload: {
      task: "open until the session closes",
      projectDirectory: f.dashboard.workspaceRoot,
      // The backend now starts any runnable item, so this one waits on a
      // prerequisite that never exists: it stays queued until the close.
      dependsOn: ["close-window-prerequisite"]
    },
    maxAttempts: 1
  });

  // A newer task with a dead Main whose settlement is locked keeps the
  // startup sweep on it, so the target cannot be taken over by the sweep.
  const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
  const store = new LocalWorkspaceStore(f.dashboard.workspaceRoot);
  await store.createTask("a-blocker", { goal: "blocker" });
  await store.createRun("a-blocker", "main-blocker");
  await store.updateTask("a-blocker", { activeRunId: "main-blocker" });
  const blockerRecord = await writeDeadMainRecord(f.dashboard.workspaceRoot, "a-blocker", "main-blocker");
  const releaseBlocker = await holdSettlementLock(blockerRecord);
  t.after(releaseBlocker);
  // The sweep takes the most recently updated Task first.
  await store.updateTask("a-blocker", { goal: "blocker is newest" });

  await f.dashboard.restart();
  // No wait for a sweep: closing is the first management call.
  await f.api("/api/tasks/z-close-window/action", { action: "cancel" });
  const closed = await waitFor(
    async () => {
      const value = await f.detail("z-close-window");
      return value.task.status === "cancelled" ? value : undefined;
    },
    "the session to close",
    60_000
  );
  assert.equal(closed.runtime.mainRunning, false);
  await waitFor(() => !alive(record.pid), "the closed Main to exit", 30_000);
  assert.equal(
    (await scheduler.list()).find((item) => item.stepId === "close-window-delegation").status,
    "cancelled"
  );
  await releaseBlocker();
  release();
});

test(
  "an interrupt a dead Main never consumed does not abort the next Main's turn",
  { timeout: 180_000 },
  async (t) => {
    let heldStarted = false;
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (!heldStarted) {
          heldStarted = true;
          response.writeHead(200, { "content-type": "text/event-stream" });
          stream(response, { role: "assistant", content: "PARTIAL" });
          return;
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-stale-interrupt", "Stale interrupt");
    const run = await f.api("/api/tasks/resident-stale-interrupt/run", { prompt: "STALE_INTERRUPT_INPUT" });
    await waitFor(() => heldStarted, "the in-flight request", 60_000);
    const record = await f.mainRecord("resident-stale-interrupt");
    // Hold the settlement so the interrupt is written while the exit is still
    // being projected; then let the projection run.
    const { agentProcessRecordPath } = await import("../dist/src/runtime/agent-process.js");
    const releaseSettlement = await holdSettlementLock(
      agentProcessRecordPath(f.dashboard.workspaceRoot, "resident-stale-interrupt", run.runId, "main", "main")
    );
    killMain(record);
    const inboxPath = join(
      f.dashboard.workspaceRoot,
      "resident-stale-interrupt",
      "runs",
      run.runId,
      "agents",
      "main",
      "inbox-store.json"
    );
    const messages = JSON.parse(await readFile(inboxPath, "utf8"));
    messages.push({
      messageId: "stale-interrupt",
      recipientAgentId: "main",
      kind: "human_command",
      eventId: "stale-interrupt-event",
      priority: 200,
      state: "ready",
      payload: { type: "main.interrupt" },
      createdAt: new Date().toISOString()
    });
    await writeFile(inboxPath, JSON.stringify(messages, null, 2));
    await releaseSettlement();

    await waitFor(
      async () => (await f.detail("resident-stale-interrupt")).task.status === "failed",
      "the death to settle",
      60_000
    );
    const settled = JSON.parse(await readFile(inboxPath, "utf8")).find(
      (message) => message.messageId === "stale-interrupt"
    );
    assert.equal(settled.state, "consumed", "the dead turn's interrupt is discarded");
  }
);

test(
  "a recovered Main from the supervisor path is the one the next message reaches",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, {
      handle: ({ response, requests }) => complete(response, `answer ${requests.length}`)
    });
    await f.createTask("resident-supervisor", "Supervisor recovery");
    const run = await f.api("/api/tasks/resident-supervisor/run", { prompt: "SUPERVISOR_FIRST_INPUT" });
    await f.settleTurn("resident-supervisor");
    const original = await f.mainRecord("resident-supervisor");

    // A Main that goes away with work still pending is what the recovery
    // supervisor starts again.
    killMain(original);
    await waitFor(() => !alive(original.pid), "the original Main to exit", 30_000);
    const { spawnMainProcess } = await import("../dist/src/runtime/main-supervisor.js");
    const recovered = await spawnMainProcess({
      taskId: "resident-supervisor",
      runId: run.runId,
      harnessRoot: resolve("."),
      workspaceRoot: f.dashboard.workspaceRoot,
      env: f.dashboard.env
    });
    assert.ok(recovered?.pid, "the supervisor records the process it started");
    assert.notEqual(recovered.pid, original.pid);

    // The next message must reach that process, not start a second Main.
    await f.api("/api/tasks/resident-supervisor/run", { prompt: "SUPERVISOR_SECOND_INPUT" });
    await f.settleTurn("resident-supervisor");
    assert.equal(
      (await f.mainRecord("resident-supervisor")).pid,
      recovered.pid,
      "the message reached the supervisor's Main"
    );
    assert.equal(alive(recovered.pid), true);
    killMain(recovered);
  }
);

test(
  "a dead Main record settles once, however many later runs look at it",
  { timeout: 180_000 },
  async (t) => {
    let heldStarted = false;
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) {
          heldStarted = true;
          response.writeHead(200, { "content-type": "text/event-stream" });
          stream(response, { role: "assistant", content: "PARTIAL_BEFORE_DEAD_RECORD" });
          return;
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-dead-record", "Dead record");
    const run = await f.api("/api/tasks/resident-dead-record/run", { prompt: "DEAD_RECORD_INPUT" });
    await waitFor(() => heldStarted, "the in-flight model request", 60_000);
    const record = await f.mainRecord("resident-dead-record");
    killMain(record);
    await waitFor(
      async () => (await f.detail("resident-dead-record")).task.status === "failed",
      "the death to settle",
      60_000
    );
    const settled = JSON.parse(
      await readFile(
        join(
          f.dashboard.workspaceRoot,
          "resident-dead-record",
          "runs",
          run.runId,
          "agents",
          "main",
          "process.json"
        ),
        "utf8"
      )
    );
    assert.ok(settled.settledAt, "the exit is recorded once the projection is complete");
    assert.equal(settled.exitSignal, "SIGKILL");

    // Later launches consult the same record; none may project the exit again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rejected = await fetch(`${f.dashboard.base}/api/tasks/resident-dead-record/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "x".repeat(520 * 1024) })
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal((await runEvents(f, "resident-dead-record", run.runId, "main.run_failed")).length, 1);
  }
);

test(
  "a message that arrives while paused stays queued and the API reports the paused status",
  { timeout: 180_000 },
  async (t) => {
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    let secondStep = false;
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) return toolCall(response, "bash", { command: "printf PAUSED_MESSAGE" });
        secondStep = true;
        await held;
        return complete(response, `answer ${requests.length}`);
      }
    });
    await f.createTask("resident-paused-message", "Paused message");
    const run = await f.api("/api/tasks/resident-paused-message/run", { prompt: "PAUSED_FIRST_INPUT" });
    await waitFor(() => secondStep, "the second model request", 60_000);
    await f.api("/api/tasks/resident-paused-message/action", { action: "pause" });
    release();
    await waitFor(
      async () => (await f.detail("resident-paused-message")).task.status === "paused",
      "the pause to be recorded",
      60_000
    );
    const queued = await f.api("/api/tasks/resident-paused-message/run", { prompt: "PAUSED_LATE_INPUT" });
    assert.equal(queued.status, "paused", "the reply matches the Task, not a turn that did not start");
    const detail = await f.detail("resident-paused-message");
    assert.equal(detail.task.status, "paused");
    const messages = await f.readInbox("resident-paused-message", run.runId);
    const late = messages.find((message) => message.payload?.message === "PAUSED_LATE_INPUT");
    assert.ok(late, "the message is durable in the Inbox");
    assert.equal(late.state, "ready", "a paused Main leaves it queued");
  }
);

test(
  "a resident Main applies a search-settings change at its next turn, and a turn in flight holds it",
  { timeout: 180_000 },
  async (t) => {
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    let requestSeen;
    const firstRequest = new Promise((done) => {
      requestSeen = done;
    });
    const f = await fixture(t, {
      handle: async ({ response, requests }) => {
        if (requests.length === 1) {
          requestSeen();
          await held;
          return complete(response, "first turn done");
        }
        return complete(response, `answer ${requests.length}`);
      }
    });
    /** The names one recorded model request declares, Main's own table included. */
    const declared = (body) => (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    const saveSearch = async (input) => {
      const response = await fetch(`${f.dashboard.base}/api/web-search-settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });
      const value = await response.json();
      assert.ok(response.ok, `${response.status} ${JSON.stringify(value)}`);
      return value;
    };

    await f.createTask("resident-web-config", "Search configuration between turns");
    await f.api("/api/tasks/resident-web-config/run", { prompt: "WEB_FIRST_INPUT" });
    await firstRequest;
    assert.equal(declared(f.requests[0]).includes("search"), true);
    // A turn that is producing an answer still holds the provider; the resident
    // idle time between turns is not a running task.
    const refused = await fetch(`${f.dashboard.base}/api/web-search-settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "off" })
    });
    assert.equal(refused.status, 400, "a turn in flight holds the search settings");
    assert.match((await refused.json()).error, /停止运行/);
    release();
    await f.settleTurn("resident-web-config");
    const record = await f.mainRecord("resident-web-config");

    // Between turns the process rests: the same user may switch search off...
    assert.equal((await saveSearch({ provider: "off" })).enabled, false);
    await f.api("/api/tasks/resident-web-config/run", { prompt: "WEB_SECOND_INPUT" });
    await f.settleTurn("resident-web-config");
    assert.equal((await f.mainRecord("resident-web-config")).pid, record.pid, "the same resident served it");
    const off = declared(f.requests.at(-1));
    assert.equal(off.includes("search"), false, "search off means the next turn declares no search");
    assert.equal(off.includes("visit"), false);

    // ...and switch it back on, without a new process.
    assert.equal((await saveSearch({ provider: "exa" })).enabled, true);
    await f.api("/api/tasks/resident-web-config/run", { prompt: "WEB_THIRD_INPUT" });
    await f.settleTurn("resident-web-config");
    assert.equal((await f.mainRecord("resident-web-config")).pid, record.pid, "still the first process");
    const on = declared(f.requests.at(-1));
    assert.equal(on.includes("search"), true, "search on restores the tool for the next turn");
    assert.equal(on.includes("visit"), true);
  }
);
