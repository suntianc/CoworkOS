import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { protocolStream } from "./model-protocol-fixture.mjs";

for (const api of ["openai-completions", "openai-responses"]) {
  for (const enabled of [false, true]) {
    test(
      `${api}: Main ${enabled ? "opt-in" : "default"} cache policy and usage survive a real Pi restart`,
      { timeout: 30000 },
      async (t) => {
        const root = await mkdtemp(join(tmpdir(), "atria-main-cache-"));
        const workspace = join(root, "workspace");
        const project = join(root, "project");
        const sessions = join(root, "sessions");
        const requests = [];
        let child;
        let childExit;
        let output = "";
        const server = createServer(async (req, res) => {
          let raw = "";
          for await (const chunk of req.setEncoding("utf8")) raw += chunk;
          requests.push(JSON.parse(raw));
          const reported = requests.length > 1;
          const usage =
            api === "openai-completions"
              ? {
                  prompt_tokens: 100,
                  completion_tokens: 10,
                  ...(reported ? { prompt_cache_hit_tokens: 0 } : {})
                }
              : {
                  input_tokens: 100,
                  output_tokens: 10,
                  total_tokens: 110,
                  ...(reported ? { input_tokens_details: { cached_tokens: 0 } } : {})
                };
          usage.api_key = "upstream-usage-secret";
          let stream = protocolStream(api, { text: "缓存验证完成" });
          if (api === "openai-completions")
            stream = stream.replace(
              "data: [DONE]",
              `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]`
            );
          else
            stream = stream.replace(
              '"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":20}',
              `"usage":${JSON.stringify(usage)}`
            );
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(stream);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(async () => {
          if (child?.pid && child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already exited */
            }
            await childExit;
          }
          server.closeAllConnections();
          await new Promise((done) => server.close(done));
          await rm(root, { recursive: true, force: true });
        });
        await mkdir(project);
        await writeFile(join(root, "config.json"), JSON.stringify({ supportsPromptCacheKey: enabled }));
        const store = new LocalWorkspaceStore(workspace);
        await store.createTask("cache-task", { goal: "缓存测试" });
        await store.createRun("cache-task", "cache-run");
        const inherited = Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name)
          )
        );
        const env = {
          ...inherited,
          ATRIA_HOME: join(root, "atria"),
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: workspace,
          COWORK_PROJECT_DIR: project,
          COWORK_TASK_ID: "cache-task",
          COWORK_RUN_ID: "cache-run",
          COWORK_GLOBAL_INDEX: join(root, "global.json"),
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-test-key",
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
        const launch = async (args) => {
          child = spawn(
            process.execPath,
            ["scripts/start-pi.mjs", "--print", "--mode", "json", "--session-dir", sessions, ...args],
            { cwd: resolve("."), env, detached: true, stdio: ["ignore", "pipe", "pipe"] }
          );
          childExit = once(child, "exit");
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          const [code] = await childExit;
          assert.equal(code, 0, output);
        };
        await launch(["--session-id", "11111111-1111-4111-8111-111111111111", "缓存测试"]);
        const files = (await readdir(sessions)).filter((file) => file.endsWith(".jsonl"));
        assert.equal(files.length, 1);
        await launch(["--session", join(sessions, files[0]), "第二轮缓存测试"]);
        assert.equal(requests.length, 2, output);
        if (enabled) {
          assert.equal(typeof requests[0].prompt_cache_key, "string");
          assert.equal(requests[1].prompt_cache_key, requests[0].prompt_cache_key);
        } else assert.ok(requests.every((body) => body.prompt_cache_key === undefined));
        const archive = await readFile(
          join(workspace, "cache-task", "sessions", "main", "cache-run-requests.jsonl"),
          "utf8"
        );
        assert.ok(!archive.includes("upstream-usage-secret"));
        const rows = archive.trim().split("\n").map(JSON.parse);
        assert.deepEqual(
          rows.filter((row) => row.type === "model_request").map((row) => row.payload.request),
          requests
        );
        assert.deepEqual(
          rows
            .filter((row) => row.type === "model_response")
            .map((row) => row.payload.message.usage.cacheReadReported),
          [false, true]
        );
        const nativeRows = (await readFile(join(sessions, files[0]), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.deepEqual(
          nativeRows
            .filter((row) => row.type === "message" && row.message.role === "assistant")
            .map((row) => row.message.usage.cacheReadReported),
          [false, true]
        );
      }
    );
  }
}
