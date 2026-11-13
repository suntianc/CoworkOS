import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { captureStandardMainRun, summarizeRequest } from "./p46-pi-upgrade-capture.mjs";
import { InboxStore } from "../dist/src/runtime/scheduler.js";

const baseline = JSON.parse(
  await readFile(new URL("./fixtures/p46-pi-upgrade-baseline.json", import.meta.url), "utf8")
);
const harness = resolve(".");

/**
 * Differences the 1.5.x upgrade is allowed to make against the recorded
 * pre-upgrade baseline. Every entry names the exact path, the change and why it
 * is the upstream fix rather than a CoworkOS behavior change. Any other
 * difference fails the comparison.
 */
const EXPECTED_BASELINE_DIFFERENCES = [
  {
    path: "tools.grep.parameters.properties.glob.description",
    change:
      "\"Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'\" -> \"Filter files by glob pattern, relative to path, e.g. … A pattern without '/' matches file names at any depth\"",
    reason:
      "Pi 1.5.2 rewords the built-in grep tool's glob option. The option name, type, required list and JSON Schema shape are unchanged."
  }
];

const TOOL_DIFFERENCE_PATHS = EXPECTED_BASELINE_DIFFERENCES.map((entry) => entry.path);

function diffPaths(expected, actual, prefix = "") {
  if (Object.is(expected, actual)) return [];
  const bothObjects = expected && actual && typeof expected === "object" && typeof actual === "object";
  if (!bothObjects || Array.isArray(expected) !== Array.isArray(actual)) return [prefix];
  if (Array.isArray(expected)) {
    const paths = [];
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1)
      paths.push(...diffPaths(expected[index], actual[index], `${prefix}[${index}]`));
    return paths;
  }
  const paths = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (!(key in expected) || !(key in actual)) paths.push(keyPath);
    else paths.push(...diffPaths(expected[key], actual[key], keyPath));
  }
  return paths;
}

test(
  "a standard Main run keeps the pre-upgrade tool table, prompt structure and request envelope",
  { timeout: 90_000 },
  async (t) => {
    const cleanup = [];
    t.after(async () => {
      for (const step of cleanup) await step();
    });
    const current = summarizeRequest(await captureStandardMainRun({ cleanup }));

    assert.equal(current.path, baseline.path, "the provider endpoint is unchanged");
    assert.deepEqual(current.envelope, baseline.envelope, "request envelope and message roles");

    const currentNames = current.tools.map((tool) => tool.name);
    assert.deepEqual(
      currentNames,
      baseline.tools.map((tool) => tool.name),
      "Main offers the same tools in the same order"
    );
    const toolDifferences = [];
    for (const [index, tool] of baseline.tools.entries()) {
      for (const path of diffPaths(tool.parameters, current.tools[index].parameters))
        toolDifferences.push(`tools.${tool.name}.parameters.${path}`);
    }
    assert.deepEqual(
      toolDifferences,
      TOOL_DIFFERENCE_PATHS,
      `unexpected tool schema differences; review each one against the upgrade notes:\n${JSON.stringify(
        EXPECTED_BASELINE_DIFFERENCES,
        null,
        2
      )}`
    );

    assert.deepEqual(
      current.systemPrompt.structure,
      baseline.systemPrompt.structure,
      "the rendered system prompt keeps the same sections in the same order"
    );
    assert.ok(
      !current.systemPrompt.structure.includes("<docs>"),
      "Main still projects away the SDK's own documentation pointer"
    );
  }
);

async function mainRunFixture(t, { runId, inbox }) {
  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "p46-startup-model" }] }));
    }
    requests.push(JSON.parse(await readFixtureRequestBody(request)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream("openai-completions", { text: "启动完成。" }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${provider.address().port}`,
    model: "p46-startup-model"
  });
  t.after(async () => {
    await dashboard.stop();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  await writeFile(
    join(dashboard.root, "config.json"),
    JSON.stringify({ api: "openai-completions", mainMaxTokens: 64 })
  );
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(
    join(dashboard.root, "pi", "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
  );
  await fetch(`${dashboard.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "startup-task", goal: "你好！" })
  });
  // The Dashboard accepts the Run id, so the fixture can put a callback in the
  // Inbox the real Main process will open during startup.
  await inbox(
    new InboxStore(
      join(dashboard.workspaceRoot, "startup-task", "runs", runId, "agents", "main", "inbox-store.json")
    )
  );
  const started = await fetch(`${dashboard.base}/api/tasks/startup-task/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "你好！", runId })
  });
  assert.equal(started.status, 202);
  let detail;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    detail = await (await fetch(`${dashboard.base}/api/tasks/startup-task`)).json();
    if (!detail.runtime.active) break;
    await delay(50);
  }
  assert.ok(detail && !detail.runtime.active, "the real Main process settled");
  const stderr = await readFile(
    join(dashboard.workspaceRoot, "startup-task", "runs", runId, "runtime-stderr.log"),
    "utf8"
  ).catch(() => "");
  return { dashboard, detail, requests, stderr };
}

test(
  "a callback delivered while Main starts joins the starting run instead of failing or opening another run",
  { timeout: 90_000 },
  async (t) => {
    const runId = "startup-run";
    const f = await mainRunFixture(t, {
      runId,
      inbox: (inbox) =>
        inbox.enqueue({
          messageId: "startup-callback",
          recipientAgentId: "main",
          callId: "startup-call",
          kind: "callback",
          eventId: "startup-event",
          priority: 1,
          state: "ready",
          payload: { callId: "startup-call", response: "STARTUP_CALLBACK_EVIDENCE" },
          createdAt: new Date().toISOString()
        })
    });
    assert.equal(f.detail.task.status, "completed", JSON.stringify(f.detail.task));
    assert.equal(f.detail.task.activeRunId, runId, "the accepted run is the one that ran");
    assert.equal(f.requests.length, 1, "the startup delivery stays in the one starting run");
    const transcript = JSON.stringify(f.requests[0].messages);
    assert.ok(transcript.includes("你好！"), "the user prompt is still the run's prompt");
    assert.ok(transcript.includes("STARTUP_CALLBACK_EVIDENCE"), "the callback joined the starting run");
    assert.ok(
      f.requests[0].messages
        .find((message) => message.role === "system")
        .content.includes("<current_workspace>"),
      "the user run received Main's context injection"
    );
    assert.doesNotMatch(f.stderr, /already processing/i);
    const inbox = new InboxStore(
      join(f.dashboard.workspaceRoot, "startup-task", "runs", runId, "agents", "main", "inbox-store.json")
    );
    assert.deepEqual(
      (await inbox.list("main")).map((message) => message.state),
      ["consumed"],
      "the delivered callback is acknowledged, not left for a second run"
    );
  }
);

function rpcFixture(t, env) {
  const child = spawn(
    process.execPath,
    [
      join(harness, "scripts", "atria.mjs"),
      "start",
      "--mode",
      "rpc",
      "--thinking",
      "off",
      "--no-approve",
      "--no-skills",
      "--no-context-files",
      "--extension",
      join(harness, ".pi", "extensions", "cowork.ts"),
      "--extension",
      join(harness, "test", "fixtures", "p46-pi-upgrade-probe.mjs")
    ],
    { cwd: env.root, env: env.env, stdio: ["pipe", "pipe", "pipe"] }
  );
  const events = [];
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
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
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "close");
    child.kill("SIGTERM");
    const timeout = new AbortController();
    try {
      await Promise.race([exited, delay(3_000, undefined, { signal: timeout.signal })]);
    } finally {
      timeout.abort();
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await exited;
  });
  const send = (type, values = {}) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = `p46-${events.length}-${pending.size}`;
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
  return { child, events, send, waitFor };
}

/**
 * A real Pi RPC host running the real Main extension next to the probe
 * extension, with a recorded local provider.
 */
async function probeRpc(t, { startupSend }) {
  const root = await mkdtemp(join(tmpdir(), "p46-upgrade-rpc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  const workspace = join(root, "workspace");
  await mkdir(profile);
  await mkdir(workspace);
  await writeFile(join(root, "fixture.txt"), "probe fixture\n");
  const requests = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "p46-rpc-model" }] }));
    }
    requests.push(JSON.parse(await readFixtureRequestBody(request)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      protocolStream(
        "openai-completions",
        // The first call leaves one tool round, so a message queued during the
        // run start has a later model call to reach.
        requests.length === 1
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
  });
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ baseUrl, apiKey: "fixture-local", model: "p46-rpc-model" })
  );
  const probeLog = join(root, "probe.jsonl");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:COWORK_|PI_|ATRIA_|OPENAI_|ANTHROPIC_|SERPER_|EXA_|NODE_OPTIONS)/.test(key)
      )
    ),
    HOME: root,
    TMPDIR: root,
    ATRIA_HOME: join(root, "home"),
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_HARNESS_ROOT: harness,
    COWORK_WORKSPACE: workspace,
    COWORK_TASK_ID: "probe-task",
    COWORK_RUN_ID: "probe-run",
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    COWORK_API_BASE: baseUrl,
    COWORK_API_KEY: "fixture-local",
    COWORK_MODEL: "p46-rpc-model",
    COWORK_MODEL_API: "openai-completions",
    COWORK_REASONING_EFFORT: "off",
    PI_CODING_AGENT_DIR: profile,
    PI_OFFLINE: "1",
    P46_PROBE_LOG: probeLog,
    ...(startupSend ? { P46_PROBE_STARTUP: "1" } : {})
  };
  const rpc = rpcFixture(t, { root, env });
  await rpc.send("get_state");
  return {
    requests,
    rpc,
    async hookEvents() {
      return (await readFile(probeLog, "utf8")).trim().split("\n").map(JSON.parse);
    }
  };
}

function workspaceInjected(request) {
  return request.messages
    .find((message) => message.role === "system")
    .content.includes("<current_workspace>");
}

test(
  "extension-triggered runs report a custom before_agent_start event and still receive Main's injection",
  { timeout: 120_000 },
  async (t) => {
    const { requests, rpc, hookEvents } = await probeRpc(t, { startupSend: false });
    await rpc.send("prompt", { message: "你好！" });
    await rpc.waitFor((event) => event.type === "agent_settled");
    assert.ok(workspaceInjected(requests[0]), "the user run received Main's context injection");

    const beforeCustom = rpc.events.length;
    // The extension command consumes this prompt; if it were treated as a user
    // prompt the hook below would report "user" and no custom run would start.
    await rpc.send("prompt", { message: "/probe-custom" });
    await rpc.waitFor((event) => event.type === "agent_settled");
    assert.equal(
      rpc.events.slice(beforeCustom).filter((event) => event.type === "agent_start").length,
      1,
      "the extension message started exactly one run"
    );
    const events = await hookEvents();
    assert.deepEqual(
      events.map((event) => event.messageType),
      ["user", "custom"],
      "before_agent_start reports the user prompt and the extension-triggered run separately"
    );
    assert.equal(events[0].hasPrompt, true);
    assert.equal(events[0].hasMessage, false);
    assert.equal(events[1].hasPrompt, false);
    assert.equal(events[1].customType, "p46-probe-custom");

    const customRun = requests.at(-1);
    assert.ok(workspaceInjected(customRun), "the custom run received Main's injection");
    assert.ok(
      JSON.stringify(customRun.messages).includes("P46_CUSTOM_MARKER"),
      "the custom run carries the extension message it was started with"
    );
    assert.ok(
      !JSON.stringify(customRun.messages).includes("/probe-custom"),
      "the command text never reaches the model as a user prompt"
    );
    assert.equal(rpc.child.exitCode, null, "the RPC host stayed healthy");
  }
);

test(
  "a message an extension sends while the run starts joins that run instead of opening another",
  { timeout: 120_000 },
  async (t) => {
    const { requests, rpc } = await probeRpc(t, { startupSend: true });
    await rpc.send("prompt", { message: "你好！" });
    await rpc.waitFor((event) => event.type === "agent_settled");
    assert.equal(
      rpc.events.filter((event) => event.type === "agent_start").length,
      1,
      "the message sent during the run start opened no second run"
    );
    assert.ok(
      JSON.stringify(requests[0].messages).includes("P46_STARTUP_MARKER"),
      "a message sent while the run starts joins that run"
    );
    assert.ok(workspaceInjected(requests[0]), "the user run received Main's context injection");
    assert.equal(rpc.child.exitCode, null, "the RPC host stayed healthy");
  }
);
