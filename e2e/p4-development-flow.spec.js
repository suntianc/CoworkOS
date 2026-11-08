import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

/**
 * One requirement developed through the OS work surface.
 *
 * The page, the Dashboard, the project data and the Git repositories are real;
 * the only substitute is a local provider that plays Main and the delegated
 * Executor/Reviewer calls. The flow is the composition this acceptance covers:
 * a demand enters from the requirement views, the work runs in the requirement
 * checkout, an independent Reviewer raises a finding, the rework continues the
 * Executor's own session and checkout, the candidate is re-reviewed and merged
 * through the shared entry, and the ledger/board show the actual merge commit
 * while the conversation draft stays with its own session.
 *
 * Set `P4_EVIDENCE_DIR` to keep the screenshots and the action log outside the
 * repository; `testInfo.attach` always keeps them with the Playwright run.
 */

const evidenceRoot = process.env.P4_EVIDENCE_DIR;
const run = promisify(execFile);
const git = (cwd, args) =>
  run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim());

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const lastToolText = (body) => messageText(body.messages.findLast((message) => message.role === "tool"));
const toolJson = (body) => {
  const text = lastToolText(body) ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`tool result was not JSON: ${text.slice(0, 500)}`);
  }
};
const userText = (body) =>
  body.messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
const systemText = (body) =>
  body.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map(messageText)
    .join("\n");

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "fixture@example.test"]);
  await git(directory, ["config", "user.name", "Fixture"]);
  await writeFile(join(directory, "README.md"), "报表仓库\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "baseline"]);
  return directory;
}

/**
 * The scripted product-side worker.
 *
 * Main's steps mirror an ordinary development: record the requirement, delegate
 * an Executor work item, collect its commit into the requirement checkout,
 * record the review channel, freeze the candidate, bind the Reviewer, keep its
 * finding, send the rework back to the Executor's own session, freeze and
 * re-review the fixed candidate, run the combined review on the current
 * version, then merge through the shared project entry.
 */
function scriptedMain({ requirementId, gate }) {
  const state = { integration: "", developmentId: "", calls: {}, findings: {}, reviews: {}, candidates: {} };
  return async (body, step) => {
    if (step === 0)
      return {
        name: "project_development",
        arguments: {
          action: "create",
          requirementId,
          goal: "新增 generate.sh：输出 report.csv 首行 header，并至少包含一行数据",
          completionCriteria: ["在仓库根目录执行 bash generate.sh 输出首行 header", "输出至少包含一行数据行"],
          route: "full"
        }
      };
    if (step === 1) {
      const development = toolJson(body).development;
      state.integration = development.workspace.directory;
      state.developmentId = development.developmentId;
      return {
        name: "call_subagent",
        arguments: {
          task: "执行者工作项 A：在需求现场写 generate.sh，输出 report.csv 的 header 行。",
          mode: "async",
          role: "executor",
          developmentId: state.developmentId
        }
      };
    }
    if (step === 2) {
      state.calls.a = toolJson(body);
      return {
        name: "wait_for_subagents",
        arguments: { callIds: [state.calls.a.callId], timeoutMs: 60_000 }
      };
    }
    if (step === 3)
      return {
        name: "bash",
        arguments: {
          command: [
            "set -e",
            `cd "${state.integration}"`,
            `cp "${state.calls.a.workspace}/generate.sh" .`,
            "git add -A",
            'git commit -m "collect A" >/dev/null',
            "echo COLLECTED"
          ].join(" && ")
        }
      };
    if (step === 4) {
      state.candidates.one = await git(state.integration, ["rev-parse", "HEAD"]);
      return { name: "bash", arguments: { command: `cd "${state.integration}" && bash generate.sh` } };
    }
    if (step === 5)
      return {
        name: "project_development",
        arguments: {
          action: "review_plan",
          developmentId: state.developmentId,
          channel: "independent",
          basis: "完成标准涉及生成输出，需要独立核验",
          checks: [
            { name: "自检：首行", command: "bash generate.sh | head -1", exitCode: 0, output: "name,score" }
          ]
        }
      };
    if (step === 6)
      return {
        name: "project_development",
        arguments: {
          action: "freeze_candidate",
          developmentId: state.developmentId,
          kind: "independent",
          authorCallId: state.calls.a.callId
        }
      };
    if (step === 7) {
      state.reviews.one = toolJson(body).review.reviewId;
      return {
        name: "call_subagent",
        arguments: {
          task: `审查者工作项 B：独立审查候选 ${state.reviews.one}，按完成标准核对 generate.sh 的输出。`,
          mode: "async",
          role: "reviewer",
          developmentId: state.developmentId
        }
      };
    }
    if (step === 8) {
      state.calls.b = toolJson(body);
      await gate.reviewerRunning();
      return {
        name: "wait_for_subagents",
        arguments: { callIds: [state.calls.b.callId], timeoutMs: 60_000 }
      };
    }
    if (step === 9)
      return {
        name: "project_development",
        arguments: { action: "attach_reviewer", reviewId: state.reviews.one, callId: state.calls.b.callId }
      };
    if (step === 10)
      return {
        name: "project_development",
        arguments: {
          action: "record_finding",
          reviewId: state.reviews.one,
          title: "导出缺少数据行",
          detail: "完成标准要求至少一行数据，实际只有 header。",
          location: "generate.sh",
          checks: [{ name: "数据行", command: "bash generate.sh | wc -l", exitCode: 1, output: "1" }],
          rawFailure: "actual_lines=1\nexpected_lines>=2"
        }
      };
    if (step === 11) {
      state.findings.missingRow = toolJson(body).review.findings.at(-1).findingId;
      return {
        name: "project_development",
        arguments: {
          action: "rule_finding",
          reviewId: state.reviews.one,
          findingId: state.findings.missingRow,
          decision: "fix",
          basis: "违反已确认的完成标准：输出至少包含一行数据"
        }
      };
    }
    if (step === 12)
      return {
        name: "project_development",
        arguments: {
          action: "complete_review",
          reviewId: state.reviews.one,
          verdict: "failed",
          summary: "缺数据行，已交回原执行会话返修",
          checks: []
        }
      };
    if (step === 13)
      return {
        name: "call_subagent",
        arguments: {
          task: "执行者工作项 A：修复审查发现，补一行数据。",
          mode: "async",
          role: "executor",
          developmentId: state.developmentId,
          continueCallId: state.calls.a.callId,
          reviewId: state.reviews.one
        }
      };
    if (step === 14) {
      state.calls.a2 = toolJson(body);
      return {
        name: "wait_for_subagents",
        arguments: { callIds: [state.calls.a2.callId], timeoutMs: 60_000 }
      };
    }
    if (step === 15)
      return {
        name: "project_development",
        arguments: {
          action: "record_rework",
          reviewId: state.reviews.one,
          findingIds: [state.findings.missingRow],
          fromCallId: state.calls.a.callId,
          continuationCallId: state.calls.a2.callId
        }
      };
    if (step === 16)
      return {
        name: "bash",
        arguments: {
          command: [
            "set -e",
            `cd "${state.integration}"`,
            `cp "${state.calls.a2.workspace}/generate.sh" .`,
            "git add -A",
            'git commit -m "fix findings" >/dev/null',
            "echo FIXED"
          ].join(" && ")
        }
      };
    if (step === 17) {
      state.candidates.two = await git(state.integration, ["rev-parse", "HEAD"]);
      return {
        name: "project_development",
        arguments: {
          action: "freeze_candidate",
          developmentId: state.developmentId,
          kind: "independent",
          previousReviewId: state.reviews.one
        }
      };
    }
    if (step === 18) {
      state.reviews.two = toolJson(body).review.reviewId;
      return {
        name: "call_subagent",
        arguments: {
          task: `审查者工作项 C：复审候选 ${state.reviews.two} 的修复与新增改动。`,
          mode: "async",
          role: "reviewer",
          developmentId: state.developmentId
        }
      };
    }
    if (step === 19) {
      state.calls.c = toolJson(body);
      return {
        name: "wait_for_subagents",
        arguments: { callIds: [state.calls.c.callId], timeoutMs: 60_000 }
      };
    }
    if (step === 20)
      return {
        name: "project_development",
        arguments: { action: "attach_reviewer", reviewId: state.reviews.two, callId: state.calls.c.callId }
      };
    if (step === 21)
      return {
        name: "bash",
        arguments: { command: `cd "${state.integration}" && bash generate.sh | wc -l` }
      };
    if (step === 22)
      return {
        name: "project_development",
        arguments: {
          action: "complete_review",
          reviewId: state.reviews.two,
          verdict: "passed",
          summary: "复审通过：数据行已补，原发现已修复",
          checks: [{ name: "复审：数据行", command: "bash generate.sh | wc -l", exitCode: 0, output: "2" }]
        }
      };
    if (step === 23)
      return {
        name: "project_development",
        arguments: {
          action: "review_plan",
          developmentId: state.developmentId,
          channel: "combined",
          basis: "对当前集成版本做组合终审",
          checks: [{ name: "自检：数据行", command: "bash generate.sh | wc -l", exitCode: 0, output: "2" }]
        }
      };
    if (step === 24)
      return {
        name: "project_development",
        arguments: { action: "freeze_candidate", developmentId: state.developmentId, kind: "combined" }
      };
    if (step === 25) {
      state.reviews.three = toolJson(body).review.reviewId;
      return {
        name: "call_subagent",
        arguments: {
          task: `审查者工作项 D：对组合版本 ${state.reviews.three} 做独立终审。`,
          mode: "async",
          role: "reviewer",
          developmentId: state.developmentId
        }
      };
    }
    if (step === 26) {
      state.calls.d = toolJson(body);
      return {
        name: "wait_for_subagents",
        arguments: { callIds: [state.calls.d.callId], timeoutMs: 60_000 }
      };
    }
    if (step === 27)
      return {
        name: "project_development",
        arguments: { action: "attach_reviewer", reviewId: state.reviews.three, callId: state.calls.d.callId }
      };
    if (step === 28)
      return {
        name: "bash",
        arguments: {
          command: `cd "${state.integration}" && test -z "$(git status --porcelain)" && echo CLEAN`
        }
      };
    if (step === 29)
      return {
        name: "project_development",
        arguments: {
          action: "complete_review",
          reviewId: state.reviews.three,
          verdict: "passed",
          summary: "组合版本终审通过",
          checks: [{ name: "组合：工作区干净", command: "git status --porcelain", exitCode: 0, output: "" }]
        }
      };
    if (step === 30)
      return {
        name: "project_development",
        arguments: { action: "delivery_check", developmentId: state.developmentId }
      };
    if (step === 31)
      return {
        name: "project_development",
        arguments: {
          action: "request_merge",
          developmentId: state.developmentId,
          mergeChecks: [{ name: "行为检查：生成输出", command: "bash generate.sh" }]
        }
      };
    if (step === 32) {
      state.merge = toolJson(body).merge;
      return {
        name: "project_development",
        arguments: { action: "delivery_status", developmentId: state.developmentId }
      };
    }
    return { text: "需求已实现、独立审查并合入，交付记录已同步。" };
  };
}

test("a requirement runs through the work surface, an independent review, a rework and the shared merge entry", async ({
  page
}, testInfo) => {
  test.setTimeout(300_000);
  const root = join(process.env.TMPDIR ?? "/tmp", `atria-p4-ui-${process.pid}-${Date.now()}`);
  const repository = await makeRepository(join(root, "repository"));
  const boardRequirement = {
    title: "生成报表导出",
    content: "仓库根目录提供 generate.sh，输出 report.csv。"
  };
  let boardRequirementId = "";

  let mainStep = 0;
  const steps = { a: 0, b: 0, c: 0, d: 0 };
  let releaseReviewer;
  const reviewerHold = new Promise((done) => {
    releaseReviewer = done;
  });
  let reviewerRunning;
  const reviewerRunningSignal = new Promise((done) => {
    reviewerRunning = done;
  });
  let scripted = {};
  const provider = await modelProtocolFixture("openai-completions", async (body) => {
    if (!systemText(body).includes("You are a CoworkOS Subagent")) return scripted.main(body, mainStep++);
    const match = userText(body).match(/工作项 ([A-D])/);
    const role = match ? match[1].toLowerCase() : "a";
    const step = steps[role]++;
    if (role === "a") {
      if (step === 0)
        return {
          name: "write_file",
          arguments: { path: "generate.sh", content: 'printf "name,score\\n"\n' }
        };
      if (step === 1) return { text: "A 完成：generate.sh 已写入 header。" };
      if (step === 2)
        return {
          name: "write_file",
          arguments: { path: "generate.sh", content: 'printf "name,score\\nada,10\\n"\n' }
        };
      return { text: "A 完成返修：数据行已补。" };
    }
    if (role === "b") {
      if (step === 0) {
        reviewerRunning();
        await reviewerHold;
        return { name: "run_command", arguments: { command: 'bash generate.sh | wc -l | tr -d "\\n"' } };
      }
      return { text: "完成标准内：输出只有 header，缺少数据行。位置 generate.sh。" };
    }
    if (role === "c") {
      if (step === 0) return { name: "run_command", arguments: { command: "bash generate.sh | wc -l" } };
      return { text: "复审通过：输出为 header 与一行数据，共 2 行。" };
    }
    if (step === 0) return { name: "run_command", arguments: { command: "bash generate.sh | wc -l" } };
    return { text: "组合版本终审通过：当前版本满足完成标准。" };
  });
  const dashboard = await startDashboard({
    defaultProject: false,
    env: { COWORK_PROJECT_WRITE: "1", COWORK_DISABLE_WATCH_SUPERVISOR: "1" }
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true });
  const actions = [];
  const shot = async (name) => {
    const png = await page.screenshot({ fullPage: false });
    await testInfo.attach(name, { body: png, contentType: "image/png" });
    if (evidenceRoot) await writeFile(join(evidenceRoot, `${name}.png`), png);
  };
  const record = (name, detail = {}) => actions.push({ name, url: page.url(), ...detail });
  const api = async (path, body) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data: body });
    expect(response.status(), `${path} ${JSON.stringify(body)}`).toBeLessThan(300);
    return response.json();
  };
  const read = async (path) => (await page.request.get(`${dashboard.base}${path}`)).json();
  const conversation = (taskId) => page.locator(`.conversation-item[data-task="${taskId}"]`);

  try {
    const project = (await api("/api/projects", { projectName: "报表项目", projectDirectory: repository }))
      .project;
    await api(`/api/projects/${encodeURIComponent(project.projectId)}/merge-config`, {
      repository,
      targetBranch: "main"
    });
    const saved = await api("/api/model-settings", {
      profileName: "本地夹具",
      baseUrl: provider.baseUrl,
      model: "protocol-fixture",
      api: "openai-completions",
      supportsReasoningEffort: false,
      supportsImages: false,
      apiKey: "p4-ui-local-key"
    });
    const profileId = saved.profiles[0].id;
    for (const role of ["main", "executor", "reviewer"])
      await api("/api/model-settings/roles", { role, profileId });
    let mainScript;
    scripted.main = (body, step) =>
      (mainScript ??= scriptedMain({
        requirementId: boardRequirementId,
        gate: { reviewerRunning: () => reviewerRunningSignal }
      }))(body, step);

    await page.goto(dashboard.base);
    await expect(page.locator("#board-nav")).toBeVisible();

    // The demand enters from the board, is claimed and its requirement is kept.
    await page.locator("#board-nav").click();
    const board = page.getByRole("dialog", { name: "需求看板", exact: true });
    await board.getByLabel("看板项目").selectOption(project.projectId);
    await board.getByLabel("看板需求标题").fill(boardRequirement.title);
    await board.getByLabel("看板需求内容").fill(boardRequirement.content);
    await board.getByLabel("外部来源").fill("外部渠道");
    await board.getByRole("button", { name: "发布需求", exact: true }).click();
    await expect(board.locator("[data-board]")).toHaveCount(1);
    await board.locator("[data-board]").click();
    await board.getByRole("button", { name: "认领", exact: true }).click();
    await expect(board.locator("[data-assignee]")).toContainText("归属：用户");
    await expect(board.locator("[data-board]")).toContainText("已认领");
    await shot("01-board-claimed");
    const entries = (await read(`/api/projects/${encodeURIComponent(project.projectId)}/board`)).entries;
    boardRequirementId = entries[0].requirementId;
    record("board-claimed", { boardId: entries[0].boardId, requirementId: boardRequirementId });
    await board.getByRole("button", { name: "关闭需求看板" }).click();

    // An internal need stays in the ledger; it never creates a board entry.
    await page.locator("#ledger-nav").click();
    const ledger = page.getByRole("dialog", { name: "需求台账", exact: true });
    await ledger.getByLabel("台账项目").selectOption(project.projectId);
    await ledger.getByLabel("需求标题").fill("补充使用说明");
    await ledger.getByLabel("需求内容").fill("内部提出的直接需求，不新增看板条目。");
    await ledger.getByRole("button", { name: "记录需求", exact: true }).click();
    await expect(ledger.locator("[data-requirement]")).toHaveCount(2);
    await shot("02-ledger-needs");
    await ledger.getByRole("button", { name: "关闭需求台账" }).click();

    // The Main session for the claimed demand carries it into the conversation.
    const session = await api(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`, {
      action: "create",
      title: "报表导出改造",
      requirementId: boardRequirementId
    });
    const taskId = session.session.taskId;
    await page.goto(dashboard.base);
    await expect(conversation(taskId)).toBeVisible();
    await conversation(taskId).click();
    await expect(page.locator("#topbar-task")).toHaveText("报表导出改造");
    await page
      .locator("#composer-input")
      .fill(
        "完成报表导出需求：仓库根目录提供 generate.sh，输出首行 name,score 并至少包含一行数据；完成后独立审查并按项目入口合入。"
      );
    await page.locator("#send-button").click();
    await expect(conversation(taskId).locator(".conversation-activity")).toHaveAttribute(
      "data-state",
      "running"
    );

    // The delegated work is visible while it runs: the requirement view shows
    // the Executor finished and the independent Reviewer still working.
    await reviewerRunningSignal;
    await page.locator("#development-nav").click();
    const development = page.getByRole("dialog", { name: "需求现场", exact: true });
    await development.getByLabel("开发记录项目").selectOption(project.projectId);
    await expect(development.locator("[data-list] button")).toHaveCount(1);
    await development.locator("[data-list] button").click();
    // Role progress comes from the recorded review facts: the Executor's
    // candidate is frozen and the reviewer call is still working.
    await expect(development.locator("[data-role]")).toHaveCount(1);
    await expect(development.locator("[data-role]")).toContainText("Executor");
    await expect(development.locator("[data-role]")).toContainText("已完成");
    await expect(development.locator("[data-review]")).toHaveCount(1);
    await expect(development.locator("[data-review]")).toContainText("审查中");
    await shot("03-development-progress");
    record("development-progress", {
      roles: await development.locator("[data-role]").allInnerTexts()
    });
    await development.getByRole("button", { name: "关闭需求现场" }).click();
    releaseReviewer();

    await expect(page.locator("#conversation")).toContainText("交付记录已同步", { timeout: 120_000 });
    await expect
      .poll(async () => (await read(`/api/tasks/${taskId}`)).runtime.active, { timeout: 120_000 })
      .toBe(false);

    // The requirement view reports the whole chain after the run settles.
    await page.locator("#development-nav").click();
    await development.getByLabel("开发记录项目").selectOption(project.projectId);
    await development.locator("[data-list] button").click();
    await expect(development.locator("[data-stage]")).toHaveText("已交付");
    await expect(development.locator("[data-qualification]")).toContainText("可交付");
    // The rework continuation is the Executor identity recorded on the reviewed
    // candidate, so the view names it once beside the latest Reviewer.
    await expect(development.locator("[data-role]")).toHaveCount(2);
    await expect(development.locator("[data-role]").first()).toContainText("Executor");
    await expect(development.locator("[data-role]").first()).toContainText("已完成");
    await expect(development.locator("[data-role]").last()).toContainText("Reviewer");
    await expect(development.locator("[data-role]").last()).toContainText("已完成");
    await expect(development.locator("[data-review]")).toHaveCount(3);
    await expect(development.locator("[data-finding]")).toHaveCount(1);
    await expect(development.locator("[data-finding]")).toContainText("已修复");
    await expect(development.locator("[data-finding]")).toContainText("裁定：修复");
    await expect(development.locator("[data-review]").first()).toContainText(/返修\s/);
    await expect(development.locator("[data-diff]")).toBeVisible();
    await expect(development.locator("[data-delivery]")).toHaveAttribute("data-state", "synced");
    await expect(development.locator("[data-merge]")).toHaveAttribute("data-state", "merged");
    await shot("04-development-delivered");
    const listed = await read(`/api/projects/${encodeURIComponent(project.projectId)}/developments`);
    const developmentId = listed.developments[0].developmentId;
    const delivered = await api(`/api/projects/${encodeURIComponent(project.projectId)}/deliveries`, {
      action: "view",
      developmentId
    });
    // The behavior check runs on the real target branch, not on a model claim.
    expect(await git(repository, ["rev-parse", "main"])).toBe(delivered.view.delivery.mergedCommit);
    expect(delivered.view.diff.head).toBe(delivered.view.delivery.mergedCommit);
    const generated = await run("bash", ["generate.sh"], { cwd: repository });
    expect(generated.stdout.trim().split("\n")).toEqual(["name,score", "ada,10"]);
    record("development-delivered", {
      roleCount: await development.locator("[data-role]").count(),
      stage: await development.locator("[data-stage]").innerText(),
      reviews: await development.locator("[data-review]").allInnerTexts(),
      finding: await development.locator("[data-finding]").allInnerTexts(),
      delivery: await development.locator("[data-delivery]").innerText(),
      merge: await development.locator("[data-merge]").innerText(),
      developmentId,
      delivered
    });
    await development.getByRole("button", { name: "关闭需求现场" }).click();

    // The board keeps the claimed demand as pending release with the real merge
    // commit, and the ledger records the delivery.
    await page.locator("#board-nav").click();
    await board.getByLabel("看板项目").selectOption(project.projectId);
    await board.locator("[data-board]").click();
    await expect(board.locator("[data-board]")).toContainText("待发布");
    await expect(board.locator("[data-delivery]")).toContainText("合入 ");
    await shot("05-board-pending-release");
    record("board", { entry: await board.locator("[data-detail]").innerText() });
    await board.getByRole("button", { name: "关闭需求看板" }).click();

    await page.locator("#ledger-nav").click();
    await ledger.getByLabel("台账项目").selectOption(project.projectId);
    const deliveredRow = ledger.locator("[data-requirement]", { hasText: boardRequirement.title });
    await deliveredRow.click();
    await expect(ledger.locator("[data-delivery]")).toBeVisible();
    await shot("06-ledger-delivered");
    record("ledger", { detail: await ledger.locator("[data-detail]").innerText() });
    await ledger.getByRole("button", { name: "关闭需求台账" }).click();

    // The draft belongs to the conversation it was typed in.
    const otherSession = await api(`/api/projects/${encodeURIComponent(project.projectId)}/main-sessions`, {
      action: "create",
      title: "使用说明跟进"
    });
    await page.locator("#composer-input").fill("继续跟进导出的未发送草稿");
    await page.goto(dashboard.base);
    await expect(conversation(taskId)).toBeVisible();
    await conversation(taskId).click();
    await expect(page.locator("#composer-input")).toHaveValue("继续跟进导出的未发送草稿");
    await conversation(otherSession.session.taskId).click();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await conversation(taskId).click();
    await expect(page.locator("#composer-input")).toHaveValue("继续跟进导出的未发送草稿");
    await shot("07-draft-kept");
    record("draft", {
      value: await page.locator("#composer-input").inputValue(),
      other: otherSession.session.taskId
    });
    expect(errors).toEqual([]);
    if (evidenceRoot)
      await writeFile(join(evidenceRoot, "ui-actions.json"), JSON.stringify({ actions }, null, 2));
  } finally {
    releaseReviewer();
    await dashboard.stop();
    await provider.close();
  }
});
