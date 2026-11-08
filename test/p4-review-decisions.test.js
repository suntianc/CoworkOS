import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { createProjectDevelopmentController } from "../web/assets/controllers/project-development.js";

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

/**
 * Main's rulings and the delivery viewer.
 *
 * The same real path as the review flow, with the parts AC2 names: findings
 * that do not stand are dismissed with their category and basis while the
 * suggestion stays on record; a change to the agreed scope goes through the
 * existing question tool; a rework is linked to the original finding and a
 * combined review is bound to the current integration version. The production
 * controller then reads self-check, independent review, rework, ruling and
 * qualification, including after a backend restart and a project switch.
 */
test(
  "Main rules findings, asks the owner about scope, and the controller reads persisted reviews",
  { timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-p4-decisions-"));
    const repository = await makeRepository(join(root, "repository"));
    await mkdir(join(root, "project-b"), { recursive: true });
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
      projectName: "裁定项目",
      projectDirectory: repository
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.project;
    const other = await request("/api/projects", {
      projectName: "另一个项目",
      projectDirectory: join(root, "project-b")
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const requirement = await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "导出报表",
      content: "导出当前报表。"
    });
    assert.equal(requirement.status, 201, JSON.stringify(requirement.body));
    const merge = await request(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`, {
      repository,
      targetBranch: "main"
    });
    assert.equal(merge.status, 200, JSON.stringify(merge.body));
    const requirementId = requirement.body.requirement.requirementId;
    const taskId = "review-decisions";
    const task = await request("/api/tasks", {
      taskId,
      goal: "完成导出并处理审查裁定",
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
    const findings = {};
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
          if (step === 0)
            return {
              name: "project_development",
              arguments: {
                action: "create",
                requirementId,
                goal: "导出 CSV 报表，包含 header 与数据行",
                completionCriteria: ["导出首行为 header", "导出至少包含一行数据"],
                route: "direct"
              }
            };
          if (step === 1) {
            const development = toolJson(body).development;
            integration = development.workspace.directory;
            developmentId = development.developmentId;
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：在需求现场生成 export.txt，目前只写 header。",
                mode: "async",
                role: "executor",
                developmentId
              }
            };
          }
          if (step === 2) {
            calls.a = toolJson(body);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.a.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 3) {
            assert.equal(
              toolJson(body).calls.find((entry) => entry.callId === calls.a.callId).status,
              "completed"
            );
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
            return { name: "bash", arguments: { command: `cd "${integration}" && head -1 export.txt` } };
          }
          if (step === 5) {
            assert.match(lastToolText(body), /header/);
            return {
              name: "project_development",
              arguments: {
                action: "review_plan",
                developmentId,
                channel: "independent",
                basis: "完成标准涉及导出内容，需要独立核验",
                checks: [{ name: "自检：首行", command: "head -1 export.txt", exitCode: 0, output: "header" }]
              }
            };
          }
          if (step === 6)
            return {
              name: "project_development",
              arguments: {
                action: "freeze_candidate",
                developmentId,
                kind: "independent",
                authorCallId: calls.a.callId
              }
            };
          if (step === 7) {
            const review = toolJson(body).review;
            reviewId1 = review.reviewId;
            assert.equal(review.candidate.commit, candidate1);
            return {
              name: "call_subagent",
              arguments: {
                task: `审查者工作项 B：独立审查候选 ${reviewId1}，分别给出完成标准内缺陷、范围外建议和误报。`,
                mode: "async",
                role: "reviewer",
                developmentId
              }
            };
          }
          if (step === 8) {
            calls.b = toolJson(body);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.b.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 9) {
            assert.equal(
              toolJson(body).calls.find((entry) => entry.callId === calls.b.callId).status,
              "completed"
            );
            return {
              name: "project_development",
              arguments: { action: "attach_reviewer", reviewId: reviewId1, callId: calls.b.callId }
            };
          }
          if (step === 10) {
            assert.equal(toolJson(body).review.reviewer.agentId, calls.b.agentId);
            return {
              name: "project_development",
              arguments: {
                action: "record_finding",
                reviewId: reviewId1,
                title: "导出缺少数据行",
                detail: "完成标准要求至少一行数据，实际只有 header。",
                location: "export.txt",
                checks: [
                  {
                    name: "数据行",
                    command: "wc -l < export.txt",
                    exitCode: 1,
                    output: "actual_lines=1"
                  }
                ],
                rawFailure: "actual_lines=1\nexpected_lines>=2"
              }
            };
          }
          if (step === 11) {
            findings.standard = toolJson(body).review.findings.at(-1).findingId;
            return {
              name: "project_development",
              arguments: {
                action: "record_finding",
                reviewId: reviewId1,
                title: "建议增加 PDF 导出",
                detail: "把导出格式从 CSV 改为 PDF 更通用。",
                location: "export.txt"
              }
            };
          }
          if (step === 12) {
            findings.outOfScope = toolJson(body).review.findings.at(-1).findingId;
            return {
              name: "project_development",
              arguments: {
                action: "record_finding",
                reviewId: reviewId1,
                title: "文件名不是 report.csv",
                detail: "报告文件名为 export.txt。",
                location: "export.txt"
              }
            };
          }
          if (step === 13) {
            findings.falsePositive = toolJson(body).review.findings.at(-1).findingId;
            return {
              name: "project_development",
              arguments: {
                action: "rule_finding",
                reviewId: reviewId1,
                findingId: findings.standard,
                decision: "fix",
                basis: "违反已确认的完成标准：导出至少包含一行数据"
              }
            };
          }
          if (step === 14) {
            assert.equal(toolJson(body).review.findings[0].state, "fix_claimed");
            return {
              name: "askhuman",
              arguments: {
                question: "是否把导出格式从 CSV 改为 PDF？",
                context: "审查建议改为 PDF；这改变已确认的导出范围。",
                options: ["保持现有 CSV 范围", "改为 PDF"],
                recommended: 0
              }
            };
          }
          if (step === 15) {
            const answer = toolJson(body);
            assert.equal(answer.status, "answered", JSON.stringify(answer));
            assert.match(answer.answer, /保持现有 CSV 范围/);
            return {
              name: "project_development",
              arguments: {
                action: "rule_finding",
                reviewId: reviewId1,
                findingId: findings.outOfScope,
                decision: "dismiss",
                category: "out_of_scope",
                basis: `负责人答复「${answer.answer}」；PDF 不在本次已确认范围，建议保留给后续需求`
              }
            };
          }
          if (step === 16) {
            assert.equal(
              toolJson(body).review.findings.find((entry) => entry.findingId === findings.outOfScope).state,
              "dismissed"
            );
            return {
              name: "project_development",
              arguments: {
                action: "rule_finding",
                reviewId: reviewId1,
                findingId: findings.falsePositive,
                decision: "dismiss",
                category: "false_positive",
                basis: "完成标准只约定首行与数据行，未约定文件名；报告无误"
              }
            };
          }
          if (step === 17) {
            assert.equal(
              toolJson(body).review.findings.find((entry) => entry.findingId === findings.falsePositive)
                .ruling.category,
              "false_positive"
            );
            return {
              name: "project_development",
              arguments: {
                action: "complete_review",
                reviewId: reviewId1,
                verdict: "failed",
                summary: "缺数据行；另有一条范围外建议和一条误报",
                checks: []
              }
            };
          }
          if (step === 18) {
            assert.equal(toolJson(body).review.state, "failed");
            return {
              name: "call_subagent",
              arguments: {
                task: "执行者工作项 A：修复审查发现，补一行数据。",
                mode: "async",
                role: "executor",
                developmentId,
                continueCallId: calls.a.callId,
                reviewId: reviewId1
              }
            };
          }
          if (step === 19) {
            calls.a2 = toolJson(body);
            assert.equal(calls.a2.agentId, calls.a.agentId);
            assert.equal(calls.a2.workspace, calls.a.workspace);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.a2.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 20) {
            assert.equal(
              toolJson(body).calls.find((entry) => entry.callId === calls.a2.callId).status,
              "completed"
            );
            return {
              name: "project_development",
              arguments: {
                action: "record_rework",
                reviewId: reviewId1,
                findingIds: [findings.standard],
                fromCallId: calls.a.callId,
                continuationCallId: calls.a2.callId
              }
            };
          }
          if (step === 21) {
            assert.equal(toolJson(body).review.reworks[0].agentId, calls.a.agentId);
            return {
              name: "bash",
              arguments: {
                command: [
                  "set -e",
                  `cd "${integration}"`,
                  `cp "${calls.a2.workspace}/export.txt" .`,
                  "git add -A",
                  'git commit -m "fix findings" >/dev/null',
                  "echo FIXED"
                ].join(" && ")
              }
            };
          }
          if (step === 22) {
            assert.match(lastToolText(body), /FIXED/);
            candidate2 = await git(integration, ["rev-parse", "HEAD"]);
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
          if (step === 23) {
            const review = toolJson(body).review;
            reviewId2 = review.reviewId;
            assert.equal(review.previousReviewId, reviewId1);
            assert.deepEqual(review.changedPaths, ["export.txt"]);
            return {
              name: "call_subagent",
              arguments: {
                task: `审查者工作项 C：复审候选 ${reviewId2} 的修复与新增改动。`,
                mode: "async",
                role: "reviewer",
                developmentId
              }
            };
          }
          if (step === 24) {
            calls.c = toolJson(body);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.c.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 25) {
            assert.equal(
              toolJson(body).calls.find((entry) => entry.callId === calls.c.callId).status,
              "completed"
            );
            return {
              name: "project_development",
              arguments: { action: "attach_reviewer", reviewId: reviewId2, callId: calls.c.callId }
            };
          }
          if (step === 26) {
            assert.equal(toolJson(body).review.reviewer.agentId, calls.c.agentId);
            return {
              name: "bash",
              arguments: { command: `cd "${integration}" && wc -l < export.txt` }
            };
          }
          if (step === 27) {
            assert.match(lastToolText(body), /2/);
            return {
              name: "project_development",
              arguments: {
                action: "complete_review",
                reviewId: reviewId2,
                verdict: "passed",
                summary: "复审通过：数据行已补，原发现已修复",
                checks: [{ name: "复审：数据行", command: "wc -l < export.txt", exitCode: 0, output: "2" }]
              }
            };
          }
          if (step === 28) {
            assert.equal(toolJson(body).review.state, "passed");
            return {
              name: "project_development",
              arguments: { action: "freeze_candidate", developmentId, kind: "combined" }
            };
          }
          if (step === 29) {
            const review = toolJson(body).review;
            reviewId3 = review.reviewId;
            assert.equal(review.kind, "combined");
            assert.equal(review.candidate.commit, candidate2);
            assert.equal(review.previousReviewId, undefined);
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
          if (step === 30) {
            calls.d = toolJson(body);
            return {
              name: "wait_for_subagents",
              arguments: { callIds: [calls.d.callId], timeoutMs: 60_000 }
            };
          }
          if (step === 31) {
            assert.equal(
              toolJson(body).calls.find((entry) => entry.callId === calls.d.callId).status,
              "completed"
            );
            return {
              name: "project_development",
              arguments: { action: "attach_reviewer", reviewId: reviewId3, callId: calls.d.callId }
            };
          }
          if (step === 32) {
            assert.equal(toolJson(body).review.reviewer.agentId, calls.d.agentId);
            return {
              name: "bash",
              arguments: {
                command: `cd "${integration}" && test -z "$(git status --porcelain)" && echo CLEAN`
              }
            };
          }
          if (step === 33) {
            assert.match(lastToolText(body), /CLEAN/, "the combined candidate is clean");
            return {
              name: "project_development",
              arguments: {
                action: "complete_review",
                reviewId: reviewId3,
                verdict: "passed",
                summary: "组合版本终审通过",
                checks: [
                  {
                    name: "组合：工作区干净",
                    command: "git status --porcelain",
                    exitCode: 0,
                    output: ""
                  }
                ]
              }
            };
          }
          if (step === 34) {
            assert.equal(toolJson(body).review.state, "passed");
            return {
              name: "project_development",
              arguments: { action: "delivery_check", developmentId }
            };
          }
          if (step === 35) {
            const qualification = toolJson(body).qualification;
            assert.equal(qualification.eligible, true, JSON.stringify(qualification));
            assert.equal(qualification.kind, "combined");
            assert.equal(qualification.reviewId, reviewId3);
            assert.equal(qualification.independentReview, true);
            assert.equal(qualification.approved.commit, candidate2);
            return { text: "审查裁定与组合版本终审已完成。" };
          }
          return { text: "审查裁定流程已完成。" };
        }
        if (role === "a") {
          if (step === 0)
            return { name: "write_file", arguments: { path: "export.txt", content: "header\n" } };
          if (step === 1) return { text: "A 完成：已写入 export.txt 的 header。" };
          if (step === 2) {
            assert.match(userText(body), /修复审查发现/);
            return {
              name: "write_file",
              arguments: { path: "export.txt", content: "header\ndata\n" }
            };
          }
          return { text: "A 完成返修：数据行已补。" };
        }
        if (role === "b") {
          if (step === 0)
            return {
              name: "run_command",
              arguments: { command: 'wc -l < export.txt | tr -d "\\n"' }
            };
          if (step === 1) {
            assert.match(lastToolText(body), /1/);
            return {
              text: "完成标准内：导出只有 header，缺少数据行。另有范围外建议：改用 PDF。误报：文件名不是 report.csv，但标准未约定。 "
            };
          }
          return { text: "审查完成。" };
        }
        if (role === "c") {
          if (step === 0) return { name: "run_command", arguments: { command: "wc -l < export.txt" } };
          return { text: "复审通过：数据行为 2 行。" };
        }
        return { text: "组合版本终审通过。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        failTest(error);
        return { text: "审查裁定夹具失败。" };
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
      apiKey: "review-decisions-local-key"
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    // The owner answers the one question that would change the agreed scope.
    let answeredQuestion = null;
    let polling = true;
    const answerer = (async () => {
      while (polling) {
        const detail = await request(`/api/tasks/${taskId}`).catch(() => ({}));
        const pending = detail.body?.humanRequests?.find((entry) => entry.status === "pending");
        if (pending) {
          answeredQuestion = pending;
          await request(`/api/tasks/${taskId}/human/${pending.requestId}/answer`, {
            answer: "保持现有 CSV 范围"
          });
          return;
        }
        await delay(100);
      }
    })();

    const started = await request(`/api/tasks/${taskId}/run`, {
      prompt: "完成导出需求，审查后按依据裁定；范围变化先问负责人。"
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    try {
      await Promise.race([settle(request, taskId), scriptFailure]);
    } finally {
      polling = false;
      await answerer;
    }
    assert.deepEqual(failures, [], failures.join("\n"));
    assert.ok(answeredQuestion, "the scope change was raised through the existing question tool");
    assert.match(answeredQuestion.question, /PDF/);

    // The persisted review shows both dismissals with their category and
    // basis, the rework that continued the original session, the re-review
    // linkage and the combined review bound to the current integration commit.
    const path = `/api/projects/${encodeURIComponent(project.projectId)}/reviews?developmentId=${encodeURIComponent(
      developmentId
    )}`;
    const records = (await request(path)).body;
    assert.equal(records.reviews.length, 3);
    const [first, second, third] = records.reviews;
    assert.equal(first.reviewId, reviewId1);
    assert.equal(first.findings.length, 3);
    const standard = first.findings.find((entry) => entry.findingId === findings.standard);
    assert.equal(standard.state, "fixed");
    assert.equal(standard.fixedCommit, candidate2);
    assert.equal(standard.ruling.decision, "fix");
    const outOfScope = first.findings.find((entry) => entry.findingId === findings.outOfScope);
    assert.equal(outOfScope.state, "dismissed");
    assert.equal(outOfScope.ruling.category, "out_of_scope");
    assert.match(outOfScope.ruling.basis, /保持现有 CSV 范围/);
    assert.equal(outOfScope.title, "建议增加 PDF 导出", "the suggestion is kept on record");
    const falsePositive = first.findings.find((entry) => entry.findingId === findings.falsePositive);
    assert.equal(falsePositive.ruling.category, "false_positive");
    assert.match(falsePositive.ruling.basis, /未约定文件名/);
    assert.equal(first.reworks.length, 1);
    assert.equal(first.reworks[0].continuationCallId, calls.a2.callId);
    assert.equal(first.reworks[0].agentId, calls.a.agentId);
    assert.equal(second.previousReviewId, first.reviewId);
    assert.deepEqual(second.changedPaths, ["export.txt"]);
    assert.equal(second.state, "passed");
    assert.equal(third.kind, "combined");
    assert.equal(third.candidate.commit, candidate2);
    assert.equal(third.state, "passed");
    assert.equal(records.plan.channel, "independent");
    assert.equal(records.plan.checks[0].name, "自检：首行");
    assert.equal(records.qualification.eligible, true);
    assert.equal(records.qualification.kind, "combined");

    // The production controller renders the author's self-check, the
    // independent review, the rework and the rulings.
    const previousGlobals = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
    t.after(() => {
      for (const [key, value] of Object.entries(previousGlobals)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    });
    const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
    globalThis.window = window;
    globalThis.document = document;
    globalThis.CSS = { escape: (value) => value };
    window.HTMLElement.prototype.getClientRects ??= () => [];
    const api = (requestPath, options) =>
      fetch(`${dashboard.base}${requestPath}`, {
        method: options?.method ?? (options?.body === undefined ? "GET" : "POST"),
        headers: options?.headers ?? { "content-type": "application/json" },
        ...(options?.body === undefined ? {} : { body: options.body })
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw Object.assign(new Error(body.error ?? "请求失败"), { status: response.status });
        return body;
      });
    const state = {
      projects: [
        { ...project, tasks: [] },
        { ...other.body.project, tasks: [] }
      ],
      selectedProjectId: project.projectId,
      selected: taskId
    };
    const controller = createProjectDevelopmentController({ api, state });
    const $ = (selector) => document.querySelector(selector);
    controller.open(project.projectId);
    await waitFor(() => Boolean($("[data-list] button")), "project A developments did not load");
    $("[data-list] button").click();
    await waitFor(
      () => /导出缺少数据行/.test($("[data-detail]").textContent),
      "review findings did not render"
    );
    const detail = $("[data-detail]").textContent;
    for (const label of ["自检", "独立审查", "组合审查", "返修", "裁定", "误报", "范围外", "可交付"])
      assert.ok(detail.includes(label), `the controller does not show ${label}: ${detail.slice(0, 500)}`);
    assert.match(detail, /保持现有 CSV 范围/);

    // Switching projects reads that project's reviews only.
    const select = $("[data-project]");
    select.children[0].removeAttribute("selected");
    select.children[1].setAttribute("selected", "");
    select.dispatchEvent(new window.Event("change"));
    await waitFor(() => /还没有开发记录/.test($("[data-list]").textContent), "project B did not load");
    assert.doesNotMatch($("[data-list]").textContent, /导出缺少数据行/);
    const otherReviews = await request(
      `/api/projects/${encodeURIComponent(other.body.project.projectId)}/reviews`
    );
    assert.equal(otherReviews.status, 200);
    assert.deepEqual(otherReviews.body.reviews, []);
    assert.equal(otherReviews.body.plan, undefined);

    // A small change with no independent Reviewer records its channel and
    // verification, and is qualified as such rather than treated as missing.
    const smallRequirement = await request(`/api/projects/${encodeURIComponent(project.projectId)}/ledger`, {
      action: "create",
      title: "修改按钮文案",
      content: "把按钮文案改为导出。"
    });
    assert.equal(smallRequirement.status, 201, JSON.stringify(smallRequirement.body));
    const smallDevelopment = await request(
      `/api/projects/${encodeURIComponent(project.projectId)}/developments`,
      {
        action: "create",
        requirementId: smallRequirement.body.requirement.requirementId,
        goal: "按钮文案改为导出",
        completionCriteria: ["按钮显示导出"],
        route: "quick"
      }
    );
    assert.equal(smallDevelopment.status, 201, JSON.stringify(smallDevelopment.body));
    const smallId = smallDevelopment.body.development.developmentId;
    const smallPlan = await request(`/api/projects/${encodeURIComponent(project.projectId)}/reviews`, {
      action: "plan",
      developmentId: smallId,
      channel: "self",
      basis: "单行文案改动，Main 直接完成并自查",
      checks: [{ name: "文案检查", command: "grep 导出", exitCode: 0, output: "导出" }]
    });
    assert.equal(smallPlan.status, 200, JSON.stringify(smallPlan.body));
    const smallDelivery = await request(`/api/projects/${encodeURIComponent(project.projectId)}/reviews`, {
      action: "delivery",
      developmentId: smallId
    });
    assert.equal(smallDelivery.status, 200, JSON.stringify(smallDelivery.body));
    assert.equal(smallDelivery.body.qualification.eligible, true);
    assert.equal(smallDelivery.body.qualification.channel, "self");
    assert.equal(smallDelivery.body.qualification.independentReview, false);
    const smallReviews = await request(
      `/api/projects/${encodeURIComponent(project.projectId)}/reviews?developmentId=${encodeURIComponent(
        smallId
      )}`
    );
    assert.deepEqual(smallReviews.body.reviews, []);
    assert.equal(smallReviews.body.plan.checks[0].name, "文案检查");

    // A backend restart keeps the plan, checks, findings, rulings and
    // qualification readable under the same project.
    await dashboard.restart();
    const afterRestart = (await request(path)).body;
    assert.equal(afterRestart.reviews.length, 3);
    assert.equal(afterRestart.plan.checks[0].name, "自检：首行");
    assert.equal(afterRestart.reviews[1].verdict.checks[0].name, "复审：数据行");
    assert.equal(afterRestart.reviews[0].findings[0].findingId, findings.standard);
    assert.equal(
      afterRestart.reviews[0].findings.find((entry) => entry.findingId === findings.outOfScope).ruling.basis,
      outOfScope.ruling.basis
    );
    assert.equal(afterRestart.qualification.eligible, true);
    assert.equal(afterRestart.qualification.reviewId, reviewId3);
    const smallAfterRestart = (
      await request(
        `/api/projects/${encodeURIComponent(project.projectId)}/reviews?developmentId=${encodeURIComponent(
          smallId
        )}`
      )
    ).body;
    assert.equal(smallAfterRestart.plan.channel, "self");
    assert.equal(smallAfterRestart.plan.checks[0].name, "文案检查");
    assert.equal(smallAfterRestart.qualification.eligible, true);
    assert.equal(await readFile(join(integration, "export.txt"), "utf8"), "header\ndata\n");
  }
);
