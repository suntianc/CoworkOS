import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";
import { prepareReviewSite } from "../dist/src/workspace/review-site.js";
import { protectedCallRefusal, protectedPathReason } from "../dist/src/tools/protected-call.js";
import { configuredProtectedPaths } from "../dist/src/tools/protected-paths.js";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * Delegated path guards and the Reviewer's shell.
 *
 * Every process here is a real Pi process launched through the backend, so the
 * assertions read what the model was sent and what happened on disk. The one
 * in-process case is the cache-warming hook: Pi sends a warm request minutes
 * after a turn, so a test cannot wait for it; the hook is what decides it.
 */

const harness = resolve(".");
const execFileAsync = promisify(execFile);
const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const MODEL = "p46-guard-model";
const TASK_ID = "p46-guard-task";
const RUN_ID = "p46-guard-run";

async function git(directory, args) {
  return (await execFileAsync("git", ["-C", directory, ...args], { windowsHide: true })).stdout.trim();
}

async function waitFor(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function toolNames(request) {
  return (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name).sort();
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function lastToolResult(requests) {
  return requests
    .at(-1)
    ?.messages.findLast((message) => message.role === "tool" || message.role === "toolResult");
}

async function readJsonRecords(runRoot) {
  const records = [];
  const directory = join(runRoot, "agents", "subagents");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await readJson(join(directory, entry.name, "process.json"), undefined);
    if (record) records.push(record);
  }
  return records;
}

/**
 * One delegated call through the real backend path, returning the settled
 * result, process record and the requests the local provider recorded.
 */
async function delegatedCall(t, { agentId, callId, handle, payload }) {
  const root = await mkdtemp(join(tmpdir(), "p46-guard-"));
  const workspace = join(root, "workspace");
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  await mkdir(workspace, { recursive: true });
  const provider = await startLocalProvider({ model: MODEL, handle });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: "{{SECRET_p46_guard_key}}",
      model: MODEL
    })
  );
  const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
  await scheduler.enqueue({
    stepId: callId,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentId,
    importance: "normal",
    payload,
    maxAttempts: 1
  });
  const service = new SubagentProcessService({
    workspaceRoot: workspace,
    harnessRoot: harness,
    env: isolatedPiEnvironment({
      HOME: root,
      TMPDIR: root,
      ATRIA_HOME: join(root, "home"),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_CONFIG_ROOT: root,
      COWORK_HARNESS_ROOT: harness,
      COWORK_WORKSPACE: workspace,
      COWORK_DISABLE_MAIN_GUARDIAN: "1",
      COWORK_API_BASE: provider.baseUrl,
      COWORK_API_KEY: "{{SECRET_p46_guard_key}}",
      COWORK_MODEL: MODEL,
      COWORK_MODEL_API: "openai-completions",
      COWORK_REASONING_EFFORT: "off",
      COWORK_EVAL_PATHS: "eval/",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1"
    }),
    pollMs: 50,
    graceMs: 500
  });
  const cleanup = async () => {
    service.close();
    await provider.close();
    for (const record of await readJsonRecords(runRoot)) {
      if (!record.pid || record.settledAt) continue;
      try {
        process.kill(-record.pid, "SIGKILL");
      } catch {
        /* the process group has already exited */
      }
    }
    await rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);
  await service.startQueued({ taskId: TASK_ID, runId: RUN_ID });
  const callback = await waitFor(async () => {
    const messages = await readJson(join(runRoot, "agents", "main", "inbox-store.json"), []);
    return messages.find((message) => message.callId === callId && message.kind === "callback");
  }, `${callId} callback`);
  const result = await readJson(join(runRoot, "agents", "subagents", agentId, "result.json"), undefined);
  const process = await waitFor(async () => {
    const record = await readJson(join(runRoot, "agents", "subagents", agentId, "process.json"), undefined);
    return record?.settledAt ? record : undefined;
  }, `${callId} settled process record`);
  return { root, workspace, runRoot, provider, callback, result, process };
}

function refusalText(requests) {
  return messageText(lastToolResult(requests)).trim();
}

test(
  "a Reviewer declares bash but no write/edit, and works in its own candidate checkout",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-review-site-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "project");
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "p46@example.test"]);
    await git(repository, ["config", "user.name", "P46"]);
    await writeFile(join(repository, "README.md"), "base\n");
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-m", "base"]);
    await writeFile(join(repository, "feature.txt"), "candidate\n");
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-m", "candidate"]);
    const candidate = await git(repository, ["rev-parse", "HEAD"]);
    const executorDirectory = join(root, "work-items", "call-executor");
    await git(repository, ["worktree", "add", "-b", "executor-work", executorDirectory, candidate]);
    const reviewerDirectory = join(root, "work-items", "call-reviewer");

    const { provider, result, callback, process } = await delegatedCall(t, {
      agentId: "subagent_review_site",
      callId: "call-guard-review-site",
      payload: {
        task: "Review the candidate in a checkout of your own",
        projectDirectory: reviewerDirectory,
        reviewSite: { repository, commit: candidate, directory: reviewerDirectory },
        delegation: { role: "reviewer" }
      },
      handle: (_body, requests) => {
        if (requests.length === 1)
          return { name: "bash", arguments: { command: "printf 'review only\\n' > reviewer-note.txt" } };
        if (requests.length === 2) {
          // The process is still running: its own copy holds the file and the
          // Executor's checkout does not.
          assert.equal(
            existsSync(join(reviewerDirectory, "reviewer-note.txt")),
            true,
            "the Reviewer writes inside its own checkout"
          );
          assert.equal(
            existsSync(join(executorDirectory, "reviewer-note.txt")),
            false,
            "the Executor's checkout is untouched"
          );
          return { name: "submit_review", arguments: { verdict: "pass", findings: [] } };
        }
        return { text: "Review complete" };
      }
    });

    const declared = toolNames(provider.requests[0]);
    assert.equal(declared.includes("bash"), true, "the Reviewer runs verification with bash");
    for (const name of ["write", "edit"])
      assert.equal(declared.includes(name), false, `the Reviewer must not hold ${name}`);
    assert.equal(declared.includes("submit_review"), true);
    assert.equal(process.workingDirectory, reviewerDirectory, "the process runs in its own checkout");
    assert.equal(result.termination, "completed");
    assert.deepEqual(result.review, { verdict: "pass", findings: [] });
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    assert.equal(provider.requests.length, 3, "the review made exactly its own turns");

    // The write never entered the candidate commit, and the checkout is gone
    // once the review process ended.
    await assert.rejects(() => git(repository, ["show", `${candidate}:reviewer-note.txt`]));
    assert.equal(await git(executorDirectory, ["status", "--porcelain"]), "");
    await waitFor(
      () => Promise.resolve(!existsSync(reviewerDirectory)),
      "the Reviewer checkout to be removed"
    );
  }
);

test(
  "an Executor's protected write through write and bash is refused with Main's error",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-guard-executor-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const site = join(root, "site");
    await mkdir(join(site, "eval"), { recursive: true });
    await writeFile(join(site, "eval", "score.py"), "score = 1\n");
    const expected = protectedPathReason("eval/score.py", "eval/");

    const { provider } = await delegatedCall(t, {
      agentId: "subagent_guarded_executor",
      callId: "call-guard-executor",
      payload: { task: "Change the feature", projectDirectory: site, delegation: { role: "executor" } },
      handle: (_body, requests) => {
        if (requests.length === 1)
          return { name: "bash", arguments: { command: "printf 'hacked\\n' > eval/score.py" } };
        if (requests.length === 2) {
          assert.equal(refusalText(requests), expected, "the bash write returns Main's refusal text");
          return { name: "write", arguments: { path: "eval/score.py", content: "hacked\n" } };
        }
        if (requests.length === 3) {
          assert.equal(refusalText(requests), expected, "the write tool returns the same refusal");
          return { text: "Done" };
        }
        return { text: "Done" };
      }
    });

    const guard = configuredProtectedPaths(site, { COWORK_EVAL_PATHS: "eval/" }, []);
    assert.deepEqual(protectedCallRefusal("bash", { command: "printf x > eval/score.py" }, guard, site), {
      path: "eval/score.py",
      pattern: "eval/",
      reason: expected
    });
    assert.deepEqual(protectedCallRefusal("write", { path: "eval/score.py" }, guard, site), {
      path: "eval/score.py",
      pattern: "eval/",
      reason: expected
    });
    assert.equal(await readFile(join(site, "eval", "score.py"), "utf8"), "score = 1\n");
    assert.equal(provider.requests.length, 3);
  }
);

test(
  "a Reviewer's protected write through bash is refused with Main's error",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-guard-reviewer-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const site = join(root, "site");
    await mkdir(join(site, "eval"), { recursive: true });
    await writeFile(join(site, "eval", "score.py"), "score = 1\n");
    const expected = protectedPathReason("eval/score.py", "eval/");

    const { provider, result } = await delegatedCall(t, {
      agentId: "subagent_guarded_reviewer",
      callId: "call-guard-reviewer",
      payload: {
        task: "Review the change",
        projectDirectory: site,
        delegation: { role: "reviewer" }
      },
      handle: (_body, requests) => {
        if (requests.length === 1)
          return { name: "bash", arguments: { command: "cp /dev/null eval/score.py" } };
        if (requests.length === 2) {
          assert.equal(refusalText(requests), expected, "the Reviewer's shell is guarded too");
          return { name: "submit_review", arguments: { verdict: "pass", findings: [] } };
        }
        return { text: "Review complete" };
      }
    });

    assert.equal(result.termination, "completed");
    assert.equal(await readFile(join(site, "eval", "score.py"), "utf8"), "score = 1\n");
    assert.equal(provider.requests.length, 3);
  }
);

function fakePi() {
  const handlers = new Map();
  const tools = new Map();
  return {
    handlers,
    tools,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerProvider() {},
    setActiveTools() {},
    getActiveTools() {
      return [...tools.keys()];
    }
  };
}

test(
  "a backend that adopts a dead review process still removes its checkout",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-guard-adopt-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
    const agentDirectory = join(runRoot, "agents", "subagents", "subagent_adopted");
    await mkdir(agentDirectory, { recursive: true });
    const repository = join(root, "project");
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "p46@example.test"]);
    await git(repository, ["config", "user.name", "P46"]);
    await writeFile(join(repository, "README.md"), "candidate\n");
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-m", "candidate"]);
    const candidate = await git(repository, ["rev-parse", "HEAD"]);
    const reviewerDirectory = join(root, "work-items", "call-adopted-review");
    const reviewSite = { repository, commit: candidate, directory: reviewerDirectory };
    await prepareReviewSite(reviewSite);
    await writeFile(join(agentDirectory, "review-site.json"), JSON.stringify(reviewSite));
    // A process record whose pid no longer exists: exactly what a backend sees
    // for a review that ended while it was away.
    const resultPath = join(agentDirectory, "result.json");
    await writeFile(
      join(agentDirectory, "process.json"),
      JSON.stringify({
        version: 1,
        taskId: TASK_ID,
        runId: RUN_ID,
        callId: "call-adopted-review",
        agentId: "subagent_adopted",
        role: "reviewer",
        pid: 999_999,
        host: hostname(),
        startedAt: "Thu Jan  1 00:00:01 1970",
        token: "adopted-review-token",
        launchedAt: new Date(0).toISOString(),
        workingDirectory: reviewerDirectory,
        sessionDirectory: join(
          workspace,
          TASK_ID,
          "sessions",
          "subagent_adopted",
          "pi",
          "call-adopted-review"
        ),
        resultPath,
        stdoutPath: join(agentDirectory, "agent-output.log"),
        stderrPath: join(agentDirectory, "agent-stderr.log")
      })
    );
    const service = new SubagentProcessService({
      workspaceRoot: workspace,
      harnessRoot: harness,
      env: {},
      pollMs: 50
    });
    t.after(() => service.close());
    await service.adopt({ taskId: TASK_ID, runId: RUN_ID });
    const record = await readJson(join(agentDirectory, "process.json"), {});
    assert.equal(record.settledAt !== undefined, true, "the adopted process settles from its records");
    assert.equal(existsSync(reviewerDirectory), false, "the adopted review checkout is removed");
    assert.equal(existsSync(join(agentDirectory, "review-site.json")), false, "its marker is removed too");
  }
);

test(
  "a delegated process answers Pi's cache-warming decision with stop, like Main",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-guard-warming-"));
    const previous = { ...process.env };
    t.after(async () => {
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    });
    Object.assign(process.env, {
      COWORK_AGENT_ROLE: "reviewer",
      COWORK_API_BASE: "https://example.test",
      COWORK_API_KEY: "{{SECRET_p46_guard_key}}",
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_WORKSPACE: root,
      COWORK_PROJECT_DIR: root,
      COWORK_TASK_ID: "guard-warming-task",
      COWORK_RUN_ID: "guard-warming-run",
      COWORK_SUBAGENT_CALL_ID: "guard-warming-call",
      COWORK_AGENT_ID: "subagent_warming",
      COWORK_SUBAGENT_TOKEN: "guard-warming-token",
      COWORK_SUBAGENT_RESULT: join(root, "result.json")
    });
    await writeFile(process.env.COWORK_CONFIG, "{}\n");
    const { createJiti } = await import(requirePi.resolve("jiti"));
    const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
    const module = await jiti.import(extensionPath, { default: true });
    const pi = fakePi();
    await (module.default ?? module)(pi);

    const decide = pi.handlers.get("cache_warming_decision");
    assert.equal(typeof decide, "function", "the delegated process answers the warming decision hook");
    assert.deepEqual(
      await decide({
        type: "cache_warming_decision",
        action: "warm",
        warmCost: 0.01,
        missCost: 0.3,
        continuationProbability: 0.5
      }),
      { action: "stop" }
    );
  }
);
