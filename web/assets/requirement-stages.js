import { agentDisplayName } from "./agent-names.js";

/**
 * One requirement's phase, derived from the records the backend keeps.
 *
 * The ledger requirement, its board projection, the development record, the
 * review plan and reviews, the merge operations and the delivery receipt are
 * separate facts. Losing one of them must not turn a later phase into an
 * earlier one, so every rule reads a recorded fact instead of a model claim,
 * and a delivered requirement can never fall back to "in development".
 *
 * The same mapping feeds the work panel, the observation list and the project
 * overview, so those surfaces cannot disagree about which phase a requirement
 * is in.
 */
export const REQUIREMENT_STAGE_LABELS = {
  pending: "待认领",
  requirement: "需求记录",
  development: "开发",
  review: "审查",
  rework: "待返修",
  merge: "待合入",
  merged: "已合入",
  release: "待发布",
  delivered: "已交付",
  withdrawn: "已撤回"
};

const STEPS = [
  { id: "requirement", label: "需求记录" },
  { id: "development", label: "开发" },
  { id: "review", label: "审查" },
  { id: "merge", label: "合入" },
  { id: "delivery", label: "交付" }
];

const MERGED = new Set(["merged"]);

function lastReview(reviews) {
  return Array.isArray(reviews) && reviews.length ? reviews.at(-1) : undefined;
}

function mergedOperation(merges) {
  return Array.isArray(merges) ? [...merges].reverse().find((entry) => MERGED.has(entry?.state)) : undefined;
}

/** The check set that proves the current candidate, newest evidence first. */
function evidenceChecks({ plan, reviews, merges }) {
  const merged = mergedOperation(merges);
  if (merged?.checks?.length) return merged.checks;
  const review = lastReview(reviews);
  if (review?.verdict?.checks?.length) return review.verdict.checks;
  if (plan?.checks?.length) return plan.checks;
  return [];
}

/**
 * A criterion is met when the recorded check at the same position passed.
 *
 * The completion criteria are the agreed observable outcomes and the plan,
 * verdict and merge checks are recorded in that order, so position is the only
 * pairing the records carry. A missing or failing check stays unchecked.
 */
export function requirementCriteria(criteria, checks) {
  const recorded = Array.isArray(checks) ? checks : [];
  return (Array.isArray(criteria) ? criteria : []).map((text, index) => ({
    text,
    checked: recorded[index]?.exitCode === 0
  }));
}

function stageOf(input) {
  const { requirement, board, development, plan, reviews, merges, delivery } = input;
  const review = lastReview(reviews);
  const merged = mergedOperation(merges);
  if (requirement?.status === "withdrawn") return "withdrawn";
  // A board need merged into the target still awaits release to its customer;
  // publishing is the later phase, so the requirement is not delivered yet.
  if (board?.state === "pending_release") return "release";
  if (delivery?.state === "synced" || requirement?.status === "delivered") return "delivered";
  if (merged || delivery?.state === "pending")
    return board?.state === "pending_release" ? "release" : "merged";
  if (Array.isArray(merges) && merges.some((entry) => ["waiting", "applying"].includes(entry?.state)))
    return "merge";
  if (review?.state === "failed") return "rework";
  if (review?.state === "in_review") return "review";
  // A self-checked channel records the plan instead of an independent review.
  if (development) return plan?.channel === "self" ? "review" : "development";
  if (board?.state === "pending") return "pending";
  if (requirement) return "requirement";
  return "pending";
}

/** The phase id and its label; `waiting` says the handling Main is blocked on a reply. */
export function requirementStage(input = {}) {
  const stage = stageOf(input);
  return { stage, label: REQUIREMENT_STAGE_LABELS[stage], waiting: Boolean(input.waitingForReply) };
}

function roleAgent(roles, role) {
  const entry = (Array.isArray(roles) ? roles : []).find((candidate) => candidate?.role === role);
  return entry?.agentId;
}

function executorLabel(input) {
  const review = lastReview(input.reviews);
  const agentId = roleAgent(input.roles, "executor") ?? review?.author?.agentId;
  if (agentId) return `Executor ${agentDisplayName(agentId)}`;
  // Before a delegated Executor is recorded, the session's own Main does the work.
  return input.development ? "Main" : "";
}

function reviewerLabel(input) {
  const review = lastReview(input.reviews);
  const agentId = roleAgent(input.roles, "reviewer") ?? review?.reviewer?.agentId;
  if (agentId) return `Reviewer ${agentDisplayName(agentId)}`;
  return input.plan?.channel === "self" ? "Main 自检" : "";
}

/**
 * The five steps with their state and the role, agent or version that explains
 * the step. `current` is the phase being worked on, `blocked` is a review that
 * came back for a fix, and `done` steps are settled facts.
 */
export function requirementSteps(input = {}) {
  const { stage } = requirementStage(input);
  const development = input.development;
  const review = lastReview(input.reviews);
  const merged = mergedOperation(input.merges);
  const reviewed =
    review?.state === "passed" ||
    input.plan?.channel === "self" ||
    Boolean(merged) ||
    input.delivery?.state === "synced" ||
    Boolean(input.delivery);
  const reached = {
    requirement: Boolean(input.requirement) || Boolean(development),
    development: Boolean(development) && stage !== "development",
    review: reviewed,
    merge: Boolean(merged) || stage === "merged" || stage === "release" || stage === "delivered",
    delivery: stage === "delivered"
  };
  const currentStep = {
    requirement: "requirement",
    development: "development",
    review: "review",
    rework: "review",
    merge: "merge",
    release: "delivery"
  }[stage];
  const meta = {
    requirement: input.requirement ? `v${input.requirement.revision}` : "",
    development: executorLabel(input),
    review: reviewerLabel(input),
    merge: merged?.targetBranch ?? input.delivery?.targetBranch ?? development?.baseline?.branch ?? "",
    delivery: ""
  };
  return STEPS.map((step) => {
    const done = reached[step.id];
    const current = currentStep === step.id;
    return {
      id: step.id,
      label: step.label,
      state: current
        ? stage === "rework" && step.id === "review"
          ? "blocked"
          : "current"
        : done
          ? "done"
          : "pending",
      meta: meta[step.id]
    };
  });
}

/** Everything the work panel needs about one requirement, in one call. */
export function requirementProgress(input = {}) {
  const stage = requirementStage(input);
  return {
    ...stage,
    steps: requirementSteps(input),
    criteria: requirementCriteria(input.development?.completionCriteria, evidenceChecks(input))
  };
}
