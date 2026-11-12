import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { testModelConnection } from "../dist/src/runtime/model-connection.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

const exec = promisify(execFile);
const profiles = [
  { reasoningEffort: "off", supportsReasoningEffort: true },
  { reasoningEffort: "low", supportsReasoningEffort: true, supportsPromptCacheKey: true },
  { reasoningEffort: "high", supportsReasoningEffort: false },
  { reasoningEffort: "minimal", supportsReasoningEffort: true, rejected: true }
];

for (const api of ["openai-completions", "openai-responses"]) {
  for (const profile of [
    ...profiles,
    ...(api === "openai-completions"
      ? [{ reasoningEffort: "off", supportsReasoningEffort: true, thinkingFormat: "zai" }]
      : [])
  ]) {
    test(
      `${api}: probe, real Main and delegated session agree on ${JSON.stringify(profile)}`,
      { timeout: 45000 },
      async (t) => {
        const root = await mkdtemp(join(tmpdir(), "atria-connection-parity-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const project = join(root, "project");
        await mkdir(project);
        const received = [];
        const replies = [];
        const responses = api === "openai-responses";
        const expected = {
          path: responses ? "/v1/responses" : "/v1/chat/completions",
          model: "protocol-fixture",
          stream: true,
          maxTokens: 1024,
          effort:
            profile.supportsReasoningEffort && profile.reasoningEffort !== "off"
              ? profile.reasoningEffort
              : undefined,
          thinking: profile.thinkingFormat === "zai" ? { type: "disabled" } : undefined,
          cacheKey: profile.supportsPromptCacheKey === true,
          messages: true,
          wrongProtocolMessages: false
        };
        const server = createServer(async (request, response) => {
          let raw = "";
          for await (const part of request) raw += part;
          const body = JSON.parse(raw);
          const contract = {
            path: request.url,
            model: body.model,
            stream: body.stream,
            maxTokens: responses ? body.max_output_tokens : body.max_completion_tokens,
            effort: responses ? body.reasoning?.effort : body.reasoning_effort,
            thinking: body.thinking,
            cacheKey: typeof body.prompt_cache_key === "string",
            messages: Array.isArray(responses ? body.input : body.messages),
            wrongProtocolMessages: (responses ? body.messages : body.input) !== undefined
          };
          received.push(contract);
          const rejected =
            contract.effort !== undefined && !["low", "medium", "high"].includes(contract.effort);
          replies.push(rejected ? 422 : 200);
          if (rejected) {
            response.writeHead(422, { "content-type": "application/json" });
            return response.end(
              JSON.stringify({ error: { message: "reasoning_effort must be low, medium or high" } })
            );
          }
          const probe = body.tools?.some(
            (tool) => (responses ? tool.name : tool.function?.name) === "atria_connection_check"
          );
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            protocolStream(
              api,
              probe
                ? {
                    name: "atria_connection_check",
                    arguments: { status: "connected", color: "none", code: "none" }
                  }
                : { text: "CONNECTION_PARITY_CONFIRMED" }
            )
          );
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(async () => {
          server.closeAllConnections();
          await new Promise((done) => server.close(done));
        });
        const config = {
          api,
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: "isolated-parity-fixture",
          model: expected.model,
          thinkingFormat: "openai",
          mainMaxTokens: 1024,
          ...profile
        };
        if (profile.rejected) await assert.rejects(testModelConnection(config), /HTTP 422/);
        else assert.equal((await testModelConnection(config)).ok, true);

        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify(config));
        const cleanEnv = Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !/^(COWORK_|ATRIA_|PI_|SERPER_)/.test(name))
        );
        const pending = exec(
          process.execPath,
          ["scripts/start-pi.mjs", "--print", "--mode", "json", "Confirm this connection."],
          {
            cwd: resolve("."),
            timeout: 35000,
            maxBuffer: 4000000,
            env: {
              ...cleanEnv,
              // Keep every host-owned path inside this disposable fixture.
              ATRIA_HOME: join(root, "home"),
              COWORK_CONFIG: configPath,
              COWORK_PROJECT_DIR: project,
              COWORK_WORKSPACE: join(root, "workspace"),
              COWORK_TASK_ID: "parity-task",
              COWORK_RUN_ID: "parity-run",
              PI_CODING_AGENT_DIR: join(root, "pi"),
              COWORK_DISABLE_WATCH_SUPERVISOR: "1",
              PI_OFFLINE: "1"
            }
          }
        );
        pending.child.stdin.end();
        const result = await pending.catch((error) => {
          if (!profile.rejected) throw error;
          return error;
        });
        const events = result.stdout.trim().split("\n").map(JSON.parse);
        const last = events.findLast((event) => event.type === "message_end")?.message;
        assert.ok(last, result.stderr);
        assert.equal(last.stopReason === "error", profile.rejected === true, last.errorMessage);
        if (profile.rejected) assert.match(last.errorMessage, /422/);
        else assert.ok(result.stdout.includes("CONNECTION_PARITY_CONFIRMED"), result.stderr);

        const delegated = await new PiSession({
          ...config,
          thinkingLevel: profile.reasoningEffort,
          maxTokens: 1024,
          maxErrorRetries: 0,
          maxTurns: 1,
          tools: new Map()
        }).run("Confirm this connection.");
        assert.equal(delegated.termination, profile.rejected ? "aborted" : "completed");
        assert.deepEqual(received, [expected, expected, expected]);
        assert.deepEqual(replies, Array(3).fill(profile.rejected ? 422 : 200));
      }
    );
  }
}
