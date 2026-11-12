import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { coworkProviderId } from "../dist/src/runtime/model-profile.js";

/**
 * A Main session written by one Pi runtime must stay usable after switching
 * between 0.87.1 and 1.5.x. Both directions run the real Pi CLI with the real
 * CoworkOS Main extension against a recorded local provider, so the session file
 * is written by Pi itself and the model request is inspected at the provider
 * seam. 0.87.1 is installed from the local npm cache into a temporary directory;
 * the project dependencies stay on 1.5.x.
 */

const OLD_PI_VERSION = "0.87.1";
const repositoryRoot = resolve(".");
const currentPiVersion = JSON.parse(
  await readFile(
    new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
    "utf8"
  )
).version;
const PROMPT = "你好！";
const FOLLOW_UP = "继续";
const FIXTURE_TEXT = "session compatibility fixture\n";
const MODEL = "p46-session-compat";

const oldPiRoots = [];
after(async () => {
  for (const root of oldPiRoots) await rm(root, { recursive: true, force: true });
});

async function runProcess(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("error", (error) => resolveRun({ code: null, output: `${output}\n${error.message}` }));
    child.once("close", (code) => resolveRun({ code, output }));
  });
}

let oldPiPromise;
function installOldPi() {
  oldPiPromise ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), "p46-session-compat-old-pi-"));
    oldPiRoots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "p46-session-compat-old-pi", private: true })
    );
    const installed = await runProcess(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--no-save",
        `@earendil-works/pi-coding-agent@${OLD_PI_VERSION}`
      ],
      { cwd: root }
    );
    if (installed.code !== 0)
      return {
        ok: false,
        reason: `Pi ${OLD_PI_VERSION} could not be installed from the local npm cache: ${installed.output.slice(-500)}`
      };
    const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const version = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
    if (version !== OLD_PI_VERSION)
      return {
        ok: false,
        reason: `the local npm cache resolved @earendil-works/pi-coding-agent to ${version}, not ${OLD_PI_VERSION}`
      };
    return { ok: true, entry: join(packageDir, "dist", "bundle", "cli.js") };
  })();
  return oldPiPromise;
}

/** A recorded provider, a user data root and the session directory one Pi process writes into. */
async function sessionHarness(t) {
  const root = await mkdtemp(join(tmpdir(), "p46-session-compat-"));
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  await mkdir(join(root, "profile"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(join(workspace, "fixture.txt"), FIXTURE_TEXT);

  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: MODEL }] }));
    }
    requests.push(JSON.parse(await readFixtureRequestBody(request)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    // Every write turn calls the read tool first so the session contains a tool
    // call and its result; the following request answers with plain text.
    response.end(
      protocolStream(
        "openai-completions",
        requests.length % 2 === 1
          ? { name: "read", arguments: { path: "fixture.txt" } }
          : { text: `reply ${requests.length}` }
      )
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    await rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  return {
    root,
    workspace,
    sessions,
    requests,
    baseUrl,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(?:COWORK_|PI_|ATRIA_|OPENAI_|ANTHROPIC_|NODE_OPTIONS)/.test(key)
        )
      ),
      HOME: root,
      TMPDIR: root,
      ATRIA_HOME: join(root, "home"),
      COWORK_WORKSPACE: workspace,
      COWORK_TASK_ID: "session-compat-task",
      COWORK_RUN_ID: "session-compat-run",
      COWORK_DISABLE_MAIN_GUARDIAN: "1",
      COWORK_API_BASE: baseUrl,
      COWORK_API_KEY: "fixture-key",
      COWORK_MODEL: MODEL,
      COWORK_MODEL_API: "openai-completions",
      COWORK_REASONING_EFFORT: "off",
      PI_CODING_AGENT_DIR: join(root, "profile"),
      PI_OFFLINE: "1"
    }
  };
}

/** One real Pi RPC process, driven through its documented protocol. */
function spawnPi(fixture, { bundleEntry, session }) {
  const args = [
    bundleEntry,
    "--mode",
    "rpc",
    "--thinking",
    "off",
    "--no-approve",
    "--no-skills",
    "--no-context-files",
    "--extension",
    join(repositoryRoot, ".pi", "extensions", "cowork.ts"),
    "--provider",
    coworkProviderId(fixture.baseUrl, ""),
    "--model",
    MODEL,
    "--append-system-prompt",
    join(repositoryRoot, ".pi", "prompts", "cowork-main.md"),
    "--session-dir",
    fixture.sessions,
    ...(session ? ["--session", session] : [])
  ];
  const child = spawn(process.execPath, args, {
    cwd: fixture.workspace,
    env: fixture.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events = [];
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(value);
      const request = value.type === "response" ? pending.get(value.id) : undefined;
      if (!request) continue;
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.success) request.resolve(value.data);
      else request.reject(new Error(JSON.stringify(value)));
    }
  });
  const send = (type, values = {}) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = `p46-session-${events.length}-${pending.size}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`RPC ${type} timed out: ${stderr}`));
      }, 30_000);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...values })}\n`);
    });
  const waitFor = async (predicate, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await delay(25);
    }
    throw new Error(`missing RPC event: ${stderr}`);
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(timer);
  };
  return { events, send, waitFor, stop, getStderr: () => stderr };
}

/** Send one prompt and return the model requests it produced. */
async function runTurn(harness, { bundleEntry, session, prompt }) {
  const before = harness.requests.length;
  const pi = spawnPi(harness, { bundleEntry, session });
  try {
    await pi.send("get_state");
    await pi.send("prompt", { message: prompt });
    await pi.waitFor((event) => event.type === "agent_settled");
    await delay(300);
    assert.equal(pi.events.filter((event) => event.type === "error").length, 0, pi.getStderr());
    assert.equal(pi.getStderr().includes("Error:"), false, pi.getStderr());
    return harness.requests.slice(before);
  } finally {
    await pi.stop();
  }
}

async function sessionFiles(directory) {
  const entries = await readdir(directory, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(directory, entry))
    .sort();
}

async function readSession(file) {
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim());
  return lines.map((line) => JSON.parse(line));
}

function messageText(content) {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function systemText(request) {
  const system = request.messages.find((message) => message.role === "system");
  return messageText(system?.content ?? "");
}

/** The complete model-visible transcript the continuation request replayed. */
function replayedHistory(request) {
  const messages = request.messages;
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? (message.tool_calls ?? []) : []
  );
  const results = messages
    .filter((message) => message.role === "tool")
    .map((message) => ({ id: message.tool_call_id, text: messageText(message.content) }));
  return {
    roles: messages.map((message) => message.role),
    userTexts: messages
      .filter((message) => message.role === "user")
      .map((message) => messageText(message.content)),
    calls: calls.map((call) => ({ id: call.id, name: call.function.name })),
    results
  };
}

function assertHistorySurvived(request, { label }) {
  const history = replayedHistory(request);
  assert.deepEqual(
    history.roles,
    ["system", "user", "assistant", "tool", "assistant", "user"],
    `${label}: the model sees the whole earlier turn in order`
  );
  assert.deepEqual(history.userTexts, [PROMPT, FOLLOW_UP], `${label}: both user messages survive`);
  assert.deepEqual(
    history.calls,
    [{ id: "call_protocol", name: "read" }],
    `${label}: the earlier tool call survives`
  );
  assert.deepEqual(
    history.results,
    [{ id: "call_protocol", text: FIXTURE_TEXT }],
    `${label}: the tool result is paired with that call and keeps its content`
  );
  assert.match(
    systemText(request),
    /<current_workspace>/,
    `${label}: Main's system prompt injection is present`
  );
}

/** A session file this run wrote must contain a tool call, its result and the injection. */
function assertSessionContents(entries, { label }) {
  const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  const call = messages.find(
    (message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall")
  );
  const result = messages.find((message) => message.role === "toolResult");
  assert.ok(call, `${label}: the session records the tool call`);
  assert.ok(result, `${label}: the session records the tool result`);
  assert.equal(
    result.toolCallId,
    call.content.find((block) => block.type === "toolCall").id,
    `${label}: the stored tool result is paired with its call`
  );
  assert.ok(
    messages.some(
      (message) =>
        message.role === "system" &&
        JSON.stringify([message.content, message.sections]).includes("<current_workspace>")
    ),
    `${label}: the session records Main's system prompt injection`
  );
}

test(
  "a Main session written by Pi 0.87.1 continues under 1.5.x with its tool history intact",
  { timeout: 180_000 },
  async (t) => {
    const oldPi = await installOldPi();
    if (!oldPi.ok) {
      t.skip(oldPi.reason);
      return;
    }
    assert.match(
      currentPiVersion,
      /^1\.5\./,
      "the current runtime is the version the rollback target is measured against"
    );
    const h = await sessionHarness(t);
    const currentEntry = join(
      repositoryRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js"
    );

    const writeRequests = await runTurn(h, { bundleEntry: oldPi.entry, prompt: PROMPT });
    assert.equal(writeRequests.length, 2, "0.87.1 answered the tool call in a second request");
    assert.match(systemText(writeRequests[0]), /<current_workspace>/, "0.87.1 ran the real Main extension");
    const [oldSession] = await sessionFiles(h.sessions);
    assert.ok(oldSession, "0.87.1 wrote a session file");
    const written = await readSession(oldSession);
    assertSessionContents(written, { label: "0.87.1 session" });
    const sessionId = written.find((entry) => entry.type === "session").id;

    const [continuation] = await runTurn(h, {
      bundleEntry: currentEntry,
      session: oldSession,
      prompt: FOLLOW_UP
    });
    assertHistorySurvived(continuation, { label: "1.5.x reading 0.87.1" });

    const continued = await readSession(oldSession);
    assert.equal(
      continued.find((entry) => entry.type === "session").id,
      sessionId,
      "1.5.x continued the same session file instead of starting another"
    );
    assert.ok(continued.length > written.length, "the continuation appended to that file");
    const appended = continued.slice(written.length).filter((entry) => entry.type === "message");
    assert.ok(
      appended.some(
        (entry) => entry.message.role === "user" && messageText(entry.message.content) === FOLLOW_UP
      ),
      "the follow-up user message was stored"
    );
  }
);

test(
  "a Main session written by 1.5.x is read back by Pi 0.87.1 and continues",
  { timeout: 180_000 },
  async (t) => {
    const oldPi = await installOldPi();
    if (!oldPi.ok) {
      t.skip(oldPi.reason);
      return;
    }
    assert.match(
      currentPiVersion,
      /^1\.5\./,
      "the current runtime is the version the rollback target is measured against"
    );
    const h = await sessionHarness(t);
    const currentEntry = join(
      repositoryRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js"
    );

    const writeRequests = await runTurn(h, { bundleEntry: currentEntry, prompt: PROMPT });
    assert.equal(writeRequests.length, 2, "1.5.x answered the tool call in a second request");
    assert.match(systemText(writeRequests[0]), /<current_workspace>/, "1.5.x ran the real Main extension");
    const [newSession] = await sessionFiles(h.sessions);
    assert.ok(newSession, "1.5.x wrote a session file");
    const written = await readSession(newSession);
    assertSessionContents(written, { label: "1.5.x session" });
    const sessionId = written.find((entry) => entry.type === "session").id;

    // The measured result: 0.87.1 reads the newer file and continues it.
    const [continuation] = await runTurn(h, {
      bundleEntry: oldPi.entry,
      session: newSession,
      prompt: FOLLOW_UP
    });
    assertHistorySurvived(continuation, { label: "0.87.1 reading 1.5.x" });

    const continued = await readSession(newSession);
    assert.equal(
      continued.find((entry) => entry.type === "session").id,
      sessionId,
      "0.87.1 continued the same session file instead of starting another"
    );
    assert.ok(continued.length > written.length, "the rollback runtime appended to that file");
  }
);
