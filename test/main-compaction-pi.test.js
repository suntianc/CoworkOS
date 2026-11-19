import assert from "node:assert/strict";
import { parseModelRequestArchive } from "../dist/src/storage/model-request-recorder.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { mainContextPaths, readMainContextState } from "../dist/src/runtime/main-context.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const api = "openai-completions";
for (const [mode, memoryKind, summaryFailure] of [
  ["automatic", "default", false],
  ["automatic", "stale", false],
  ["explicit", "default", false],
  ["automatic", "default", "http"],
  ["explicit", "default", "http"],
  ...["empty", "whitespace", "thinking"].flatMap((failure) => [
    ["automatic", "default", failure],
    ["explicit", "default", failure]
  ])
])
  test(
    summaryFailure
      ? `Main ${summaryFailure} ${mode} summary preserves the task history and a resumable context cursor`
      : `Main ${mode} compaction summarizes real task history with ${memoryKind} memory and survives restart`,
    { timeout: 60_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-main-compaction-"));
      const workspace = join(root, "workspace");
      const project = join(root, "project");
      const taskId = "compaction-task";
      const runId = "compaction-run";
      const goal =
        "TASK_GOAL_ANCHOR: implement incrementCount in counter.js without changing its public API.";
      const originalGuard = "ORIGINAL_TASK_GUARD: preserve the existing counter module exports.";
      const next = "NEXT_ACTION_ANCHOR: update docs/usage.md after the counter tests pass.";
      const verification = "VERIFIED_ANCHOR: counter.spec.js has 3 passed tests.";
      const oldPayload = "OLD_TOOL_PAYLOAD_ANCHOR:" + "obsolete-diagnostic ".repeat(500);
      const source = "export const incrementCount = (value) => value + 1;\n";
      const summary = `## Goal\n${goal}\n## Completed\ncounter.js now exports incrementCount. ${verification}\n## Next\n${next}`;
      const requests = [];
      const summaryRequests = [];
      const failures = [];
      const events = [];
      let mainRequests = 0;
      let continued = false;
      let child;
      let childExit;
      let output = "";
      const server = createServer(async (request, response) => {
        const body = JSON.parse(await readFixtureRequestBody(request));
        requests.push(body);
        let reply;
        let highUsage = false;
        try {
          assert.equal(request.url, "/v1/chat/completions");
          assert.equal(body.stream, true);
          const serialized = JSON.stringify(body.messages);
          const visible = body.messages
            .map((message) =>
              typeof message.content === "string"
                ? message.content
                : (message.content ?? []).map((part) => part.text ?? "").join("\n")
            )
            .join("\n");
          if (!body.tools?.length) {
            summaryRequests.push(body);
            const recoveryPrefix = continued && mode === "explicit" && !serialized.includes(goal);
            if (recoveryPrefix) {
              assert.ok(serialized.includes("Continue the next action from the preserved task state."));
            } else {
              assert.ok(serialized.includes(goal), "summarize the actual task goal");
              assert.ok(serialized.includes(verification), "summarize completed verification");
              assert.ok(serialized.includes(next), "preserve the unresolved next action");
              assert.ok(serialized.includes("counter.js"), "summarize the changed file");
            }
            if (summaryFailure === "http" && !continued) {
              response.writeHead(503, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: { message: "Fixture summary unavailable" } }));
              return;
            }
            reply =
              summaryFailure && !continued
                ? { text: summaryFailure === "whitespace" ? "   \n\t " : "" }
                : {
                    text: recoveryPrefix
                      ? "The user requested continuation from preserved task state; retry the context checkpoint before updating documentation."
                      : summary + (serialized.includes(originalGuard) ? `\n${originalGuard}` : "")
                  };
          } else {
            mainRequests++;
            if (continued) {
              assert.ok(
                serialized.includes(originalGuard),
                "current harness context retains the Task goal even when it was absent from summarized history"
              );
              if (summaryFailure) {
                for (const anchor of [goal, verification, next])
                  assert.ok(serialized.includes(anchor), "failed summary preserves recoverable task state");
              } else {
                assert.ok(
                  visible.includes(summary),
                  "the next real request receives the semantic checkpoint"
                );
                assert.ok(
                  !serialized.includes(oldPayload),
                  "old raw tool output is summarized rather than replayed"
                );
              }
              assert.equal(await readFile(join(project, "counter.js"), "utf8"), source);
              reply =
                summaryFailure && mode === "explicit"
                  ? {
                      name: "clear_context",
                      arguments: { reason: "Retry the failed semantic checkpoint after recovery." }
                    }
                  : {
                      text: "Continued with the existing implementation and verification; documentation is next."
                    };
              highUsage = Boolean(summaryFailure && mode === "automatic");
            } else if (mainRequests === 1) {
              reply = { name: "write", arguments: { path: "counter.js", content: source } };
            } else if (mainRequests === 2) {
              reply = {
                name: "bash",
                arguments: {
                  command: `node --input-type=module -e ${JSON.stringify(`import assert from 'node:assert/strict'; import {incrementCount} from './counter.js'; for (const value of [0, 1, -1]) assert.equal(incrementCount(value), value + 1); console.log(${JSON.stringify(verification)}); console.log(${JSON.stringify(next)});`)}`,
                  timeout: 10
                }
              };
            } else if (mainRequests === 3) {
              reply = { name: "read", arguments: { path: "old-diagnostics.txt" } };
            } else {
              assert.equal(mainRequests, 4, "the fixture must not silently restart implementation");
              reply =
                mode === "explicit"
                  ? {
                      name: "clear_context",
                      arguments: { reason: "Continue documentation from a semantic checkpoint." }
                    }
                  : { text: `Implemented counter.js. ${verification} ${next}` };
              highUsage = mode === "automatic";
            }
          }
        } catch (error) {
          failures.push(error.stack ?? error.message);
          reply = { text: "Compaction regression fixture failed." };
        }
        let stream = protocolStream(api, reply).replaceAll("call_protocol", `call_${requests.length}`);
        if (summaryFailure === "thinking" && !continued && !body.tools?.length)
          stream = stream.replace(
            '"content":""',
            '"reasoning_content":"I should preserve the completed work and unresolved next action."'
          );
        if (highUsage || !body.tools?.length)
          stream = stream.replace(
            "data: [DONE]",
            `data: ${JSON.stringify({
              id: `usage_${requests.length}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "protocol-fixture",
              choices: [],
              usage: highUsage
                ? { prompt_tokens: 53000, completion_tokens: 10, total_tokens: 53010 }
                : { prompt_tokens: 600, completion_tokens: 37, total_tokens: 637 }
            })}\n\ndata: [DONE]`
          );
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(stream);
      });
      t.after(async () => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // The child can exit between checking it and sending the signal.
          }
          await childExit;
        }
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(project);
      await writeFile(join(project, "old-diagnostics.txt"), oldPayload);
      await writeFile(join(root, "config.json"), JSON.stringify({ contextWindow: 64000 }));
      await mkdir(join(root, "pi"));
      await writeFile(
        join(root, "pi", "settings.json"),
        JSON.stringify({
          retry: { enabled: false },
          compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32 }
        })
      );
      const store = new LocalWorkspaceStore(workspace);
      await store.createTask(taskId, { goal: `${goal}\n${originalGuard}` });
      await store.createRun(taskId, runId);
      const paths = mainContextPaths(workspace, taskId);
      if (memoryKind === "stale") {
        await mkdir(paths.directory, { recursive: true });
        await writeFile(
          paths.memory,
          "# Main Agent Memory\n\n## Goal\nAn older, incomplete plan.\n\n## Completed\n- No implementation or verification yet.\n"
        );
      }
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(COWORK_|ATRIA_|PI_|OPENAI_|ANTHROPIC_)/.test(name))
      );
      const env = {
        ...inherited,
        ATRIA_HOME: join(root, "atria"),
        COWORK_CONFIG: join(root, "config.json"),
        COWORK_WORKSPACE: workspace,
        COWORK_PROJECT_DIR: project,
        COWORK_TASK_ID: taskId,
        COWORK_RUN_ID: runId,
        COWORK_GLOBAL_INDEX: join(root, "workspaces.json"),
        COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
        COWORK_API_KEY: "isolated-compaction-fixture",
        COWORK_MODEL: "protocol-fixture",
        COWORK_MODEL_API: api,
        COWORK_DASHBOARD_URL: "",
        COWORK_DISABLE_MAIN_GUARDIAN: "1",
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        COWORK_WEB_TOOLS: "0",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1"
      };
      const launch = async (args) => {
        child = spawn(
          process.execPath,
          [
            "scripts/start-pi.mjs",
            "--print",
            "--mode",
            "json",
            "--session-dir",
            join(root, "sessions"),
            ...args
          ],
          {
            cwd: resolve("."),
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env
          }
        );
        childExit = once(child, "exit");
        child.stderr.on("data", (chunk) => {
          output = (output + chunk).slice(-20_000);
        });
        let pending = "";
        child.stdout.on("data", (chunk) => {
          output = (output + chunk).slice(-20_000);
          pending += chunk;
          const rows = pending.split("\n");
          pending = rows.pop();
          for (const row of rows) {
            try {
              events.push(JSON.parse(row));
            } catch {
              /* Startup diagnostics are not JSON events. */
            }
          }
        });
        return childExit;
      };
      const [code] = await launch(["--session-id", runId, `${goal}\n${next}`]);
      assert.deepEqual(failures, [], output.slice(-2000));
      assert.equal(code, 0, output.slice(-3000));
      assert.ok(
        summaryRequests.length > 0,
        "Main must summarize actual history even when memory is absent or stale"
      );
      const compacted = events.find((event) => event.type === "compaction_end" && event.result);
      if (summaryFailure) {
        assert.equal(compacted, undefined, "a failed summary must not commit a compaction");
        if (summaryFailure !== "http") {
          assert.ok(
            events.some(
              (event) =>
                event.type === "compaction_end" &&
                event.errorMessage?.includes("Context summarization returned no non-whitespace text")
            ),
            "the failure identifies the empty generated summary"
          );
          const recordingPath = join(workspace, taskId, "sessions", "main", `${runId}-requests.jsonl`);
          const records = parseModelRequestArchive(await readFile(recordingPath, "utf8"));
          const summaryIds = new Set(
            records
              .filter((row) => row.type === "model_request" && !row.payload.tools.length)
              .map((row) => row.requestId)
          );
          const responses = records.filter(
            (row) => row.type === "model_response" && summaryIds.has(row.requestId)
          );
          assert.ok(responses.length > 0, "archive the actual provider response before validation");
          for (const { payload } of responses) {
            assert.equal(payload.message.stopReason, "stop", "keep the provider's original stop reason");
            assert.equal(payload.message.usage.input, 600);
            assert.equal(payload.message.usage.output, 37);
            assert.equal(
              payload.message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
              summaryFailure === "whitespace" ? "   \n\t " : "",
              "keep the original summary body in the request archive"
            );
            if (summaryFailure === "thinking")
              assert.ok(payload.message.content.some((block) => block.type === "thinking"));
          }
        }
        assert.equal(
          (await readMainContextState(paths)).contextEpoch,
          0,
          "failed compaction retains its cursor"
        );
        assert.ok(
          (await readFile(paths.messages, "utf8")).includes(oldPayload),
          "raw history stays available for recovery"
        );
      } else {
        assert.ok(compacted, output);
        assert.ok(compacted.result.summary.includes(summary));
        assert.ok((await readMainContextState(paths)).contextEpoch > 0);
      }
      const sessions = (await readdir(join(root, "sessions"))).filter((name) => name.endsWith(".jsonl"));
      assert.equal(sessions.length, 1);
      const sessionPath = join(root, "sessions", sessions[0]);
      const compactionEntries = (await readFile(sessionPath, "utf8"))
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row))
        .filter((entry) => entry.type === "compaction");
      assert.equal(
        compactionEntries.length,
        summaryFailure ? 0 : 1,
        "the saved session commits only a valid summary"
      );
      continued = true;
      const [continuedCode] = await launch([
        "--session",
        sessionPath,
        "Continue the next action from the preserved task state."
      ]);
      assert.equal(continuedCode, 0, output);
      assert.deepEqual(failures, [], output.slice(-2000));
      assert.equal(mainRequests, 5);
      if (summaryFailure) {
        const recovered = events.find((event) => event.type === "compaction_end" && event.result);
        assert.ok(recovered, "a later valid summary can compact the preserved history");
        assert.ok(recovered.result.summary.includes(summary));
        assert.ok((await readMainContextState(paths)).contextEpoch > 0);
      }
      assert.deepEqual(
        events
          .filter((event) => event.type === "tool_execution_end")
          .map((event) => [event.toolName, event.isError]),
        [
          ["write", false],
          ["bash", false],
          ["read", false],
          ...(mode === "explicit" ? [["clear_context", false]] : []),
          ...(summaryFailure && mode === "explicit" ? [["clear_context", false]] : [])
        ],
        "restart must not repeat completed tools"
      );
    }
  );
