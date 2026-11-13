import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";
import { SubagentQuestionStore } from "../dist/src/runtime/subagent-questions.js";
import { JsonlEventStore } from "../dist/src/storage/event-store.js";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * The durable delivery channel between Main, a running Executor and its peers.
 *
 * Every case runs the real delegated Pi process through the backend that
 * launches it. Main's guidance is produced by the same runtime call Main's
 * `send_subagent_message` tool makes; a question is answered through the same
 * durable record that tool writes; a peer message goes through the sender's
 * real `send_peer_message` tool. What the model actually received is read from
 * the recorded provider requests, not from the extension's own bookkeeping.
 */

const harness = resolve(".");
const MODEL = "p46-message-model";
const TASK_ID = "p46-message-task";
const RUN_ID = "p46-message-run";

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

function gate() {
  let release;
  const opened = new Promise((resolveGate) => {
    release = resolveGate;
  });
  return { opened, release: () => release() };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The recorded request bodies, which are what the model was actually sent. */
function requestsWith(provider, marker) {
  return provider.requests.filter((request) => JSON.stringify(request.messages).includes(marker));
}

function requestText(request) {
  return JSON.stringify(request.messages);
}

async function recordedProcesses(f) {
  const records = [];
  const directory = join(f.runRoot, "agents", "subagents");
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const record = await readJson(join(directory, entry.name, "process.json"), undefined);
    if (record?.pid) records.push(record);
  }
  return records;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "close");
  child.kill("SIGTERM");
  const timeout = new AbortController();
  try {
    await Promise.race([exited, delay(10_000, undefined, { signal: timeout.signal })]);
  } finally {
    timeout.abort();
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await exited;
}

function childEnvironment(f) {
  return isolatedPiEnvironment({
    HOME: f.root,
    TMPDIR: f.root,
    ATRIA_HOME: join(f.root, "home"),
    COWORK_CONFIG: join(f.root, "config.json"),
    COWORK_CONFIG_ROOT: f.root,
    COWORK_HARNESS_ROOT: harness,
    COWORK_WORKSPACE: f.workspace,
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    COWORK_API_BASE: f.provider.baseUrl,
    COWORK_API_KEY: "{{SECRET_p46_message_key}}",
    COWORK_MODEL: MODEL,
    COWORK_MODEL_API: "openai-completions",
    COWORK_REASONING_EFFORT: "off",
    PI_CODING_AGENT_DIR: join(f.root, "pi"),
    PI_OFFLINE: "1"
  });
}

/** A Task/Run workspace, a work site, and one fake provider for its processes. */
async function fixture(t, { handle, env = {} }) {
  const root = await mkdtemp(join(tmpdir(), "p46-subagent-messages-"));
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
      apiKey: "{{SECRET_p46_message_key}}",
      model: MODEL
    })
  );
  const f = { root, workspace, site, runRoot, provider, services: [], children: [], env };
  t.after(async () => {
    for (const service of f.services) service.close();
    for (const child of f.children) await stopChild(child);
    for (const record of await recordedProcesses(f)) {
      if (!record.pid || !groupAlive(record.pid)) continue;
      try {
        process.kill(-record.pid, "SIGKILL");
      } catch {
        /* the process group already exited */
      }
    }
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

function serviceFor(f) {
  const service = new SubagentProcessService({
    workspaceRoot: f.workspace,
    harnessRoot: harness,
    env: { ...childEnvironment(f), ...f.env },
    pollMs: 50,
    leaseMs: 120_000
  });
  f.services.push(service);
  return service;
}

function startBackend(f) {
  const child = spawn(
    process.execPath,
    [
      join(harness, "dist", "src", "cli", "cowork.js"),
      "worker",
      "--task",
      TASK_ID,
      "--run",
      RUN_ID,
      "--poll-ms",
      "100",
      "--lease-ms",
      "120000"
    ],
    {
      cwd: f.root,
      env: { ...childEnvironment(f), ...f.env },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  f.children.push(child);
  return child;
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

async function inboxMessages(f, agentId) {
  return readJson(join(f.runRoot, "agents", "subagents", agentId, "inbox-store.json"), []);
}

async function mainInbox(f) {
  return readJson(join(f.runRoot, "agents", "main", "inbox-store.json"), []);
}

async function waitForCallback(f, callId) {
  return waitFor(async () => {
    const messages = await mainInbox(f);
    const found = messages.find((message) => message.callId === callId && message.kind === "callback");
    return found ?? undefined;
  }, `${callId} callback`);
}

async function runEvents(f) {
  return new JsonlEventStore(join(f.runRoot, "run_events.jsonl")).list(RUN_ID);
}

test(
  "Main's guidance reaches a running Executor once, at its next safe turn",
  { timeout: 120_000 },
  async (t) => {
    const held = gate();
    const f = await fixture(t, {
      handle: (_body, requests) => {
        if (requests.length === 1) {
          // Stay in flight so the message is written while the turn is running.
          return held.opened.then(() => ({ name: "read", arguments: { path: "SITE_MARKER.txt" } }));
        }
        return { text: "EXECUTOR_FINISHED_WITH_GUIDANCE" };
      }
    });
    await queueCall(f, { callId: "call-message-main", agentId: "subagent_1", task: "读取现场标记" });
    startBackend(f);
    await waitFor(() => f.provider.requests.length === 1, "the Executor's first model request");

    // The same runtime call Main's send_subagent_message tool makes.
    const sent = await new CoordinatorRuntime().sendMessage({
      taskId: TASK_ID,
      runId: RUN_ID,
      workspaceRoot: f.workspace,
      callId: "call-message-main",
      message: "MAIN_GUIDANCE_MARKER: keep the existing export name."
    });
    assert.equal(sent.status, "queued");
    // The turn is still in flight, so the running process takes the message
    // now and Pi holds it until the next safe boundary. Releasing after that
    // makes the assertion about ordering, not about who won a race.
    await waitFor(
      async () =>
        (await inboxMessages(f, "subagent_1")).find(
          (message) => message.messageId === sent.messageId && message.state === "leased"
        ),
      "the running Executor to take the guidance"
    );
    held.release();

    await waitFor(
      async () =>
        (await inboxMessages(f, "subagent_1")).find(
          (message) => message.messageId === sent.messageId && message.state === "consumed"
        ),
      "the guidance to be consumed"
    );
    await waitFor(
      () => requestsWith(f.provider, "MAIN_GUIDANCE_MARKER")[0],
      "the guidance in a model request"
    );

    const occurrences = f.provider.requests.filter((request) =>
      requestText(request).includes("MAIN_GUIDANCE_MARKER")
    );
    assert.equal(occurrences.length, 1, "a durable message is read once, not once per turn");
    assert.equal(
      requestText(f.provider.requests[0]).includes("MAIN_GUIDANCE_MARKER"),
      false,
      "the request already in flight when the message was written does not carry it"
    );
    assert.ok(f.provider.requests.length >= 2, "the message was read on a later turn");

    const receipts = (await runEvents(f)).filter(
      (event) => event.type === "inbox.consumed" && event.payload?.messageId === sent.messageId
    );
    assert.equal(receipts.length, 1, "the consumption position is written once");
    assert.equal(receipts[0].agentId, "subagent_1", "the receipt names the process that read it");

    const callback = await waitForCallback(f, "call-message-main");
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    assert.match(callback.payload.response, /EXECUTOR_FINISHED_WITH_GUIDANCE/);
  }
);

test(
  "ask_main reaches Main, its answer returns to the same Executor, and a timeout continues on the assumption",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, {
      env: { COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "1500" },
      handle: (_body, requests) => {
        if (requests.length === 1)
          return {
            name: "ask_main",
            arguments: {
              question: "WHICH_CONFIG_MARKER: which config is authoritative?",
              assumption: "Use configs/default.json"
            }
          };
        if (requests.length === 2)
          return {
            name: "ask_main",
            arguments: {
              question: "MIGRATION_MARKER: should the migration run in this round?",
              assumption: "ASSUMPTION_MARKER: skip the migration this round"
            }
          };
        return { text: "ASK_MAIN_FLOW_DONE" };
      }
    });
    await queueCall(f, { callId: "call-message-ask", agentId: "subagent_2", task: "确认配置来源" });
    startBackend(f);

    const firstQuestion = await waitFor(async () => {
      const messages = await mainInbox(f);
      return messages.find(
        (message) =>
          message.kind === "subagent_question" &&
          String(message.payload?.question).includes("WHICH_CONFIG_MARKER")
      );
    }, "the first question in Main's Inbox");
    assert.equal(firstQuestion.callId, "call-message-ask");
    assert.equal(firstQuestion.payload.assumption, "Use configs/default.json");

    // The same durable answer Main's send_subagent_message writes for a question.
    const store = new SubagentQuestionStore(f.workspace);
    await store.answer(
      TASK_ID,
      firstQuestion.payload.questionId,
      "ANSWER_MARKER: configs/eval.py is authoritative"
    );

    const secondQuestion = await waitFor(async () => {
      const messages = await mainInbox(f);
      return messages.find(
        (message) =>
          message.kind === "subagent_question" &&
          String(message.payload?.question).includes("MIGRATION_MARKER")
      );
    }, "the second question in Main's Inbox");
    // It is deliberately left unanswered: the wait must expire and continue.
    assert.notEqual(secondQuestion.payload.questionId, firstQuestion.payload.questionId);

    const callback = await waitForCallback(f, "call-message-ask");
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    assert.match(callback.payload.response, /ASK_MAIN_FLOW_DONE/);

    const afterAnswer = f.provider.requests[1];
    assert.match(requestText(afterAnswer), /ANSWER_MARKER/, "Main's answer is the tool result it waits for");
    const afterTimeout = f.provider.requests[2];
    assert.match(
      requestText(afterTimeout),
      /ASSUMPTION_MARKER/,
      "an unanswered question continues on the declared assumption"
    );

    assert.equal((await store.read(TASK_ID, firstQuestion.payload.questionId)).status, "answered");
    assert.equal((await store.read(TASK_ID, secondQuestion.payload.questionId)).status, "expired");
  }
);

test(
  "a peer message written while the backend is down is delivered after it restarts",
  { timeout: 120_000 },
  async (t) => {
    const senderHeld = gate();
    const receiverHeld = gate();
    const f = await fixture(t, {
      handle: (_body, requests) => {
        const text = JSON.stringify(_body.messages);
        if (text.includes("SENDER_TASK_MARKER")) {
          const turns = requests.filter((request) => requestText(request).includes("SENDER_TASK_MARKER"));
          if (turns.length === 1) {
            return senderHeld.opened.then(() => ({
              name: "send_peer_message",
              arguments: {
                targetCallId: "call-message-receiver",
                message: "PEER_MARKER: the new column is nullable."
              }
            }));
          }
          return { text: "SENDER_DONE" };
        }
        const turns = requests.filter((request) => requestText(request).includes("RECEIVER_TASK_MARKER"));
        if (turns.length === 1) return receiverHeld.opened.then(() => ({ text: "RECEIVER_DONE" }));
        return { text: "RECEIVER_DONE" };
      }
    });
    await queueCall(f, {
      callId: "call-message-sender",
      agentId: "subagent_3",
      task: "SENDER_TASK_MARKER: tell the peer about the column"
    });
    await queueCall(f, {
      callId: "call-message-receiver",
      agentId: "subagent_4",
      task: "RECEIVER_TASK_MARKER: wait for the peer's finding"
    });
    const firstBackend = startBackend(f);
    await waitFor(
      () =>
        requestsWith(f.provider, "SENDER_TASK_MARKER").length === 1 &&
        requestsWith(f.provider, "RECEIVER_TASK_MARKER").length === 1,
      "both delegated processes' first requests"
    );
    const peerTool = f.provider.requests[0].tools.find(
      (tool) => (tool.function?.name ?? tool.name) === "send_peer_message"
    );
    assert.deepEqual(
      peerTool.function.parameters.required,
      ["targetCallId", "message"],
      "priority is optional guidance, not part of what the model must send"
    );

    // Stop the backend the way an upgrade would: the agent processes outlive it.
    await stopChild(firstBackend);
    const records = await recordedProcesses(f);
    const sender = records.find((record) => record.callId === "call-message-sender");
    const receiver = records.find((record) => record.callId === "call-message-receiver");
    assert.ok(sender?.pid && receiver?.pid, "both processes have durable launch records");
    assert.equal(alive(sender.pid), true, "the sender outlives the backend");
    assert.equal(alive(receiver.pid), true, "the receiver outlives the backend");

    // The running sender writes the peer message while no backend exists.
    senderHeld.release();
    const peerMessage = await waitFor(async () => {
      const messages = await inboxMessages(f, "subagent_4");
      return messages.find(
        (message) =>
          message.kind === "peer_message" && String(message.payload?.message).includes("PEER_MARKER")
      );
    }, "the peer message in the receiver's Inbox");
    assert.equal(peerMessage.callId, "call-message-receiver");
    assert.equal(peerMessage.payload.senderAgentId, "subagent_3");
    assert.equal(peerMessage.payload.senderCallId, "call-message-sender");
    assert.equal(
      (await mainInbox(f)).filter(
        (message) => message.kind === "callback" && message.callId === "call-message-sender"
      ).length,
      0,
      "no backend is running to report the sender's exit"
    );

    // The sender finishes while the backend is down; its result record is durable.
    await waitFor(
      async () =>
        (await readJson(join(f.runRoot, "agents", "subagents", "subagent_3", "result.json"), undefined))
          ?.termination === "completed",
      "the sender's result record"
    );

    startBackend(f);
    const senderCallback = await waitForCallback(f, "call-message-sender");
    assert.equal(senderCallback.payload.status, "succeeded", JSON.stringify(senderCallback.payload));

    receiverHeld.release();
    const afterRestart = await waitFor(
      () => requestsWith(f.provider, "PEER_MARKER")[0],
      "the peer message in the receiver's next request"
    );
    assert.equal(
      requestsWith(f.provider, "PEER_MARKER").length,
      1,
      "the peer message is read once, including across the restart"
    );
    assert.ok(requestText(afterRestart).includes("the new column is nullable."));

    await waitFor(
      async () =>
        (await inboxMessages(f, "subagent_4")).find(
          (message) => message.messageId === peerMessage.messageId && message.state === "consumed"
        ),
      "the receiver to consume the peer message"
    );
    const receiverCallback = await waitForCallback(f, "call-message-receiver");
    assert.equal(receiverCallback.payload.status, "succeeded", JSON.stringify(receiverCallback.payload));
    assert.match(receiverCallback.payload.response, /RECEIVER_DONE/);
    const queued = (await runEvents(f)).filter((event) => event.type === "peer_message.queued");
    assert.equal(queued.length, 1, "the peer message is recorded once when it is queued");
  }
);

test(
  "cancelling a Subagent blocked on Main stops its process and reports a cancelled callback",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t, {
      env: { COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "600000" },
      handle: () => ({
        name: "ask_main",
        arguments: {
          question: "CANCEL_QUESTION_MARKER: proceed with the wide refactor?",
          assumption: "Keep the narrow change"
        }
      })
    });
    await queueCall(f, { callId: "call-message-cancel", agentId: "subagent_5", task: "等待 Main 的答复" });
    const service = serviceFor(f);
    await service.startQueued({ taskId: TASK_ID, runId: RUN_ID });

    // The question reaching Main is the observable proof that the process is
    // blocked inside ask_main rather than still starting up.
    await waitFor(async () => {
      const messages = await mainInbox(f);
      return messages.find(
        (message) =>
          message.kind === "subagent_question" &&
          String(message.payload?.question).includes("CANCEL_QUESTION_MARKER")
      );
    }, "the question in Main's Inbox");
    const record = (await recordedProcesses(f)).find((entry) => entry.callId === "call-message-cancel");
    assert.ok(record?.pid, "the delegated process was launched");
    assert.equal(groupAlive(record.pid), true);
    const requestsBefore = f.provider.requests.length;

    const stopped = await service.stop({
      taskId: TASK_ID,
      runId: RUN_ID,
      callId: "call-message-cancel"
    });
    assert.equal(stopped?.status, "cancelled", JSON.stringify(stopped));

    await waitFor(() => !alive(record.pid), "the cancelled process to exit");
    assert.equal(groupAlive(record.pid), false, "the whole process group is stopped");

    const callback = await waitForCallback(f, "call-message-cancel");
    assert.equal(callback.payload.status, "cancelled", JSON.stringify(callback.payload));
    await waitFor(
      async () =>
        (await readJson(join(f.runRoot, "queue.json"), [])).find(
          (item) => item.stepId === "call-message-cancel"
        )?.status === "cancelled",
      "the cancelled call to settle in the queue"
    );
    assert.equal(
      (await mainInbox(f)).filter(
        (message) => message.callId === "call-message-cancel" && message.kind === "callback"
      ).length,
      1,
      "cancellation reports exactly one callback"
    );
    await delay(200);
    assert.equal(
      f.provider.requests.length,
      requestsBefore,
      "a stopped process makes no further model request"
    );
  }
);
