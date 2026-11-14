import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DurableScheduler, InboxStore } from "../dist/src/runtime/scheduler.js";
import { readHeartbeat } from "../dist/src/runtime/main-heartbeat.js";
import { readSleep } from "../dist/src/runtime/main-sleep.js";
import { spawnMainProcess } from "../dist/src/runtime/main-supervisor.js";
import { enqueueMainCallback } from "../dist/src/runtime/subagent-callback.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";
import { SubagentQuestionStore } from "../dist/src/runtime/subagent-questions.js";
import { JsonlEventStore } from "../dist/src/storage/event-store.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * Waking an idle process when OS file events cannot be trusted.
 *
 * The two idle waits this Run depends on are a resident Main between turns and
 * a Subagent blocked in `ask_main`. Both used to be woken only by a directory
 * watch, and a host whose FSEvents daemon is saturated can deliver that event
 * late, coalesced or never. Every case here runs the real processes against a
 * local provider with `COWORK_DISABLE_FILE_WATCH=1`, so the watch never
 * attaches: whatever reaches the process came from the writer's own wake
 * notification, re-read from the durable record.
 */

const harness = resolve(".");
const MODEL = "p46-idle-wake-model";
const TASK_ID = "p46-idle-wake-task";
const RUN_ID = "p46-idle-wake-run";
/** The note a model message carries, whether it is a system, user or tool turn. */
const requestText = (request) => JSON.stringify(request.messages);

async function waitFor(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
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

/** End one launched process group and wait until the OS has released it. */
async function stopGroup(pid) {
  if (!pid || !groupAlive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (groupAlive(pid) && Date.now() < deadline) await delay(25);
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Whether one endpoint currently accepts a local connection. */
function endpointAccepts(endpoint) {
  return new Promise((accepts) => {
    const socket = connect(endpoint);
    const settle = (value) => {
      socket.destroy();
      accepts(value);
    };
    socket.setTimeout(500, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * Wait for a launched process to be listening.
 *
 * A process that has not bound yet would miss the notification, and this test
 * is about the notification, not about that startup window — the durable Inbox
 * covers it.
 */
async function waitForEndpoint(endpoint, label) {
  assert.equal(typeof endpoint, "string", `${label} records a wake endpoint`);
  assert.notEqual(endpoint, "", `${label} records a wake endpoint`);
  await waitFor(() => endpointAccepts(endpoint), `${label} to accept wake notifications`, 60_000);
  return endpoint;
}

/** One Task/Run workspace and the recording provider its processes use. */
async function fixture(t, { handle, env = {} }) {
  const root = await mkdtemp(join(tmpdir(), "p46-idle-wake-"));
  const workspace = join(root, "workspace");
  const site = join(root, "work-site");
  await mkdir(workspace, { recursive: true });
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "SITE_MARKER.txt"), "the delegated site\n");
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  const provider = await startLocalProvider({ model: MODEL, handle });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: "{{SECRET_p46_idle_wake_key}}",
      model: MODEL
    })
  );
  const store = new LocalWorkspaceStore(workspace);
  await store.createTask(TASK_ID, { projectDirectory: site });
  await store.createRun(TASK_ID, RUN_ID);
  const childEnvironment = isolatedPiEnvironment({
    HOME: root,
    TMPDIR: root,
    ATRIA_HOME: join(root, "home"),
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_CONFIG_ROOT: root,
    COWORK_HARNESS_ROOT: harness,
    COWORK_WORKSPACE: workspace,
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    // The seam this file exists for: no OS directory event can wake anything.
    COWORK_DISABLE_FILE_WATCH: "1",
    COWORK_API_BASE: provider.baseUrl,
    COWORK_API_KEY: "{{SECRET_p46_idle_wake_key}}",
    COWORK_MODEL: MODEL,
    COWORK_MODEL_API: "openai-completions",
    COWORK_REASONING_EFFORT: "off",
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1",
    ...env
  });
  const f = { root, workspace, site, runRoot, provider, services: [], records: [], env: childEnvironment };
  t.after(async () => {
    for (const service of f.services) service.close();
    const launched = [...f.records];
    for (const entry of await readdir(join(runRoot, "agents", "subagents")).catch(() => []))
      launched.push(await readJson(join(runRoot, "agents", "subagents", entry, "process.json"), undefined));
    for (const record of launched) {
      if (!record?.pid || record.host !== hostname()) continue;
      await stopGroup(record.pid);
    }
    await provider.close();
    // A stopped process group can still be flushing its last records; retry the
    // directory removal instead of racing it with an assertion-free unlink.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return f;
}

async function queueCall(f, { callId, agentId, task, role = "executor" }) {
  await new DurableScheduler(join(f.runRoot, "queue.json")).enqueue({
    stepId: callId,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentId,
    importance: "normal",
    payload: { task, projectDirectory: f.site, delegation: { role } },
    maxAttempts: 1
  });
}

/** The durable Inbox of one agent, addressed by its directory inside the Run. */
async function agentInbox(f, ...directory) {
  return readJson(join(f.runRoot, "agents", ...directory, "inbox-store.json"), []);
}

test(
  "an idle resident Main reads a callback and a user message with OS file events suppressed",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, {
      handle: (_body, requests) => {
        if (requests.length === 1)
          return {
            name: "sleep_until",
            arguments: {
              reason: "PARK_MARKER: wait for the delegated result to arrive",
              wakeInSeconds: 3600
            }
          };
        return { text: `MAIN_ANSWER_${requests.length}` };
      }
    });
    const main = await spawnMainProcess({
      taskId: TASK_ID,
      runId: RUN_ID,
      harnessRoot: harness,
      workspaceRoot: f.workspace,
      env: f.env
    });
    assert.ok(main?.pid, "the supervisor records the Main it started");
    f.records.push(main);
    const endpoint = await waitForEndpoint(main.wakeEndpoint, "the resident Main");

    const inbox = new InboxStore(join(f.runRoot, "agents", "main", "inbox-store.json"));
    /** The Main process that serves this Run, read from its turn record. */
    const heartbeat = () => readHeartbeat(f.workspace, TASK_ID);
    /** Wait until no turn is running, so what is written next finds it idle. */
    const idleAfter = async (turnId, label) =>
      waitFor(async () => {
        const beat = await heartbeat();
        return beat?.turnId !== turnId && beat.turnActive === false ? beat : undefined;
      }, label);
    const userMessage = (messageId, marker, text) =>
      inbox.enqueue({
        messageId,
        recipientAgentId: "main",
        kind: "human_command",
        eventId: `${messageId}-event`,
        priority: 10,
        state: "ready",
        payload: { type: "human.message", message: `${marker}: ${text}` },
        createdAt: new Date().toISOString()
      });

    // Open the Run. This first message may also be caught by the startup Inbox
    // read, so it only puts Main into its parked, resident state; the wakes
    // below are the ones this test holds the process to.
    await userMessage("idle-wake-kickoff", "IDLE_WAKE_KICKOFF_MARKER", "start with this.");
    const running = await waitFor(async () => {
      const beat = await heartbeat();
      return beat?.turnActive === true ? beat : undefined;
    }, "the turn opened by the kickoff message");
    // The turn has to be over before the callback is written: this is the idle
    // wait the ticket is about. Main parked the Task for a later wake and the
    // process stayed resident. The heartbeat names the Pi process that serves
    // the Run, which outlives its turn.
    const idle = await waitFor(async () => {
      const beat = await heartbeat();
      return beat?.pid === running.pid && beat.turnActive === false ? beat : undefined;
    }, "the Main turn to settle into an idle process");
    assert.equal(alive(main.pid), true, "the idle Main process stays alive");

    // A delegated call finishes and the backend queues its callback. The
    // callback is what a lost directory event used to leave unread.
    const queued = await enqueueMainCallback({
      workspaceRoot: f.workspace,
      taskId: TASK_ID,
      runId: RUN_ID,
      callId: "call-idle-wake",
      agentId: "subagent_1",
      status: "succeeded",
      response: "IDLE_WAKE_CALLBACK_MARKER: the delegated work is done.",
      outputFiles: [],
      diagnostics: {
        tracePath: "agents/subagents/subagent_1",
        resultPath: "agents/subagents/subagent_1/result.json"
      }
    });
    assert.equal(queued.queued, true);

    await waitFor(
      () => f.provider.requests.find((request) => requestText(request).includes("IDLE_WAKE_CALLBACK_MARKER")),
      "the callback to reach the idle Main"
    );
    const read = await waitFor(
      async () =>
        (await agentInbox(f, "main")).find(
          (message) => message.messageId === queued.messageId && message.state === "consumed"
        ),
      "the callback to be read"
    );
    assert.equal(read.kind, "callback");
    assert.equal(await readSleep(f.workspace, TASK_ID), undefined, "the wake cleared the parked Task");
    const receipts = (await new JsonlEventStore(join(f.runRoot, "run_events.jsonl")).list(RUN_ID)).filter(
      (event) => event.type === "callback.consumed" && event.payload?.messageId === queued.messageId
    );
    assert.equal(receipts.length, 1, "the callback is recorded as consumed once");
    assert.equal(alive(main.pid), true, "the same Main process served the callback");
    const afterCallback = await idleAfter(idle.turnId, "the callback turn to settle in the same process");
    assert.equal(afterCallback.pid, running.pid, "the callback turn ran in the process that was idle");

    // The other wake the idle process waits for: a message from the person,
    // written into the same Inbox while no turn is running.
    await userMessage("idle-wake-followup", "IDLE_WAKE_FOLLOWUP_MARKER", "also update the README.");
    await waitFor(
      () => f.provider.requests.find((request) => requestText(request).includes("IDLE_WAKE_FOLLOWUP_MARKER")),
      "the follow-up message to reach the idle Main"
    );
    await waitFor(
      async () =>
        (await agentInbox(f, "main")).find(
          (message) => message.messageId === "idle-wake-followup" && message.state === "consumed"
        ),
      "the follow-up message to be read"
    );
    const afterFollowUp = await idleAfter(afterCallback.turnId, "the follow-up turn to settle");
    assert.equal(afterFollowUp.pid, running.pid, "the follow-up also ran in the resident process");
  }
);

test(
  "a Subagent blocked in ask_main reads Main's answer with OS file events suppressed",
  { timeout: 180_000 },
  async (t) => {
    let answeredAt = 0;
    const f = await fixture(t, {
      handle: (_body, requests) => {
        if (requests.length === 1)
          return {
            name: "ask_main",
            arguments: {
              question: "BLOCKED_QUESTION_MARKER: which config is authoritative?",
              assumption: "ASSUMPTION_MARKER: use configs/default.json"
            }
          };
        assert.match(
          requestText(requests.at(-1)),
          /IDLE_WAKE_ANSWER_MARKER: configs\/eval\.py is authoritative/,
          "the blocked tool returns Main's answer"
        );
        assert.ok(
          Date.now() - answeredAt < 60_000,
          "the answer reached the blocked process, not the wait's deadline"
        );
        return { text: "ASK_MAIN_WAKE_DONE" };
      }
    });
    const service = new SubagentProcessService({
      workspaceRoot: f.workspace,
      harnessRoot: harness,
      env: f.env,
      pollMs: 50,
      leaseMs: 120_000
    });
    f.services.push(service);
    await queueCall(f, { callId: "call-idle-ask", agentId: "subagent_2", task: "block on Main's answer" });
    await service.startQueued({ taskId: TASK_ID, runId: RUN_ID });

    const question = await waitFor(async () => {
      const pending = await new SubagentQuestionStore(f.workspace).list(TASK_ID, "pending");
      return pending.find((candidate) => candidate.callId === "call-idle-ask");
    }, "the blocked question");
    const record = await readJson(join(f.runRoot, "agents", "subagents", "subagent_2", "process.json"));
    assert.ok(record?.pid, "the delegated process has a launch record");
    await waitForEndpoint(record.wakeEndpoint, "the blocked Subagent");

    // The same durable write Main's send_subagent_message performs for an
    // answer; with the file watch suppressed only the notification can end the
    // wait before its deadline.
    answeredAt = Date.now();
    await new SubagentQuestionStore(f.workspace).answer(
      TASK_ID,
      question.questionId,
      "IDLE_WAKE_ANSWER_MARKER: configs/eval.py is authoritative"
    );

    const result = await waitFor(
      () => readJson(join(f.runRoot, "agents", "subagents", "subagent_2", "result.json"), undefined),
      "the delegated result record"
    );
    assert.equal(result.termination, "completed");
    assert.match(result.response, /ASK_MAIN_WAKE_DONE/);
    assert.equal(
      (await new SubagentQuestionStore(f.workspace).read(TASK_ID, question.questionId)).status,
      "answered"
    );
    assert.ok(
      requestText(f.provider.requests.at(-1)).includes("IDLE_WAKE_ANSWER_MARKER"),
      "the model saw the answer as the tool result"
    );
    assert.equal(answeredAt > 0, true);
  }
);
