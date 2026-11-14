import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { InputStore } from "../dist/src/workspace/input-store.js";
import { Readable } from "node:stream";
import { SubagentProcessService } from "../dist/src/runtime/subagent-processes.js";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * Role-narrowed delegated processes.
 *
 * Each case runs a real Pi process through the backend that launches delegated
 * work, and reads what the model was actually sent: the tool table is the one
 * recorded in the recorded provider request, not the set of registration calls.
 */

const harness = resolve(".");
const execFileAsync = promisify(execFile);
const MODEL = "p46-role-model";
const TASK_ID = "p46-role-task";
const RUN_ID = "p46-role-run";

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

const EXECUTOR_TOOLS = ["ask_main", "bash", "browse_workspace", "edit", "read", "send_peer_message", "write"];

const REVIEWER_TOOLS = [
  "ask_main",
  "bash",
  "browse_workspace",
  "find",
  "grep",
  "ls",
  "read",
  "send_peer_message",
  "submit_review"
];

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

/** The text of the last tool result in a recorded model request. */
function lastToolText(body) {
  const last = (body.messages ?? []).findLast((message) => message.role === "tool");
  if (!last) return "";
  const content = last.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
}

/**
 * One delegated call through the real backend path: a durable queue item, the
 * process service that launches it, and Main's callback once it settles.
 */
async function delegatedCall(
  t,
  { role, agentId, callId, handle, task = "执行本轮任务", grants, prepare, env = {} }
) {
  const root = await mkdtemp(join(tmpdir(), "p46-role-"));
  const workspace = join(root, "workspace");
  const site = join(root, "work-site");
  await mkdir(workspace, { recursive: true });
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "SITE_MARKER.txt"), "delegated work site\n");
  // The site is the candidate Executors edit and Reviewers copy; a Reviewer
  // without a requirement site needs a commit to detach its own checkout at.
  await execFileAsync("git", ["-C", site, "init", "-b", "main"], { windowsHide: true });
  await execFileAsync("git", ["-C", site, "config", "user.email", "p46@example.test"], { windowsHide: true });
  await execFileAsync("git", ["-C", site, "config", "user.name", "P46"], { windowsHide: true });
  await execFileAsync("git", ["-C", site, "add", "-A"], { windowsHide: true });
  await execFileAsync("git", ["-C", site, "commit", "-m", "delegated site"], { windowsHide: true });
  const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
  const prepared = await prepare?.({ workspace, site });
  const capabilityGrants = grants ?? prepared?.grants;
  const provider = await startLocalProvider({ model: MODEL, handle });
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: "{{SECRET_p46_role_key}}",
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
    payload: {
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
      COWORK_API_KEY: "{{SECRET_p46_role_key}}",
      COWORK_MODEL: MODEL,
      COWORK_MODEL_API: "openai-completions",
      COWORK_REASONING_EFFORT: "off",
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      ...env
    }),
    pollMs: 50
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
  // A callback is queued before the outcome is recorded, so wait for the record
  // before the test's cleanup removes the workspace it is written into.
  await waitFor(
    async () =>
      (await readJson(join(runRoot, "agents", "subagents", agentId, "process.json"), undefined))?.settledAt,
    `${callId} settled process record`,
    10_000
  );
  return { root, workspace, site, runRoot, provider, callback, result };
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
    for (const name of ["read", "bash", "edit", "write", "ask_main", "send_peer_message"])
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
