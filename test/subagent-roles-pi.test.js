import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";
import { prepareReviewSite } from "../dist/src/workspace/review-site.js";
import { InputStore } from "../dist/src/workspace/input-store.js";
import { protectedCallRefusal, protectedPathReason } from "../dist/src/tools/protected-call.js";
import { configuredProtectedPaths } from "../dist/src/tools/protected-paths.js";
import { fakeEventHandlers } from "./fixtures/fake-pi-events.mjs";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * Delegated roles: what each role may hold, what its review must record, where
 * a Reviewer runs, and which writes are refused.
 *
 * Each case runs a real Pi process through the backend that launches delegated
 * work, and reads what the model was actually sent and what happened on disk:
 * the tool table is the one recorded in the provider request, not the set of
 * registration calls. The in-process cases are the decisions that cannot be
 * observed from a request: the cache-warming hook (Pi sends a warm request
 * minutes after a turn) and the protected-path command resolution.
 */

const harness = resolve(".");
const execFileAsync = promisify(execFile);
const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const MODEL = "p46-subagent-model";
const TASK_ID = "p46-subagent-task";
const RUN_ID = "p46-subagent-run";
const API_KEY = "subagent-pi-test-key";

/** Tools Main holds for orchestrating a Task; no delegated role may declare one. */
const MAIN_ONLY_TOOLS = [
  "call_subagent",
  "send_subagent_message",
  "cancel_subagent",
  "get_subagent_status",
  "wait_for_subagents",
  "get_task_status",
  "finish_task",
  "askhuman",
  "sleep_until",
  "grant_capabilities",
  "clear_context",
  "enable_tools",
  "project_ledger",
  "project_development",
  "publish_artifact"
];

const EXECUTOR_TOOLS = [
  "ask_main",
  "bash",
  "browse_workspace",
  "edit",
  "load_skill",
  "read",
  "search",
  "send_peer_message",
  "visit",
  "write"
];

const REVIEWER_TOOLS = [
  "ask_main",
  "bash",
  "browse_workspace",
  "find",
  "grep",
  "load_skill",
  "ls",
  "read",
  "search",
  "send_peer_message",
  "submit_review",
  "visit"
];

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

/** The text of the last tool result in a recorded model request. */
function lastToolText(body) {
  const last = (body.messages ?? []).findLast((message) => message.role === "tool");
  return last ? messageText(last) : "";
}

function lastToolResult(requests) {
  return requests
    .at(-1)
    ?.messages.findLast((message) => message.role === "tool" || message.role === "toolResult");
}

function refusalText(requests) {
  return messageText(lastToolResult(requests)).trim();
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
 * One delegated call through the real backend path: a durable queue item, the
 * process service that launches it, and Main's callback once it settles.
 *
 * A caller that passes `payload` owns the whole work item (its project
 * directory, review site, role); the others run in a committed work site of
 * their own with the role in the payload.
 */
async function delegatedCall(
  t,
  {
    role,
    agentId,
    callId,
    handle,
    task = "执行本轮任务",
    grants,
    prepare,
    env = {},
    payload,
    observe,
    expectFailure = false
  }
) {
  const root = await mkdtemp(join(tmpdir(), "p46-subagent-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  // A Reviewer without a requirement site needs a commit to detach its own
  // checkout at, so the role's work site is a repository with one commit.
  let site;
  if (payload === undefined) {
    site = join(root, "work-site");
    await mkdir(site, { recursive: true });
    await writeFile(join(site, "SITE_MARKER.txt"), "delegated work site\n");
    await git(site, ["init", "-b", "main"]);
    await git(site, ["config", "user.email", "p46@example.test"]);
    await git(site, ["config", "user.name", "P46"]);
    await git(site, ["add", "-A"]);
    await git(site, ["commit", "-m", "delegated site"]);
  }
  const prepared = await prepare?.({ workspace, site });
  const capabilityGrants = grants ?? prepared?.grants;
  const provider = await startLocalProvider({ model: MODEL, handle });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: API_KEY,
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
    payload: payload ?? {
      task,
      projectDirectory: site,
      delegation: { role },
      ...(capabilityGrants ? { capabilityGrants } : {})
    },
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
      COWORK_API_KEY: API_KEY,
      COWORK_MODEL: MODEL,
      COWORK_MODEL_API: "openai-completions",
      COWORK_REASONING_EFFORT: "off",
      COWORK_EVAL_PATHS: "eval/",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      ...env
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
  // A callback is queued before the outcome is recorded, so wait for the record
  // before the test's cleanup removes the workspace it is written into.
  const record = await waitFor(
    async () => {
      const current = await readJson(
        join(runRoot, "agents", "subagents", agentId, "process.json"),
        undefined
      );
      return current?.settledAt ? current : undefined;
    },
    `${callId} settled process record`,
    10_000
  );
  return { root, workspace, site, runRoot, provider, callback, result, process: record };
}

test(
  "an Executor process declares the coding and verification tools plus the channels, and no Main-only tool",
  { timeout: 120_000 },
  async (t) => {
    const { provider, result } = await delegatedCall(t, {
      role: "executor",
      agentId: "subagent_1",
      callId: "call-role-executor",
      handle: () => ({ text: "EXECUTOR_DONE" })
    });

    assert.equal(result.termination, "completed");
    const request = provider.requests[0];
    assert.deepEqual(
      toolNames(request),
      EXECUTOR_TOOLS,
      "the recorded request carries the Executor tool table"
    );
    const declared = new Set(toolNames(request));
    for (const name of MAIN_ONLY_TOOLS)
      assert.equal(declared.has(name), false, `${name} is Main's and must not reach a Subagent`);
    for (const name of ["read", "bash", "edit", "write", "ask_main", "send_peer_message", "load_skill"])
      assert.equal(declared.has(name), true, `the Executor needs ${name}`);

    const system = request.messages.find((message) => message.role === "system").content;
    assert.match(system, /You are a CoworkOS Subagent/, "the process identifies itself as a Subagent");
    assert.match(
      system,
      /You run this work item as the Executor/,
      "the role line is the in-process role line"
    );
    assert.match(system, /You can reach Main with ask_main/, "the ask_main guidance reaches the model");
    assert.match(system, /send_peer_message/, "the peer-message guidance reaches the model");
    assert.doesNotMatch(system, /submit_review/, "review submission belongs to the Reviewer");
    assert.doesNotMatch(system, /<docs>/, "the harness documentation pointer is not delegated work");
    // A delegated process does the same kind of work Main does, so it discovers
    // the same bundled catalog even though it runs outside the install root.
    assert.match(system, /<available_skills>/, "the process is given a skill catalog");
    assert.match(system, /<name>workspace-explore<\/name>/, "a bundled skill is in that catalog");
    assert.ok(
      system.includes(resolve(".pi", "skills")),
      "the catalog points at the install's bundled skill directory"
    );
    assert.doesNotMatch(system, /\brun_command\b/, "the catalog and role text name only tools it holds");
  }
);

test(
  "a delegated process follows Main's search switch: no web tool when search is off",
  { timeout: 120_000 },
  async (t) => {
    const { result } = await delegatedCall(t, {
      role: "executor",
      agentId: "subagent_web_off",
      callId: "call-role-web-off",
      env: { COWORK_WEB_TOOLS: "0" },
      handle: (body) => {
        const declared = toolNames(body);
        assert.equal(declared.includes("search"), false, "search off means no search tool is declared");
        assert.equal(declared.includes("visit"), false, "search off means no visit tool is declared");
        return { text: "NO_WEB" };
      }
    });

    assert.equal(result.termination, "completed");
  }
);

test(
  "a Reviewer process has a shell but no write tool, declares the conclusion tool, and still has no Main-only tool",
  { timeout: 120_000 },
  async (t) => {
    const { provider } = await delegatedCall(t, {
      role: "reviewer",
      agentId: "subagent_2",
      callId: "call-role-reviewer",
      handle: () => ({ text: "REVIEW_TEXT_WITHOUT_CONCLUSION" })
    });

    const request = provider.requests[0];
    assert.deepEqual(
      toolNames(request),
      REVIEWER_TOOLS,
      "the recorded request carries the Reviewer tool table"
    );
    const declared = new Set(toolNames(request));
    for (const name of MAIN_ONLY_TOOLS)
      assert.equal(declared.has(name), false, `${name} is Main's and must not reach a Subagent`);
    for (const name of ["write", "edit"])
      assert.equal(
        declared.has(name),
        false,
        `${name} can change project files, so a Reviewer must not hold it`
      );
    assert.equal(
      declared.has("bash"),
      true,
      "the Reviewer runs its verification inside its own candidate checkout"
    );
    assert.equal(
      declared.has("submit_review"),
      true,
      "the Reviewer submits its conclusion through its own tool"
    );
    assert.equal(declared.has("read"), true, "the Reviewer examines the candidate through read-only tools");
    assert.equal(
      declared.has("load_skill"),
      true,
      "a Reviewer loads the published skills it is told to follow"
    );

    const system = request.messages.find((message) => message.role === "system").content;
    assert.match(system, /independent Reviewer/, "the role line is the in-process Reviewer line");
    assert.match(system, /submit_review/, "the process is told how its conclusion reaches Main");
    assert.match(
      system,
      /run the tests and commands that prove or reproduce what you report/,
      "the Reviewer is told it verifies in its own checkout"
    );
    assert.match(
      system,
      /files you create stay in your checkout and never reach the candidate/,
      "the Reviewer is told its changes stay out of the candidate"
    );
    assert.doesNotMatch(system, /You run this work item as the Executor/);
  }
);

test("the prompt and skill text name only tools a Subagent actually holds", async () => {
  // `run_command` was the old second shell tool. Neither role holds one, so a
  // prompt or skill that tells a delegated process to call it sends it after a
  // tool that does not exist.
  const directories = [join(".pi", "prompts"), join(".pi", "skills")];
  const files = [];
  for (const directory of directories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(join(directory, entry.name, "SKILL.md"));
      else if (entry.name.endsWith(".md")) files.push(join(directory, entry.name));
    }
  }
  assert.ok(files.length > 10, "the scan covers the prompts and every bundled skill");
  for (const path of files) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    assert.doesNotMatch(text, /\brun_command\b/, `${path} names a tool no process holds`);
  }
});

test(
  "a submitted conclusion enters the result record in the fixed shape and reaches Main",
  { timeout: 120_000 },
  async (t) => {
    const conclusion = {
      verdict: "changes_requested",
      findings: [
        {
          location: "src/feature.ts:12",
          evidence:
            "The new branch returns the old value; the added test passes only because it asserts the old value.",
          blocking: true
        },
        {
          location: "README.md",
          evidence: "The documented flag is not mentioned in the change.",
          blocking: false
        }
      ]
    };
    const { provider, result, callback } = await delegatedCall(t, {
      role: "reviewer",
      agentId: "subagent_3",
      callId: "call-role-submit",
      handle: (_body, requests) =>
        requests.length === 1 ? { name: "submit_review", arguments: conclusion } : { text: "Review complete" }
    });

    const toolResult = provider.requests[1].messages.findLast(
      (message) => message.role === "tool" || message.role === "toolResult"
    );
    assert.match(String(toolResult?.content ?? ""), /"submitted":true/, "the tool confirms the record");

    assert.deepEqual(result.review, conclusion, "the conclusion is stored as submitted, finding by finding");
    assert.equal(result.termination, "completed");
    assert.equal(result.response, "Review complete");
    assert.equal(callback.payload.status, "succeeded", JSON.stringify(callback.payload));
    assert.deepEqual(callback.payload.review, conclusion, "Main receives the structured verdict");
  }
);

test(
  "a malformed conclusion is a tool error the model can correct, and the corrected one is recorded",
  { timeout: 120_000 },
  async (t) => {
    const invalid = {
      verdict: "pass",
      findings: [{ location: "src/a.ts", evidence: "observed a broken branch", blocking: true }]
    };
    const corrected = {
      verdict: "changes_requested",
      findings: [
        { location: "src/a.ts:8", evidence: "the branch ignores the configured limit", blocking: true }
      ]
    };
    const { provider, result } = await delegatedCall(t, {
      role: "reviewer",
      agentId: "subagent_4",
      callId: "call-role-retry",
      handle: (_body, requests) => {
        if (requests.length === 1) return { name: "submit_review", arguments: invalid };
        const lastReply = requests
          .at(-1)
          .messages.findLast((message) => message.role === "tool" || message.role === "toolResult");
        if (String(lastReply?.content ?? "").includes('"submitted":true')) return { text: "Review complete" };
        return { name: "submit_review", arguments: corrected };
      }
    });

    const rejection = provider.requests[1].messages.findLast(
      (message) => message.role === "tool" || message.role === "toolResult"
    );
    const rejectionText = String(rejection?.content ?? "");
    assert.match(rejectionText, /"submitted":false/, "the malformed submission is rejected, not recorded");
    assert.match(rejectionText, /pass cannot carry a blocking finding/, "the error names what to fix");
    assert.ok(provider.requests.length >= 3, "the model continued after the rejected submission");
    assert.deepEqual(result.review, corrected, "the corrected conclusion is the recorded one");
    assert.equal(result.termination, "completed");
  }
);

test(
  "a Reviewer that ends without a conclusion is recorded as a failure",
  { timeout: 120_000 },
  async (t) => {
    const { result, callback } = await delegatedCall(t, {
      role: "reviewer",
      agentId: "subagent_5",
      callId: "call-role-no-conclusion",
      handle: () => ({ text: "looks fine to me" })
    });

    assert.equal(result.termination, "failed");
    assert.match(result.error, /without submitting a review conclusion/);
    assert.equal(result.review, undefined);
    assert.equal(callback.payload.status, "failed", JSON.stringify(callback.payload));
    assert.match(callback.payload.error, /without submitting a review conclusion/);
  }
);

test(
  "the backend refuses a completed Reviewer record that carries no valid conclusion",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-role-record-"));
    const workspace = join(root, "workspace");
    const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
    const directory = join(runRoot, "agents", "subagents", "subagent_6");
    await mkdir(directory, { recursive: true });
    await mkdir(join(workspace, TASK_ID, "sessions", "subagent_6", "pi", "call-role-stale"), {
      recursive: true
    });
    const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
    await scheduler.enqueue({
      stepId: "call-role-stale",
      taskId: TASK_ID,
      runId: RUN_ID,
      agentId: "subagent_6",
      importance: "normal",
      payload: { task: "stale reviewer", delegation: { role: "reviewer" } },
      maxAttempts: 1
    });
    const resultPath = join(directory, "result.json");
    // Completed turn, valid token, but no conclusion: exactly the record the
    // backend must not project as a successful review.
    await writeFile(
      resultPath,
      JSON.stringify({
        version: 1,
        taskId: TASK_ID,
        runId: RUN_ID,
        callId: "call-role-stale",
        agentId: "subagent_6",
        role: "reviewer",
        token: "record-token",
        termination: "completed",
        stopReason: "stop",
        response: "no structured verdict",
        outputFiles: [],
        diagnostics: { tracePath: "sessions/subagent_6/pi/call-role-stale", resultPath: "result.json" }
      })
    );
    await writeFile(
      join(directory, "process.json"),
      JSON.stringify({
        version: 1,
        taskId: TASK_ID,
        runId: RUN_ID,
        callId: "call-role-stale",
        agentId: "subagent_6",
        role: "reviewer",
        pid: process.pid,
        host: "record-host",
        startedAt: "Thu Jan  1 00:00:01 1970",
        token: "record-token",
        launchedAt: new Date(0).toISOString(),
        workingDirectory: root,
        sessionDirectory: join(workspace, TASK_ID, "sessions", "subagent_6", "pi", "call-role-stale"),
        resultPath,
        stdoutPath: join(directory, "agent-output.log"),
        stderrPath: join(directory, "agent-stderr.log")
      })
    );
    const service = new SubagentProcessService({
      workspaceRoot: workspace,
      harnessRoot: harness,
      env: {},
      pollMs: 50
    });
    t.after(async () => {
      service.close();
      await rm(root, { recursive: true, force: true });
    });
    const settled = await service.stop({ taskId: TASK_ID, runId: RUN_ID, callId: "call-role-stale" });
    assert.equal(settled?.status, "failed", "a record without a conclusion is not a successful review");
    assert.match(settled.error, /no valid review conclusion/);
    const messages = await readJson(join(runRoot, "agents", "main", "inbox-store.json"), []);
    const callback = messages.find((message) => message.callId === "call-role-stale");
    assert.equal(callback.payload.status, "failed", JSON.stringify(callback.payload));
    assert.equal(callback.payload.review, undefined);
  }
);

test(
  "a Reviewer works in its own candidate checkout and never reaches the candidate from its shell",
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
    // After a directory change it cannot follow, a relative write is refused
    // for where it might land, and the refusal says so instead of calling the
    // named file protected.
    for (const [command, path] of [
      ['cd "$D" && rm score.py', "score.py"],
      ['cd "$DEV"; cp "$A/bin/run.js" bin/run.js', "bin/run.js"]
    ]) {
      const refused = protectedCallRefusal("bash", { command }, guard, site);
      assert.equal(refused?.path, path, command);
      assert.equal(refused?.pattern, "eval/", command);
      assert.match(refused.reason, /cannot be followed .* absolute path/, command);
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
          if (previous.command.includes("$D"))
            assert.match(
              refusalText(requests),
              /cannot be followed/,
              `${previous.command} is refused like Main`
            );
          else
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

/** A real Task upload the capability provider can validate against. */
async function receiveInput(workspace, name, body) {
  const store = new InputStore(join(workspace, TASK_ID, "inputs"));
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return await store.receive(name, Readable.from([bytes]));
}

test(
  "a granted Executor sends an uploaded image to its model, and an ungranted one cannot read it",
  { timeout: 180_000 },
  async (t) => {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    let uploadId = "";
    const granted = await delegatedCall(t, {
      agentId: "subagent_image_granted",
      callId: "call-image-granted",
      env: { COWORK_SUPPORTS_IMAGES: "1" },
      prepare: async ({ workspace }) => {
        const file = await receiveInput(workspace, "pixel.png", pixel);
        uploadId = file.uploadId;
        return { grants: [{ provider: "attachments", scope: [file.uploadId] }] };
      },
      handle: (body, requests) => {
        if (requests.length === 1) {
          assert.equal(
            toolNames(body).includes("read_attachment"),
            true,
            "a granted attachment registers the image reader"
          );
          return { name: "read_attachment", arguments: { id: uploadId } };
        }
        if (requests.length === 2) {
          const sent = JSON.stringify(body.messages);
          assert.match(sent, /data:image\/png;base64,/, "the uploaded pixels reach the model request");
          assert.ok(
            sent.includes(pixel.toString("base64").slice(0, 32)),
            "the request carries the uploaded image bytes, not a placeholder"
          );
          return { text: "图片已读取。" };
        }
        return { text: "图片已读取。" };
      }
    });
    assert.equal(granted.callback.payload.status, "succeeded", JSON.stringify(granted.callback.payload));

    const ungranted = await delegatedCall(t, {
      agentId: "subagent_image_ungranted",
      callId: "call-image-ungranted",
      env: { COWORK_SUPPORTS_IMAGES: "1" },
      handle: (body, requests) => {
        assert.equal(
          toolNames(body).includes("read_attachment"),
          false,
          "a work item without a grant registers no attachment reader"
        );
        if (requests.length === 1) return { name: "read_attachment", arguments: { id: "upload_missing" } };
        if (requests.length === 2) {
          assert.doesNotMatch(JSON.stringify(body.messages), /data:image\//);
          assert.match(lastToolText(body), /not found|unknown|不存在|未注册|unavailable/i);
          return { text: "附件读取被拒。" };
        }
        return { text: "附件读取被拒。" };
      }
    });
    assert.equal(ungranted.callback.payload.status, "succeeded", JSON.stringify(ungranted.callback.payload));
  }
);

test(
  "a granted attachment registers read_attachment, and an ungranted work item registers nothing",
  { timeout: 120_000 },
  async (t) => {
    let uploadId = "";
    const granted = await delegatedCall(t, {
      agentId: "subagent_granted",
      callId: "call-granted-attachment",
      prepare: async ({ workspace }) => {
        const file = await receiveInput(workspace, "brief.txt", "delegated attachment body\n");
        uploadId = file.uploadId;
        return { grants: [{ provider: "attachments", scope: [file.uploadId] }] };
      },
      handle: (body, requests) => {
        if (requests.length === 1) {
          assert.equal(
            toolNames(body).includes("read_attachment"),
            true,
            "a granted attachment registers the reader"
          );
          assert.match(JSON.stringify(body.tools), /read_attachment/);
          return { name: "read_attachment", arguments: { id: uploadId } };
        }
        if (requests.length === 2) {
          assert.match(lastToolText(body), /delegated attachment body/);
          return { text: "已读取委托附件。" };
        }
        return { text: "已读取委托附件。" };
      }
    });
    assert.equal(granted.callback.payload.status, "succeeded", JSON.stringify(granted.callback.payload));

    const ungranted = await delegatedCall(t, {
      agentId: "subagent_ungranted",
      callId: "call-ungranted-attachment",
      handle: (body) => {
        assert.equal(
          toolNames(body).includes("read_attachment"),
          false,
          "a work item dispatched without a grant registers no attachment reader"
        );
        return { text: "未读取任何附件。" };
      }
    });
    assert.equal(ungranted.callback.payload.status, "succeeded", JSON.stringify(ungranted.callback.payload));
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
