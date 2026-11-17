import assert from "node:assert/strict";
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

const textOf = (messages) =>
  messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n")
    )
    .join("\n");

for (const mode of ["automatic", "explicit"])
  test(
    `Main ${mode} compaction preserves bounded tool evidence and keeps current state outside old summaries`,
    { timeout: 60_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-main-compaction-input-"));
      const workspace = join(root, "workspace");
      const project = join(root, "project");
      const taskId = "summary-input-task";
      const runId = "summary-input-run";
      const goal = "HISTORICAL_GOAL_ANCHOR: inspect the verification evidence before updating counter.js.";
      const taskConstraint = "TASK_RECORD_ONLY_CONSTRAINT: preserve the counter module public exports.";
      const head = "VERIFICATION_OUTPUT_HEAD_8c76";
      const middle = "VERIFICATION_OUTPUT_MIDDLE_8c76";
      const tail = "VERIFICATION_OUTPUT_TAIL_8c76: 4 failed, 1413 passed, 1 skipped";
      const rawOutput = `${head}\n${"diagnostic-before-middle ".repeat(220)}\n${middle}\n${"diagnostic-after-middle ".repeat(220)}\n${tail}\n`;
      const checkpoint =
        "## Goal\nInspect verification evidence before changing counter.js.\n## Constraints & Preferences\n- (none stated in the covered messages)\n## Progress\n### Done\n- [x] Read verification.log.\n### In Progress\n- [ ] Repair the failures before considering the implementation verified.\n### Blocked\n- (none)\n## Key Decisions\n- A passed count does not establish an overall passing test run.\n## Next Steps\n1. Inspect the reported failure before updating counter.js.\n## Critical Context\n- EVIDENCE_CHECKPOINT_8c76: cat verification.log; exit 1 reported 4 failed, 1413 passed, 1 skipped and exit code 1.";
      const prefixCheckpoint =
        "## Original Request\nContinue from the recorded evidence.\n## Progress So Far\n- Requested a context checkpoint; no new verification was performed.\n## Context Needed to Continue\n- The covered earlier turn contains verification evidence; use the historical checkpoint.";
      const requests = [];
      const summaryRequests = [];
      const failures = [];
      const events = [];
      let mainRequests = 0;
      let stage = "initial";
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
          const visible = textOf(body.messages);
          if (!body.tools?.length) {
            summaryRequests.push(body);
            assert.ok(
              !visible.includes("<previous-summary>"),
              "a runtime supplement must not invent a previous checkpoint"
            );
            assert.ok(
              !visible.includes("PRESERVE all existing information"),
              "update policy must reconcile, rather than append all old records"
            );
            assert.ok(
              !visible.includes("<atria_main_context>"),
              "current runtime state is supplied separately from covered history"
            );
            if (visible.includes("cat verification.log")) {
              assert.ok(visible.includes(head), "the summary request retains the output beginning");
              assert.ok(visible.includes(tail), "the summary request retains the final test statistics");
              assert.ok(
                visible.includes("Command exited with code 1"),
                "the summary request retains the failed command exit status"
              );
              assert.ok(
                !visible.includes(middle),
                "the middle is omitted instead of replaying the whole output"
              );
              reply = { text: checkpoint };
            } else reply = { text: prefixCheckpoint };
          } else {
            mainRequests++;
            if (stage === "resumed") {
              assert.ok(
                visible.includes("EVIDENCE_CHECKPOINT_8c76"),
                "restart receives the persisted semantic checkpoint"
              );
              assert.ok(
                visible.includes(taskConstraint),
                "current context retains the Task-only requirement"
              );
              assert.ok(
                visible.includes("<atria_main_context>"),
                "restart receives a fresh machine-state projection"
              );
              assert.equal(
                visible.match(/<atria_main_context>/g)?.length,
                1,
                "refresh replaces the machine-state projection instead of appending snapshots"
              );
              assert.ok(
                visible.includes("Runtime state: phase=active"),
                "current phase is refreshed rather than copied from an old checkpoint"
              );
              assert.ok(!visible.includes(middle), "restart must not replay the old raw output");
              reply = {
                text: "Continue by inspecting the recorded failure; do not repeat the evidence-producing command."
              };
            } else if (stage === "compact") {
              reply = {
                name: "clear_context",
                arguments: { reason: "Create a checkpoint before continuing the recorded work." }
              };
              stage = "after-explicit";
            } else if (stage === "after-explicit") {
              reply = { text: "The checkpoint is preserved; inspect the recorded failure next." };
            } else if (mainRequests === 1) {
              // The literal output markers are only on disk, never in assistant tool arguments.
              reply = { name: "bash", arguments: { command: "cat verification.log; exit 1", timeout: 10 } };
            } else {
              assert.equal(mainRequests, 2, "the fixture must not repeat the failed command");
              reply = {
                text: "The evidence has been collected. Inspect the reported failure before making changes."
              };
              highUsage = mode === "automatic";
            }
          }
        } catch (error) {
          failures.push(error.stack ?? error.message);
          reply = { text: "Summary input fixture failed." };
        }
        let stream = protocolStream("openai-completions", reply).replaceAll(
          "call_protocol",
          `call_${requests.length}`
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
                : { prompt_tokens: 600, completion_tokens: 80, total_tokens: 680 }
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
            /* The child may already have exited. */
          }
          await childExit;
        }
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(project);
      await writeFile(join(project, "verification.log"), rawOutput);
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
      await store.createTask(taskId, { goal: `${goal}\n${taskConstraint}` });
      await store.createRun(taskId, runId);
      const paths = mainContextPaths(workspace, taskId);
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
        COWORK_API_KEY: "isolated-compaction-input-fixture",
        COWORK_MODEL: "protocol-fixture",
        COWORK_MODEL_API: "openai-completions",
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
        let pending = "";
        child.stderr.on("data", (chunk) => {
          output = (output + chunk).slice(-25_000);
        });
        child.stdout.on("data", (chunk) => {
          output = (output + chunk).slice(-25_000);
          pending += chunk;
          const rows = pending.split("\n");
          pending = rows.pop();
          for (const row of rows) {
            try {
              events.push(JSON.parse(row));
            } catch {
              /* Startup diagnostics are not events. */
            }
          }
        });
        const [code] = await childExit;
        assert.deepEqual(failures, [], output.slice(-2000));
        assert.equal(code, 0, output.slice(-3000));
      };
      await launch(["--session-id", runId, goal]);
      const sessions = (await readdir(join(root, "sessions"))).filter((name) => name.endsWith(".jsonl"));
      assert.equal(sessions.length, 1);
      const sessionPath = join(root, "sessions", sessions[0]);
      if (mode === "explicit") {
        assert.equal(
          summaryRequests.length,
          0,
          "the completed first turn does not reach the automatic threshold"
        );
        stage = "compact";
        await launch([
          "--session",
          sessionPath,
          "Continue from the recorded evidence and checkpoint the earlier work before proceeding."
        ]);
      }
      assert.ok(
        summaryRequests.some((body) => textOf(body.messages).includes("cat verification.log")),
        "the covered historical tool result reaches a native summary request"
      );
      assert.equal(
        summaryRequests.length,
        mode === "automatic" ? 1 : 2,
        "reuse the native history/prefix requests without another model review"
      );
      assert.ok((await readMainContextState(paths)).contextEpoch > 0);
      assert.ok(
        events.some(
          (event) =>
            event.type === "compaction_end" && event.result?.summary.includes("EVIDENCE_CHECKPOINT_8c76")
        ),
        "a valid semantic checkpoint is committed"
      );
      assert.ok(
        (await readFile(paths.messages, "utf8")).includes(middle),
        "the unmodified raw archive retains omitted evidence"
      );
      stage = "resumed";
      await launch(["--session", sessionPath, "Continue the unresolved work from the checkpoint."]);
      assert.equal(mainRequests, mode === "automatic" ? 3 : 4);
      assert.deepEqual(
        events
          .filter((event) => event.type === "tool_execution_end")
          .map((event) => [event.toolName, event.isError]),
        [["bash", true], ...(mode === "explicit" ? [["clear_context", false]] : [])],
        "resume does not repeat the failed verification command"
      );
    }
  );
