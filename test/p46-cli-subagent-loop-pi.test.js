import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { createSubagentClient } from "../dist/src/runtime/subagent-client.js";

/**
 * A CLI run with no Dashboard still delegates through a backend.
 *
 * The CLI host assembles the same subagent backend in its own process, so Main
 * asks it for a work item and the item runs as a real delegated Pi process —
 * not inside Main's process, and not through a second execution loop.
 */

const harness = resolve(".");
const exec = promisify(execFile);

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");

function roleOf(body) {
  const system = body.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map(messageText)
    .join("\n");
  return system.includes("You are a CoworkOS Subagent") ? "subagent" : "main";
}

test(
  "the CLI host serves delegation so a subagent runs as its own Pi process",
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-cli-loop-"));
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    const taskId = "cli-loop-task";
    const runId = "cli-loop-run";
    await mkdir(project, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const steps = { main: 0, subagent: 0 };
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      const role = roleOf(body);
      const step = steps[role]++;
      if (role === "main")
        return step === 0
          ? {
              name: "call_subagent",
              arguments: {
                task: "CLI_SUBAGENT_MARKER：写入 marker.txt 并返回结论。",
                mode: "sync",
                role: "executor"
              }
            }
          : { text: "CLI_MAIN_DONE" };
      if (step === 0)
        return {
          name: "bash",
          arguments: { command: 'printf "delegated\\n" > marker.txt && echo SUBAGENT_WROTE_MARKER' }
        };
      return { text: "CLI_SUBAGENT_DONE" };
    });
    t.after(() => provider.close());
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: "cli-fixture-key",
        model: "protocol-fixture",
        api: "openai-completions",
        supportsReasoningEffort: false
      })
    );
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|EXA_|NODE_OPTIONS)/.test(name))
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const pending = exec(
      process.execPath,
      [join(harness, "scripts", "start-pi.mjs"), "--print", "--mode", "json", "派单并等待结果"],
      {
        cwd: project,
        timeout: 150_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...cleanEnv,
          COWORK_CONFIG: configPath,
          COWORK_HARNESS_ROOT: harness,
          COWORK_PROJECT_DIR: project,
          COWORK_WORKSPACE: workspace,
          COWORK_TASK_ID: taskId,
          COWORK_RUN_ID: runId,
          COWORK_DISABLE_MAIN_GUARDIAN: "1",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    // --print reads from stdin as well as the prompt argument; EOF lets it start.
    pending.child.stdin.end();
    const { stdout, stderr } = await pending;
    assert.match(stdout, /CLI_MAIN_DONE/, stderr.slice(-2000));
    assert.equal(steps.subagent, 2, "the delegated process ran its own model turns");

    const runRoot = join(workspace, taskId, "runs", runId);
    const queue = JSON.parse(await readFile(join(runRoot, "queue.json"), "utf8"));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].status, "completed", JSON.stringify(queue[0]));
    assert.equal(queue[0].attempts, 1);

    const agents = await readdir(join(runRoot, "agents", "subagents"));
    assert.equal(agents.length, 1, "one delegated process directory");
    const record = JSON.parse(
      await readFile(join(runRoot, "agents", "subagents", agents[0], "process.json"), "utf8")
    );
    assert.ok(Number.isInteger(record.pid), "a real process was launched");
    assert.equal(record.role, "executor");
    assert.ok(record.settledAt, "the CLI host settled the process");
    const result = JSON.parse(await readFile(record.resultPath, "utf8"));
    assert.match(result.response, /CLI_SUBAGENT_DONE/);

    const owner = JSON.parse(await readFile(join(workspace, ".runtime", "subagent-owner.json"), "utf8"));
    assert.equal(owner.kind, "worker", "the CLI host claims the root as a worker backend");

    const inbox = JSON.parse(await readFile(join(runRoot, "agents", "main", "inbox-store.json"), "utf8"));
    assert.ok(
      inbox.some((message) => message.kind === "callback" && message.callId === queue[0].stepId),
      "Main reads the result from its durable Inbox"
    );
    assert.equal(await readFile(join(project, "marker.txt"), "utf8"), "delegated\n");
  }
);

test("a CLI run that yielded to a live app backend says where to run instead", () => {
  const names = [
    "COWORK_DASHBOARD_URL",
    "COWORK_API_TOKEN",
    "COWORK_SUBAGENT_BACKEND_URL",
    "COWORK_SUBAGENT_BACKEND_TOKEN",
    "COWORK_SUBAGENT_UNAVAILABLE"
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.COWORK_SUBAGENT_UNAVAILABLE = "workspace_owned";
    assert.throws(
      () => createSubagentClient({ taskId: "owned-task" }),
      /工作区由正在运行的应用后端管理.*请在应用中运行.*关闭应用后重试/
    );
    delete process.env.COWORK_SUBAGENT_UNAVAILABLE;
    assert.throws(() => createSubagentClient({ taskId: "owned-task" }), /没有本地服务地址/);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
