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
import { fakeEventHandlers } from "./fixtures/fake-pi-events.mjs";
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
async function delegatedCall(t, { agentId, callId, handle, payload, observe, expectFailure = false }) {
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
  if (observe) Object.assign(observe, { root, workspace, runRoot });
  await service.startQueued({ taskId: TASK_ID, runId: RUN_ID });
  const callback = await waitFor(async () => {
    const messages = await readJson(join(runRoot, "agents", "main", "inbox-store.json"), []);
    return messages.find((message) => message.callId === callId && message.kind === "callback");
  }, `${callId} callback`);
  if (expectFailure) return { root, workspace, runRoot, provider, callback };
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
        projectDirectory: executorDirectory,
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

    // The write never entered the candidate commit. Its own checkout is kept:
    // Main binds the review and checks the candidate for drift after the call
    // is over, so a successful review's site is its evidence. An attempt that
    // ended without a conclusion is the one that gets removed (see the adopted
    // dead review process case below).
    await assert.rejects(() => git(repository, ["show", `${candidate}:reviewer-note.txt`]));
    assert.equal(await git(executorDirectory, ["status", "--porcelain"]), "");
    assert.equal(existsSync(join(reviewerDirectory, "reviewer-note.txt")), true);
    assert.equal(
      await git(reviewerDirectory, ["rev-parse", "HEAD"]),
      candidate,
      "the kept site is still the candidate the review examined"
    );
  }
);

test(
  "a Reviewer with only a project directory gets a detached checkout of that repository",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-review-derived-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "project");
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "p46@example.test"]);
    await git(repository, ["config", "user.name", "P46"]);
    await writeFile(join(repository, "README.md"), "candidate\n");
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-m", "candidate"]);
    const candidate = await git(repository, ["rev-parse", "HEAD"]);
    await writeFile(join(repository, "user-untracked.txt"), "keep me\n");
    const observe = {};

    const { provider, result, callback, process } = await delegatedCall(t, {
      agentId: "subagent_derived_review",
      callId: "call-guard-derived-review",
      observe,
      payload: {
        task: "Review the candidate in a checkout of your own",
        projectDirectory: repository,
        delegation: { role: "reviewer" }
      },
      handle: async (_body, requests) => {
        if (requests.length === 1)
          return { name: "bash", arguments: { command: "printf 'review only\n' > reviewer-note.txt" } };
        if (requests.length === 2) {
          const record = await readJson(
            join(observe.runRoot, "agents", "subagents", "subagent_derived_review", "process.json"),
            undefined
          );
          assert.ok(record?.workingDirectory, "the Reviewer process has a working directory");
          assert.notEqual(
            record.workingDirectory,
            repository,
            "it never runs in the user's project directory"
          );
          assert.equal(
            await git(record.workingDirectory, ["rev-parse", "HEAD"]),
            candidate,
            "its detached checkout is the project HEAD"
          );
          assert.equal(
            existsSync(join(record.workingDirectory, "reviewer-note.txt")),
            true,
            "the shell writes inside its own checkout"
          );
          assert.equal(
            existsSync(join(repository, "reviewer-note.txt")),
            false,
            "the user's working tree is untouched"
          );
          return { name: "submit_review", arguments: { verdict: "pass", findings: [] } };
        }
        return { text: "Review complete" };
      }
    });

    assert.equal(result.termination, "completed");
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    assert.notEqual(process.workingDirectory, repository);
    assert.equal(await git(repository, ["status", "--porcelain"]), "?? user-untracked.txt");
    assert.equal(
      existsSync(join(process.workingDirectory, "reviewer-note.txt")),
      true,
      "a successful review keeps its checkout as the evidence its record names"
    );
    assert.equal(await git(process.workingDirectory, ["rev-parse", "HEAD"]), candidate);
  }
);

test(
  "a Reviewer without a checkout and without a Git project is refused before it starts",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-review-no-git-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const site = join(root, "plain-site");
    await mkdir(site, { recursive: true });
    await writeFile(join(site, "notes.txt"), "user notes\n");

    const { callback, runRoot } = await delegatedCall(t, {
      agentId: "subagent_no_checkout",
      callId: "call-guard-no-checkout",
      expectFailure: true,
      payload: {
        task: "Review the candidate",
        projectDirectory: site,
        delegation: { role: "reviewer" }
      },
      handle: () => ({ text: "should never run" })
    });

    assert.equal(callback.payload.status, "failed", JSON.stringify(callback.payload));
    assert.match(callback.payload.error, /Reviewer work item has no candidate checkout/);
    assert.match(callback.payload.error, /plain-site/);
    assert.equal(
      existsSync(join(runRoot, "agents", "subagents", "subagent_no_checkout", "process.json")),
      false,
      "no Reviewer process was started"
    );
    assert.deepEqual(await readdir(site), ["notes.txt"], "the plain project directory is untouched");
  }
);

test(
  "relative shell writes follow cd, pushd and git -C, and an unresolved directory is refused",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-guard-relative-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const site = join(root, "site");
    await mkdir(join(site, "eval"), { recursive: true });
    const guard = configuredProtectedPaths(site, { COWORK_EVAL_PATHS: "eval/" }, []);
    const refusal = (path) => ({
      path,
      pattern: "eval/",
      reason: protectedPathReason(path, "eval/")
    });

    for (const [command, path] of [
      ["cd eval && rm score.py", "score.py"],
      ["cd eval && printf x > score.py", "score.py"],
      ["git -C eval rm score.py", "score.py"],
      ['cd "$D" && rm score.py', "score.py"],
      ["pushd eval && rm score.py", "score.py"],
      ["(cd eval && rm score.py)", "score.py"],
      ['cd eval && bash -c "rm score.py"', "score.py"],
      ["(cd ..) ; rm eval/score.py", "eval/score.py"],
      ["(cd /tmp) ; rm eval/score.py", "eval/score.py"],
      ["echo $(cd ..) ; rm eval/score.py", "eval/score.py"],
      ["{ cd eval; rm score.py; }", "score.py"],
      ["{ cd eval; }; rm score.py", "score.py"],
      ["git -C . -C eval rm score.py", "score.py"],
      ["git restore eval/score.py", "eval/score.py"],
      ["git restore --worktree eval/score.py", "eval/score.py"],
      ["git checkout eval/score.py", "eval/score.py"]
    ]) {
      assert.deepEqual(
        protectedCallRefusal("bash", { command }, guard, site),
        refusal(path),
        `${command} must resolve relative to the directory it reached`
      );
    }
    for (const command of [
      "cd eval && cd .. && rm score.py",
      "cd eval && cd - && rm score.py",
      "pushd eval && popd && rm score.py",
      "cd /tmp && rm score.py",
      "make -C eval clean",
      "(cd eval) ; rm score.py"
    ]) {
      assert.equal(
        protectedCallRefusal("bash", { command }, guard, site),
        undefined,
        `${command} does not write a protected path`
      );
    }
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
    await git(site, ["init", "-b", "main"]);
    await git(site, ["config", "user.email", "p46@example.test"]);
    await git(site, ["config", "user.name", "P46"]);
    await writeFile(join(site, "eval", "score.py"), "score = 1\n");
    await git(site, ["add", "-A"]);
    await git(site, ["commit", "-m", "candidate"]);
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
  const events = fakeEventHandlers();
  const tools = new Map();
  return {
    handlers: events.handlers,
    tools,
    on: events.on,
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
  "a real shell cannot escape protection by changing directory before the write",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-guard-cd-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const site = join(root, "site");
    await mkdir(join(site, "eval"), { recursive: true });
    await git(site, ["init", "-b", "main"]);
    await git(site, ["config", "user.email", "p46@example.test"]);
    await git(site, ["config", "user.name", "P46"]);
    await writeFile(join(site, "eval", "score.py"), "score = 1\n");
    await git(site, ["add", "-A"]);
    await git(site, ["commit", "-m", "scorer"]);
    const commands = [
      { command: "cd eval && rm score.py", path: "score.py" },
      { command: "cd eval && printf 'hacked\\n' > score.py", path: "score.py" },
      { command: "git -C eval rm score.py", path: "score.py" },
      { command: 'cd "$D" && rm score.py', path: "score.py" },
      { command: "(cd ..) ; rm eval/score.py", path: "eval/score.py" },
      { command: "echo $(cd ..) ; rm eval/score.py", path: "eval/score.py" },
      { command: "{ cd eval; rm score.py; }", path: "score.py" },
      { command: "git -C . -C eval rm score.py", path: "score.py" },
      { command: "git restore eval/score.py", path: "eval/score.py" },
      { command: "git checkout eval/score.py", path: "eval/score.py" }
    ];

    const { provider, runRoot } = await delegatedCall(t, {
      agentId: "subagent_cd_guard",
      callId: "call-guard-cd",
      payload: { task: "Verify the scorer", projectDirectory: site, delegation: { role: "executor" } },
      handle: (_body, requests) => {
        const index = requests.length - 1;
        if (index > 0 && index <= commands.length) {
          const previous = commands[index - 1];
          assert.equal(
            refusalText(requests),
            protectedPathReason(previous.path, "eval/"),
            `${previous.command} is refused like Main`
          );
        }
        if (index < commands.length) return { name: "bash", arguments: { command: commands[index].command } };
        return { text: "Done" };
      }
    });

    assert.equal(provider.requests.length, commands.length + 1);
    assert.equal(await readFile(join(site, "eval", "score.py"), "utf8"), "score = 1\n");
    assert.equal(await git(site, ["status", "--porcelain"]), "");
    const event = await waitFor(async () => {
      const events = (await readFile(join(runRoot, "run_events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const refusals = events.filter(
        (entry) => entry.type === "guard.write_refused" && entry.agentId === "subagent_cd_guard"
      );
      return refusals.length === commands.length ? refusals : undefined;
    }, "the delegated guard refusal events");
    // The refusal event is written fire-and-forget, so event order is not the
    // tool-call order; the multiset of refused paths is what stays stable.
    assert.deepEqual(
      event.map((entry) => entry.payload.path).sort(),
      commands.map((command) => command.path).sort()
    );
    for (const entry of event) {
      assert.equal(entry.payload.pattern, "eval/");
      assert.equal(entry.payload.toolName, "bash");
      assert.equal(entry.taskId, TASK_ID);
      assert.equal(entry.runId, RUN_ID);
    }
  }
);

test(
  "an Executor carrying a reviewSite, or a review site that cannot be created, is refused before launch",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-review-refused-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "project");
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "p46@example.test"]);
    await git(repository, ["config", "user.name", "P46"]);
    await writeFile(join(repository, "README.md"), "candidate\n");
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-m", "candidate"]);
    const candidate = await git(repository, ["rev-parse", "HEAD"]);
    const site = join(root, "executor-site");
    await mkdir(site, { recursive: true });

    const executor = await delegatedCall(t, {
      agentId: "subagent_executor_review_site",
      callId: "call-guard-executor-review-site",
      expectFailure: true,
      payload: {
        task: "Change the feature",
        projectDirectory: site,
        reviewSite: { repository, commit: candidate, directory: join(root, "not-used") },
        delegation: { role: "executor" }
      },
      handle: () => ({ text: "should never run" })
    });
    assert.equal(executor.callback.payload.status, "failed", JSON.stringify(executor.callback.payload));
    assert.match(executor.callback.payload.error, /Executor work item must not carry a reviewSite/);
    assert.equal(
      existsSync(
        join(executor.runRoot, "agents", "subagents", "subagent_executor_review_site", "process.json")
      ),
      false
    );

    const reviewer = await delegatedCall(t, {
      agentId: "subagent_missing_commit",
      callId: "call-guard-missing-commit",
      expectFailure: true,
      payload: {
        task: "Review the candidate",
        projectDirectory: site,
        reviewSite: { repository, commit: "0123456789abcdef", directory: join(root, "missing-commit-site") },
        delegation: { role: "reviewer" }
      },
      handle: () => ({ text: "should never run" })
    });
    assert.equal(reviewer.callback.payload.status, "failed", JSON.stringify(reviewer.callback.payload));
    assert.match(reviewer.callback.payload.error, /审查候选提交不存在|0123456789abcdef/);
    assert.equal(
      existsSync(
        join(reviewer.runRoot, "agents", "subagents", "subagent_missing_commit", "review-site.json")
      ),
      false,
      "the marker is removed when the checkout cannot be created"
    );
    assert.equal(existsSync(join(root, "missing-commit-site")), false);
  }
);

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
