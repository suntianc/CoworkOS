import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import {
  PROJECT_DATA_ENGINES,
  projectDataConfig,
  startPostgresProjectDatabase
} from "./p3-storage-fixture.mjs";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";
import { RemoteProjectDataService } from "../dist/src/workspace/project-data-remote.js";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { prepareDevelopmentWorkspace } from "../dist/src/workspace/development-workspace.js";
import { prepareWorkItemSite } from "../dist/src/workspace/work-item-workspace.js";

const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());
const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const lastToolText = (body) => messageText(body.messages.findLast((message) => message.role === "tool"));
const toolJson = (body) => JSON.parse(lastToolText(body));
const userText = (body) =>
  body.messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
const assistantText = (body) =>
  body.messages
    .filter((message) => message.role === "assistant")
    .map(messageText)
    .join("\n");

const client = (dashboard) => async (path, body, method) => {
  const response = await fetch(`${dashboard.base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

const waitFor = async (check, message, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
};

const settle = async (request, taskId, timeout = 120_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${taskId}`);
    if (detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === "completed")
      return detail.body;
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle`);
};

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "tracked.txt"), "committed\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

/** A real Reviewer writes failure evidence inside its own checkout. */
const FAILURE_LOG = [
  'command: test "$(tail -1 export.txt)" = total',
  "exit: 1",
  "actual: body",
  "expected: total"
].join("\n");

/**
 * A fixed candidate, an independent Reviewer, a rework in the original session
 * and a re-review, all through the real OS entry.
 *
 * The model is a scripted local provider; the spawned Main, `project_development`
 * and `call_subagent` tools, the durable Coordinator queue, the Git worktrees,
 * the Dashboard HTTP surface and the review records are production code. The
 * candidate is a real commit; the Reviewer's failure output is a real failing
 * command's file in its own checkout; the rework continues the first Executor's
 * checkpoint instead of starting a fresh Agent.
 */
test(
  "a frozen Git candidate is reviewed, reworked in the original session and re-reviewed",
  { timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-review-"));
    const repository = await makeRepository(join(root, "repository"));
    const baselineHead = await git(repository, ["rev-parse", "HEAD"]);
    const dashboard = await startDashboard({
      defaultProject: false,
      env: { COWORK_PROJECT_WRITE: "1", COWORK_DISABLE_WATCH_SUPERVISOR: "1" }
    });
    t.after(async () => {
      await dashboard.stop();
      await rm(root, { recursive: true, force: true });
    });
    const request = client(dashboard);
    const created = await request("/api/projects", {
      projectName: "候选审查项目",
      projectDirectory: repository
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project;
    const requirement = await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "报表导出加合计行",
      content: "导出文件须包含合计行。"
    });
    assert.equal(requirement.status, 201, JSON.stringify(requirement.body));
    const merge = await request(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`, {
      repository,
      targetBranch: "main"
    });
    assert.equal(merge.status, 200, JSON.stringify(merge.body));
    const requirementId = requirement.body.requirement.requirementId;
    const taskId = "candidate-review";
    const task = await request("/api/tasks", {
      taskId,
      goal: "完成报表导出审查",
      projectId: project.projectId
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));

    const failures = [];
    const requests = { main: 0, a: 0, b: 0, c: 0, d: 0 };
    const calls = {};
    let integration = "";
    let developmentId = "";
    let reviewId1 = "";
    let reviewId2 = "";
    let reviewId3 = "";
    let candidate1 = "";
    let candidate2 = "";
    let findingId = "";
    let failedReview = "";
    let failTest;
    const scriptFailure = new Promise((_, reject) => {
      failTest = reject;
    });
    const identity = (body) => {
      const system = body.messages
        .filter((message) => ["system", "developer"].includes(message.role))
        .map(messageText)
        .join("\n");
      if (!system.includes("You are a CoworkOS Subagent")) return "main";
      const match = userText(body).match(/工作项 ([A-D])/);
      return match ? match[1].toLowerCase() : "unknown";
    };
    const provider = await modelProtocolFixture("openai-completions", async (body) => {
      try {
        const role = identity(body);
        const step = requests[role]++;
        if (role === "main") {
          if (step === 0) {
            assert.ok(body.tools.some((tool) => tool.function.name === "project_development"));
            return {
              name: "project_development",
              arguments: {
                action: "create",
                requirementId,
                goal: "导出文件包含 header、数据行与合计行",
                completionCriteria: ["第一行为 header", "最后一行为 total"],
                route: "direct"
              }
            };
          }
          if (step === 1) {
            const development = toolJson(body).development;
            integration = development.workspace.directory;
            developmentId = development.developmentId;
            assert.ok(!integration.startsWith(`${repository}/`));
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：在需求现场生成 export.txt，第一行 header，第二行数据。",
                mode: "async",
                role: "executor",
                developmentId
              }
            };
          }
          if (step === 2) {
            calls.a = toolJson(body);
            assert.equal(calls.a.accepted, true);
            assert.equal(calls.a.role, "executor");
            assert.notEqual(calls.a.workspace, integration);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.a.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 3) {
            const waited = toolJson(body);
            assert.equal(waited.calls.find((entry) => entry.callId === calls.a.callId).status, "completed");
            return {
              name: "bash",
              arguments: {
                command: [
                  "set -e",
                  `cd "${integration}"`,
                  `cp "${calls.a.workspace}/export.txt" .`,
                  "git add -A",
                  'git commit -m "collect A" >/dev/null',
                  "echo COLLECTED"
                ].join(" && ")
              }
            };
          }
          if (step === 4) {
            assert.match(lastToolText(body), /COLLECTED/);
            candidate1 = await git(integration, ["rev-parse", "HEAD"]);
            return {
              name: "bash",
              arguments: {
                command: `cd "${integration}" && test "$(head -1 export.txt)" = header && echo SELF_OK`
              }
            };
          }
          if (step === 5) {
            assert.match(lastToolText(body), /SELF_OK/);
            return {
              name: "project_development",
              arguments: {
                action: "review_plan",
                developmentId,
                channel: "independent",
                basis: "导出格式属于完成标准，需要独立核验",
                checks: [
                  {
                    name: "自检：导出首行",
                    command: "head -1 export.txt",
                    exitCode: 0,
                    output: "SELF_OK"
                  }
                ]
              }
            };
          }
          if (step === 6) {
            assert.equal(toolJson(body).plan.channel, "independent");
            return {
              name: "project_development",
              arguments: {
                action: "freeze_candidate",
                developmentId,
                kind: "independent",
                authorCallId: calls.a.callId
              }
            };
          }
          if (step === 7) {
            const review = toolJson(body).review;
            reviewId1 = review.reviewId;
            assert.equal(review.state, "in_review");
            assert.equal(review.candidate.commit, candidate1);
            assert.equal(review.author.callId, calls.a.callId);
            return {
              name: "call_subagent",
              arguments: {
                task: `审查者工作项 B：独立核验候选 ${reviewId1} 的导出格式与完成标准。`,
                mode: "async",
                role: "reviewer",
                developmentId
              }
            };
          }
          if (step === 8) {
            calls.b = toolJson(body);
            assert.equal(calls.b.role, "reviewer");
            assert.notEqual(calls.b.agentId, calls.a.agentId, "the reviewer has its own identity");
            assert.notEqual(calls.b.workspace, calls.a.workspace, "the reviewer has its own checkout");
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.b.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 9) {
            const waited = toolJson(body);
            assert.equal(waited.calls.find((entry) => entry.callId === calls.b.callId).status, "completed");
            return {
              name: "project_development",
              arguments: { action: "attach_reviewer", reviewId: reviewId1, callId: calls.b.callId }
            };
          }
          if (step === 10) {
            const review = toolJson(body).review;
            assert.equal(review.reviewer.callId, calls.b.callId);
            assert.equal(review.reviewer.agentId, calls.b.agentId);
            assert.equal(review.reviewer.workspace, calls.b.workspace);
            return {
              name: "bash",
              arguments: { command: `cat "${calls.b.workspace}/evidence/failure.log"` }
            };
          }
          if (step === 11) {
            assert.match(lastToolText(body), /expected: total/);
            return {
              name: "project_development",
              arguments: {
                action: "record_finding",
                reviewId: reviewId1,
                title: "导出缺少合计行",
                detail: "完成标准要求最后一行为 total，实际最后一行为 body。",
                location: "export.txt",
                checks: [
                  {
                    name: "复审：合计行",
                    command: 'test "$(tail -1 export.txt)" = total',
                    exitCode: 1,
                    output: "actual: body\nexpected: total"
                  }
                ],
                rawFailure: readFileSync(join(calls.b.workspace, "evidence", "failure.log"), "utf8")
              }
            };
          }
          if (step === 12) {
            const review = toolJson(body).review;
            findingId = review.findings[0].findingId;
            assert.ok(findingId);
            return {
              name: "project_development",
              arguments: {
                action: "rule_finding",
                reviewId: reviewId1,
                findingId,
                decision: "fix",
                basis: "违反已确认的完成标准：导出须有合计行"
              }
            };
          }
          if (step === 13) {
            assert.equal(toolJson(body).review.findings[0].state, "fix_claimed");
            return {
              name: "project_development",
              arguments: {
                action: "complete_review",
                reviewId: reviewId1,
                verdict: "failed",
                summary: "候选缺少合计行，需返修后复审",
                checks: []
              }
            };
          }
          if (step === 14) {
            failedReview = toolJson(body).review.state;
            assert.equal(failedReview, "failed");
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：修复审查发现，补上合计行并重新生成 export.txt。",
                mode: "async",
                role: "executor",
                developmentId,
                continueCallId: calls.a.callId,
                reviewId: reviewId1
              }
            };
          }
          if (step === 15) {
            calls.a2 = toolJson(body);
            assert.equal(calls.a2.agentId, calls.a.agentId, "the rework keeps the original identity");
            assert.equal(calls.a2.workspace, calls.a.workspace, "the rework keeps the original checkout");
            assert.notEqual(calls.a2.callId, calls.a.callId);
            assert.equal(calls.a2.continuedFrom, calls.a.callId);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.a2.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 16) {
            const waited = toolJson(body);
            assert.equal(waited.calls.find((entry) => entry.callId === calls.a2.callId).status, "completed");
            return {
              name: "project_development",
              arguments: {
                action: "record_rework",
                reviewId: reviewId1,
                findingIds: [findingId],
                fromCallId: calls.a.callId,
                continuationCallId: calls.a2.callId
              }
            };
          }
          if (step === 17) {
            const review = toolJson(body).review;
            assert.equal(review.reworks.length, 1);
            assert.deepEqual(review.reworks[0].findingIds, [findingId]);
            assert.equal(review.reworks[0].agentId, calls.a.agentId);
            return {
              name: "bash",
              arguments: {
                command: [
                  "set -e",
                  `cd "${integration}"`,
                  `cp "${calls.a2.workspace}/export.txt" .`,
                  "git add -A",
                  'git commit -m "fix finding" >/dev/null',
                  "echo FIXED"
                ].join(" && ")
              }
            };
          }
          if (step === 18) {
            assert.match(lastToolText(body), /FIXED/);
            candidate2 = await git(integration, ["rev-parse", "HEAD"]);
            assert.notEqual(candidate2, candidate1);
            return {
              name: "project_development",
              arguments: {
                action: "freeze_candidate",
                developmentId,
                kind: "independent",
                previousReviewId: reviewId1
              }
            };
          }
          if (step === 19) {
            const review = toolJson(body).review;
            reviewId2 = review.reviewId;
            assert.equal(review.previousReviewId, reviewId1);
            assert.equal(review.previousCandidateCommit, candidate1);
            assert.deepEqual(review.changedPaths, ["export.txt"]);
            assert.equal(review.candidate.commit, candidate2);
            assert.equal(review.author.callId, calls.a2.callId);
            return {
              name: "call_subagent",
              arguments: {
                task: `审查者工作项 C：复审候选 ${reviewId2} 对原发现 ${findingId} 的修复。`,
                mode: "async",
                role: "reviewer",
                developmentId
              }
            };
          }
          if (step === 20) {
            calls.c = toolJson(body);
            assert.notEqual(calls.c.agentId, calls.a.agentId);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.c.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 21) {
            const waited = toolJson(body);
            assert.equal(waited.calls.find((entry) => entry.callId === calls.c.callId).status, "completed");
            return {
              name: "project_development",
              arguments: { action: "attach_reviewer", reviewId: reviewId2, callId: calls.c.callId }
            };
          }
          if (step === 22) {
            assert.equal(toolJson(body).review.reviewer.agentId, calls.c.agentId);
            return {
              name: "bash",
              arguments: {
                command: `cd "${integration}" && test "$(tail -1 export.txt)" = total && echo REVIEW_OK`
              }
            };
          }
          if (step === 23) {
            assert.match(lastToolText(body), /REVIEW_OK/);
            return {
              name: "project_development",
              arguments: {
                action: "complete_review",
                reviewId: reviewId2,
                verdict: "passed",
                summary: "复审通过：导出首行 header，末行 total，原发现已修复",
                checks: [
                  {
                    name: "复审：合计行",
                    command: "tail -1 export.txt",
                    exitCode: 0,
                    output: "REVIEW_OK"
                  }
                ]
              }
            };
          }
          if (step === 24) {
            assert.equal(toolJson(body).review.state, "passed");
            return {
              name: "project_development",
              arguments: { action: "get_review", reviewId: reviewId1 }
            };
          }
          if (step === 25) {
            const review = toolJson(body).review;
            const finding = review.findings.find((entry) => entry.findingId === findingId);
            assert.equal(finding.state, "fixed");
            assert.equal(finding.fixedCommit, candidate2);
            assert.equal(finding.candidateCommit, candidate1);
            assert.equal(finding.checks[0].exitCode, 1);
            assert.equal(
              finding.rawFailure,
              readFileSync(join(calls.b.workspace, "evidence", "failure.log"), "utf8")
            );
            assert.equal(finding.ruling.decision, "fix");
            assert.match(finding.ruling.basis, /完成标准/);
            return {
              name: "project_development",
              arguments: { action: "delivery_check", developmentId }
            };
          }
          if (step === 26) {
            const qualification = toolJson(body).qualification;
            assert.equal(qualification.eligible, true, JSON.stringify(qualification));
            assert.equal(qualification.reviewId, reviewId2);
            assert.equal(qualification.independentReview, true);
            assert.equal(qualification.approved.commit, candidate2);
            return {
              name: "bash",
              arguments: {
                command: [
                  "set -e",
                  `cd "${integration}"`,
                  'printf "later\\n" > later.txt',
                  "git add -A",
                  'git commit -m "later change" >/dev/null',
                  "echo LATER"
                ].join(" && ")
              }
            };
          }
          if (step === 27) {
            assert.match(lastToolText(body), /LATER/);
            return {
              name: "project_development",
              arguments: { action: "delivery_check", developmentId }
            };
          }
          if (step === 28) {
            const qualification = toolJson(body).qualification;
            assert.equal(qualification.eligible, false);
            assert.ok(qualification.reasons.includes("candidate_changed"), JSON.stringify(qualification));
            assert.equal(qualification.approved.commit, candidate2);
            return {
              name: "project_development",
              arguments: {
                action: "review_plan",
                developmentId,
                channel: "combined",
                basis: "对当前集成版本做组合终审",
                checks: [
                  { name: "自检：导出首行", command: "head -1 export.txt", exitCode: 0, output: "header" }
                ]
              }
            };
          }
          if (step === 29) {
            assert.equal(toolJson(body).plan.channel, "combined");
            return {
              name: "project_development",
              arguments: { action: "freeze_candidate", developmentId, kind: "combined" }
            };
          }
          if (step === 30) {
            const review = toolJson(body).review;
            reviewId3 = review.reviewId;
            assert.equal(review.kind, "combined");
            return {
              name: "call_subagent",
              arguments: {
                task: `审查者工作项 D：对组合版本 ${reviewId3} 做独立终审。`,
                mode: "async",
                role: "reviewer",
                developmentId
              }
            };
          }
          if (step === 31) {
            calls.d = toolJson(body);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.d.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 32) {
            const waited = toolJson(body);
            assert.equal(waited.calls.find((entry) => entry.callId === calls.d.callId).status, "completed");
            return {
              name: "bash",
              arguments: {
                command: `cd "${calls.d.workspace}" && printf "tampered\\n" >> export.txt && echo TAMPERED`
              }
            };
          }
          if (step === 33) {
            assert.match(lastToolText(body), /TAMPERED/);
            return {
              name: "project_development",
              arguments: { action: "attach_reviewer", reviewId: reviewId3, callId: calls.d.callId }
            };
          }
          if (step === 34) {
            assert.match(lastToolText(body), /审查现场/, `drift was not reported: ${lastToolText(body)}`);
            return {
              name: "project_development",
              arguments: { action: "get_review", reviewId: reviewId3 }
            };
          }
          if (step === 35) {
            const review = toolJson(body).review;
            assert.equal(review.state, "drifted");
            assert.match(review.drift, /受控文件改动/);
            return {
              name: "project_development",
              arguments: { action: "delivery_check", developmentId }
            };
          }
          if (step === 36) {
            const qualification = toolJson(body).qualification;
            assert.equal(qualification.eligible, false);
            assert.ok(qualification.reasons.includes("review_drifted"), JSON.stringify(qualification));
            return { text: "候选审查、原上下文返修与复审已完成；组合版本漂移未被记为有效审查。" };
          }
          return { text: "候选审查流程已完成。" };
        }
        if (role === "a") {
          if (step === 0) {
            assert.equal(
              body.messages.filter((message) => message.role === "user").length,
              1,
              "the first call starts from a fresh transcript"
            );
            return {
              name: "write_file",
              arguments: { path: "export.txt", content: "header\nbody\n" }
            };
          }
          if (step === 1) return { text: "A 完成：已写入 export.txt，首行 header。" };
          if (step === 2) {
            // The continuation is the same agent with the earlier transcript.
            assert.match(userText(body), /修复审查发现/);
            assert.match(assistantText(body), /A 完成：已写入 export\.txt/);
            assert.equal(body.messages.filter((message) => message.role === "user").length, 2);
            return {
              name: "write_file",
              arguments: { path: "export.txt", content: "header\nbody\ntotal\n" }
            };
          }
          return { text: "A 完成返修：已补合计行。" };
        }
        if (role === "b") {
          if (step === 0)
            return {
              name: "write_file",
              arguments: { path: "evidence/failure.log", content: FAILURE_LOG }
            };
          if (step === 1)
            return {
              name: "run_command",
              arguments: { command: 'test "$(tail -1 export.txt)" = total' }
            };
          return {
            text: "候选违反完成标准：export.txt 末行为 body，应为 total；失败原件见 work/failure.log。"
          };
        }
        if (role === "c") {
          if (step === 0)
            return {
              name: "run_command",
              arguments: { command: 'test "$(tail -1 export.txt)" = total && echo REVIEW_OK' }
            };
          return { text: "复审通过：export.txt 末行为 total，原发现已修复。" };
        }
        // Reviewer D examines the combined version; it writes nothing.
        return { text: "组合版本核对通过。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        failTest(error);
        return { text: "候选审查夹具失败。" };
      }
    });
    t.after(async () => {
      await provider.close();
    });
    const saved = await request("/api/model-settings", {
      profileName: "本地夹具",
      baseUrl: provider.baseUrl,
      model: "protocol-fixture",
      api: "openai-completions",
      supportsReasoningEffort: false,
      supportsImages: false,
      apiKey: "native-execution-local-key"
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const started = await request(`/api/tasks/${taskId}/run`, {
      prompt: "完成报表导出需求：先实现，再冻结候选做独立审查，有发现时在原执行会话返修并复审。"
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await Promise.race([settle(request, taskId), scriptFailure]);
    assert.deepEqual(failures, [], failures.join("\n"));

    // The integration checkout holds the corrected export; the original
    // Executor's own checkout was reused rather than recreated.
    assert.equal(await readFile(join(integration, "export.txt"), "utf8"), "header\nbody\ntotal\n");
    assert.equal(
      await git(calls.a.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
      `coworkos/work/${calls.a.callId}`
    );
    assert.equal(
      await git(calls.a2.workspace, ["rev-parse", "HEAD"]),
      await git(calls.a.workspace, ["rev-parse", "HEAD"])
    );

    // Records are readable through the project surface after the run, with the
    // reviewer identity, versions, checks, failure original and rulings.
    const records = await request(
      `/api/projects/${encodeURIComponent(project.projectId)}/reviews?developmentId=${encodeURIComponent(
        developmentId
      )}`
    );
    assert.equal(records.status, 200, JSON.stringify(records.body));
    assert.equal(records.body.plan.channel, "combined");
    assert.equal(records.body.plan.checks[0].name, "自检：导出首行");
    assert.equal(records.body.reviews.length, 3);
    const [first, second, third] = records.body.reviews;
    assert.equal(first.reviewId, reviewId1);
    assert.equal(first.state, "failed");
    assert.equal(first.reviewer.agentId, calls.b.agentId);
    assert.notEqual(first.reviewer.agentId, first.author.agentId);
    assert.equal(first.findings[0].state, "fixed");
    assert.equal(first.findings[0].fixedCommit, candidate2);
    assert.equal(second.reviewId, reviewId2);
    assert.equal(second.state, "passed");
    assert.deepEqual(second.changedPaths, ["export.txt"]);
    assert.equal(third.reviewId, reviewId3);
    assert.equal(third.state, "drifted");
    assert.equal(records.body.qualification.eligible, false);
    assert.ok(records.body.qualification.reasons.includes("review_drifted"));

    // The Reviewer session is a real, separate work item; its checkout is not
    // the dependency integration site or the user's repository.
    assert.notEqual(calls.b.agentId, calls.a.agentId);
    assert.notEqual(calls.c.agentId, calls.a.agentId);
    assert.notEqual(calls.b.workspace, integration);
    assert.equal((await stat(calls.b.workspace)).isDirectory(), true);
    // The user's own working tree was never touched.
    assert.equal(await git(repository, ["rev-parse", "HEAD"]), baselineHead);
    assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "committed\n");
  }
);

/**
 * The same review records on SQLite and PostgreSQL, with a backup/restore and
 * a restart in between. The candidate and the Reviewer's checkout are real
 * worktrees; only the model session is represented by the recorded call facts.
 */
let postgres;

before(
  async () => {
    postgres = await startPostgresProjectDatabase();
  },
  { timeout: 180_000 }
);

after(async () => {
  await postgres?.stop();
});

for (const engine of PROJECT_DATA_ENGINES) {
  test(`${engine}: review plans, fixed candidates and rulings survive restart and backup`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `atria-p4-review-${engine}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = await makeRepository(join(root, "repository"));
    const developmentRoot = join(root, "development-workspaces");
    const runtime = new ProjectDataRuntime({
      config:
        engine === "sqlite"
          ? { sqlite: { path: join(root, "project-data.sqlite") } }
          : projectDataConfig(engine, { postgres }),
      configPath: join(root, "config.json"),
      dataRoot: root,
      env: {}
    });
    let runtimeClosed = false;
    t.after(async () => {
      if (!runtimeClosed) await runtime.close();
    });
    const gateway = await runtime.service();
    await gateway.ensureProject({
      projectId: "project-review",
      projectName: "审查项目",
      projectDirectory: repository,
      backendId: "backend-review"
    });
    const requirement = await gateway.createRequirement("project-review", {
      title: "审查契约",
      content: "验证审查记录。"
    });
    await gateway.setMergeConfig(
      "project-review",
      { repository, targetBranch: "main", executionBackendId: "backend-review" },
      "backend-review"
    );
    const calls = {};
    const service = createProjectDevelopmentService({
      runtime,
      backendId: "backend-review",
      developmentRoot,
      project: async (id) =>
        id === "project-review"
          ? { projectId: id, projectName: "审查项目", projectDirectory: repository }
          : undefined,
      taskProject: async (id) =>
        id === "task-review"
          ? { projectId: "project-review", projectName: "审查项目", projectDirectory: repository }
          : undefined,
      call: async (_taskId, callId) => calls[callId]
    });
    const development = await service.createForTask("task-review", {
      requirementId: requirement.requirementId,
      goal: "导出包含合计行",
      completionCriteria: ["最后一行为 total"],
      route: "direct"
    });
    const integration = development.workspace.directory;
    await writeFile(join(integration, "export.txt"), "header\nbody\n");
    await git(integration, ["add", "."]);
    await git(integration, ["commit", "-m", "candidate one"]);
    const candidateOne = await git(integration, ["rev-parse", "HEAD"]);

    await service.setReviewPlanForTask("task-review", {
      developmentId: development.developmentId,
      channel: "independent",
      basis: "需要独立核验",
      checks: [{ name: "自检", command: "head -1 export.txt", exitCode: 0, output: "header" }]
    });
    const executorSite = join(developmentRoot, "work-items", "call-author");
    await prepareWorkItemSite({
      developmentDirectory: integration,
      directory: executorSite,
      branch: "coworkos/work/call-author"
    });
    calls["call-author"] = {
      callId: "call-author",
      agentId: "subagent-author",
      role: "executor",
      workspace: executorSite,
      developmentId: development.developmentId,
      status: "completed"
    };
    let review = await service.startReviewForTask("task-review", {
      developmentId: development.developmentId,
      kind: "independent",
      authorCallId: "call-author"
    });
    assert.equal(review.candidate.commit, candidateOne);
    const reviewerSite = join(developmentRoot, "work-items", "call-reviewer");
    await prepareWorkItemSite({
      developmentDirectory: integration,
      directory: reviewerSite,
      branch: "coworkos/work/call-reviewer"
    });
    calls["call-reviewer"] = {
      callId: "call-reviewer",
      agentId: "subagent-reviewer",
      role: "reviewer",
      workspace: reviewerSite,
      developmentId: development.developmentId,
      status: "completed"
    };
    review = await service.attachReviewerForTask("task-review", {
      reviewId: review.reviewId,
      callId: "call-reviewer"
    });
    review = await service.recordFindingForTask("task-review", {
      reviewId: review.reviewId,
      title: "缺少合计行",
      detail: "最后一行为 body",
      checks: [{ name: "检查", command: "tail -1 export.txt", exitCode: 1, output: "body" }],
      rawFailure: "actual: body\nexpected: total"
    });
    const findingId = review.findings[0].findingId;
    review = await service.ruleFindingForTask("task-review", {
      reviewId: review.reviewId,
      findingId,
      decision: "dismiss",
      category: "out_of_scope",
      basis: "建议改为 PDF 不在本次完成标准内；保留建议，由负责人另行决定"
    });
    assert.equal(review.findings[0].state, "dismissed");
    assert.equal(review.findings[0].ruling.category, "out_of_scope");
    review = await service.completeReviewForTask("task-review", {
      reviewId: review.reviewId,
      verdict: "failed",
      summary: "只有一条范围外建议，候选内容仍不完整",
      checks: []
    });
    assert.equal(review.state, "failed");

    // Backup includes the new shared tables; restoring removes a later review.
    const backupPath = join(root, `review-backup-${engine}.json`);
    const backup = await gateway.backupTo(backupPath);
    assert.equal(backup.counts.project_data_development_review_plans, 1);
    assert.equal(backup.counts.project_data_development_reviews, 1);
    const laterSite = join(developmentRoot, "work-items", "call-later");
    await prepareWorkItemSite({
      developmentDirectory: integration,
      directory: laterSite,
      branch: "coworkos/work/call-later"
    });
    calls["call-later"] = {
      callId: "call-later",
      agentId: "subagent-later",
      role: "reviewer",
      workspace: laterSite,
      developmentId: development.developmentId,
      status: "completed"
    };
    await writeFile(join(integration, "later.txt"), "later\n");
    await git(integration, ["add", "."]);
    await git(integration, ["commit", "-m", "candidate two"]);
    await service.setReviewPlanForTask("task-review", {
      developmentId: development.developmentId,
      channel: "combined",
      basis: "combined final version",
      checks: [{ name: "combined self", command: "fixture", exitCode: 0, output: "ok" }]
    });
    const later = await service.startReviewForTask("task-review", {
      developmentId: development.developmentId,
      kind: "combined",
      previousReviewId: review.reviewId
    });
    assert.equal((await service.queryReviewsForTask("task-review")).length, 2);
    const restored = await gateway.restoreFrom(backupPath);
    assert.equal(restored.counts.project_data_development_reviews, 1);
    assert.equal((await service.queryReviewsForTask("task-review")).length, 1);

    // A restart reads the same plan, candidate, finding and ruling.
    await runtime.close();
    runtimeClosed = true;
    const reopened = new ProjectDataRuntime({
      config:
        engine === "sqlite"
          ? { sqlite: { path: join(root, "project-data.sqlite") } }
          : projectDataConfig(engine, { postgres }),
      configPath: join(root, "config.json"),
      dataRoot: root,
      env: {}
    });
    t.after(() => reopened.close());
    const afterRestart = await reopened.service();
    const reads = await afterRestart.queryReviews("project-review", development.developmentId);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].reviewId, review.reviewId);
    assert.equal(reads[0].candidate.commit, candidateOne);
    assert.equal(reads[0].findings[0].findingId, findingId);
    assert.equal(
      reads[0].findings[0].ruling.basis,
      "建议改为 PDF 不在本次完成标准内；保留建议，由负责人另行决定"
    );
    const afterPlan = await afterRestart.reviewPlan("project-review", development.developmentId);
    assert.equal(afterPlan.channel, "independent");
    assert.equal(afterPlan.checks[0].name, "自检");
    // The later candidate's review was the one the restore removed.
    assert.equal(later.reviewId === reads[0].reviewId, false);
  });
}

/**
 * A secondary backend's review writes travel through the authority.
 *
 * The service runs where the checkout and the Git facts live; the shared plan,
 * candidate, findings and rulings are stored by the authority. This is the
 * remote gateway path #01 established, now carrying review records.
 */
test("a remote backend writes review facts through the authority and reads them back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p4-review-remote-"));
  const repository = await makeRepository(join(root, "repository"));
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(async () => {
    await dashboard.stop();
    await rm(root, { recursive: true, force: true });
  });
  const request = client(dashboard);
  const project = (
    await request("/api/projects", { projectName: "远端审查项目", projectDirectory: repository })
  ).body.project;
  const requirement = (
    await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "远端审查",
      content: "远端写入审查记录。"
    })
  ).body.requirement;
  const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
  assert.ok(instance.value?.token);
  const remote = await RemoteProjectDataService.open({
    url: dashboard.base,
    token: instance.value.token,
    backendId: "backend_remote_review",
    source: "p4-review-test"
  });
  t.after(() => remote.close());
  const calls = {};
  const remoteRoot = join(root, "remote");
  const service = createProjectDevelopmentService({
    runtime: { service: async () => remote },
    backendId: "backend_remote_review",
    developmentRoot: join(remoteRoot, "development-workspaces"),
    project: async (id) =>
      id === project.projectId
        ? { projectId: id, projectName: "远端审查项目", projectDirectory: repository }
        : undefined,
    taskProject: async (id) =>
      id === "task-remote"
        ? { projectId: project.projectId, projectName: "远端审查项目", projectDirectory: repository }
        : undefined,
    call: async (_taskId, callId) => calls[callId]
  });
  await service.setMergeConfig(project.projectId, { repository, targetBranch: "main" });
  const development = await service.create(project.projectId, {
    requirementId: requirement.requirementId,
    goal: "远端候选审查",
    completionCriteria: ["导出包含数据行"],
    route: "direct"
  });
  assert.equal(development.workspace.state, "ready");
  const integration = development.workspace.directory;
  await writeFile(join(integration, "export.txt"), "header\ndata\n");
  await git(integration, ["add", "."]);
  await git(integration, ["commit", "-m", "remote candidate"]);
  const candidate = await git(integration, ["rev-parse", "HEAD"]);

  await service.setReviewPlan(project.projectId, {
    developmentId: development.developmentId,
    channel: "independent",
    basis: "远端记录",
    checks: [{ name: "远端自检", command: "head -1 export.txt", exitCode: 0, output: "header" }]
  });
  let review = await service.startReview(project.projectId, "task-remote", {
    developmentId: development.developmentId,
    kind: "independent"
  });
  assert.equal(review.candidate.commit, candidate);
  const reviewerSite = join(remoteRoot, "development-workspaces", "work-items", "call-remote-reviewer");
  await prepareWorkItemSite({
    developmentDirectory: integration,
    directory: reviewerSite,
    branch: "coworkos/work/call-remote-reviewer"
  });
  calls["call-remote-reviewer"] = {
    callId: "call-remote-reviewer",
    agentId: "subagent-remote-reviewer",
    role: "reviewer",
    workspace: reviewerSite,
    developmentId: development.developmentId,
    status: "completed"
  };
  review = await service.attachReviewer(project.projectId, "task-remote", {
    reviewId: review.reviewId,
    callId: "call-remote-reviewer"
  });
  assert.equal(review.reviewer.agentId, "subagent-remote-reviewer");
  review = await service.recordFinding(project.projectId, {
    reviewId: review.reviewId,
    title: "远端建议",
    detail: "建议增加 CSV BOM",
    checks: []
  });
  const findingId = review.findings[0].findingId;
  review = await service.ruleFinding(project.projectId, {
    reviewId: review.reviewId,
    findingId,
    decision: "dismiss",
    category: "out_of_scope",
    basis: "BOM 不在本次验收内"
  });
  review = await service.completeReview(project.projectId, {
    reviewId: review.reviewId,
    verdict: "passed",
    summary: "远端复审通过",
    checks: [{ name: "远端检查", command: "head -1 export.txt", exitCode: 0, output: "header" }]
  });
  assert.equal(review.state, "passed");
  const qualification = await service.delivery(project.projectId, development.developmentId);
  assert.equal(qualification.eligible, true, JSON.stringify(qualification));
  assert.equal(qualification.approved.commit, candidate);

  // The authority holds the shared facts and reports no checkout of its own.
  const authority = await request(
    `/api/projects/${encodeURIComponent(project.projectId)}/reviews?developmentId=${encodeURIComponent(
      development.developmentId
    )}`
  );
  assert.equal(authority.status, 200, JSON.stringify(authority.body));
  assert.equal(authority.body.plan.basis, "远端记录");
  assert.equal(authority.body.reviews.length, 1);
  assert.equal(authority.body.reviews[0].findings[0].ruling.category, "out_of_scope");
  assert.equal(authority.body.qualification, null);

  // A review already opened cannot be replaced by a no-Reviewer channel.
  await assert.rejects(
    service.setReviewPlan(project.projectId, {
      developmentId: development.developmentId,
      channel: "self",
      basis: "试图绕过已有审查",
      checks: [{ name: "检查", command: "head -1 export.txt", exitCode: 0, output: "header" }]
    }),
    (error) => {
      assert.equal(error.code, "review_channel_downgrade");
      return true;
    }
  );

  // The remote reader sees the same review and its qualification.
  const remoteReviews = await remote.queryReviews(project.projectId, development.developmentId);
  assert.equal(remoteReviews.length, 1);
  assert.equal(remoteReviews[0].reviewId, review.reviewId);
  assert.equal(remoteReviews[0].findings[0].state, "dismissed");
  assert.equal(
    (await remote.reviewPlan(project.projectId, development.developmentId)).channel,
    "independent"
  );
});

/**
 * A lifecycle harness over the real service, gateway and Git worktrees.
 *
 * Reviewer/Executor identities are durable call facts, like the queue the
 * production service reads; the check rows are controlled service inputs that
 * pin down state transitions without a second model run.
 */
async function makeLifecycleHarness({ root, runtime, backendId = "backend-lifecycle" }) {
  const repository = await makeRepository(join(root, "repository"));
  const developmentRoot = join(root, "development-workspaces");
  const gateway = await runtime.service();
  const projectId = "project-lifecycle";
  const project = { projectId, projectName: "lifecycle", projectDirectory: repository };
  await gateway.ensureProject({
    projectId,
    projectName: project.projectName,
    projectDirectory: repository,
    backendId
  });
  await gateway.setMergeConfig(
    projectId,
    { repository, targetBranch: "main", executionBackendId: backendId },
    backendId
  );
  const calls = {};
  const service = createProjectDevelopmentService({
    runtime,
    backendId,
    developmentRoot,
    project: async (id) => (id === projectId ? project : undefined),
    taskProject: async (id) => (id === "task-lifecycle" ? project : undefined),
    call: async (_taskId, callId) => calls[callId]
  });
  let seq = 0;
  const fixtureChecks = [{ name: "controlled check", command: "fixture", exitCode: 0, output: "ok" }];
  async function makeDevelopment(label) {
    const requirement = await gateway.createRequirement(projectId, { title: label, content: label });
    return service.create(projectId, {
      requirementId: requirement.requirementId,
      goal: label,
      completionCriteria: ["observable result"],
      route: "direct"
    });
  }
  async function commit(development, name, content) {
    const directory = development.workspace.directory;
    await writeFile(join(directory, name), content);
    await git(directory, ["add", "."]);
    await git(directory, ["commit", "-m", content]);
    return git(directory, ["rev-parse", "HEAD"]);
  }
  async function writeExecutor(development, agentId = "executor-a") {
    const callId = `call-author-${++seq}`;
    const directory = join(developmentRoot, "work-items", callId);
    await prepareWorkItemSite({
      developmentDirectory: development.workspace.directory,
      directory,
      branch: `coworkos/work/${callId}`
    });
    const fact = {
      callId,
      agentId,
      role: "executor",
      workspace: directory,
      developmentId: development.developmentId,
      status: "completed"
    };
    calls[callId] = fact;
    return fact;
  }
  function continueExecutor(from) {
    const callId = `call-continuation-${++seq}`;
    const fact = { ...from, callId, continuationFrom: from.callId };
    calls[callId] = fact;
    return fact;
  }
  async function addReviewer(development) {
    const callId = `call-reviewer-${++seq}`;
    const directory = join(developmentRoot, "work-items", callId);
    await prepareWorkItemSite({
      developmentDirectory: development.workspace.directory,
      directory,
      branch: `coworkos/work/${callId}`
    });
    const fact = {
      callId,
      agentId: `reviewer-${seq}`,
      role: "reviewer",
      workspace: directory,
      developmentId: development.developmentId,
      status: "completed"
    };
    calls[callId] = fact;
    return fact;
  }
  const plan = (development, channel = "independent") =>
    service.setReviewPlan(projectId, {
      developmentId: development.developmentId,
      channel,
      basis: "lifecycle regression",
      checks: fixtureChecks
    });
  const start = (development, options = {}) =>
    service.startReview(projectId, "task-lifecycle", {
      developmentId: development.developmentId,
      kind: "independent",
      ...options
    });
  const attach = (review, callId) =>
    service.attachReviewer(projectId, "task-lifecycle", { reviewId: review.reviewId, callId });
  const finding = (review, title) =>
    service.recordFinding(projectId, { reviewId: review.reviewId, title, detail: title, checks: [] });
  const rule = (review, findingId, decision, extra = {}) =>
    service.ruleFinding(projectId, {
      reviewId: review.reviewId,
      findingId,
      decision,
      basis: "recorded lifecycle basis",
      ...extra
    });
  const complete = (review, verdict, checks = fixtureChecks) =>
    service.completeReview(projectId, {
      reviewId: review.reviewId,
      verdict,
      summary: "controlled lifecycle result",
      checks
    });
  const rework = (review, findingId, from, continuation) =>
    service.recordRework(projectId, "task-lifecycle", {
      reviewId: review.reviewId,
      findingIds: [findingId],
      fromCallId: from.callId,
      continuationCallId: continuation.callId
    });
  async function currentCandidate(development) {
    const workspace = development.workspace.directory;
    return {
      commit: await git(workspace, ["rev-parse", "HEAD"]),
      tree: await git(workspace, ["rev-parse", "HEAD^{tree}"]),
      branch: development.workspace.branch,
      workspace
    };
  }
  return {
    repository,
    developmentRoot,
    gateway,
    service,
    calls,
    projectId,
    project,
    makeDevelopment,
    commit,
    writeExecutor,
    continueExecutor,
    addReviewer,
    currentCandidate,
    plan,
    start,
    attach,
    finding,
    rule,
    complete,
    rework,
    delivery: (development) => service.delivery(projectId, development.developmentId),
    getReview: (reviewId) => service.getReview(projectId, reviewId)
  };
}

test("a closed or drifted review keeps its findings rulable and one reviewer owns it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-p4-lifecycle-"));
  const config = { sqlite: { path: join(root, "project-data.sqlite") } };
  let runtime = new ProjectDataRuntime({
    config,
    configPath: join(root, "config.json"),
    dataRoot: root,
    env: {}
  });
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const h = await makeLifecycleHarness({ root, runtime });

  // P1: a finding left open when its review completes failed can still be ruled.
  const failed = await h.makeDevelopment("failed review with open finding");
  await h.commit(failed, "export.txt", "header\n");
  await h.plan(failed);
  const failedAuthor = await h.writeExecutor(failed);
  let review = await h.start(failed, { authorCallId: failedAuthor.callId });
  review = await h.attach(review, (await h.addReviewer(failed)).callId);
  review = await h.finding(review, "found late");
  const lateFinding = review.findings[0].findingId;
  review = await h.complete(review, "failed", []);
  assert.equal(review.state, "failed");
  assert.equal(review.findings[0].state, "open");
  const ruledLate = await h.rule(review, lateFinding, "dismiss", { category: "false_positive" });
  assert.equal(ruledLate.findings[0].state, "dismissed");
  await assert.rejects(h.finding(review, "too late"), (error) => error.code === "review_closed");
  assert.equal(
    (await h.delivery(failed)).reasons.includes("findings_open"),
    false,
    "a ruled finding no longer blocks delivery"
  );

  // P1: a fix ruled after closure can be reworked from the original session and
  // settled by a successor review pass.
  const fixed = await h.makeDevelopment("failed review with fix after closure");
  await h.commit(fixed, "export.txt", "header\n");
  await h.plan(fixed);
  const fixedAuthor = await h.writeExecutor(fixed);
  let fixReview = await h.start(fixed, { authorCallId: fixedAuthor.callId });
  fixReview = await h.attach(fixReview, (await h.addReviewer(fixed)).callId);
  fixReview = await h.finding(fixReview, "repair me");
  const fixFinding = fixReview.findings[0].findingId;
  fixReview = await h.complete(fixReview, "failed", []);
  fixReview = await h.rule(fixReview, fixFinding, "fix");
  const continuation = h.continueExecutor(fixedAuthor);
  await h.rework(fixReview, fixFinding, fixedAuthor, continuation);
  const fixedCandidate = await h.commit(fixed, "export.txt", "header\nfixed\n");
  let successor = await h.start(fixed, { previousReviewId: fixReview.reviewId });
  successor = await h.attach(successor, (await h.addReviewer(fixed)).callId);
  successor = await h.complete(successor, "passed");
  const fixedAfter = await h.getReview(fixReview.reviewId);
  assert.equal(fixedAfter.state, "failed");
  assert.equal(fixedAfter.findings[0].state, "fixed");
  assert.equal(fixedAfter.findings[0].fixedCommit, fixedCandidate);
  assert.equal(fixedAfter.findings[0].verifiedByReviewId, successor.reviewId);
  assert.equal((await h.delivery(fixed)).eligible, true);

  // P1: a drifted review is terminal but its findings can still be dismissed or
  // reworked; the drift itself is never turned into a passed review.
  const driftedDev = await h.makeDevelopment("drifted review with findings");
  await h.commit(driftedDev, "export.txt", "header\n");
  await h.plan(driftedDev);
  const driftAuthor = await h.writeExecutor(driftedDev);
  let driftReview = await h.start(driftedDev, { authorCallId: driftAuthor.callId });
  const driftReviewer = await h.addReviewer(driftedDev);
  driftReview = await h.attach(driftReview, driftReviewer.callId);
  driftReview = await h.finding(driftReview, "fix after drift");
  const driftFinding = driftReview.findings[0].findingId;
  driftReview = await h.rule(driftReview, driftFinding, "fix");
  driftReview = await h.finding(driftReview, "dismiss after drift");
  const dismissFinding = driftReview.findings.at(-1).findingId;
  await writeFile(join(driftReviewer.workspace, "export.txt"), "tampered\n");
  await assert.rejects(h.complete(driftReview, "failed", []), (error) => error.code === "review_drifted");
  const drifted = await h.getReview(driftReview.reviewId);
  assert.equal(drifted.state, "drifted");
  const dismissed = await h.rule(drifted, dismissFinding, "dismiss", { category: "out_of_scope" });
  assert.equal(dismissed.findings.find((entry) => entry.findingId === dismissFinding).state, "dismissed");
  const driftContinuation = h.continueExecutor(driftAuthor);
  await h.rework(drifted, driftFinding, driftAuthor, driftContinuation);
  const driftCandidate = await h.commit(driftedDev, "export.txt", "header\nfixed\n");
  let driftSuccessor = await h.start(driftedDev, { previousReviewId: drifted.reviewId });
  driftSuccessor = await h.attach(driftSuccessor, (await h.addReviewer(driftedDev)).callId);
  driftSuccessor = await h.complete(driftSuccessor, "passed");
  const driftAfter = await h.getReview(drifted.reviewId);
  assert.equal(driftAfter.state, "drifted", "a drifted review stays drifted");
  assert.equal(driftAfter.findings.find((entry) => entry.findingId === driftFinding).state, "fixed");
  assert.equal(
    driftAfter.findings.find((entry) => entry.findingId === driftFinding).fixedCommit,
    driftCandidate
  );
  assert.equal((await h.delivery(driftedDev)).eligible, true);

  // M1: a review belongs to the Reviewer that was bound first. A second
  // Reviewer cannot replace it; the same call is an idempotent retry.
  const identity = await h.makeDevelopment("reviewer identity");
  await h.commit(identity, "export.txt", "header\n");
  await h.plan(identity);
  const identityAuthor = await h.writeExecutor(identity);
  let identityReview = await h.start(identity, { authorCallId: identityAuthor.callId });
  const reviewerOne = await h.addReviewer(identity);
  identityReview = await h.attach(identityReview, reviewerOne.callId);
  identityReview = await h.finding(identityReview, "source finding");
  const sourceFinding = identityReview.findings[0].findingId;
  assert.equal(identityReview.findings[0].source.callId, reviewerOne.callId);
  const reviewerTwo = await h.addReviewer(identity);
  await assert.rejects(
    h.attach(identityReview, reviewerTwo.callId),
    (error) => error.code === "review_reviewer_bound"
  );
  const unchanged = await h.getReview(identityReview.reviewId);
  assert.equal(unchanged.reviewer.callId, reviewerOne.callId);
  assert.equal(unchanged.findings[0].findingId, sourceFinding);
  assert.equal(unchanged.findings[0].source.callId, reviewerOne.callId);
  const retried = await h.attach(unchanged, reviewerOne.callId);
  assert.equal(retried.reviewer.callId, reviewerOne.callId);
  assert.equal(retried.findings[0].findingId, sourceFinding);
  // A different Reviewer needs its own review record, not a rebind.
  let separate = await h.start(identity);
  separate = await h.attach(separate, reviewerTwo.callId);
  assert.equal(separate.reviewer.callId, reviewerTwo.callId);
  const originalStill = await h.getReview(identityReview.reviewId);
  assert.equal(originalStill.reviewer.callId, reviewerOne.callId);
  assert.equal(originalStill.findings[0].source.callId, reviewerOne.callId);

  // A leased Reviewer whose own checkout is not prepared yet is retryable, not
  // a drift that permanently invalidates the review.
  const pending = await h.makeDevelopment("reviewer site not ready");
  await h.commit(pending, "export.txt", "header\n");
  await h.plan(pending);
  const pendingAuthor = await h.writeExecutor(pending);
  const pendingReview = await h.start(pending, { authorCallId: pendingAuthor.callId });
  const pendingCall = "call-pending-site";
  const pendingDirectory = join(h.developmentRoot, "work-items", pendingCall);
  h.calls[pendingCall] = {
    callId: pendingCall,
    agentId: "reviewer-pending",
    role: "reviewer",
    workspace: pendingDirectory,
    developmentId: pending.developmentId,
    status: "leased"
  };
  await assert.rejects(
    h.attach(pendingReview, pendingCall),
    (error) => error.code === "review_site_unavailable"
  );
  assert.equal((await h.getReview(pendingReview.reviewId)).state, "in_review");
  await prepareWorkItemSite({
    developmentDirectory: pending.workspace.directory,
    directory: pendingDirectory,
    branch: `coworkos/work/${pendingCall}`
  });
  const pendingAttached = await h.attach(pendingReview, pendingCall);
  assert.equal(pendingAttached.reviewer.callId, pendingCall);

  // A forced self plan with a started review is not deliverable; the guard
  // covers inconsistent/legacy rows even though the service refuses to create
  // this state through startReview.
  const selfDev = await h.makeDevelopment("self with started review");
  await h.commit(selfDev, "self.txt", "one\n");
  const selfCandidate = await h.currentCandidate(selfDev);
  await h.gateway.setReviewPlan(h.projectId, selfDev.developmentId, {
    channel: "self",
    basis: "forced legacy self plan",
    checks: [{ name: "self", command: "fixture", exitCode: 0, output: "ok" }],
    candidate: selfCandidate
  });
  await h.gateway.createReview(h.projectId, selfDev.developmentId, {
    kind: "independent",
    candidate: selfCandidate,
    changedPaths: []
  });
  const selfQualification = await h.delivery(selfDev);
  assert.equal(selfQualification.eligible, false);
  assert.ok(selfQualification.reasons.includes("review_started"), JSON.stringify(selfQualification));

  // A restart keeps the drifted review, its settled findings and the delivery
  // qualification.
  await runtime.close();
  runtime = new ProjectDataRuntime({
    config,
    configPath: join(root, "config.json"),
    dataRoot: root,
    env: {}
  });
  const reopened = createProjectDevelopmentService({
    runtime,
    backendId: "backend-lifecycle",
    developmentRoot: h.developmentRoot,
    project: async (id) => (id === h.projectId ? h.project : undefined),
    taskProject: async (id) => (id === "task-lifecycle" ? h.project : undefined),
    call: async (_taskId, callId) => h.calls[callId]
  });
  const persisted = await reopened.getReview(h.projectId, drifted.reviewId);
  assert.equal(persisted.state, "drifted");
  assert.equal(persisted.findings.find((entry) => entry.findingId === driftFinding).state, "fixed");
  assert.equal(persisted.findings.find((entry) => entry.findingId === dismissFinding).state, "dismissed");
  const persistedFailed = await reopened.getReview(h.projectId, review.reviewId);
  assert.equal(persistedFailed.state, "failed");
  assert.equal(persistedFailed.findings[0].state, "dismissed");
  const persistedFix = await reopened.getReview(h.projectId, fixReview.reviewId);
  assert.equal(persistedFix.findings[0].state, "fixed");
  assert.equal(persistedFix.findings[0].fixedCommit, fixedCandidate);
  assert.equal(persistedFix.findings[0].verifiedByReviewId, successor.reviewId);
  const persistedIdentity = await reopened.getReview(h.projectId, identityReview.reviewId);
  assert.equal(persistedIdentity.reviewer.callId, reviewerOne.callId);
  assert.equal(persistedIdentity.findings[0].source.callId, reviewerOne.callId);
  assert.equal((await reopened.delivery(h.projectId, driftedDev.developmentId)).eligible, true);
});

for (const engine of PROJECT_DATA_ENGINES) {
  test(`${engine}: linked review rounds settle their own findings and unrelated open ones still block`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `atria-p4-chain-${engine}-`));
    const config =
      engine === "sqlite"
        ? { sqlite: { path: join(root, "project-data.sqlite") } }
        : projectDataConfig(engine, { postgres });
    const runtime = new ProjectDataRuntime({
      config,
      configPath: join(root, "config.json"),
      dataRoot: root,
      env: {}
    });
    t.after(async () => {
      await runtime.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    const h = await makeLifecycleHarness({ root, runtime, backendId: `backend-chain-${engine}` });

    // M2: R1 fixes F1 and fails, R2 finds F2 and fails, R3 passes. Both are
    // settled through the explicit previousReview chain, each at the candidate
    // that actually carried its repair.
    const chain = await h.makeDevelopment("three review rounds");
    await h.commit(chain, "chain.txt", "one\n");
    await h.plan(chain);
    const author = await h.writeExecutor(chain);
    let first = await h.start(chain, { authorCallId: author.callId });
    first = await h.attach(first, (await h.addReviewer(chain)).callId);
    first = await h.finding(first, "first defect");
    const firstFinding = first.findings[0].findingId;
    first = await h.rule(first, firstFinding, "fix");
    first = await h.complete(first, "failed", []);
    const firstContinuation = h.continueExecutor(author);
    await h.rework(first, firstFinding, author, firstContinuation);
    const secondCandidate = await h.commit(chain, "chain.txt", "two\n");
    let second = await h.start(chain, { previousReviewId: first.reviewId });
    assert.equal(second.author.callId, firstContinuation.callId);
    second = await h.attach(second, (await h.addReviewer(chain)).callId);
    second = await h.finding(second, "second defect");
    const secondFinding = second.findings[0].findingId;
    second = await h.rule(second, secondFinding, "fix");
    second = await h.complete(second, "failed", []);
    const secondContinuation = h.continueExecutor(firstContinuation);
    await h.rework(second, secondFinding, firstContinuation, secondContinuation);
    const thirdCandidate = await h.commit(chain, "chain.txt", "three\n");
    let third = await h.start(chain, { previousReviewId: second.reviewId });
    third = await h.attach(third, (await h.addReviewer(chain)).callId);
    third = await h.complete(third, "passed");
    const firstAfter = await h.getReview(first.reviewId);
    const secondAfter = await h.getReview(second.reviewId);
    assert.equal(firstAfter.findings[0].state, "fixed");
    assert.equal(firstAfter.findings[0].fixedCommit, secondCandidate);
    assert.equal(firstAfter.findings[0].verifiedByReviewId, third.reviewId);
    assert.equal(secondAfter.findings[0].state, "fixed");
    assert.equal(secondAfter.findings[0].fixedCommit, thirdCandidate);
    assert.equal(secondAfter.findings[0].verifiedByReviewId, third.reviewId);
    const chainQualification = await h.delivery(chain);
    assert.equal(chainQualification.eligible, true, JSON.stringify(chainQualification));

    // A pass does not clear an open finding outside its chain; ruling that
    // finding on the closed review is what unblocks delivery.
    const open = await h.makeDevelopment("unrelated open finding");
    await h.commit(open, "open.txt", "one\n");
    await h.plan(open);
    const openAuthor = await h.writeExecutor(open);
    let openReview = await h.start(open, { authorCallId: openAuthor.callId });
    openReview = await h.attach(openReview, (await h.addReviewer(open)).callId);
    openReview = await h.finding(openReview, "never ruled");
    const openFinding = openReview.findings[0].findingId;
    openReview = await h.complete(openReview, "failed", []);
    await h.commit(open, "open.txt", "two\n");
    let openSuccessor = await h.start(open, { previousReviewId: openReview.reviewId });
    openSuccessor = await h.attach(openSuccessor, (await h.addReviewer(open)).callId);
    openSuccessor = await h.complete(openSuccessor, "passed");
    const openReviewAfter = await h.getReview(openReview.reviewId);
    assert.equal(
      openReviewAfter.findings[0].state,
      "open",
      "a pass only settles fix-claimed findings on its linked chain"
    );
    const blocked = await h.delivery(open);
    assert.equal(blocked.eligible, false);
    assert.ok(blocked.reasons.includes("findings_open"));
    const openRuled = await h.rule(openReviewAfter, openFinding, "dismiss", { category: "out_of_scope" });
    assert.equal(openRuled.findings[0].state, "dismissed");
    const unblocked = await h.delivery(open);
    assert.equal(unblocked.eligible, true, JSON.stringify(unblocked));
  });
}
