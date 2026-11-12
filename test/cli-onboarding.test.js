import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const exec = promisify(execFile);
const entry = resolve(process.env.ATRIA_TEST_CLI_ENTRY || "scripts/atria.mjs");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-onboarding-"));
  const project = join(root, "project"),
    user = join(root, "user");
  await mkdir(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("COWORK_") && !name.startsWith("PI_") && name !== "ATRIA_HOME"
    )
  );
  Object.assign(env, {
    ATRIA_HOME: user,
    COWORK_API_KEY: "private-cli-fixture-key",
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  });
  const run = (args, extra = {}) => {
    const pending = exec(process.execPath, [entry, ...args], {
      cwd: project,
      env: { ...env, ...extra },
      timeout: 25000,
      maxBuffer: 1024 * 1024
    });
    pending.child.stdin.end(); // A print-mode Pi reads piped input until EOF.
    return pending;
  };
  return { root, project, user, env, run, config: join(user, "config.json") };
}

test("CLI setup uses private user data, checks without model requests, and refuses accidental overwrite", async (t) => {
  const f = await fixture(t);
  const result = await f.run([
    "init",
    "--base-url",
    "https://example.com/v1",
    "--model",
    "fixture",
    "--api-key-env",
    "COWORK_API_KEY"
  ]);
  assert.ok(!result.stdout.includes(f.env.COWORK_API_KEY));
  const config = JSON.parse(await readFile(f.config, "utf8"));
  assert.equal(config.api, "openai-responses");
  assert.equal(config.supportsReasoningEffort, false);
  assert.equal(config.reasoningEffort, "off");
  assert.equal(config.mainMaxTokens, 8192);
  assert.equal(config.workspaceRoot, join(f.user, "workspace"));
  assert.equal((await stat(f.config)).mode & 0o777, 0o600);
  const doctor = await f.run(["doctor"]);
  assert.match(doctor.stdout, /OK.*模型配置/);
  assert.match(doctor.stdout, /未发送模型请求/);
  assert.ok(!doctor.stdout.includes(f.env.COWORK_API_KEY));
  await assert.rejects(f.run(["init"]), (error) => /未覆盖/.test(error.stderr));
  assert.equal(await readFile(f.config, "utf8"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(
    f.config,
    JSON.stringify({
      ...config,
      api: "openai-completions",
      workspaceRoot: join(f.root, "retained"),
      mainMaxTurns: 77
    })
  );
  await f.run(["init", "--force", "--reasoning", "--thinking", "low", "--max-tokens", "4096"]);
  const updated = JSON.parse(await readFile(f.config, "utf8"));
  assert.equal(
    updated.api,
    "openai-completions",
    "init --force preserves explicitly selected legacy formats"
  );
  assert.equal(updated.workspaceRoot, join(f.root, "retained"));
  assert.equal(updated.mainMaxTurns, 77);
  assert.equal(updated.reasoningEffort, "low");
  assert.equal(updated.supportsReasoningEffort, true);
  assert.equal(updated.subagentMaxTokens, 4096);
  const legacy = { ...updated };
  delete legacy.api;
  await writeFile(f.config, JSON.stringify(legacy));
  await f.run(["init", "--force"]);
  assert.equal(JSON.parse(await readFile(f.config, "utf8")).api, "openai-completions");
  const explicit = join(f.root, "explicit.json");
  await writeFile(explicit, JSON.stringify({ ...updated, workspaceRoot: "relative-data" }));
  const explicitDoctor = await f.run(["doctor"], { COWORK_CONFIG: explicit });
  assert.match(explicitDoctor.stdout, /OK.*工作区写入/);
  await f.run(["task", "create", "path-test", "--goal", "Verify project-relative task data"], {
    COWORK_CONFIG: explicit
  });
  const tasks = await f.run(["task", "list"], { COWORK_CONFIG: explicit });
  assert.match(tasks.stdout, /path-test/);
  assert.equal((await stat(join(f.project, "relative-data", "path-test"))).isDirectory(), true);
});

test("CLI selects project configuration and reports malformed secrets without disclosing them", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, ".cowork"));
  const path = join(f.project, ".cowork/config.json");
  await writeFile(path, '{"apiKey":"private-malformed-key');
  await assert.rejects(f.run(["doctor"]), (error) => {
    assert.match(error.stdout, /\.cowork\/config.json/);
    assert.match(error.stderr, /不是有效 JSON/);
    assert.ok(!error.stderr.includes("private-malformed-key"));
    return true;
  });
  await assert.rejects(
    f.run(["init", "--force"]),
    (error) => /配置/.test(error.stderr) && !error.stderr.includes("private-malformed-key")
  );
  assert.equal(await readFile(path, "utf8"), '{"apiKey":"private-malformed-key');
});

test(
  "CLI from an external project uses the real Main and delegated Pi provider after initialization",
  { timeout: 35000 },
  async (t) => {
    const f = await fixture(t);
    const namesFor = (body) => body.tools?.map((tool) => tool.name ?? tool.function?.name) || [];
    const handle = (body) => {
      const names = namesFor(body);
      const history = body.input ?? body.messages;
      if (
        names.includes("call_subagent") &&
        !history.some((message) => message.role === "tool" || message.type === "function_call_output")
      )
        return {
          name: "call_subagent",
          arguments: { task: "Calculate 2+2 independently and return the result.", mode: "sync" }
        };
      return { text: names.includes("call_subagent") ? "验证完成：子任务结果为4。" : "子任务结果：4。" };
    };
    const provider = await modelProtocolFixture("openai-responses", handle);
    t.after(() => provider.close());
    const legacyProvider = await modelProtocolFixture("openai-completions", handle);
    t.after(() => legacyProvider.close());
    await f.run(["init", "--base-url", provider.baseUrl, "--model", "fixture"]);
    const doctor = await f.run(["doctor", "--test-connection"]);
    assert.match(doctor.stdout, /OK.*流式模型连接/);
    const main = await f.run(
      [
        "start",
        "--approve",
        "--mode",
        "json",
        "--no-session",
        "-p",
        "Delegate the calculation and verify it."
      ],
      { COWORK_TASK_ID: "onboarding" }
    );
    assert.match(main.stdout, /验证完成/);
    assert.ok(!main.stdout.includes(f.env.COWORK_API_KEY));
    assert.ok(provider.requests.some(({ body }) => namesFor(body).includes("call_subagent")));
    assert.ok(
      provider.requests.some(({ body }) => namesFor(body).includes("read_file")),
      "a real delegated session must reach the model"
    );
    for (const { path, body } of provider.requests) {
      assert.equal(path, "/v1/responses");
      assert.equal(body.stream, true);
      assert.equal(body.max_output_tokens, 8192);
      assert.equal(body.reasoning, undefined);
    }
    // Environment-only users must not be given a nonexistent explicit config file.
    await rm(f.config);
    const environmentOnly = await f.run(
      [
        "start",
        "--approve",
        "--mode",
        "json",
        "--no-session",
        "-p",
        "Delegate the calculation using environment-only settings."
      ],
      {
        COWORK_API_BASE: legacyProvider.baseUrl,
        COWORK_MODEL: "fixture",
        COWORK_TASK_ID: "environment-only",
        COWORK_WORKSPACE: join(f.root, "environment-workspace"),
        PI_CODING_AGENT_DIR: join(f.root, "environment-pi"),
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        COWORK_MAIN_MAX_TOKENS: "8192",
        COWORK_MAX_TOKENS: "8192"
      }
    );
    assert.match(environmentOnly.stdout, /验证完成/);
    assert.ok(legacyProvider.requests.length > 0);
    for (const { path, body } of legacyProvider.requests) {
      assert.equal(path, "/v1/chat/completions");
      assert.equal(body.max_completion_tokens, 8192);
    }
  }
);
