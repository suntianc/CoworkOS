import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mainContextPaths, readMainContextState } from "../dist/src/runtime/main-context.js";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const usage = {
  input: 53000,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 53010,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

for (const mode of ["cooldown", "manual", "clear-context"])
  test(
    `real Main suppresses repeated automatic summary failures and recovers via ${mode}`,
    { timeout: 45_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-main-compaction-retry-"));
      const workspace = join(root, "workspace");
      const project = join(root, "project");
      const taskId = "retry-task";
      const runId = "retry-run";
      const goal = "COVERED_GOAL_ANCHOR: preserve the recorded evidence and continue the inspection.";
      const checkpoint =
        "CHECKPOINT_RETRY_ANCHOR: inspection evidence was collected; verify the next change.";
      const oldPayload = `EVIDENCE_HEAD_ANCHOR\n${"old-diagnostic ".repeat(9000)}\nEVIDENCE_TAIL_ANCHOR`;
      const requests = [];
      const summaryRequests = [];
      const mainRequests = [];
      const failures = [];
      const rows = [];
      let summarySucceeded = false;
      let child;
      let closed;
      let buffer = "";
      let output = "";
      let parseError;
      const server = createServer(async (request, response) => {
        const body = JSON.parse(await readFixtureRequestBody(request));
        requests.push(body);
        const isSummary = !body.tools?.length;
        (isSummary ? summaryRequests : mainRequests).push(body);
        try {
          assert.equal(request.url, "/v1/chat/completions");
          assert.equal(body.stream, true);
          const serialized = JSON.stringify(body.messages);
          if (isSummary) {
            assert.ok(serialized.includes(goal), "summarize the same actual historical prefix");
            assert.ok(serialized.includes("EVIDENCE_HEAD_ANCHOR"));
            assert.ok(serialized.includes("EVIDENCE_TAIL_ANCHOR"));
          } else if (summarySucceeded) {
            assert.ok(serialized.includes(checkpoint), "inference receives the committed checkpoint");
            assert.ok(!serialized.includes("old-diagnostic"), "successful recovery omits old raw output");
          } else {
            assert.ok(serialized.includes("EVIDENCE_HEAD_ANCHOR"), "failure keeps the original history");
          }
        } catch (error) {
          failures.push(error.stack ?? error.message);
        }
        if (isSummary && summaryRequests.length === 1) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Fixture summary temporarily unavailable" } }));
          return;
        }
        if (isSummary) summarySucceeded = true;
        let stream = protocolStream(
          "openai-completions",
          mode === "clear-context" && !isSummary && mainRequests.length === 2
            ? {
                name: "clear_context",
                arguments: { reason: "Explicit checkpoint while automatic retry is cooling down." }
              }
            : { text: isSummary ? checkpoint : "Continue the inspection from the recorded evidence." }
        ).replaceAll("call_protocol", `call_${requests.length}`);
        stream = stream.replace(
          "data: [DONE]",
          `data: ${JSON.stringify({
            id: `usage_${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "protocol-fixture",
            choices: [],
            usage:
              !isSummary && !summarySucceeded
                ? { prompt_tokens: 53000, completion_tokens: 10, total_tokens: 53010 }
                : { prompt_tokens: 600, completion_tokens: 40, total_tokens: 640 }
          })}\n\ndata: [DONE]`
        );
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(stream);
      });
      t.after(async () => {
        if (child && child.exitCode === null) {
          child.kill("SIGTERM");
          const force = setTimeout(() => child.kill("SIGKILL"), 2000);
          await closed;
          clearTimeout(force);
        }
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(project);
      await mkdir(join(root, "pi"));
      await writeFile(join(root, "config.json"), JSON.stringify({ contextWindow: 64000 }));
      await writeFile(
        join(root, "pi", "settings.json"),
        JSON.stringify({
          retry: { enabled: false },
          compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
        })
      );
      const store = new LocalWorkspaceStore(workspace);
      await store.createTask(taskId, { goal, projectDirectory: project });
      await store.createRun(taskId, runId);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      const model = createCoworkModel({
        baseUrl,
        model: "protocol-fixture",
        api: "openai-completions",
        contextWindow: 64000,
        supportsReasoningEffort: false
      });
      const native = SessionManager.create(project, join(root, "sessions"), { id: runId });
      native.appendModelChange(model.provider, model.id);
      native.appendThinkingLevelChange("off");
      native.appendMessage({ role: "user", content: goal, timestamp: 1 });
      native.appendMessage({
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          { type: "toolCall", id: "seed-read", name: "read", arguments: { path: "old-evidence.txt" } }
        ],
        stopReason: "toolUse",
        usage,
        timestamp: 2
      });
      native.appendMessage({
        role: "toolResult",
        toolCallId: "seed-read",
        toolName: "read",
        content: [{ type: "text", text: oldPayload }],
        isError: false,
        timestamp: 3
      });
      native.appendMessage({
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "Evidence collected; continue the inspection." }],
        stopReason: "stop",
        usage,
        timestamp: 4
      });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/^(COWORK_|ATRIA_|PI_|EXA_|OPENAI_|ANTHROPIC_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/.test(
              key
            )
        )
      );
      Object.assign(env, {
        ATRIA_HOME: join(root, "home"),
        COWORK_CONFIG: join(root, "config.json"),
        COWORK_WORKSPACE: workspace,
        COWORK_PROJECT_DIR: project,
        COWORK_TASK_ID: taskId,
        COWORK_RUN_ID: runId,
        COWORK_GLOBAL_INDEX: join(root, "workspaces.json"),
        COWORK_API_BASE: baseUrl,
        COWORK_API_KEY: "isolated-retry-fixture",
        COWORK_MODEL: model.id,
        COWORK_MODEL_API: model.api,
        COWORK_DISABLE_MAIN_GUARDIAN: "1",
        COWORK_WEB_TOOLS: "0",
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0"
      });
      child = spawn(
        process.execPath,
        [
          "scripts/start-pi.mjs",
          "--mode",
          "rpc",
          "--session",
          native.getSessionFile(),
          "--session-dir",
          join(root, "sessions")
        ],
        { cwd: resolve("."), env, stdio: "pipe" }
      );
      closed = new Promise((done) => child.once("close", done));
      child.stderr.on("data", (chunk) => {
        output = (output + chunk).slice(-20000);
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines.filter(Boolean)) {
          try {
            rows.push(JSON.parse(line));
          } catch (error) {
            parseError = error;
          }
        }
      });
      const wait = async (predicate, label) => {
        const deadline = Date.now() + 15000;
        while (!predicate()) {
          assert.equal(parseError, undefined, "RPC stdout remains JSONL");
          if (child.exitCode !== null || Date.now() >= deadline)
            assert.fail(`${label}: ${output}\n${JSON.stringify(rows.slice(-8))}`);
          await delay(20);
        }
      };
      const command = async (value) => {
        child.stdin.write(`${JSON.stringify(value)}\n`);
        await wait(() => rows.some((row) => row.id === value.id), `RPC ${value.type} did not answer`);
        const response = rows.find((row) => row.id === value.id);
        assert.equal(response.success, true, JSON.stringify(response));
        return response;
      };
      const prompt = async (id) => {
        const settled = rows.filter((row) => row.type === "agent_settled").length;
        await command({ id, type: "prompt", message: `Continue the current inspection (${id}).` });
        await wait(
          () => rows.filter((row) => row.type === "agent_settled").length > settled,
          "Main did not settle"
        );
      };
      await command({ id: "ready", type: "get_state" });
      await prompt("first");
      assert.equal(
        summaryRequests.length,
        1,
        "post-run threshold checks must not immediately repeat a failed request"
      );
      await prompt("immediate");
      const paths = mainContextPaths(workspace, taskId);
      if (mode === "clear-context") {
        assert.equal(
          summaryRequests.length,
          2,
          "the automatic cooldown cancellation must preserve a scheduled clear_context request"
        );
        await prompt("after-clear-context");
      } else {
        assert.equal(
          summaryRequests.length,
          1,
          "new tail messages do not reset the same failed prefix cooldown"
        );
        assert.equal(
          (await readMainContextState(paths)).contextEpoch,
          0,
          "failed/skipped summaries never commit"
        );
        if (mode === "cooldown") {
          await delay(5100);
          await prompt("after-cooldown");
        } else {
          await command({ id: "manual", type: "compact" });
          await prompt("after-manual");
        }
      }
      assert.deepEqual(failures, [], output);
      assert.equal(summaryRequests.length, 2, "recovery sends one actual summary request");
      assert.equal(mainRequests.length, 3);
      assert.equal(
        (await readMainContextState(paths)).contextEpoch,
        1,
        "recovery commits exactly one native checkpoint"
      );
      assert.ok(
        rows.some((row) => row.type === "compaction_end" && row.reason === "threshold" && row.aborted),
        "Pi owns cancellation events for skipped threshold compactions"
      );
      const records = (
        await readFile(join(workspace, taskId, "sessions", "main", `${runId}-requests.jsonl`), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      const recordedRequests = records.filter((row) => row.type === "model_request");
      assert.equal(
        recordedRequests.length,
        requests.length,
        "skipped compactions create no fictional provider requests"
      );
      assert.equal(recordedRequests.filter((row) => !row.payload.tools.length).length, 2);
      assert.deepEqual(
        recordedRequests.map((row) => row.payload.request),
        requests
      );
      child.stdin.end();
      await closed;
      assert.equal(child.exitCode, 0, output);
    }
  );
