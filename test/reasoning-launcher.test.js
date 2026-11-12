import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const runFile = promisify(execFile);
const launcherPath = resolve("scripts/start-pi.mjs");
const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

async function launch({ args = [], config = {}, env = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-reasoning-launcher-"));
  try {
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(
      join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi"),
      `
console.log(JSON.stringify({
  args: process.argv.slice(2),
  dataHome: process.env.ATRIA_HOME,
  globalIndex: process.env.COWORK_GLOBAL_INDEX,
  thinkingLevel: process.env.COWORK_REASONING_EFFORT,
  thinkingFormat: process.env.COWORK_THINKING_FORMAT,
  supportsReasoningEffort: process.env.COWORK_SUPPORTS_REASONING_EFFORT
}));
`
    );
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const launchEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(COWORK_|PI_|ATRIA_)/.test(key))
    );
    const { stdout } = await runFile(process.execPath, [launcherPath, ...args], {
      cwd: root,
      env: {
        ...launchEnv,
        ATRIA_HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "pi"),
        COWORK_GLOBAL_INDEX: join(root, "global.json"),
        COWORK_CONFIG: configPath,
        COWORK_DISABLE_MAIN_GUARDIAN: "1",
        ...env
      }
    });
    return JSON.parse(stdout.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function thinkingArg(result) {
  return result.args[result.args.indexOf("--thinking") + 1];
}

test("Pi launcher explicitly applies high when starting or continuing an old session", async () => {
  for (const args of [[], ["--continue"]]) {
    const result = await launch({ args });
    assert.equal(thinkingArg(result), "high");
    assert.equal(result.thinkingLevel, "high");
    assert.equal(result.supportsReasoningEffort, "1");
    assert.equal(result.globalIndex, join(result.dataHome, "..", "global.json"));
  }
});

test("Pi launch reasoning settings honor CLI, environment, then local config", async () => {
  const config = { reasoningEffort: "max", supportsReasoningEffort: false };
  const configured = await launch({ config });
  assert.equal(thinkingArg(configured), "max");
  assert.equal(configured.supportsReasoningEffort, "0");

  const env = { COWORK_REASONING_EFFORT: "low", COWORK_SUPPORTS_REASONING_EFFORT: "1" };
  const overridden = await launch({ config, env });
  assert.equal(thinkingArg(overridden), "low");
  assert.equal(overridden.supportsReasoningEffort, "1");

  const explicit = await launch({ config, env, args: ["--continue", "--thinking", "off"] });
  assert.equal(thinkingArg(explicit), "off");
  assert.equal(explicit.thinkingLevel, "off");
  assert.equal(explicit.args.filter((arg) => arg === "--thinking").length, 1);

  const canonical = await launch({
    env: { COWORK_REASONING_EFFORT: "hight" },
    args: ["--thinking", " high "]
  });
  assert.equal(thinkingArg(canonical), "high", "the normalized value must reach Pi's strict native parser");
});

test("Pi launcher preserves explicit thinking format and its environment override", async () => {
  assert.equal((await launch()).thinkingFormat, "auto");
  assert.equal((await launch({ config: { thinkingFormat: "zai" } })).thinkingFormat, "zai");
  assert.equal(
    (await launch({ config: { thinkingFormat: "zai" }, env: { COWORK_THINKING_FORMAT: "openai" } }))
      .thinkingFormat,
    "openai"
  );
  await assert.rejects(launch({ config: { thinkingFormat: "invalid" } }), /thinkingFormat/);
});

test("Pi launcher rejects misspelled or missing effort before starting the model", async () => {
  for (const options of [
    { env: { COWORK_REASONING_EFFORT: "hight" } },
    { config: { reasoningEffort: "hight" } },
    { args: ["--thinking", "hight"] },
    { args: ["--thinking"] }
  ]) {
    await assert.rejects(launch(options), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /reasoning|thinking/);
      assert.equal(error.stdout, "");
      return true;
    });
  }
});

test("Pi launcher treats --thinking after -- as prompt text", async () => {
  const result = await launch({ args: ["--", "--thinking", "off"] });
  assert.equal(thinkingArg(result), "high");
  assert.deepEqual(result.args.slice(-3), ["--", "--thinking", "off"]);
});

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

function fakePi(initialThinkingLevel = "off") {
  let thinkingLevel = initialThinkingLevel;
  const tools = new Map();
  const handlers = new Map();
  const providers = new Map();
  const selected = [];
  return {
    tools,
    handlers,
    providers,
    selected,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerProvider(name, provider) {
      providers.set(name, provider);
    },
    registerCommand() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendMessage: async () => {},
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level) {
      selected.push(level);
      thinkingLevel = level;
    }
  };
}

test("Cowork provider, recovered calls and new delegations use the active Main effort", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-reasoning-extension-"));
  const keys = [
    "ATRIA_HOME",
    "PI_CODING_AGENT_DIR",
    "COWORK_GLOBAL_INDEX",
    "COWORK_CONFIG",
    "COWORK_API_BASE",
    "COWORK_API_KEY",
    "COWORK_WORKSPACE",
    "COWORK_TASK_ID",
    "COWORK_RUN_ID",
    "COWORK_REASONING_EFFORT",
    "COWORK_SUPPORTS_REASONING_EFFORT"
  ];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousArgv = process.argv;
  const recoveries = [];
  const dispatches = [];
  const pendingDeliveries = new Set();
  const deliver = MainInboxDelivery.prototype.deliver;
  t.mock.method(MainInboxDelivery.prototype, "deliver", function (...args) {
    const pending = deliver.apply(this, args);
    pendingDeliveries.add(pending);
    void pending.finally(() => pendingDeliveries.delete(pending)).catch(() => {});
    return pending;
  });
  t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  t.mock.method(CoordinatorRuntime.prototype, "recoverRun", async (input) => {
    recoveries.push(input);
    return [];
  });
  t.mock.method(CoordinatorRuntime.prototype, "dispatch", async (input) => {
    dispatches.push(input);
    input.onQueued?.();
    return { ...input, status: "succeeded", response: "Complete", artifacts: [] };
  });
  try {
    for (const key of keys) delete process.env[key];
    await writeFile(join(root, "config.json"), "{}\n");
    Object.assign(process.env, {
      ATRIA_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_API_BASE: "https://example.test",
      COWORK_API_KEY: "test-key",
      COWORK_WORKSPACE: root,
      COWORK_TASK_ID: "reasoning",
      COWORK_RUN_ID: "main"
    });
    process.argv = [process.execPath, "pi"];
    await new LocalWorkspaceStore(root).createTask("reasoning", { goal: "Reasoning regression" });
    const extension = await loadExtension();
    const pi = fakePi("off");
    extension(pi);
    const ctx = { sessionManager: SessionManager.inMemory(), ui: { setStatus() {}, notify() {} } };
    await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
    assert.equal(pi.getThinkingLevel(), "high", "direct extension startup must replace a legacy off default");
    assert.equal(pi.providers.get("cowork-glm").models[0].compat.supportsReasoningEffort, true);
    assert.equal(recoveries[0].thinkingLevel, "high");
    assert.equal(recoveries[0].supportsReasoningEffort, true);

    for (const level of ["low", "max", "off"]) {
      pi.setThinkingLevel(level);
      await pi.tools
        .get("call_subagent")
        .execute(`call-${level}`, { task: "Bounded subtask", mode: "sync" }, undefined, undefined, ctx);
      assert.equal(dispatches.at(-1).thinkingLevel, level);
      assert.equal(dispatches.at(-1).supportsReasoningEffort, true);
    }
    await pi.handlers.get("context")({ messages: [] }, ctx);

    process.argv = [process.execPath, "pi", "--thinking", "off"];
    process.env.COWORK_SUPPORTS_REASONING_EFFORT = "0";
    const explicit = fakePi("off");
    extension(explicit);
    await explicit.handlers.get("session_start")({ reason: "startup" }, ctx);
    assert.deepEqual(explicit.selected, [], "session_start must not overwrite native CLI --thinking off");
    assert.equal(explicit.providers.get("cowork-glm").models[0].compat.supportsReasoningEffort, false);
    assert.equal(recoveries.at(-1).thinkingLevel, "off");
    assert.equal(recoveries.at(-1).supportsReasoningEffort, false);
  } finally {
    // Startup recovery queues Inbox delivery asynchronously. Drain both fake
    // sessions before removing their workspace; heartbeat writes can also be
    // finishing as the harness shuts down.
    try {
      while (pendingDeliveries.size) await Promise.all([...pendingDeliveries]);
    } finally {
      process.argv = previousArgv;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  }
});
