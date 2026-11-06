import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

const readRows = async (path) => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (content) =>
  typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
const toolDefinitions = (body, api) =>
  body.tools.map((tool) => {
    const definition = api === "openai-responses" ? tool : tool.function;
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters
    };
  });

// Exercise the production launcher and extension rather than a fake ExtensionAPI.
// Every assertion in the server runs before it sends the model response.
for (const [api, compact] of [
  ["openai-completions", false],
  ["openai-responses", false],
  ["openai-completions", true],
  ["openai-responses", true]
]) {
  test(
    `Main ${api}: archive actual requests before HTTP receipt and capture dynamically enabled tools${compact ? " through compaction and restart" : ""}`,
    { timeout: 60_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-main-requests-"));
      const workspace = join(root, "workspace");
      const project = join(root, "project");
      const taskId = "recording-task";
      const runId = "recording-run";
      const credential = "isolated-main-recording-credential";
      const prompt = "先启用应用工具，然后列出可用应用并完成核对。";
      const finalText = "已启用应用工具并核对应用目录。";
      const memory = "已完成应用工具启用和目录核对。继续只读确认，保留此前工具结果。";
      const continuation = "根据已有记忆继续核对，不要重复工具调用。";
      const recordingPath = join(workspace, taskId, "sessions", "main", `${runId}-requests.jsonl`);
      const received = [];
      const mainReceived = [];
      const summaries = [];
      const recordedBeforeResponse = [];
      const failures = [];
      const events = [];
      let child;
      let childExit;
      let output = "";
      const server = createServer(async (request, response) => {
        // Snapshot synchronously on header receipt, before consuming the body or
        // yielding: later disk writes cannot make this durability check pass.
        let receiptRows;
        try {
          receiptRows = readFileSync(recordingPath, "utf8").trim().split("\n").map(JSON.parse);
        } catch (error) {
          failures.push(error.stack ?? error.message);
        }
        const raw = await readFixtureRequestBody(request);
        let reply = { text: "请求归档回归失败。" };
        try {
          const body = JSON.parse(raw);
          received.push(body);
          const isSummary = !body.tools?.length;
          (isSummary ? summaries : mainReceived).push(body);
          assert.equal(request.method, "POST");
          assert.equal(request.url, api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
          assert.equal(request.headers.authorization, `Bearer ${credential}`);
          assert.equal(body.stream, true);
          assert.equal(body.model, "protocol-fixture");

          // The server has the actual bytes now: a missing/partial archive is a
          // real durability failure, regardless of what is written after exit.
          const rows = receiptRows;
          const requests = rows.filter((row) => row.type === "model_request");
          assert.equal(requests.length, received.length, "persist each request before sending it");
          const saved = requests.at(-1);
          recordedBeforeResponse.push(saved);
          assert.equal(saved.taskId, taskId);
          assert.equal(saved.runId, runId);
          assert.equal(saved.agentId, "main");
          assert.equal(saved.payload.model.api, api);
          assert.equal(saved.payload.model.contextWindow, 64000);
          assert.equal(body.contextWindow, undefined, "capacity stays local to the runtime");
          assert.deepEqual(saved.payload.request, body, "preserve the entire actual provider payload");

          if (isSummary) {
            assert.ok(compact, "only the compaction variants request a summary");
            assert.ok(JSON.stringify(body).includes(prompt), "summarize the actual user request");
            reply = { text: `# Task checkpoint\n${prompt}\n${memory}` };
          } else {
            const messages = api === "openai-responses" ? body.input : body.messages;
            const system = messages.filter((message) => ["system", "developer"].includes(message.role));
            assert.equal(system.length, 1);
            assert.equal(text(system[0].content), saved.payload.systemPrompt);
            assert.match(saved.payload.systemPrompt, /You are CoworkOS Main/);
            assert.doesNotMatch(
              saved.payload.systemPrompt,
              /expert coding assistant operating inside pi|Pi documentation \(read only/
            );
            if (mainReceived.length === 1)
              assert.ok(
                !saved.payload.systemPrompt.includes("Create a resource the user can edit alongside you")
              );
            else {
              assert.ok(
                saved.payload.systemPrompt.includes("Create a resource the user can edit alongside you"),
                "new tool snippets must stay dynamic"
              );
              assert.ok(
                saved.payload.systemPrompt.includes("read and edit the bound resource in place"),
                "new tool guidelines must stay dynamic"
              );
            }
            assert.ok(saved.payload.systemPrompt.length > 2_000, "archive the expanded Main policy");
            assert.ok(saved.payload.systemPrompt.includes(project), "include the actual project context");
            assert.ok(
              saved.payload.systemPrompt.includes(join(workspace, taskId)),
              "include the Task workspace"
            );
            assert.equal(saved.payload.systemPromptSha256, hash(saved.payload.systemPrompt));
            assert.equal(saved.payload.toolsSha256, hash(saved.payload.tools));
            assert.deepEqual(
              toolDefinitions(body, api),
              saved.payload.tools.map(({ name, description, parameters }) => ({
                name,
                description,
                parameters
              })),
              "archive complete descriptions and nested parameter schemas for every active tool"
            );
            if (mainReceived.length === 4) {
              assert.ok(compact);
              assert.ok(
                JSON.stringify(body).includes(memory),
                "the archived body must contain the actual durable-memory compaction"
              );
              assert.ok(JSON.stringify(saved.payload.context).includes(memory));
              assert.ok(
                messages.some(
                  (message) => message.role === "user" && text(message.content).includes(continuation)
                )
              );
            } else {
              assert.ok(
                messages.some((message) => message.role === "user" && text(message.content).includes(prompt))
              );
              assert.ok(JSON.stringify(saved.payload.context).includes(prompt));
            }

            const names = saved.payload.tools.map((tool) => tool.name);
            if (mainReceived.length === 1) {
              assert.ok(names.includes("enable_tools"));
              assert.ok(!names.includes("list_applications"));
              assert.ok(!names.includes("create_resource"));
              reply = { name: "enable_tools", arguments: { groups: ["applications"] } };
            } else {
              assert.ok(
                names.includes("list_applications"),
                "the next request must include newly enabled tools"
              );
              assert.ok(names.includes("create_resource"));
              assert.ok(names.includes("apply_resource_operation"));
              assert.notEqual(saved.payload.toolsSha256, requests[0].payload.toolsSha256);
              assert.ok(JSON.stringify(body).includes("applications"));
              if (mainReceived.length === 2) {
                assert.ok(
                  JSON.stringify(body).includes("call_main_1"),
                  "retain the previous tool call and receipt"
                );
                reply = { name: "list_applications", arguments: {} };
              } else {
                assert.ok(mainReceived.length === 3 || (compact && mainReceived.length === 4));
                if (mainReceived.length === 3) {
                  assert.ok(JSON.stringify(body).includes("call_main_2"));
                  assert.ok(
                    JSON.stringify(body).includes("text/markdown"),
                    "retain the real application directory result"
                  );
                }
                reply = { text: finalText };
              }
            }
          }
          assert.equal(
            rows.filter((row) => row.type === "model_response").length,
            received.length - 1,
            "a settled response must be durable before the next request"
          );
        } catch (error) {
          failures.push(error.stack ?? error.message);
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        let stream = protocolStream(api, reply)
          .replaceAll("call_protocol", `call_main_${received.length}`)
          .replaceAll("fc_protocol", `fc_main_${received.length}`)
          .replaceAll("resp_protocol", `resp_main_${received.length}`);
        if (compact && mainReceived.length === 3 && reply.text === finalText) {
          // Simulate a provider usage report crossing Pi's native threshold
          // without needing a huge fixture body. Main supplies the summary.
          if (api === "openai-responses") {
            stream = stream.replace(
              '"input_tokens":10,"output_tokens":10,"total_tokens":20',
              '"input_tokens":53000,"output_tokens":10,"total_tokens":53010'
            );
          } else {
            stream = stream.replace(
              "data: [DONE]",
              `data: ${JSON.stringify({
                id: "protocol",
                object: "chat.completion.chunk",
                created: 1,
                model: "protocol-fixture",
                choices: [],
                usage: { prompt_tokens: 53000, completion_tokens: 10, total_tokens: 53010 }
              })}\n\ndata: [DONE]`
            );
          }
        }
        response.end(stream);
      });
      t.after(async () => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* The process may have exited between the check and the signal. */
          }
          await childExit;
        }
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(project);
      await writeFile(join(root, "config.json"), JSON.stringify({ contextWindow: 64000 }));
      const store = new LocalWorkspaceStore(workspace);
      await store.createTask(taskId, { goal: prompt });
      await store.createRun(taskId, runId);
      if (compact) {
        const contextDirectory = join(workspace, taskId, "agents", "main", "context");
        await mkdir(contextDirectory, { recursive: true });
        await writeFile(join(contextDirectory, "memory.md"), memory);
        await mkdir(join(root, "pi"));
        await writeFile(
          join(root, "pi", "settings.json"),
          JSON.stringify({
            compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32 }
          })
        );
      }
      server.listen(0, "127.0.0.1");
      await once(server, "listening");

      // Keep machine/user model connections and storage out of this fixture.
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name)
        )
      );
      const environment = {
        ...inherited,
        ATRIA_HOME: join(root, "atria"),
        COWORK_CONFIG: join(root, "config.json"),
        COWORK_WORKSPACE: workspace,
        COWORK_PROJECT_DIR: project,
        COWORK_TASK_ID: taskId,
        COWORK_RUN_ID: runId,
        COWORK_GLOBAL_INDEX: join(root, "workspaces.json"),
        COWORK_TABS_INDEX: join(root, "tabs.json"),
        COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
        COWORK_API_KEY: credential,
        COWORK_MODEL: "protocol-fixture",
        COWORK_MODEL_API: api,
        COWORK_DASHBOARD_URL: "",
        COWORK_DISABLE_WATCH_SUPERVISOR: "1",
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        COWORK_WEB_TOOLS: "0",
        COWORK_SERPER_API_KEY: "",
        SERPER_API_KEY: "",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1"
      };
      const launch = (args) => {
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
            env: environment
          }
        );
        childExit = once(child, "exit");
        const recordOutput = (chunk) => {
          output = (output + chunk).slice(-20_000);
        };
        child.stdout.on("data", recordOutput);
        child.stderr.on("data", recordOutput);
        let pending = "";
        child.stdout.on("data", (chunk) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) {
            try {
              events.push(JSON.parse(line));
            } catch {
              /* Startup diagnostics are not JSON events. */
            }
          }
        });
        return childExit;
      };
      const [code] = await launch(["--session-id", runId, prompt]);
      assert.equal(code, 0, output);
      assert.deepEqual(failures, [], output);
      assert.equal(mainReceived.length, 3);
      assert.equal(recordedBeforeResponse.length, received.length);
      const firstProcessRows = await readRows(recordingPath);
      assert.deepEqual(
        firstProcessRows.map((row) => row.sequence),
        firstProcessRows.map((_, index) => index + 1)
      );
      if (compact) {
        assert.equal(
          firstProcessRows.find(
            (row) => row.type === "model_response" && row.payload.message.usage.input === 53000
          )?.payload.message.usage.input,
          53000
        );
        const compaction = events.find((event) => event.type === "compaction_end" && event.result);
        assert.ok(
          compaction,
          `the real Pi process must successfully compact at the provider usage threshold: ${JSON.stringify(events.filter((event) => event.type.includes("compaction") || event.type === "message_end").map((event) => (event.type === "message_end" ? { type: event.type, role: event.message.role, usage: event.message.usage } : event)))}`
        );
        assert.equal(compaction.reason, "threshold");
        assert.equal(compaction.aborted, false);
        assert.ok(compaction.result.summary.includes(memory));
        assert.ok(summaries.length > 0, "automatic compaction must summarize the real history");
        const files = (await readdir(join(root, "sessions"))).filter((file) => file.endsWith(".jsonl"));
        assert.equal(files.length, 1);
        const [continuedCode] = await launch(["--session", join(root, "sessions", files[0]), continuation]);
        assert.equal(continuedCode, 0, output);
        assert.deepEqual(failures, [], output);
        assert.equal(mainReceived.length, 4);
        assert.equal(recordedBeforeResponse.length, received.length);
      }
      assert.deepEqual(
        events
          .filter((event) => event.type === "tool_execution_end")
          .map((event) => [event.toolName, event.isError]),
        [
          ["enable_tools", false],
          ["list_applications", false]
        ]
      );
      const finalEvent = events.findLast(
        (event) => event.type === "message_end" && event.message.role === "assistant"
      );
      assert.equal(text(finalEvent.message.content), finalText);

      const rows = await readRows(recordingPath);
      const requests = rows.filter((row) => row.type === "model_request");
      const responses = rows.filter((row) => row.type === "model_response");
      const httpResponses = rows.filter((row) => row.type === "model_response_http");
      assert.equal(responses.length, requests.length);
      assert.equal(httpResponses.length, requests.length);
      assert.equal(new Set(requests.map((row) => row.requestId)).size, requests.length);
      const recorderIds = new Set(rows.map((row) => row.recorderId));
      assert.equal(recorderIds.size, compact ? 2 : 1, "restarted Main must identify its new recorder");
      for (const recorderId of recorderIds) {
        const producerRows = rows.filter((row) => row.recorderId === recorderId);
        assert.equal(typeof recorderId, "string");
        assert.deepEqual(
          producerRows.map((row) => row.sequence),
          producerRows.map((_, index) => index + 1)
        );
      }
      assert.deepEqual(
        rows.slice(0, firstProcessRows.length),
        firstProcessRows,
        "a restarted Main must append rather than overwrite prior requests"
      );
      for (const request of requests) {
        const response = responses.find((row) => row.requestId === request.requestId);
        const httpResponse = httpResponses.find((row) => row.requestId === request.requestId);
        assert.ok(response, "each response must identify its originating model request");
        assert.equal(httpResponse.payload.status, 200);
        assert.ok(request.sequence < httpResponse.sequence && httpResponse.sequence < response.sequence);
        assert.equal(response.payload.message.model, "protocol-fixture");
        assert.equal(response.payload.message.api, api);
        assert.equal(typeof response.payload.message.usage.totalTokens, "number");
      }
      assert.equal(responses.at(-1).payload.message.stopReason, "stop");
      assert.equal(text(responses.at(-1).payload.message.content), finalText);
      assert.deepEqual(
        requests.map((row) => row.payload.request),
        received
      );
      assert.ok(
        rows.every(
          (row) =>
            row.schemaVersion === 1 && row.taskId === taskId && row.runId === runId && row.agentId === "main"
        )
      );
      assert.ok(rows.every((row) => row.producer.version !== "unknown" && row.producer.piCodingAgent));
      assert.ok(!(await readFile(recordingPath, "utf8")).includes(credential));
      if (process.platform !== "win32") assert.equal((await stat(recordingPath)).mode & 0o777, 0o600);
    }
  );
}
