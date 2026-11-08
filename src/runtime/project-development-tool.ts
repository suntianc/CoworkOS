import { createProjectDevelopmentClient } from "./project-development-client.js";

export interface ProjectDevelopmentToolOptions {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}

const ID = { type: "string", minLength: 1, maxLength: 300 };
const CHECK = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    command: { type: "string", maxLength: 4000 },
    exitCode: { type: "integer", minimum: 0, maximum: 255 },
    output: { type: "string", maxLength: 8000 }
  },
  required: ["name", "exitCode"],
  additionalProperties: false
} as const;

const MERGE_ACTIONS = ["request_merge", "apply_merge", "merge_status"] as const;

const REVIEW_ACTIONS = [
  "review_plan",
  "freeze_candidate",
  "attach_reviewer",
  "record_finding",
  "rule_finding",
  "record_rework",
  "complete_review",
  "delivery_check",
  "query_reviews",
  "get_review"
] as const;

/**
 * The Main tool over requirement development records and their reviews.
 *
 * Kept out of the Pi extension so the production path — this executor and its
 * real HTTP bridge — can be exercised without a model. The extension only
 * registers it.
 */
export function createProjectDevelopmentTool(options: ProjectDevelopmentToolOptions) {
  // The bridge is built on first call. Registration must not depend on this
  // run's credential: a delegated subprocess keeps the Dashboard URL while the
  // run credential is removed, and a missing credential must disable only this
  // tool rather than abort every later registration in the extension.
  let client: ReturnType<typeof createProjectDevelopmentClient> | undefined;
  const bridge = () => (client ??= createProjectDevelopmentClient(options));
  return {
    name: "project_development",
    label: "Project Development",
    description:
      "The current project's requirement development records, fixed-candidate reviews and shared merge entry. create records the goal, completion criteria, suggested route and the code baseline, then prepares this backend's isolated Git checkout for the requirement; one record exists per requirement, so read it before creating. get/query read records back, find_by_requirement looks one up for a requirement, update appends a new revision (carry the revision you last read), and ensure_workspace continues or repairs the existing checkout at its recorded baseline. Review actions record the channel decision and the version its self-checks ran on (review_plan), freeze the integration checkout's current commit as a candidate and open a review (freeze_candidate), bind one independent Reviewer call (attach_reviewer), keep its findings and Main's rulings (record_finding/rule_finding), record a rework that continued the original Executor session (record_rework), read or finish a review (get_review/complete_review), and read delivery qualification (delivery_check). A passed review settles its linked fixes; failed or drifted reviews keep their findings rulable so a repair or reasoned dismissal can still settle them. Merge actions apply an accepted candidate to the project's configured target through the shared entry: request_merge queues it (and the execution location applies its queue when this backend owns it), apply_merge asks the execution location to reconcile interrupted attempts and process waiting operations in order, and merge_status reads operations and their idempotent merged receipts. Delivery is recorded automatically after a real merge; delivery_status reads its phase, role progress, committed diff, checks, findings and the ledger/board synchronization receipt (pending rows keep their last error and retry automatically). The current project and Task come from this conversation, so no project id or path is accepted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "get",
            "query",
            "find_by_requirement",
            "update",
            "ensure_workspace",
            ...REVIEW_ACTIONS,
            ...MERGE_ACTIONS,
            "delivery_status"
          ]
        },
        requirementId: {
          ...ID,
          description: "create/find_by_requirement/delivery_status target requirement."
        },
        developmentId: {
          ...ID,
          description: "get/update/ensure_workspace/review/merge/delivery_status target."
        },
        goal: {
          type: "string",
          maxLength: 4000,
          description: "create/update: what this development must achieve."
        },
        completionCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 1000 },
          description: "create/update: observable conditions that make the requirement done."
        },
        route: {
          type: "string",
          enum: ["quick", "direct", "full"],
          description: "The suggested path: quick, direct or full. A suggestion, not a quota."
        },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "update: the revision returned by the last read; a stale value is refused."
        },
        channel: {
          type: "string",
          enum: ["self", "independent", "combined"],
          description:
            "review_plan: self (Main verified a small change), independent, or combined for a final version. self checks bind to the current commit/tree; record them again after the checkout moves."
        },
        basis: {
          type: "string",
          maxLength: 2000,
          description: "review_plan/rule_finding: why this channel or ruling is justified."
        },
        checks: {
          type: "array",
          maxItems: 20,
          items: CHECK,
          description: "review_plan/record_finding/complete_review: command, exit code and captured output."
        },
        kind: {
          type: "string",
          enum: ["independent", "combined"],
          description:
            "freeze_candidate: independent review, or combined (which requires a combined plan) for the final version."
        },
        previousReviewId: {
          ...ID,
          description: "freeze_candidate: the review whose findings and new changes this re-review covers."
        },
        authorCallId: {
          ...ID,
          description:
            "freeze_candidate: the Executor work item that produced the candidate; its identity must differ from the Reviewer's."
        },
        reviewId: { ...ID, description: "attach_reviewer/record/rule/complete/get_review target." },
        callId: {
          ...ID,
          description:
            "attach_reviewer: the Reviewer work item returned by call_subagent. The first Reviewer owns the review; retrying the same call is safe and another call is refused."
        },
        title: { type: "string", maxLength: 300, description: "record_finding: short finding title." },
        detail: { type: "string", maxLength: 4000, description: "record_finding: what is wrong and why." },
        location: { type: "string", maxLength: 1000, description: "record_finding: file or symbol." },
        rawFailure: {
          type: "string",
          maxLength: 8000,
          description: "record_finding: the Reviewer's verbatim failing output, kept for later reading."
        },
        findingId: { ...ID, description: "rule_finding: the finding to rule on." },
        decision: {
          type: "string",
          enum: ["fix", "dismiss"],
          description:
            "rule_finding: fix it, or dismiss it with a recorded basis. Findings of failed or drifted reviews stay rulable; a passed review is closed."
        },
        category: {
          type: "string",
          enum: ["false_positive", "out_of_scope", "other"],
          description: "rule_finding with dismiss: why the finding does not stand."
        },
        findingIds: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 300 },
          description: "record_rework: findings this continuation fixed."
        },
        fromCallId: {
          ...ID,
          description: "record_rework: the original Executor call whose session and checkout continued."
        },
        continuationCallId: {
          ...ID,
          description: "record_rework: the continuation call returned by call_subagent continueCallId."
        },
        mergeChecks: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              command: { type: "string", minLength: 1, maxLength: 4000 }
            },
            required: ["name", "command"],
            additionalProperties: false
          },
          description:
            "request_merge: commands to run on the target-plus-candidate version. Omit to reuse the recorded self checks or the passed review's checks."
        },
        verdict: {
          type: "string",
          enum: ["passed", "failed"],
          description: "complete_review: whether the fixed candidate satisfies the completion criteria."
        },
        summary: {
          type: "string",
          maxLength: 2000,
          description: "complete_review: the Reviewer's conclusion."
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const action = typeof input.action === "string" ? input.action : "";
      const request = bridge();
      if (action === "create")
        return request({
          action,
          requirementId: input.requirementId,
          goal: input.goal,
          completionCriteria: input.completionCriteria,
          route: input.route
        });
      if (action === "get") return request({ action, developmentId: input.developmentId });
      if (action === "query") return request({ action });
      if (action === "find_by_requirement") return request({ action, requirementId: input.requirementId });
      if (action === "update")
        return request({
          action,
          developmentId: input.developmentId,
          expectedRevision: input.expectedRevision,
          ...(input.goal === undefined ? {} : { goal: input.goal }),
          ...(input.completionCriteria === undefined ? {} : { completionCriteria: input.completionCriteria }),
          ...(input.route === undefined ? {} : { route: input.route })
        });
      if (action === "ensure_workspace") return request({ action, developmentId: input.developmentId });

      const review = request.reviews;
      if (action === "review_plan")
        return review({
          action: "plan",
          developmentId: input.developmentId,
          channel: input.channel,
          basis: input.basis,
          checks: input.checks
        });
      if (action === "freeze_candidate")
        return review({
          action: "start",
          developmentId: input.developmentId,
          kind: input.kind,
          ...(input.previousReviewId === undefined ? {} : { previousReviewId: input.previousReviewId }),
          ...(input.authorCallId === undefined ? {} : { authorCallId: input.authorCallId })
        });
      if (action === "attach_reviewer")
        return review({ action: "attach_reviewer", reviewId: input.reviewId, callId: input.callId });
      if (action === "record_finding")
        return review({
          action: "record_finding",
          reviewId: input.reviewId,
          title: input.title,
          detail: input.detail,
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.checks === undefined ? {} : { checks: input.checks }),
          ...(input.rawFailure === undefined ? {} : { rawFailure: input.rawFailure })
        });
      if (action === "rule_finding")
        return review({
          action: "rule_finding",
          reviewId: input.reviewId,
          findingId: input.findingId,
          decision: input.decision,
          ...(input.category === undefined ? {} : { category: input.category }),
          basis: input.basis
        });
      if (action === "record_rework")
        return review({
          action: "record_rework",
          reviewId: input.reviewId,
          findingIds: input.findingIds,
          fromCallId: input.fromCallId,
          continuationCallId: input.continuationCallId
        });
      if (action === "complete_review")
        return review({
          action: "complete",
          reviewId: input.reviewId,
          verdict: input.verdict,
          summary: input.summary,
          checks: input.checks
        });
      if (action === "delivery_check")
        return review({ action: "delivery", developmentId: input.developmentId });
      if (action === "query_reviews")
        return review({
          action: "query",
          ...(input.developmentId === undefined ? {} : { developmentId: input.developmentId })
        });
      if (action === "get_review") return review({ action: "get", reviewId: input.reviewId });

      const merges = request.merges;
      if (action === "request_merge")
        return merges({
          action: "request",
          developmentId: input.developmentId,
          ...(input.mergeChecks === undefined ? {} : { checks: input.mergeChecks })
        });
      if (action === "apply_merge") return merges({ action: "apply" });
      if (action === "merge_status")
        return merges({
          action: "query",
          ...(input.developmentId === undefined ? {} : { developmentId: input.developmentId })
        });
      if (action === "delivery_status")
        return request.deliveries({
          action: "view",
          ...(input.developmentId === undefined ? {} : { developmentId: input.developmentId }),
          ...(input.requirementId === undefined ? {} : { requirementId: input.requirementId })
        });
      throw new Error(`未知的开发记录操作：${String(action)}`);
    }
  };
}
