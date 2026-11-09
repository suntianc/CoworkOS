import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { publishTaskArtifact } from "../dist/src/workspace/artifact-store.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** The serving backend's identity, which recorded workspace and merge facts must name. */
export async function servingBackendId(dashboard) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = await readBackendInstance(backendPaths(dashboard.env.ATRIA_HOME));
    if (instance.value?.backendId) return instance.value.backendId;
    await delay(25);
  }
  throw new Error("the backend did not publish its identity");
}

/**
 * One committed checkout for a requirement: baseline, the candidate change and
 * the commit a merge would have written.
 */
async function makeCheckout(directory, files) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "README.md"), "基线\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  const baseline = await git(directory, ["rev-parse", "HEAD"]);
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "candidate"]);
  const candidate = await git(directory, ["rev-parse", "HEAD"]);
  const tree = await git(directory, ["rev-parse", "HEAD^{tree}"]);
  // The merge writes the same tree, so every phase shows the same change.
  await git(directory, ["commit", "--allow-empty", "-m", "merge"]);
  const merged = await git(directory, ["rev-parse", "HEAD"]);
  return { baseline, candidate, tree, merged };
}

const check = (name, exitCode) => ({ name, command: `test ${name}`, exitCode, output: "" });

/**
 * Record one requirement in a chosen phase through the same HTTP facts a
 * remote execution backend publishes.
 *
 * `development`/`review`/`merge`/`delivery` are recorded with the backend's own
 * identity, so the panel reads exactly what such a backend would have
 * published; nothing here writes the ledger's delivering state by hand.
 */
export async function seedRequirement(page, dashboard, project, input) {
  const api = async (path, body, headers = {}) => {
    const response = await page.request.post(`${dashboard.base}${path}`, {
      data: body,
      headers: { "content-type": "application/json", ...headers }
    });
    const payload = await response.json();
    expect(response.status(), `${path} ${JSON.stringify(body)} -> ${JSON.stringify(payload)}`).toBeLessThan(
      300
    );
    return payload;
  };
  const backendId = await servingBackendId(dashboard);
  // The project's merge entry names another backend, so a merged operation
  // waits for that backend's delivery instead of this host completing it.
  const declared = { "x-cowork-backend-id": REMOTE_BACKEND };
  const projectPath = (suffix) => `/api/projects/${encodeURIComponent(project.projectId)}${suffix}`;

  const requirement = (
    await api(projectPath("/ledger"), {
      action: "create",
      title: input.title,
      content: input.content ?? `${input.title}的内容。`
    })
  ).requirement;
  const session = (
    await api(projectPath("/main-sessions"), {
      action: "create",
      title: input.title,
      requirementId: requirement.requirementId
    })
  ).session;
  const checkout = await makeCheckout(join(dashboard.root, "checkouts", requirement.requirementId), {
    "summarize.sh": "#!/usr/bin/env bash\nset -euo pipefail\n",
    "notes.md": "# 验收记录\n"
  });
  const development = (
    await api(
      projectPath("/developments"),
      {
        action: "create",
        requirementId: requirement.requirementId,
        goal: input.title,
        completionCriteria: input.criteria ?? ["bash summarize.sh 输出 30", "文件不存在时退出码 1"],
        route: input.route ?? "full",
        baseline: { branch: "main", commit: checkout.baseline }
      },
      declared
    )
  ).development;
  await api(projectPath("/developments"), {
    action: "record_workspace",
    developmentId: development.developmentId,
    workspace: {
      workspaceId: `workspace_${requirement.requirementId}`,
      backendId,
      directory: join(dashboard.root, "checkouts", requirement.requirementId),
      branch: `coworkos/${requirement.requirementId}`,
      baseCommit: checkout.baseline,
      state: "ready"
    }
  });
  const candidate = {
    commit: checkout.candidate,
    tree: checkout.tree,
    branch: `coworkos/${requirement.requirementId}`,
    workspace: join(dashboard.root, "checkouts", requirement.requirementId)
  };
  if (!input.phase || input.phase === "development") return { requirement, session, development, checkout };

  const checks = [check("第一条", 0), check("第二条", 0)];
  await api(
    projectPath("/reviews"),
    {
      action: "plan",
      developmentId: development.developmentId,
      channel: "independent",
      basis: "完成标准需要独立核验",
      checks,
      candidate
    },
    declared
  );
  let review = (
    await api(
      projectPath("/reviews"),
      {
        action: "start",
        developmentId: development.developmentId,
        kind: "independent",
        candidate,
        author: {
          role: "executor",
          callId: "call-executor",
          agentId: "subagent_1",
          workspace: candidate.workspace
        }
      },
      declared
    )
  ).review;
  const reviewer = {
    role: "reviewer",
    taskId: session.taskId,
    callId: "call-reviewer",
    agentId: "subagent_2",
    workspace: candidate.workspace
  };
  const state = input.phase === "review" ? "in_review" : input.phase === "rework" ? "failed" : "passed";
  review = (
    await api(
      projectPath("/reviews"),
      {
        action: "update",
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        state,
        reviewer,
        ...(state === "failed"
          ? {
              verdict: {
                summary: "第二条完成标准未通过",
                checks: [check("第一条", 0), check("第二条", 1)]
              }
            }
          : state === "passed"
            ? { verdict: { summary: "候选满足完成标准", checks } }
            : {})
      },
      declared
    )
  ).review;
  if (input.phase === "review" || input.phase === "rework")
    return { requirement, session, development, checkout };
  if (!input.phase || input.phase === "merged" || input.phase === "delivered") {
    let merge = (
      await api(
        projectPath("/merges"),
        {
          action: "create",
          developmentId: development.developmentId,
          requestedBy: REMOTE_BACKEND,
          executionBackendId: REMOTE_BACKEND,
          targetBranch: "main",
          candidate,
          acceptance: {
            channel: "independent",
            approvedCommit: checkout.candidate,
            approvedTree: checkout.tree,
            reviewId: review.reviewId
          },
          checks: [
            { name: "组合检查", command: "test -f summarize.sh" },
            { name: "组合检查 2", command: "test -f notes.md" }
          ]
        },
        declared
      )
    ).merge;
    merge = (
      await api(
        projectPath("/merges"),
        {
          action: "update",
          mergeId: merge.mergeId,
          expectedRevision: merge.revision,
          state: "merged",
          combinedBase: checkout.baseline,
          mergeCommit: checkout.merged,
          checks: [
            { name: "组合检查", command: "test -f summarize.sh", exitCode: 0, output: "" },
            { name: "组合检查 2", command: "test -f notes.md", exitCode: 0, output: "" }
          ]
        },
        declared
      )
    ).merge;
    if (input.phase !== "delivered") return { requirement, session, development, checkout, review, merge };
    await api(
      projectPath("/deliveries"),
      {
        action: "sync",
        receipt: {
          mergeId: merge.mergeId,
          developmentId: development.developmentId,
          requirementId: requirement.requirementId,
          candidateCommit: checkout.candidate,
          mergedCommit: checkout.merged,
          targetBranch: "main",
          // The receipt is the merged operation's own timestamp, not a new one.
          mergedAt: merge.updatedAt
        }
      },
      declared
    );
    return { requirement, session, development, checkout, review, merge };
  }
  throw new Error(`unknown seeded phase: ${input.phase}`);
}

/**
 * Record one finished Run the way the runtime writes it: the run's clock, Main's
 * trace with its tool calls and token reports, the durable work items and their
 * agent traces. Statistics and activity are read from these files, not supplied.
 */
export async function seedRun(page, dashboard, taskId, { toolCalls = 148, roles } = {}) {
  const response = await page.request.get(`${dashboard.base}/api/tasks/${encodeURIComponent(taskId)}`);
  expect(response.ok()).toBe(true);
  const detail = await response.json();
  const taskRoot = join(detail.storageRoot, taskId);
  const runId = "run_seed";
  const runRoot = join(taskRoot, "runs", runId);
  await mkdir(runRoot, { recursive: true });
  const updatedAt = Date.parse(detail.task.updatedAt);
  const createdAt = new Date(updatedAt - 24 * 60 * 1000 - 24 * 1000);
  await writeFile(
    join(runRoot, "run.json"),
    JSON.stringify({ createdAt: createdAt.toISOString(), updatedAt: new Date(updatedAt).toISOString() })
  );
  const usage = (input, output) =>
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: updatedAt - 60 * 1000,
        usage: { input, output, cacheRead: 0, cacheWrite: 0, tokenUsageReported: true }
      }
    });
  const lines = [];
  for (let index = 0; index < toolCalls; index += 1) {
    const at = new Date(createdAt.getTime() + Math.floor((index / toolCalls) * 20 * 60 * 1000));
    lines.push(JSON.stringify({ occurredAt: at.toISOString(), type: "tool_execution_start" }));
  }
  lines.push(usage(1_000_000, 210_000));
  await writeFile(join(runRoot, "runtime-output.log"), `${lines.join("\n")}\n`);
  await writeFile(
    join(runRoot, "queue.json"),
    JSON.stringify([
      { stepId: "call-executor", agentId: "subagent_1" },
      { stepId: "call-reviewer", agentId: "subagent_2" }
    ])
  );
  for (const [agentId, input, output] of [
    ["subagent_1", 1_200_000, 140_000],
    ["subagent_2", 400_000, 30_000]
  ]) {
    const directory = join(taskRoot, "sessions", agentId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${runId}.jsonl`), `${usage(input, output)}\n`);
  }
  // The task's recorded Run is the one the runtime sampled; publishing it as
  // the task's active run makes the activity read the trace above instead of
  // treating the conversation as never run.
  await new LocalWorkspaceStore(detail.storageRoot).updateTask(
    taskId,
    { activeRunId: runId, status: "completed" },
    { preserveUpdatedAt: true }
  );
  return roles ?? ["subagent_1", "subagent_2"];
}

/** The backend the project configured as its merge entry; it owns merge operations here. */
export const REMOTE_BACKEND = "backend_remote_executor_01";

/** Record the project's merge entry, which every merge operation is checked against. */
export async function configureMerge(page, dashboard, project, repository) {
  // The ledger read binds the project into the shared records; the merge entry
  // is a shared fact and cannot exist before that.
  expect(
    (
      await page.request.get(`${dashboard.base}/api/projects/${encodeURIComponent(project.projectId)}/ledger`)
    ).ok()
  ).toBe(true);
  const response = await page.request.post(
    `${dashboard.base}/api/projects/${encodeURIComponent(project.projectId)}/merge-config`,
    {
      data: { repository, targetBranch: "main", executionBackendId: REMOTE_BACKEND },
      headers: { "content-type": "application/json", "x-cowork-backend-id": REMOTE_BACKEND }
    }
  );
  const payload = await response.text();
  expect(response.status(), `${response.url()} ${payload}`).toBeLessThan(300);
  await servingBackendId(dashboard);
}

/**
 * Publish one artifact through the production writer, so the record carries the
 * same relative path and friendly name a real export produces.
 */
export async function publishNamedArtifact(page, dashboard, taskId, { relativePath, displayName, content }) {
  const response = await page.request.get(`${dashboard.base}/api/tasks/${encodeURIComponent(taskId)}`);
  expect(response.ok()).toBe(true);
  const detail = await response.json();
  return publishTaskArtifact({
    workspaceRoot: detail.storageRoot,
    taskId,
    runId: "workspace",
    producerAgentId: "main",
    relativePath,
    displayName,
    content
  });
}

/** Append one assistant reply to the conversation's saved history. */
export async function seedAssistantMessage(page, dashboard, taskId, content) {
  const response = await page.request.get(`${dashboard.base}/api/tasks/${encodeURIComponent(taskId)}`);
  expect(response.ok()).toBe(true);
  const detail = await response.json();
  const path = join(detail.storageRoot, taskId, "agents", "main", "context", "messages.json");
  let existing = [];
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    existing = [];
  }
  const timestamp = Date.now();
  await writeFile(
    path,
    JSON.stringify([
      ...existing,
      { role: "user", content: "生成报告", timestamp: timestamp - 1000 },
      { role: "assistant", content, timestamp, stopReason: "stop" }
    ])
  );
}

/** Publish one artifact file the way a finished run writes into artifacts/. */
export async function seedArtifact(page, dashboard, taskId, name, content) {
  const response = await page.request.get(`${dashboard.base}/api/tasks/${encodeURIComponent(taskId)}`);
  expect(response.ok()).toBe(true);
  const detail = await response.json();
  const directory = join(detail.storageRoot, taskId, "artifacts");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), content);
}

export { git };
