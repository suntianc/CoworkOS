import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatcherRuntime } from "../dist/src/runtime/watcher.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { TraceRecorder } from "../dist/src/storage/trace-recorder.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

const exec = promisify(execFile);
const system = (body) => {
  const messages = body.messages ?? body.input;
  return Array.isArray(messages)
    ? messages
        .filter((m) => ["system", "developer"].includes(m.role))
        .map((m) => (typeof m.content === "string" ? m.content : m.content?.map((p) => p.text).join("\n")))
        .join("\n")
    : body.instructions;
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-role-requests-")),
    requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      protocolStream(request.url.endsWith("responses") ? "openai-responses" : "openai-completions", {
        text: "classification: no_change\nPi user topic retained."
      })
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "fixture-role-key",
    model: "fixture",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    maxTurns: 5,
    maxTokens: 1024,
    timeoutMs: 10000,
    tools: new Map()
  };
  return { root, requests, options };
}

test(
  "real PiSession and Main requests use neutral defaults, preserve custom/empty prompts and record actual payloads",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    for (const api of ["openai-completions", "openai-responses"]) {
      const trace = new TraceRecorder(join(f.root, `${api}-trace.jsonl`));
      const agent = new PiSession({
        ...f.options,
        api,
        trace: { recorder: trace, taskId: "agent", runId: api, agentId: "agent" }
      });
      await agent.run("Pi user first turn");
      await agent.run("Pi user second turn");
      for (const body of f.requests.slice(-2)) {
        assert.match(system(body), /You are CoworkOS Agent/);
        assert.doesNotMatch(system(body), /trained by Pujiang Laboratory/);
      }
      const archived = (await readFile(trace.modelRequestPath, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((r) => r.type === "model_request");
      assert.deepEqual(
        archived.map((r) => r.payload.request),
        f.requests.slice(-2)
      );
      for (const custom of [
        "User chose Pi identity and trained by Pujiang Laboratory in quoted material.",
        ""
      ]) {
        const session = new PiSession({ ...f.options, api, systemPrompt: custom });
        await session.run("Pi body");
        assert.equal(system(f.requests.at(-1)) || "", custom);
      }
      const service = new RunService(join(f.root, `workspace-${api}`));
      for (const [index, custom] of [undefined, "User chose Pi Main identity", ""].entries()) {
        await service.runPi({
          ...f.options,
          api,
          taskId: `main-${index}`,
          runId: `run-${index}`,
          prompt: "Pi material",
          systemPrompt: custom,
          tools: () => new Map()
        });
        const actual = system(f.requests.at(-1));
        assert.doesNotMatch(actual, /trained by Pujiang Laboratory/);
        if (custom === undefined) assert.match(actual, /You are CoworkOS Main/);
        else {
          assert.doesNotMatch(actual, /You are CoworkOS Main/);
          if (custom) assert.match(actual, /User chose Pi Main identity/);
        }
        assert.match(actual, /memory/i);
      }
    }
  }
);

test(
  "real Coordinator, WatchSupervisor and public watch-run retain their roles, event data and actual request archives",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      workspace = join(f.root, "workspace"),
      store = new LocalWorkspaceStore(workspace);
    await store.createTask("t");
    await store.createRun("t", "main-t");
    const dispatched = await new CoordinatorRuntime().dispatch({
      ...f.options,
      api: "openai-completions",
      taskId: "t",
      runId: "sub-run",
      agentId: "checker",
      task: "Pi delegated topic",
      mode: "sync",
      workspaceRoot: workspace,
      maxAttempts: 1,
      skillRoots: [],
      toolFactory: () => new Map()
    });
    assert.equal(dispatched.status, "succeeded");
    assert.match(system(f.requests.at(-1)), /You are a CoworkOS Subagent/);
    const programs = new WatchProgramStore(workspace);
    const program = await programs.createProgram({
      taskId: "t",
      programId: "p",
      subject: "Pi topic",
      objective: "Keep user Pi material"
    });
    const monitor = await programs.createVirtualAgent({
      programId: program.programId,
      task: "Analyze Pi event",
      profileId: "custom",
      cadenceSeconds: 60,
      wake: "important",
      activate: true
    });
    await programs.updateVirtualAgentState("t", "p", monitor.monitorId, {
      lastCheckedAt: new Date().toISOString()
    });
    const watcher = new WatcherRuntime({
      workspaceRoot: workspace,
      taskId: "t",
      runId: "watch-p",
      programId: "p",
      recipientAgentId: monitor.monitorId
    });
    await watcher.ingest({
      watcherId: monitor.monitorId,
      source: "fixture",
      type: "fixture.changed",
      dedupeKey: "one",
      payload: { text: "Pi event preserved" }
    });
    const result = await new WatchSupervisor({
      workspaceRoot: workspace,
      ...f.options,
      api: "openai-completions"
    }).runCycle({ taskId: "t" });
    assert.equal(result.failures.length, 0, JSON.stringify(result));
    assert.equal(result.processed, 1);
    assert.match(system(f.requests.at(-1)), /You are a CoworkOS Subagent/);
    assert.match(JSON.stringify(f.requests.at(-1)), /performing a Watch monitoring task/);
    assert.match(JSON.stringify(f.requests.at(-1)), /Pi event preserved/);
    await watcher.ingest({
      watcherId: monitor.monitorId,
      source: "fixture",
      type: "fixture.changed",
      dedupeKey: "two",
      payload: { text: "Pi second event" }
    });
    const config = join(f.root, "config.json");
    await writeFile(config, "{}");
    await exec(
      process.execPath,
      [
        resolve("scripts/atria.mjs"),
        "watch-run",
        "--task",
        "t",
        "--run",
        "watch-p",
        "--program",
        "p",
        "--monitor",
        monitor.monitorId
      ],
      {
        cwd: f.root,
        timeout: 15000,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !/^(COWORK_|PI_|ATRIA_)/.test(k))
          ),
          HOME: f.root,
          ATRIA_HOME: join(f.root, "home"),
          COWORK_WORKSPACE: workspace,
          COWORK_HARNESS_ROOT: resolve("."),
          COWORK_CONFIG: config,
          COWORK_API_BASE: f.options.baseUrl,
          COWORK_API_KEY: f.options.apiKey,
          COWORK_MODEL: "fixture",
          COWORK_MODEL_API: "openai-completions",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0"
        }
      }
    );
    assert.equal(f.requests.length, 3);
    assert.match(JSON.stringify(f.requests.at(-1)), /performing a Watch monitoring task/);
    for (const body of f.requests) assert.doesNotMatch(JSON.stringify(body), /trained by Pujiang Laboratory/);
    const archived = [];
    async function walk(path) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (file.isDirectory()) await walk(join(path, file.name));
        else if (file.name.endsWith("-requests.jsonl"))
          for (const row of (await readFile(join(path, file.name), "utf8"))
            .trim()
            .split("\n")
            .map(JSON.parse))
            if (row.type === "model_request") archived.push(row.payload.request);
      }
    }
    await walk(workspace);
    assert.equal(archived.length, f.requests.length);
    for (const body of f.requests)
      assert.ok(
        archived.some((saved) => JSON.stringify(saved) === JSON.stringify(body)),
        "retain complete provider payload"
      );
  }
);
