import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIREMENT_TABS,
  requirementCriteria,
  requirementProgress,
  requirementStage,
  requirementSteps,
  requirementTab,
  requirementTabCounts
} from "../web/assets/requirement-stages.js";

const commit = (value) => value.repeat(40).slice(0, 40);

const development = (overrides = {}) => ({
  projectId: "project-1",
  developmentId: "development-1",
  requirementId: "requirement-1",
  requirementTitle: "按分数文件汇总总分",
  goal: "新增 summarize.sh",
  completionCriteria: ["bash summarize.sh 输出 30", "文件不存在时退出码 1"],
  route: "full",
  status: "active",
  revision: 1,
  baseline: { branch: "main", commit: commit("a") },
  workspace: {
    workspaceId: "workspace-1",
    backendId: "backend-1",
    directory: "/tmp/requirement-1",
    branch: "coworkos/requirement-1",
    baseCommit: commit("a"),
    state: "ready"
  },
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
  ...overrides
});

const roles = [
  { role: "executor", callId: "call-executor", agentId: "subagent_1", state: "completed" },
  { role: "reviewer", callId: "call-reviewer", agentId: "subagent_2", state: "in_review" }
];

const review = (state, extra = {}) => ({
  projectId: "project-1",
  reviewId: "review-1",
  developmentId: "development-1",
  kind: "independent",
  state,
  revision: 1,
  candidate: {
    commit: commit("b"),
    tree: commit("c"),
    branch: "coworkos/requirement-1",
    workspace: "/tmp/requirement-1"
  },
  changedPaths: [],
  findings: [],
  reworks: [],
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
  ...extra
});

const merge = (state, extra = {}) => ({
  projectId: "project-1",
  mergeId: "merge-1",
  developmentId: "development-1",
  requirementId: "requirement-1",
  state,
  revision: 2,
  requestedBy: "backend-1",
  executionBackendId: "backend-1",
  targetBranch: "main",
  candidate: review("in_review").candidate,
  acceptance: { channel: "independent", approvedCommit: commit("b"), approvedTree: commit("c") },
  checks: [],
  reasons: [],
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
  ...extra
});

const check = (exitCode) => ({ name: "检查", exitCode, output: "" });

test("an unclaimed board requirement is pending rather than in development", () => {
  const input = { board: { state: "pending" } };
  assert.equal(requirementStage(input).stage, "pending");
  assert.deepEqual(
    requirementSteps(input).map((step) => step.state),
    ["pending", "pending", "pending", "pending", "pending"]
  );
});

test("a recorded requirement without a development is at the record step", () => {
  const input = { requirement: { revision: 2, status: "open" } };
  assert.equal(requirementStage(input).stage, "requirement");
  const steps = requirementSteps(input);
  assert.deepEqual(
    steps.map((step) => [step.id, step.state, step.meta]),
    [
      ["requirement", "current", "v2"],
      ["development", "pending", ""],
      ["review", "pending", ""],
      ["merge", "pending", ""],
      ["delivery", "pending", ""]
    ]
  );
});

test("development names the Executor, review names the Reviewer and merge names its target", () => {
  const developing = { development: development(), roles };
  const developingSteps = requirementSteps(developing);
  assert.equal(requirementStage(developing).stage, "development");
  assert.equal(developingSteps[0].state, "done");
  assert.equal(developingSteps[1].state, "current");
  assert.equal(developingSteps[1].meta, "Executor Ara");
  assert.equal(developingSteps[2].state, "pending");

  const reviewing = { ...developing, reviews: [review("in_review")] };
  assert.equal(requirementStage(reviewing).stage, "review");
  const reviewingSteps = requirementSteps(reviewing);
  assert.equal(reviewingSteps[1].state, "done");
  assert.equal(reviewingSteps[2].state, "current");
  assert.equal(reviewingSteps[2].meta, "Reviewer Norma");

  const merged = {
    ...developing,
    reviews: [review("passed")],
    merges: [merge("merged", { mergeCommit: commit("d") })]
  };
  assert.equal(requirementStage(merged).stage, "merged");
  const mergedSteps = requirementSteps(merged);
  assert.deepEqual(
    mergedSteps.map((step) => step.state),
    ["done", "done", "done", "done", "pending"]
  );
  assert.equal(mergedSteps[3].meta, "main");
});

test("a failed review is a rework, not a finished review", () => {
  const input = {
    development: development(),
    roles,
    reviews: [review("failed", { verdict: { summary: "未通过", checks: [check(0), check(1)] } })],
    plan: {
      projectId: "project-1",
      developmentId: "development-1",
      channel: "independent",
      basis: "需要独立审查",
      checks: [check(0)],
      candidate: review("in_review").candidate,
      revision: 1,
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z"
    }
  };
  assert.equal(requirementStage(input).stage, "rework");
  assert.equal(requirementStage(input).label, "待返修");
  const steps = requirementSteps(input);
  assert.equal(steps[2].state, "blocked");
  assert.equal(steps[3].state, "pending");
});

test("a queued merge waits, a real merge is merged and a synced delivery is delivered", () => {
  const reviews = [review("passed")];
  assert.equal(
    requirementStage({ development: development(), reviews, merges: [merge("waiting")] }).stage,
    "merge"
  );
  assert.equal(
    requirementStage({ development: development(), reviews, merges: [merge("applying")] }).stage,
    "merge"
  );
  assert.equal(
    requirementStage({
      development: development(),
      reviews,
      merges: [merge("merged", { mergeCommit: commit("d") })]
    }).stage,
    "merged"
  );
  assert.equal(
    requirementStage({
      development: development(),
      reviews,
      merges: [merge("merged", { mergeCommit: commit("d") })],
      delivery: { state: "pending", mergedCommit: commit("d") }
    }).stage,
    "merged"
  );
  const delivered = requirementStage({
    development: development(),
    reviews,
    merges: [merge("merged", { mergeCommit: commit("d") })],
    delivery: { state: "synced", mergedCommit: commit("d") }
  });
  assert.equal(delivered.stage, "delivered");
  assert.equal(delivered.label, "已交付");
});

test("a delivered requirement never reads as in progress", () => {
  const input = {
    requirement: { revision: 3, status: "delivered" },
    development: development(),
    roles,
    reviews: [review("passed")],
    merges: [merge("merged", { mergeCommit: commit("d") })],
    delivery: { state: "synced", mergedCommit: commit("d") }
  };
  assert.equal(requirementStage(input).stage, "delivered");
  assert.deepEqual(
    requirementSteps(input).map((step) => step.state),
    ["done", "done", "done", "done", "done"]
  );
});

test("a merged board need stays 待发布 after its ledger delivery until it is released", () => {
  const input = {
    requirement: { revision: 3, status: "delivered" },
    development: development(),
    roles,
    reviews: [review("passed")],
    merges: [merge("merged", { mergeCommit: commit("d") })],
    delivery: { state: "synced", mergedCommit: commit("d") },
    board: { state: "pending_release" }
  };
  assert.equal(requirementStage(input).stage, "release");
  assert.equal(requirementStage(input).label, "待发布");
  assert.deepEqual(
    requirementSteps(input).map((step) => step.state),
    ["done", "done", "done", "done", "current"]
  );
});

test("a merged board need awaiting release is 待发布 and waiting for a reply is reported separately", () => {
  const mergedBoard = {
    development: development(),
    reviews: [review("passed")],
    merges: [merge("merged", { mergeCommit: commit("d") })],
    delivery: { state: "pending", mergedCommit: commit("d") },
    board: { state: "pending_release" }
  };
  assert.equal(requirementStage(mergedBoard).stage, "release");
  assert.equal(requirementStage(mergedBoard).label, "待发布");
  assert.equal(requirementProgress(mergedBoard).steps[4].state, "current");

  const waiting = requirementProgress({ ...mergedBoard, waitingForReply: true });
  assert.equal(waiting.waiting, true);
  assert.equal(requirementProgress(mergedBoard).waiting, false);
});

test("criteria are checked only by a recorded passing check at the same position", () => {
  assert.deepEqual(requirementCriteria(["第一条", "第二条", "第三条"], [check(0), check(1)]), [
    { text: "第一条", checked: true },
    { text: "第二条", checked: false },
    { text: "第三条", checked: false }
  ]);
  assert.deepEqual(requirementCriteria(["第一条"], []), [{ text: "第一条", checked: false }]);
  // The newest recorded evidence decides, so a later failing run unchecks it.
  const progress = requirementProgress({
    development: development({ completionCriteria: ["第一条", "第二条"] }),
    plan: {
      channel: "independent",
      checks: [check(0), check(0)],
      candidate: review("in_review").candidate
    },
    reviews: [review("failed", { verdict: { summary: "未通过", checks: [check(0), check(1)] } })]
  });
  assert.deepEqual(progress.criteria, [
    { text: "第一条", checked: true },
    { text: "第二条", checked: false }
  ]);
});

/**
 * The observation list groups every combination of ledger, board and delivery
 * records into one tab, and the tab is decided by the same mapping the panel
 * shows. These cases pin the wording a person reads next to the phase as well:
 * the two surfaces share one label set, so a phase can never be called one
 * thing in the work panel and another in observation.
 */
test("the phase wording names an in-progress phase as 开发中 and 审查中", () => {
  const developing = { development: development(), roles };
  assert.equal(requirementStage(developing).label, "开发中");
  assert.equal(requirementStage({ ...developing, reviews: [review("in_review")] }).label, "审查中");
  assert.equal(requirementStage({ ...developing, reviews: [review("failed")] }).label, "待返修");
});

test("a Main waiting for a reply reads 等待回复 without losing its phase", () => {
  const reviewing = {
    development: development(),
    roles,
    reviews: [review("in_review")],
    waitingForReply: true
  };
  const stage = requirementStage(reviewing);
  assert.equal(stage.stage, "review");
  assert.equal(stage.label, "等待回复");
  assert.equal(stage.waiting, true);
  assert.equal(requirementTab(reviewing), "waiting");
});

test("every recorded combination lands in exactly one observation tab", () => {
  const developing = { development: development(), roles };
  const merged = {
    ...developing,
    reviews: [review("passed")],
    merges: [merge("merged", { mergeCommit: commit("d") })]
  };
  const cases = [
    ["unclaimed board need", { board: { state: "pending" } }, "pending"],
    ["claimed board need", { board: { state: "claimed" } }, "pending"],
    ["ledger record only", { requirement: { revision: 1, status: "open" } }, "active"],
    ["development", developing, "active"],
    ["review", { ...developing, reviews: [review("in_review")] }, "active"],
    ["review not passed", { ...developing, reviews: [review("failed")] }, "active"],
    ["queued merge", { ...developing, reviews: [review("passed")], merges: [merge("waiting")] }, "active"],
    ["merged", merged, "active"],
    ["merged board need awaiting release", { ...merged, board: { state: "pending_release" } }, "release"],
    [
      "delivered board need still awaiting release",
      {
        ...merged,
        delivery: { state: "synced", mergedCommit: commit("d") },
        board: { state: "pending_release" }
      },
      "release"
    ],
    ["delivered", { ...merged, delivery: { state: "synced", mergedCommit: commit("d") } }, "delivered"],
    ["ledger says delivered", { requirement: { revision: 3, status: "delivered" } }, "delivered"],
    ["withdrawn", { requirement: { revision: 2, status: "withdrawn" } }, "withdrawn"],
    ["a waiting Main", { ...developing, waitingForReply: true }, "waiting"]
  ];
  for (const [name, input, tab] of cases) assert.equal(requirementTab(input), tab, name);
});

test("tab counts add up to the whole list and a delivered need never counts as in progress", () => {
  const developing = { development: development(), roles };
  const delivered = {
    ...developing,
    requirement: { revision: 3, status: "delivered" },
    reviews: [review("passed")],
    merges: [merge("merged", { mergeCommit: commit("d") })],
    delivery: { state: "synced", mergedCommit: commit("d") }
  };
  const counts = requirementTabCounts([
    delivered,
    developing,
    { board: { state: "pending" } },
    { ...developing, reviews: [review("in_review")], waitingForReply: true }
  ]);
  assert.deepEqual(counts, {
    all: 4,
    pending: 1,
    active: 1,
    waiting: 1,
    release: 0,
    delivered: 1
  });
});

test("the tabs are the design's six, in order", () => {
  assert.deepEqual(
    REQUIREMENT_TABS.map((tab) => [tab.id, tab.label]),
    [
      ["all", "全部"],
      ["pending", "待认领"],
      ["active", "进行中"],
      ["waiting", "等待回复"],
      ["release", "待发布"],
      ["delivered", "已交付"]
    ]
  );
});
