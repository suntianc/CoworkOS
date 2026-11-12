import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { protocolStream } from "./model-protocol-fixture.mjs";

const harness = resolve(process.env.TEST_ATRIA_CLI_ROOT || ".");
const node = process.env.TEST_ATRIA_NODE || process.execPath;
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const nodeCommand = (source) => quote(node) + " -e " + quote(source);
const expected = "ENV=coworkos;ENGINE=true\n" + "完整输出\n".repeat(12000);

async function fixture(t, command) {
  const root = await mkdtemp(join(tmpdir(), "atria-shell-identity-"));
  const profile = join(root, "profile"),
    project = join(root, "project");
  await mkdir(profile);
  await mkdir(project);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const data of req) raw += data;
    const body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      protocolStream(
        "openai-completions",
        body.messages.some((m) => m.role === "tool")
          ? { text: "SHELL_COMPLETED" }
          : { name: "bash", arguments: { command } }
      )
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ baseUrl, apiKey: "fixture-local", model: "fixture" })
  );
  await writeFile(
    join(profile, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl,
          api: "openai-completions",
          apiKey: "fixture-local",
          models: [
            {
              id: "fixture",
              name: "fixture",
              contextWindow: 32768,
              maxTokens: 1024,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  );
  const extension = join(root, "custom-extension.mjs");
  await writeFile(extension, "export default function() {}\n");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(COWORK_|PI_|ATRIA_|OPENAI_|ANTHROPIC_|NODE_OPTIONS)/.test(k)
      )
    ),
    HOME: root,
    ATRIA_HOME: join(root, "home"),
    TMPDIR: root,
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_HARNESS_ROOT: harness,
    COWORK_WORKSPACE: join(root, "workspace"),
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    COWORK_API_BASE: baseUrl,
    COWORK_API_KEY: "fixture-local",
    COWORK_MODEL: "fixture",
    COWORK_MODEL_API: "openai-completions",
    COWORK_REASONING_EFFORT: "off",
    PI_CODING_AGENT_DIR: profile,
    PI_OFFLINE: "1",
    AI_AGENT: "outside-user-value"
  };
  const child = spawn(
    node,
    [
      join(harness, "scripts/atria.mjs"),
      "start",
      "--mode",
      "rpc",
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--thinking",
      "off",
      "--no-approve",
      "--extension",
      extension,
      "--no-skills",
      "--no-context-files"
    ],
    { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] }
  );
  const exit = once(child, "close");
  const pending = new Map(),
    events = [];
  let buffer = "",
    stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  child.stdout.on("data", (b) => {
    buffer += b;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"),
        line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(value);
      if (value.type === "response" && pending.has(value.id)) {
        const request = pending.get(value.id);
        pending.delete(value.id);
        clearTimeout(request.timer);
        value.success ? request.resolve(value.data) : request.reject(new Error(JSON.stringify(value)));
      }
    }
  });
  child.once("close", () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(stderr || "CLI closed"));
    }
    pending.clear();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    let killTimer;
    try {
      await Promise.race([
        exit,
        new Promise((r) => {
          killTimer = setTimeout(r, 3000);
        })
      ]);
    } finally {
      clearTimeout(killTimer);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const request = (type, values = {}) =>
    new Promise((resolve, reject) => {
      const id = "request-" + events.length + "-" + pending.size;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("RPC " + type + " timed out: " + stderr));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, type, ...values }) + "\n");
    });
  await request("get_state");
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Missing RPC event: " + stderr);
  };
  return { root, request, waitFor, events };
}

test(
  "public RPC shell exposes CoworkOS identity, retains the engine marker and creates a readable CoworkOS output file",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const result = await f.request("bash", {
      command: nodeCommand(
        'console.log("ENV="+process.env.AI_AGENT+";ENGINE="+process.env.PI_CODING_AGENT);process.stdout.write("完整输出\\n".repeat(12000));'
      )
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.cancelled, false);
    assert.equal(result.truncated, true);
    assert.match(basename(result.fullOutputPath), /^atria-bash-[a-f0-9]+\.log$/);
    assert.equal(await readFile(result.fullOutputPath, "utf8"), expected);
    const failure = await f.request("bash", { command: nodeCommand("process.exit(7)") });
    assert.equal(failure.exitCode, 7);
    assert.equal(failure.cancelled, false);
    const running = f.request("bash", { command: nodeCommand("setTimeout(()=>{},30000)") });
    await new Promise((r) => setTimeout(r, 150));
    await f.request("abort_bash");
    const aborted = await running;
    assert.equal(aborted.cancelled, true);
  }
);

test(
  "model-issued native bash and its streaming/final metadata point to the same genuine CoworkOS file",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      nodeCommand(
        'console.log("ENV="+process.env.AI_AGENT+";ENGINE="+process.env.PI_CODING_AGENT);process.stdout.write("完整输出\\n".repeat(12000));'
      )
    );
    await f.request("prompt", { message: "Execute the fixture shell once." });
    const end = await f.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash");
    assert.equal(end.isError, false);
    const path = end.result.details.fullOutputPath;
    assert.match(basename(path), /^atria-bash-[a-f0-9]+\.log$/);
    assert.equal(await readFile(path, "utf8"), expected);
    assert.ok(end.result.content.some((p) => p.text?.includes(path)));
    for (const event of f.events.filter(
      (e) => e.type === "tool_execution_update" && e.partialResult?.details?.fullOutputPath
    ))
      assert.equal(event.partialResult.details.fullOutputPath, path);
  }
);
