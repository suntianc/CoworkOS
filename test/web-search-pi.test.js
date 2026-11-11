import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

async function searchFixture(t) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req.setEncoding("utf8")) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (req.method === "DELETE" || body.method?.startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    let result;
    if (body.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "local-exa", version: "1" }
      };
    else if (body.method === "tools/list") result = { tools: [] };
    else {
      calls.push(body.params);
      result = {
        content: [
          {
            type: "text",
            text:
              body.params.name === "web_search_exa"
                ? "Title: Public paper\nURL: https://example.org/paper\nPublished: 2026-10-01\nHighlights:\nSearch evidence."
                : "# Public paper\nURL: https://example.org/paper\n\nFetched source evidence."
          }
        ]
      };
    }
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "pi-fixture" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}/mcp`, calls };
}

test(
  "real Pi Main discovers search first turn, reads sources, delegates and resumes the same anonymous config",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-web-pi-"));
    const project = join(root, "project"),
      workspace = join(root, "workspace"),
      sessions = join(root, "sessions");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("search-task", { goal: "search" });
    await store.createRun("search-task", "search-run");
    const exa = await searchFixture(t);
    const failures = [],
      mainRequests = [],
      delegateRequests = [];
    let mainStep = 0,
      delegateStep = 0,
      phase = "first",
      child;
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      const main = body.tools.some((tool) => tool.function.name === "call_subagent");
      const names = body.tools.map((tool) => tool.function.name);
      (main ? mainRequests : delegateRequests).push(body);
      try {
        assert.ok(names.includes("search"), `${main ? "Main" : "delegate"} must discover default search`);
        assert.ok(names.includes("visit"));
        if (main) {
          const step = mainStep++;
          if (step === 0) return { name: "search", arguments: { query: `${phase} main public paper` } };
          if (step === 1) {
            const result = JSON.parse(body.messages.findLast((message) => message.role === "tool").content);
            assert.equal(result.sources[0].url, "https://example.org/paper");
            return { name: "visit", arguments: { url: result.sources[0].url } };
          }
          if (step === 2) {
            assert.match(
              body.messages.findLast((message) => message.role === "tool").content,
              /Fetched source evidence/
            );
            return {
              name: "call_subagent",
              arguments: {
                task: "Independently search and read the public paper; cite https://example.org/paper",
                mode: "sync"
              }
            };
          }
          return { text: "Main and delegate verified source: [Public paper](https://example.org/paper)." };
        }
        const step = delegateStep++;
        if (step === 0) return { name: "search", arguments: { query: "delegate public paper" } };
        if (step === 1) return { name: "visit", arguments: { url: "https://example.org/paper" } };
        return { text: "Read source evidence: https://example.org/paper" };
      } catch (error) {
        failures.push(error.message);
        return { text: `Fixture failed: ${error.message}` };
      }
    });
    let output = "";
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await provider.close();
      await rm(root, { recursive: true, force: true });
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^(?:COWORK_|PI_|ATRIA_|SERPER_|EXA_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)/.test(
            name
          )
      )
    );
    Object.assign(env, {
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_WORKSPACE: workspace,
      COWORK_PROJECT_DIR: project,
      COWORK_TASK_ID: "search-task",
      COWORK_RUN_ID: "search-run",
      COWORK_TABS_INDEX: join(root, "tabs.json"),
      COWORK_API_BASE: provider.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_EXA_MCP_ENDPOINT: exa.endpoint,
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0"
    });
    const run = async (extra = []) => {
      child = spawn(
        process.execPath,
        [
          "scripts/atria.mjs",
          "--print",
          "--mode",
          "json",
          "--session-dir",
          sessions,
          ...extra,
          `${phase}: search paper, read source, delegate and cite links`
        ],
        { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] }
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const [code] = await once(child, "exit");
      assert.equal(code, 0, output);
      assert.deepEqual(failures, [], output);
    };
    await run();
    assert.ok(mainRequests.length >= 4);
    assert.ok(delegateRequests.length >= 3);
    const [session] = (await readdir(sessions)).filter((name) => name.endsWith(".jsonl"));
    assert.ok(session);
    const original = await readFile(join(sessions, session), "utf8");
    assert.match(original, /https:\/\/example.org\/paper/);
    phase = "restart";
    mainStep = 0;
    delegateStep = 0;
    await run(["--session", join(sessions, session)]);
    assert.equal(exa.calls.filter((call) => call.name === "web_search_exa").length, 4);
    assert.equal(exa.calls.filter((call) => call.name === "web_fetch_exa").length, 4);
    assert.ok(
      mainRequests
        .at(-1)
        .messages.some((message) => JSON.stringify(message).includes("Main and delegate verified source")),
      "Pi history survives restart"
    );
    assert.match(output, /Main and delegate verified source/);
  }
);
