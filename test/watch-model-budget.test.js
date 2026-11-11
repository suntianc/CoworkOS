import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";

async function fixture(t, { responseDelayMs = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-watch-shared-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("task", {
    goal: "classify a monitored event",
    capabilities: { maxAttempts: 1 }
  });
  await workspace.createRun("task", "main-task");
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({
    taskId: "task",
    subject: "fixture",
    objective: "find relevant changes"
  });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "classify evidence",
    activate: true
  });
  const work = join(root, "task", "agents", "subagents", monitor.monitorId, "work");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "evidence.txt"), "A relevant change has occurred.");
  const requests = [];
  const timers = new Set();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req.setEncoding("utf8")) raw += chunk;
    requests.push(JSON.parse(raw));
    const turn = requests.length;
    const respond = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `watch-${turn}`, object: "chat.completion.chunk", model: "budget-fixture", created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      if (turn < 15) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `read-${turn}`,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "work/evidence.txt" }) }
            }
          ]
        });
        send({}, "tool_calls");
      } else {
        send({ content: "classification: relevant_change\nThe evidence confirms a relevant change." });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    };
    if (responseDelayMs) timers.add(setTimeout(respond, responseDelayMs));
    else respond();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    root,
    programs,
    program,
    monitor,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    pollerFactory: () => ({
      watcherId: monitor.monitorId,
      poll: async () => [
        {
          watcherId: monitor.monitorId,
          source: "fixture",
          type: "changed",
          dedupeKey: "event-1",
          payload: { value: 1 }
        }
      ]
    })
  };
}

for (const scenario of [
  {
    name: "custom monitoring can complete 15 turns using Main's larger budget",
    maxTurns: 20,
    timeoutMs: 0,
    calls: 15,
    success: true
  },
  {
    name: "custom monitoring stops at Main's configured turn limit",
    maxTurns: 3,
    timeoutMs: 0,
    calls: 3,
    success: false
  },
  {
    name: "custom monitoring uses Main's configured model deadline",
    maxTurns: 20,
    timeoutMs: 100,
    responseDelayMs: 500,
    calls: 1,
    success: false
  }
])
  test(scenario.name, async (t) => {
    const f = await fixture(t, scenario);
    const supervisor = new WatchSupervisor({
      workspaceRoot: f.root,
      baseUrl: f.baseUrl,
      apiKey: "local-fixture",
      model: "budget-fixture",
      supportsReasoningEffort: false,
      runtimeEnv: {
        COWORK_MAIN_MAX_TURNS: String(scenario.maxTurns),
        COWORK_MAIN_MAX_TOKENS: "32768",
        COWORK_MAIN_TIMEOUT_MS: String(scenario.timeoutMs),
        COWORK_MAX_TURNS: "1",
        COWORK_MAX_TOKENS: "128",
        COWORK_SUBAGENT_TIMEOUT_MS: "1"
      },
      pollerFactory: f.pollerFactory
    });
    const result = await supervisor.runCycle();
    assert.equal(f.requests.length, scenario.calls);
    for (const request of f.requests)
      assert.equal(request.max_completion_tokens ?? request.max_tokens, 32768);
    const state = await f.programs.readVirtualAgentState("task", f.program.programId, f.monitor.monitorId);
    assert.equal(result.processed, scenario.success ? 1 : 0);
    assert.equal(result.wakeRequests, scenario.success ? 1 : 0);
    assert.equal(state.status, scenario.success ? "active" : "failed");
    if (scenario.success) {
      assert.equal(state.lastClassification, "relevant_change");
      const readResult = f.requests[1].messages.findLast((message) => message.role === "tool");
      assert.match(JSON.stringify(readResult.content), /A relevant change has occurred/);
    } else {
      assert.equal(result.failures[0].stage, "execute");
      if (scenario.timeoutMs) assert.match(state.lastSummary, /timed_out/);
    }
  });
