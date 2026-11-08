import { dirname, join, resolve } from "node:path";
import {
  dismissalCategory,
  reviewBasis,
  reviewCandidate,
  reviewFindingInput,
  reviewKind,
  reviewPlanInput,
  reviewVerdict,
  rulingDecision,
  type DevelopmentReview,
  type ReviewCandidate,
  type ReviewFinding,
  type ReviewQualification
} from "../domain/development-review.js";
import {
  mergeAcceptance,
  mergeCheckCommands,
  type DevelopmentMerge,
  type MergeAcceptance,
  type MergeCheck
} from "../domain/development-merge.js";
import {
  deliveryFromMerge,
  deliveryReceipt,
  type DeliveryDiff,
  type DeliveryRoleProgress,
  type DeliveryStage,
  type DeliveryView,
  type DevelopmentDelivery
} from "../domain/development-delivery.js";
import {
  DevelopmentExistsError,
  developmentIdentifier,
  mergeExecutionBackendId,
  mergeRepository,
  mergeTargetBranch,
  type DevelopmentRecord,
  type MergeConfig
} from "../domain/project-development.js";
import { ProjectDataConflictError, ProjectDataNotFoundError } from "../domain/project-ledger.js";
import { id, now } from "../domain/types.js";
import type {
  DevelopmentCreate,
  DevelopmentUpdate,
  MergeConfigInput,
  ProjectDataGateway,
  ProjectDataRuntime
} from "../workspace/project-data-service.js";
import {
  developmentWorkspaceIsIntact,
  git,
  prepareDevelopmentWorkspace,
  resolveDevelopmentBaseline
} from "../workspace/development-workspace.js";
import { DeliveryOutbox, type DeliveryIntent } from "../workspace/delivery-outbox.js";
import {
  isAncestor,
  mergeCandidate,
  publishMerge,
  removeMergeSite,
  runMergeChecks,
  targetTip
} from "../workspace/project-merge.js";

export interface DevelopmentProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
}

/** One work item's durable facts, read from this host's queue rather than a model claim. */
export interface WorkItemCallFact {
  callId: string;
  agentId: string;
  role: "executor" | "reviewer";
  workspace?: string;
  developmentId?: string;
  status: string;
  continuationFrom?: string;
}

export interface ProjectDevelopmentPorts {
  runtime: Pick<ProjectDataRuntime, "service">;
  /** The serving backend: it owns the checkouts it prepares and can read them back. */
  backendId: string;
  /**
   * This process instance's start time. A merge claim records it, so a later
   * process of the same backend can tell an interrupted operation from one that
   * is still being applied by this instance.
   */
  startedAt?: string;
  /** Where isolated checkouts live, outside every user working copy. */
  developmentRoot: string;
  /** Where this host keeps the delivery facts it published but has not synced yet. */
  deliveryRoot?: string;
  /**
   * Test-only crash injection: `crash:<mergeId|*>@after-apply` kills the process
   * between the target update and its record, reproducing that recovery window.
   */
  mergeFaultInject?: string;
  project(projectId: string): Promise<DevelopmentProject | undefined>;
  taskProject(taskId: string): Promise<DevelopmentProject | undefined>;
  /** A call this Task's own durable queue recorded; never an identity the model supplied. */
  call?(taskId: string, callId: string): Promise<WorkItemCallFact | undefined>;
}

/**
 * The development-record service: shared goal, criteria, route and baseline,
 * plus this backend's isolated Git checkout.
 *
 * The shared record is written through the unified project-data gateway, so
 * SQLite and PostgreSQL behave the same; the repository check and the
 * `git worktree` are host facts and stay in this backend. A failed checkout is
 * recorded and returned rather than thrown away, so the requirement and the
 * workspace it names remain findable.
 */
export function createProjectDevelopmentService(ports: ProjectDevelopmentPorts) {
  const gateway = () => ports.runtime.service();
  const deliveryOutbox = new DeliveryOutbox(
    ports.deliveryRoot ?? join(ports.developmentRoot, "delivery-sync")
  );

  async function bind(project: DevelopmentProject) {
    if (!project.projectDirectory) return;
    const service = await gateway();
    await service.ensureProject({
      projectId: project.projectId,
      projectName: project.projectName,
      projectDirectory: project.projectDirectory,
      backendId: ports.backendId
    });
  }

  async function project(projectId: string): Promise<DevelopmentProject> {
    const found = await ports.project(projectId);
    if (found) {
      await bind(found);
      return found;
    }
    // A secondary backend's project is not in this catalog. The shared
    // identity must exist; its directory stays that other backend's fact.
    const service = await gateway();
    const shared = await service.projects();
    if (!shared.some((entry) => entry.projectId === projectId))
      throw new ProjectDataNotFoundError("项目不存在");
    return { projectId, projectName: projectId, projectDirectory: "" };
  }

  async function taskProject(taskId: string): Promise<DevelopmentProject> {
    const found = await ports.taskProject(taskId);
    if (!found) throw new ProjectDataNotFoundError("会话不属于任何项目");
    await bind(found);
    return found;
  }

  const workspaceDirectory = (developmentId: string) => join(ports.developmentRoot, developmentId);
  const workspaceBranch = (developmentId: string) => `coworkos/development/${developmentId}`;

  /**
   * The project's merge entry.
   *
   * Every backend that can see the configured repository may prepare its own
   * isolated checkout; only the named execution backend claims an operation and
   * updates the target. Preparation is therefore not an ownership refusal.
   */
  async function requiredMergeConfig(projectId: string): Promise<MergeConfig> {
    const config = await (await gateway()).mergeConfig(projectId);
    if (!config)
      throw new ProjectDataConflictError(
        "项目合入配置缺失：请先设置 repository、targetBranch 与 executionBackendId",
        undefined,
        "project_git_missing"
      );
    return config;
  }

  async function markFailed(
    projectId: string,
    record: DevelopmentRecord,
    directory: string,
    branch: string,
    error: string
  ): Promise<DevelopmentRecord> {
    return (await gateway()).recordDevelopmentWorkspace(projectId, record.developmentId, {
      workspaceId: record.workspace?.workspaceId ?? id("workspace"),
      backendId: ports.backendId,
      directory: record.workspace?.directory ?? directory,
      branch: record.workspace?.branch ?? branch,
      baseCommit: record.workspace?.baseCommit ?? record.baseline.commit,
      state: "failed",
      error
    });
  }

  async function prepare(
    projectId: string,
    record: DevelopmentRecord,
    repository: string
  ): Promise<DevelopmentRecord> {
    const directory = record.workspace?.directory ?? workspaceDirectory(record.developmentId);
    const branch = record.workspace?.branch ?? workspaceBranch(record.developmentId);
    try {
      await prepareDevelopmentWorkspace({
        repository,
        branch,
        commit: record.baseline.commit,
        directory
      });
      const service = await gateway();
      return await service.recordDevelopmentWorkspace(projectId, record.developmentId, {
        workspaceId: record.workspace?.workspaceId ?? id("workspace"),
        backendId: ports.backendId,
        directory,
        branch,
        baseCommit: record.baseline.commit,
        state: "ready"
      });
    } catch (error) {
      return markFailed(
        projectId,
        record,
        directory,
        branch,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function create(
    projectId: string,
    input: DevelopmentCreate,
    taskId?: string
  ): Promise<DevelopmentRecord> {
    await project(projectId);
    const service = await gateway();
    const requirementId = developmentIdentifier(input.requirementId, "需求 ID");
    // Resolve the requirement before any record or checkout exists.
    await service.getRequirement(projectId, requirementId);
    const existing = await service.findDevelopmentByRequirement(projectId, requirementId, ports.backendId);
    if (existing)
      throw new DevelopmentExistsError(
        `该需求已有开发记录（${existing.developmentId}）；请读取后更新，不要重复创建`,
        existing.developmentId
      );
    let sessionId = input.sessionId;
    if (taskId) {
      const session = await service.findMainSessionByTask(projectId, ports.backendId, taskId);
      sessionId = session?.session.sessionId;
    } else if (sessionId) await service.getMainSession(projectId, sessionId);
    const config = await requiredMergeConfig(projectId);
    // The baseline is the configured target branch as it exists right now.
    const baseline = await resolveDevelopmentBaseline({
      repository: config.repository,
      branch: config.targetBranch
    });
    const record = await service.createDevelopment(projectId, {
      requirementId,
      goal: input.goal,
      completionCriteria: input.completionCriteria,
      route: input.route,
      baseline,
      sessionId,
      taskId
    });
    return prepare(projectId, record, config.repository);
  }

  async function ensureWorkspace(projectId: string, developmentId: string): Promise<DevelopmentRecord> {
    await project(projectId);
    const service = await gateway();
    const record = await service.getDevelopment(projectId, developmentId, ports.backendId);
    const directory = record.workspace?.directory ?? workspaceDirectory(record.developmentId);
    const branch = record.workspace?.branch ?? workspaceBranch(record.developmentId);
    const config = await service.mergeConfig(projectId);
    if (!config)
      return markFailed(
        projectId,
        record,
        directory,
        branch,
        "项目合入配置缺失：请先设置 repository、targetBranch 与 executionBackendId"
      );
    if (
      record.workspace &&
      (await developmentWorkspaceIsIntact({
        repository: config.repository,
        directory: record.workspace.directory,
        branch: record.workspace.branch
      }))
    ) {
      if (record.workspace.state === "ready") return record;
      // A failed marker after a successful checkout (for example a ready-write
      // failure) is reconciled without creating a second worktree or resetting
      // the user's work.
      const service = await gateway();
      return await service.recordDevelopmentWorkspace(projectId, record.developmentId, {
        workspaceId: record.workspace.workspaceId,
        backendId: ports.backendId,
        directory: record.workspace.directory,
        branch: record.workspace.branch,
        baseCommit: record.workspace.baseCommit,
        state: "ready"
      });
    }
    return prepare(projectId, record, config.repository);
  }

  // ---- fixed-candidate review -------------------------------------------------
  // The program owns versions, identities, drift and delivery prerequisites.
  // Main owns the judgement: which candidate to freeze, what a finding means,
  // whether to fix or dismiss it, and whether a Reviewer is needed at all.

  function conflict(message: string, code: string): ProjectDataConflictError {
    return new ProjectDataConflictError(message, undefined, code);
  }

  async function reviewDevelopment(
    projectId: string,
    developmentIdValue: unknown
  ): Promise<DevelopmentRecord> {
    await project(projectId);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    const record = await (await gateway()).getDevelopment(projectId, developmentId, ports.backendId);
    if (!record.workspace || record.workspace.state !== "ready")
      throw conflict("开发记录没有就绪的本机现场；先 ensure_workspace", "review_workspace_not_ready");
    return record;
  }

  async function inspectWorkspace(record: DevelopmentRecord): Promise<ReviewCandidate & { changes: string }> {
    const workspace = record.workspace!;
    try {
      const [commit, tree, changes] = await Promise.all([
        git(workspace.directory, ["rev-parse", "HEAD"]),
        git(workspace.directory, ["rev-parse", "HEAD^{tree}"]),
        git(workspace.directory, ["status", "--porcelain"])
      ]);
      return { commit, tree, branch: workspace.branch, workspace: workspace.directory, changes };
    } catch (error) {
      throw conflict(
        `无法读取需求现场 ${workspace.directory}：${error instanceof Error ? error.message : String(error)}`,
        "review_site_unavailable"
      );
    }
  }

  async function currentCandidate(record: DevelopmentRecord): Promise<ReviewCandidate> {
    const current = await inspectWorkspace(record);
    if (current.changes)
      throw conflict("候选现场有未提交改动；先提交或清理再冻结候选", "review_candidate_dirty");
    return {
      commit: current.commit,
      tree: current.tree,
      branch: current.branch,
      workspace: current.workspace
    };
  }

  interface ReviewSiteState {
    head: string;
    tree: string;
    changes: string;
  }

  /** Read the Reviewer checkout, or undefined while it is not prepared yet. */
  async function readReviewSite(workspace: string): Promise<ReviewSiteState | undefined> {
    try {
      const [head, tree, changes] = await Promise.all([
        git(workspace, ["rev-parse", "HEAD"]),
        git(workspace, ["rev-parse", "HEAD^{tree}"]),
        git(workspace, ["status", "--porcelain", "--untracked-files=no"])
      ]);
      return { head, tree, changes };
    } catch {
      return undefined;
    }
  }

  /** The reviewed content is the candidate commit's tracked tree, not the Reviewer's evidence files. */
  function driftReason(site: ReviewSiteState, candidate: ReviewCandidate): string | undefined {
    if (site.head !== candidate.commit)
      return `审查现场已从候选 ${candidate.commit.slice(0, 8)} 移到 ${site.head.slice(0, 8)}`;
    if (site.tree !== candidate.tree) return `审查现场的受审内容已变化（树 ${site.tree.slice(0, 8)}）`;
    if (site.changes)
      return `审查现场有未提交的受控文件改动：${site.changes.split("\n").slice(0, 5).join("、")}`;
    return undefined;
  }

  async function markDrifted(projectId: string, review: DevelopmentReview, reason: string): Promise<void> {
    await (
      await gateway()
    ).updateReview(projectId, review.reviewId, {
      expectedRevision: review.revision,
      state: "drifted",
      drift: reason
    });
  }

  async function requireCall(taskId: string | undefined, callIdValue: unknown): Promise<WorkItemCallFact> {
    const callId = developmentIdentifier(callIdValue, "工作项 callId");
    if (!taskId) throw conflict("审查操作须来自一个 Main 会话", "review_task_required");
    if (!ports.call) throw conflict("当前服务无法读取工作项身份", "review_call_source_missing");
    const fact = await ports.call(taskId, callId);
    if (!fact) throw conflict(`当前运行没有工作项 ${callId}`, "review_call_unknown");
    return fact;
  }

  async function setReviewPlan(projectId: string, input: Record<string, unknown>) {
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    const record = await reviewDevelopment(projectId, developmentId);
    const current = await inspectWorkspace(record);
    // A self check belongs to the integration version it actually ran on. The
    // program records that version here, so a later commit cannot inherit it.
    const plan = reviewPlanInput({
      ...input,
      candidate: {
        commit: current.commit,
        tree: current.tree,
        branch: current.branch,
        workspace: current.workspace
      }
    });
    if (plan.channel === "self" && plan.checks.length === 0)
      throw conflict("没有独立 Reviewer 时须至少记录一项相关验证", "review_checks_missing");
    // The checks claim this committed version. An uncommitted checkout would
    // let a later clean state inherit verification that never ran on it.
    if (plan.channel === "self" && current.changes)
      throw conflict("自检须对应已提交的干净现场；先提交或清理再记录", "review_candidate_dirty");
    if (plan.channel === "self") {
      // A review already opened for this development stands: the self channel
      // records a decision made before review, not a way to erase one.
      const existing = await (await gateway()).queryReviews(projectId, developmentId);
      if (existing.length)
        throw conflict("该需求已有候选审查，不能改为无独立审查的通道", "review_channel_downgrade");
    }
    return (await gateway()).setReviewPlan(projectId, developmentId, plan);
  }

  async function startReview(
    projectId: string,
    taskId: string | undefined,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    const record = await reviewDevelopment(projectId, developmentId);
    const kind = reviewKind(input.kind);
    const service = await gateway();
    const plan = await service.reviewPlan(projectId, developmentId);
    if (!plan) throw conflict("先记录审查通道（review_plan），再冻结候选", "review_plan_missing");
    if (plan.channel === "self")
      throw conflict("当前通道是不含独立审查的 self；先明确改变通道再冻结候选", "review_channel_mismatch");
    if (kind === "combined" && plan.channel !== "combined")
      throw conflict("组合审查须先把通道改为 combined", "review_channel_mismatch");
    const candidate = await currentCandidate(record);
    let author: DevelopmentReview["author"];
    let previous: DevelopmentReview | undefined;
    let changedPaths: string[] = [];
    if (input.previousReviewId !== undefined) {
      previous = await service.getReview(
        projectId,
        developmentIdentifier(input.previousReviewId, "上一次审查 ID")
      );
      if (previous.developmentId !== developmentId)
        throw conflict("上一次审查不属于这个开发记录", "review_previous_mismatch");
      if (previous.state === "in_review")
        throw conflict("上一次审查还没有结束，不能开始复审", "review_previous_open");
      if (previous.candidate.commit === candidate.commit)
        throw conflict("候选没有变化；复审需要新的候选提交", "review_candidate_unchanged");
      changedPaths = (
        await git(record.workspace!.directory, [
          "diff",
          "--name-only",
          `${previous.candidate.commit}..${candidate.commit}`
        ])
      )
        .split("\n")
        .filter(Boolean)
        .slice(0, 200);
      const pending = previous.findings.filter((finding) => finding.state === "fix_claimed");
      if (previous.author && pending.length) {
        const covered = new Set(previous.reworks.flatMap((rework) => rework.findingIds));
        const missing = pending.filter((finding) => !covered.has(finding.findingId));
        if (missing.length)
          throw conflict(
            `发现 ${missing.map((finding) => finding.findingId).join("、")} 还没有记录原上下文返修`,
            "review_rework_missing"
          );
        const rework = previous.reworks.at(-1);
        if (rework)
          author = {
            role: "executor",
            callId: rework.continuationCallId,
            agentId: rework.agentId,
            workspace: rework.workspace
          };
      }
    }
    if (!author && input.authorCallId !== undefined) {
      const fact = await requireCall(taskId, input.authorCallId);
      if (fact.role !== "executor" || fact.developmentId !== developmentId || !fact.workspace)
        throw conflict("候选执行工作项不是该需求下的 Executor 现场", "review_author_invalid");
      author = { role: "executor", callId: fact.callId, agentId: fact.agentId, workspace: fact.workspace };
    }
    return service.createReview(projectId, developmentId, {
      kind,
      candidate,
      ...(author ? { author } : {}),
      ...(previous
        ? {
            previousReviewId: previous.reviewId,
            previousCandidateCommit: previous.candidate.commit,
            changedPaths
          }
        : {})
    });
  }

  async function attachReviewer(
    projectId: string,
    taskId: string | undefined,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state !== "in_review")
      throw conflict(`审查已经是 ${review.state}，不能再绑定会话`, "review_closed");
    const fact = await requireCall(taskId, input.callId);
    if (fact.role !== "reviewer")
      throw conflict("该工作项不是 Reviewer，不能记为独立审查", "review_reviewer_role");
    if (fact.developmentId !== review.developmentId)
      throw conflict("审查工作项不属于这个需求的现场", "review_development_mismatch");
    if (fact.status === "queued")
      throw conflict("审查工作项还没有开始，现场不可核对", "review_reviewer_not_started");
    if (fact.status === "failed" || fact.status === "cancelled")
      throw conflict(`审查工作项已 ${fact.status}，没有有效结论`, "review_reviewer_terminal");
    if (!fact.workspace) throw conflict("审查工作项没有独立现场", "review_site_missing");
    const development = await service.getDevelopment(projectId, review.developmentId, ports.backendId);
    if (!development.workspace)
      throw conflict("开发记录没有就绪的本机现场；先 ensure_workspace", "review_workspace_not_ready");
    // The Coordinator derives a work item's site beside its integration
    // checkout; any other directory is not that item's own site.
    const derived = join(dirname(development.workspace.directory), "work-items", fact.callId);
    if (resolve(fact.workspace) !== resolve(derived))
      throw conflict(`审查现场不是工作项 ${fact.callId} 自己的现场`, "review_site_mismatch");
    if (review.reviewer) {
      // A review belongs to the session that was bound first. The same call is
      // a safe retry; another Reviewer must use its own review record instead of
      // silently inheriting the findings and evidence already recorded here.
      if (review.reviewer.callId === fact.callId) return review;
      throw conflict(
        `审查已绑定 Reviewer ${review.reviewer.callId}；新的 Reviewer 须使用独立审查记录`,
        "review_reviewer_bound"
      );
    }
    if (review.author && (review.author.callId === fact.callId || review.author.agentId === fact.agentId))
      throw conflict("审查会话与执行身份相同，不能记为独立审查", "review_not_independent");
    // A leased work item may not have created its checkout yet. That is a
    // retryable state, not unauthorized drift; only readable, changed content
    // invalidates the review.
    const site = await readReviewSite(fact.workspace);
    if (!site) throw conflict("审查工作项现场尚未准备完成；稍后重试绑定", "review_site_unavailable");
    const reason = driftReason(site, review.candidate);
    if (reason) {
      await markDrifted(projectId, review, reason);
      throw conflict(reason, "review_drifted");
    }
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      reviewer: {
        role: "reviewer",
        taskId: taskId!,
        callId: fact.callId,
        agentId: fact.agentId,
        workspace: derived
      }
    });
  }

  async function recordFinding(
    projectId: string,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state !== "in_review") throw conflict("审查已结束，不能再追加发现", "review_closed");
    if (!review.reviewer) throw conflict("还没有绑定独立审查会话", "review_reviewer_missing");
    const parsed = reviewFindingInput(input);
    const timestamp = now();
    const finding: ReviewFinding = {
      findingId: id("finding"),
      title: parsed.title,
      detail: parsed.detail,
      ...(parsed.location ? { location: parsed.location } : {}),
      candidateCommit: review.candidate.commit,
      state: "open",
      checks: parsed.checks,
      ...(parsed.rawFailure ? { rawFailure: parsed.rawFailure } : {}),
      source: {
        role: "reviewer",
        callId: review.reviewer.callId,
        agentId: review.reviewer.agentId
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      findings: [...review.findings, finding]
    });
  }

  async function ruleFinding(projectId: string, input: Record<string, unknown>): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    // A failed or drifted review is terminal for its verdict, not for the
    // findings it recorded: Main still has to rule them so a repair or a
    // reasoned dismissal can settle them later.
    if (review.state === "passed") throw conflict("审查已通过，不能再裁定", "review_closed");
    const findingId = developmentIdentifier(input.findingId, "发现 ID");
    const decision = rulingDecision(input.decision);
    const category = decision === "dismiss" ? dismissalCategory(input.category) : undefined;
    if (decision === "dismiss" && !category)
      throw conflict("不采纳的裁定须记录原因类别", "review_ruling_category");
    const basis = reviewBasis(input.basis);
    const target = review.findings.find((finding) => finding.findingId === findingId);
    if (!target) throw new ProjectDataNotFoundError("审查发现不存在");
    if (target.state !== "open") throw conflict(`发现 ${findingId} 已有裁定`, "review_finding_ruled");
    const timestamp = now();
    const findings = review.findings.map((finding) =>
      finding.findingId === findingId
        ? {
            ...finding,
            state: decision === "fix" ? ("fix_claimed" as const) : ("dismissed" as const),
            ruling: {
              rulingId: id("ruling"),
              decision,
              ...(category ? { category } : {}),
              basis,
              candidateCommit: review.candidate.commit,
              at: timestamp
            },
            updatedAt: timestamp
          }
        : finding
    );
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      findings
    });
  }

  async function recordRework(
    projectId: string,
    taskId: string | undefined,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state === "passed") throw conflict("审查已通过，不能记录返修", "review_closed");
    const from = await requireCall(taskId, input.fromCallId);
    const continuation = await requireCall(taskId, input.continuationCallId);
    if (from.role !== "executor" || continuation.role !== "executor")
      throw conflict("返修须由 Executor 工作项执行", "review_rework_role");
    if (from.developmentId !== review.developmentId || continuation.developmentId !== review.developmentId)
      throw conflict("返修工作项不属于这个需求的现场", "review_development_mismatch");
    if (continuation.continuationFrom !== from.callId)
      throw conflict("返修工作项不是从原执行工作项续接的", "review_rework_not_continuation");
    if (continuation.agentId !== from.agentId)
      throw conflict("返修没有复用原执行身份", "review_rework_identity");
    if (
      !from.workspace ||
      !continuation.workspace ||
      resolve(from.workspace) !== resolve(continuation.workspace)
    )
      throw conflict("返修没有复用原执行现场", "review_rework_site");
    if (continuation.status !== "completed")
      throw conflict(`返修工作项还没有完成（${continuation.status}）`, "review_rework_unfinished");
    if (
      review.author &&
      (from.agentId !== review.author.agentId ||
        resolve(from.workspace ?? "") !== resolve(review.author.workspace))
    )
      throw conflict("返修没有复用候选执行者的原身份与现场", "review_rework_author_mismatch");
    if (review.reworks.some((rework) => rework.continuationCallId === continuation.callId))
      throw conflict("该返修工作项已经记录", "review_rework_duplicate");
    const findingIds = Array.isArray(input.findingIds)
      ? input.findingIds.map((entry) => developmentIdentifier(entry, "返修发现"))
      : [];
    if (!findingIds.length) throw conflict("返修须关联至少一条发现", "review_rework_findings");
    for (const findingId of findingIds) {
      const finding = review.findings.find((entry) => entry.findingId === findingId);
      if (!finding) throw new ProjectDataNotFoundError(`审查发现 ${findingId} 不存在`);
      if (finding.ruling?.decision !== "fix")
        throw conflict(`发现 ${findingId} 没有要求修复的裁定`, "review_rework_ruling");
    }
    const reworks = [
      ...review.reworks,
      {
        fromCallId: from.callId,
        fromAgentId: from.agentId,
        continuationCallId: continuation.callId,
        agentId: continuation.agentId,
        workspace: from.workspace,
        findingIds,
        at: now()
      }
    ];
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      reworks
    });
  }

  /**
   * Settle fix-claimed findings along the explicit previousReview chain.
   *
   * A passing review verifies the whole chain it descends from, not just its
   * immediate predecessor. Each finding is settled at the first review on that
   * chain created after its fix evidence (the recorded rework, or the ruling
   * when Main repaired directly), so a long rework keeps the candidate that
   * actually carried the repair. Findings outside the chain are not touched.
   */
  async function settleLinkedFindings(
    projectId: string,
    passed: DevelopmentReview,
    service: ProjectDataGateway
  ): Promise<void> {
    const all = await service.queryReviews(projectId, passed.developmentId);
    const byId = new Map(all.map((entry) => [entry.reviewId, entry] as const));
    const chain: DevelopmentReview[] = [passed];
    const seen = new Set([passed.reviewId]);
    let parentId = passed.previousReviewId;
    while (parentId && !seen.has(parentId)) {
      const parent = byId.get(parentId) ?? (await service.getReview(projectId, parentId));
      chain.unshift(parent);
      seen.add(parentId);
      parentId = parent.previousReviewId;
    }
    const timestamp = now();
    for (let index = 0; index < chain.length - 1; index += 1) {
      const parent = chain[index]!;
      if (!parent.findings.some((finding) => finding.state === "fix_claimed")) continue;
      const evidenceAt = new Map<string, string>();
      for (const rework of parent.reworks)
        for (const findingId of rework.findingIds) evidenceAt.set(findingId, rework.at);
      const findings = parent.findings.map((finding) => {
        if (finding.state !== "fix_claimed") return finding;
        const since = evidenceAt.get(finding.findingId) ?? finding.ruling?.at ?? finding.updatedAt;
        const carrier = chain.slice(index + 1).find((candidate) => candidate.createdAt >= since);
        if (!carrier) return finding;
        return {
          ...finding,
          state: "fixed" as const,
          fixedCommit: carrier.candidate.commit,
          verifiedByReviewId: passed.reviewId,
          updatedAt: timestamp
        };
      });
      await service.updateReview(projectId, parent.reviewId, {
        expectedRevision: parent.revision,
        findings
      });
    }
  }

  async function completeReview(
    projectId: string,
    input: Record<string, unknown>
  ): Promise<DevelopmentReview> {
    const service = await gateway();
    const reviewId = developmentIdentifier(input.reviewId, "审查 ID");
    const review = await service.getReview(projectId, reviewId);
    if (review.state !== "in_review") throw conflict("审查已经结束", "review_closed");
    if (!review.reviewer) throw conflict("还没有绑定独立审查会话", "review_reviewer_missing");
    const verdict = reviewVerdict({ summary: input.summary, checks: input.checks });
    if (input.verdict !== "passed" && input.verdict !== "failed")
      throw conflict("审查结论须为 passed / failed", "review_verdict_invalid");
    const site = await readReviewSite(review.reviewer.workspace);
    if (!site) {
      const reason = `审查现场 ${review.reviewer.workspace} 不可读`;
      await markDrifted(projectId, review, reason);
      throw conflict(reason, "review_drifted");
    }
    const reason = driftReason(site, review.candidate);
    if (reason) {
      await markDrifted(projectId, review, reason);
      throw conflict(reason, "review_drifted");
    }
    if (input.verdict === "passed") {
      if (verdict.checks.length === 0) throw conflict("通过审查须记录检查回执", "review_checks_missing");
      const unresolved = review.findings.filter((finding) => finding.state !== "dismissed");
      if (unresolved.length)
        throw conflict(
          `发现 ${unresolved.map((finding) => finding.findingId).join("、")} 还没有不采纳的裁定；修复后须复审新候选`,
          "review_findings_open"
        );
    }
    if (input.verdict === "passed" && review.previousReviewId)
      await settleLinkedFindings(projectId, review, service);
    return service.updateReview(projectId, reviewId, {
      expectedRevision: review.revision,
      state: input.verdict === "passed" ? "passed" : "failed",
      verdict
    });
  }

  async function deliveryQualification(
    projectId: string,
    developmentIdValue: unknown
  ): Promise<ReviewQualification> {
    const record = await reviewDevelopment(projectId, developmentIdValue);
    const service = await gateway();
    const developmentId = record.developmentId;
    const plan = await service.reviewPlan(projectId, developmentId);
    const reviews = await service.queryReviews(projectId, developmentId);
    const current = await inspectWorkspace(record);
    const qualification: ReviewQualification = {
      developmentId,
      eligible: false,
      ...(plan ? { channel: plan.channel } : {}),
      candidate: {
        commit: current.commit,
        tree: current.tree,
        branch: current.branch,
        workspace: current.workspace
      },
      independentReview: false,
      reasons: []
    };
    const reasons: string[] = [];
    if (!plan) reasons.push("review_plan_missing");
    const latest = reviews.at(-1);
    if (plan?.channel === "self") {
      const aligned = plan.candidate.commit === current.commit && plan.candidate.tree === current.tree;
      if (!aligned) reasons.push("self_check_stale");
      if (reviews.length > 0) reasons.push("review_started");
      if (plan.checks.length === 0) reasons.push("review_checks_missing");
      if (aligned && reviews.length === 0) qualification.approved = plan.candidate;
    } else if (plan) {
      if (!latest) reasons.push("review_missing");
      else {
        qualification.reviewId = latest.reviewId;
        qualification.kind = latest.kind;
        qualification.independentReview = Boolean(latest.reviewer);
        if (latest.state !== "passed") reasons.push(`review_${latest.state}`);
        else {
          qualification.approved = latest.candidate;
          if (plan.channel === "combined" && latest.kind !== "combined") reasons.push("review_kind_mismatch");
          if (latest.candidate.commit !== current.commit || latest.candidate.tree !== current.tree)
            reasons.push("candidate_changed");
        }
      }
    }
    if (current.changes) reasons.push("candidate_workspace_dirty");
    const unresolved = reviews
      .flatMap((review) => review.findings)
      .filter((finding) => finding.state === "open" || finding.state === "fix_claimed");
    if (unresolved.length) reasons.push("findings_open");
    qualification.reasons = [...new Set(reasons)];
    qualification.eligible = qualification.reasons.length === 0;
    return qualification;
  }

  // ---- project merge entry ---------------------------------------------------
  // Every Main applies here; the configured execution backend claims one
  // operation at a time and updates the target. The operation row is the
  // persistent identity a later process reconciles against real Git facts, so a
  // crash between "target updated" and "record written" cannot merge twice.

  const startedAt = ports.startedAt ?? "unidentified";
  const mergeAttempts = 3;
  const projectQueues = new Map<string, Promise<unknown>>();

  /** One project queue per process; the shared row is the cross-process lock. */
  function serialized<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = projectQueues.get(projectId) ?? Promise.resolve();
    const next = previous.then(action, action);
    projectQueues.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  const mergeSite = (mergeId: string) => join(ports.developmentRoot, "merges", mergeId);

  function parseMergeFault(value: string | undefined): { mergeId?: string } | undefined {
    if (!value) return undefined;
    const match = value.match(/^crash:(.+)@after-apply$/);
    if (!match) return undefined;
    return match[1] === "*" ? {} : { mergeId: match[1] };
  }

  function afterApply(merge: DevelopmentMerge): void {
    const fault = parseMergeFault(ports.mergeFaultInject);
    if (!fault) return;
    if (fault.mergeId && fault.mergeId !== merge.mergeId) return;
    // The target is already updated; nothing after this point can run. A real
    // kill, so recovery has to reconcile the record against Git.
    process.kill(process.pid, "SIGKILL");
  }

  /**
   * Checks the requester did not name fall back to the commands its self plan or
   * passed review actually ran, so the combined version is verified with the
   * same relevant checks rather than an empty list.
   */
  async function recordedMergeChecks(
    service: ProjectDataGateway,
    projectId: string,
    developmentId: string
  ): Promise<MergeCheck[]> {
    const plan = await service.reviewPlan(projectId, developmentId);
    const reviews = await service.queryReviews(projectId, developmentId);
    const commands = (checks: { name: string; command?: string }[]): MergeCheck[] =>
      checks
        .filter((check): check is { name: string; command: string } => Boolean(check.command))
        .map((check) => ({ name: check.name, command: check.command }));
    const fromPlan = commands(plan?.checks ?? []);
    if (fromPlan.length) return fromPlan;
    return commands(reviews.at(-1)?.verdict?.checks ?? []);
  }

  /**
   * Re-check the accepted version without reading the requester's checkout.
   *
   * The execution backend may be another host, so it verifies the shared facts
   * the request was qualified against: the same self-check version with no
   * review started, or the same passed review with every finding settled. A
   * later pass on a different candidate therefore does not approve this one.
   */
  async function acceptanceReasons(projectId: string, merge: DevelopmentMerge): Promise<string[]> {
    const service = await gateway();
    const plan = await service.reviewPlan(projectId, merge.developmentId);
    const reviews = await service.queryReviews(projectId, merge.developmentId);
    const reasons: string[] = [];
    if (merge.acceptance.channel === "self") {
      if (!plan || plan.channel !== "self") reasons.push("review_plan_missing");
      else {
        if (plan.candidate.commit !== merge.candidate.commit || plan.candidate.tree !== merge.candidate.tree)
          reasons.push("candidate_changed");
        if (!plan.checks.length) reasons.push("review_checks_missing");
      }
      if (reviews.length) reasons.push("review_started");
    } else {
      const review = merge.acceptance.reviewId
        ? reviews.find((entry) => entry.reviewId === merge.acceptance.reviewId)
        : undefined;
      if (!review) reasons.push("review_missing");
      else {
        if (review.state !== "passed") reasons.push(`review_${review.state}`);
        if (review.candidate.commit !== merge.candidate.commit) reasons.push("candidate_changed");
        if (merge.acceptance.channel === "combined" && review.kind !== "combined")
          reasons.push("review_kind_mismatch");
      }
      const unresolved = reviews
        .flatMap((entry) => entry.findings)
        .filter((finding) => finding.state === "open" || finding.state === "fix_claimed");
      if (unresolved.length) reasons.push("findings_open");
    }
    if (merge.acceptance.approvedCommit !== merge.candidate.commit) reasons.push("candidate_changed");
    if (merge.acceptance.approvedTree !== merge.candidate.tree) reasons.push("candidate_changed");
    return [...new Set(reasons)];
  }

  async function requestMerge(projectId: string, input: Record<string, unknown>): Promise<DevelopmentMerge> {
    await project(projectId);
    const developmentId = developmentIdentifier(input.developmentId, "开发记录 ID");
    await reviewDevelopment(projectId, developmentId);
    const config = await requiredMergeConfig(projectId);
    const qualification = await deliveryQualification(projectId, developmentId);
    if (
      !qualification.eligible ||
      !qualification.channel ||
      !qualification.candidate ||
      !qualification.approved
    )
      throw conflict(
        `交付资格还不满足：${qualification.reasons.join("、") || "未通过验收"}`,
        "merge_not_qualified"
      );
    const candidate = qualification.candidate;
    if (qualification.approved.commit !== candidate.commit || qualification.approved.tree !== candidate.tree)
      throw conflict("验收版本与当前候选不一致；请在当前版本验收后再申请合入", "merge_not_qualified");
    const supplied = input.checks === undefined ? undefined : mergeCheckCommands(input.checks);
    const service = await gateway();
    const checks = supplied ?? (await recordedMergeChecks(service, projectId, developmentId));
    if (!checks.length) throw conflict("合入须记录在组合版本上运行的检查命令", "merge_checks_missing");
    const acceptance: MergeAcceptance = {
      channel: qualification.channel,
      approvedCommit: qualification.approved.commit,
      approvedTree: qualification.approved.tree,
      ...(qualification.reviewId ? { reviewId: qualification.reviewId } : {})
    };
    const existing = await service.queryMerges(projectId, developmentId);
    const open = existing.find(
      (entry) =>
        (entry.state === "waiting" || entry.state === "applying") &&
        entry.candidate.commit === candidate.commit
    );
    if (open) return open;
    // A merged candidate is the same receipt on a retry; a new version needs its
    // own operation instead of inheriting the previous approval.
    const merged = [...existing]
      .reverse()
      .find((entry) => entry.state === "merged" && entry.candidate.commit === candidate.commit);
    if (merged) return merged;
    const created = await service.createMerge(projectId, developmentId, {
      candidate,
      acceptance,
      checks,
      requestedBy: ports.backendId,
      executionBackendId: config.executionBackendId,
      targetBranch: config.targetBranch
    });
    if (config.executionBackendId !== ports.backendId) return created;
    // The location that owns the target applies its own project queue; another
    // backend's request stays waiting until that location processes it.
    const applied = await applyMerges(projectId);
    return (
      applied.find((entry) => entry.mergeId === created.mergeId) ??
      service.getMerge(projectId, created.mergeId)
    );
  }

  async function executeMerge(
    projectId: string,
    config: MergeConfig,
    merge: DevelopmentMerge
  ): Promise<DevelopmentMerge> {
    const service = await gateway();
    let current = merge;
    const update = (patch: Record<string, unknown>) =>
      service.updateMerge(projectId, current.mergeId, {
        expectedRevision: current.revision,
        ...patch
      });
    try {
      const reasons = await acceptanceReasons(projectId, merge);
      if (reasons.length)
        return await update({
          state: "check_failed",
          reasons,
          detail: "合入前复核验收未通过；旧候选或旧审查不能批准当前版本"
        });
      for (let attempt = 0; attempt < mergeAttempts; attempt += 1) {
        const combined = await mergeCandidate({
          repository: config.repository,
          directory: mergeSite(merge.mergeId),
          targetBranch: merge.targetBranch,
          candidate: merge.candidate.commit
        });
        if (combined.status === "conflict") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "conflict",
            reasons: [],
            detail: `目标分支与候选存在 Git 冲突：${combined.paths.join("、")}`
          });
        }
        if (combined.status === "failed") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({ state: "failed", reasons: [], detail: combined.detail });
        }
        const results = await runMergeChecks(mergeSite(merge.mergeId), merge.checks);
        const failed = results.filter((check) => check.exitCode !== 0);
        if (failed.length) {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "check_failed",
            checks: results,
            reasons: [],
            detail: `组合版本检查未通过：${failed.map((check) => check.name).join("、")}`
          });
        }
        // Persist the combined base, the commit about to be published and the
        // real receipts before the ref moves; that is the recovery identity.
        current = await update({
          checks: results,
          reasons: [],
          detail: null,
          combinedBase: combined.baseCommit,
          expectedTarget: combined.baseCommit,
          mergeCommit: combined.mergeCommit
        });
        const published = await publishMerge({
          repository: config.repository,
          targetBranch: current.targetBranch,
          mergeCommit: combined.mergeCommit,
          expectedTarget: combined.baseCommit
        });
        if (published.status === "moved") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          current = await update({
            reasons: ["target_moved"],
            combinedBase: null,
            expectedTarget: null,
            mergeCommit: null
          });
          continue;
        }
        if (published.status === "blocked") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "conflict",
            reasons: ["target_worktree_blocked"],
            detail: published.detail
          });
        }
        // The target now contains this commit. Keep the local fact before any
        // shared write: if the shared store is unreachable, the delivery and
        // the merged record are completed later from this entry and Git.
        const intent = intentOf(current);
        if (intent) await deliveryOutbox.put(intent).catch(() => undefined);
        afterApply(current);
        await removeMergeSite(config.repository, mergeSite(merge.mergeId));
        let merged: DevelopmentMerge;
        try {
          merged = await update({ state: "merged", reasons: [], detail: null });
        } catch {
          // The real Git update is done and the staged row still names it, so
          // the Run is not blocked by a record that cannot be written now.
          return current;
        }
        // The ledger/board are a separate shared write; a failure leaves the
        // delivery pending and visible instead of turning the merge failed.
        await syncDelivery(projectId, merged).catch(() => undefined);
        return merged;
      }
      return await update({
        state: "failed",
        reasons: ["target_moved"],
        detail: "目标分支在合入期间持续前移，稍后重新申请合入",
        combinedBase: null,
        expectedTarget: null,
        mergeCommit: null
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed = await service
        .updateMerge(projectId, merge.mergeId, {
          expectedRevision: current.revision,
          state: "failed",
          reasons: ["merge_failed"],
          detail
        })
        .catch(() => undefined);
      return failed ?? service.getMerge(projectId, merge.mergeId);
    }
  }

  /**
   * Resolve an operation a previous process left `applying`.
   *
   * Its own row says which commit it staged and which target it expected; the
   * actual branch decides what happened. If the target already points at the
   * staged commit, only the record is missing. If the target still equals the
   * expectation, the compare-and-swap never ran, so publishing the same commit
   * is safe. Anything else means the target advanced; the attempt is requeued.
   */
  async function reconcileApplying(
    projectId: string,
    config: MergeConfig,
    merge: DevelopmentMerge
  ): Promise<DevelopmentMerge> {
    const service = await gateway();
    const update = (patch: Record<string, unknown>) =>
      service.updateMerge(projectId, merge.mergeId, {
        expectedRevision: merge.revision,
        ...patch
      });
    try {
      const tip = await targetTip(config.repository, merge.targetBranch);
      if (!tip)
        return await update({
          state: "failed",
          reasons: ["target_missing"],
          detail: `目标分支 ${merge.targetBranch} 不存在`
        });
      // The target may already contain the staged commit: either it moved to
      // exactly that commit, or another update landed on top of it. In both
      // cases only the record is missing, so the same receipt is completed
      // instead of merging the candidate a second time.
      if (merge.mergeCommit && (await isAncestor(config.repository, merge.mergeCommit, tip))) {
        await removeMergeSite(config.repository, mergeSite(merge.mergeId));
        return await update({ state: "merged", reasons: [], detail: null });
      }
      if (merge.mergeCommit && merge.expectedTarget && tip === merge.expectedTarget) {
        const published = await publishMerge({
          repository: config.repository,
          targetBranch: merge.targetBranch,
          mergeCommit: merge.mergeCommit,
          expectedTarget: merge.expectedTarget
        });
        if (published.status === "updated") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({ state: "merged", reasons: [], detail: null });
        }
        if (published.status === "blocked") {
          await removeMergeSite(config.repository, mergeSite(merge.mergeId));
          return await update({
            state: "conflict",
            reasons: ["target_worktree_blocked"],
            detail: published.detail
          });
        }
      }
      await removeMergeSite(config.repository, mergeSite(merge.mergeId));
      return await update({
        state: "waiting",
        reasons: ["target_moved"],
        detail: "目标已前移；在最新目标上重新验证组合版本",
        combinedBase: null,
        expectedTarget: null,
        mergeCommit: null
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return await update({
        state: "failed",
        reasons: ["merge_reconcile_failed"],
        detail
      }).catch(() => merge);
    }
  }

  // ---- delivery synchronization ------------------------------------------------
  // A merge is done when the target branch contains its commit; delivery is a
  // separate shared write. The outbox below keeps that write retryable on the
  // host that published it, so a shared-store outage or restart completes it
  // later without a second development or merge.

  const deliveryReplays = new Map<string, Promise<DevelopmentMerge[]>>();

  /** Apply one merged operation's receipt to the ledger and board. */
  async function syncDelivery(
    projectId: string,
    merge: DevelopmentMerge
  ): Promise<DevelopmentDelivery | undefined> {
    const receipt = deliveryFromMerge(merge);
    if (!receipt) return undefined;
    try {
      const delivery = await (await gateway()).syncDelivery(projectId, receipt);
      if (delivery.state === "synced")
        await deliveryOutbox.remove(projectId, merge.mergeId).catch(() => undefined);
      return delivery;
    } catch (error) {
      await deliveryOutbox
        .fail(projectId, merge.mergeId, error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
      throw error;
    }
  }

  /** Retry the latest merged operation of one development from its persisted receipt. */
  async function retryDevelopmentDelivery(
    projectId: string,
    developmentIdValue: unknown
  ): Promise<DevelopmentDelivery> {
    await project(projectId);
    const developmentId = developmentIdentifier(developmentIdValue, "开发记录 ID");
    await replayDeliveries(projectId);
    const service = await gateway();
    const merge = [...(await service.queryMerges(projectId, developmentId))]
      .reverse()
      .find((entry) => entry.state === "merged" || entry.state === "applying" || entry.state === "waiting");
    if (!merge || merge.state !== "merged")
      throw conflict("合入尚未完成，稍后重试交付同步", "delivery_not_merged");
    const delivery = await syncDelivery(projectId, merge);
    if (!delivery) throw conflict("该合入没有可同步的回执", "delivery_not_merged");
    return delivery;
  }

  function intentOf(merge: DevelopmentMerge): DeliveryIntent | undefined {
    if (!merge.mergeCommit) return undefined;
    const timestamp = now();
    return {
      projectId: merge.projectId,
      mergeId: merge.mergeId,
      developmentId: merge.developmentId,
      requirementId: merge.requirementId,
      candidateCommit: merge.candidate.commit,
      mergedCommit: merge.mergeCommit,
      targetBranch: merge.targetBranch,
      mergedAt: timestamp,
      ...(merge.expectedTarget ? { expectedTarget: merge.expectedTarget } : {}),
      ...(merge.combinedBase ? { combinedBase: merge.combinedBase } : {}),
      publishedAt: timestamp
    };
  }

  /**
   * Resolve one locally published operation against the shared row and Git.
   *
   * The outbox entry exists only after the target accepted this commit, so a
   * row still `applying` (even when its owner is this process) can be completed
   * from the local fact instead of waiting for a restart. A row that no longer
   * matches is dropped rather than applied to another operation.
   */
  async function resumeDeliveryIntent(
    projectId: string,
    config: MergeConfig | undefined,
    intent: DeliveryIntent
  ): Promise<DevelopmentMerge | undefined> {
    const service = await gateway();
    let merge = await service.getMerge(projectId, intent.mergeId).catch(() => undefined);
    if (!merge) return undefined;
    // The outbox belongs to the backend that published the operation; another
    // backend reading the same data root must not complete or drop it.
    if (merge.executionBackendId !== ports.backendId) return undefined;
    if (merge.state === "merged") {
      await syncDelivery(projectId, merge).catch(() => undefined);
      return merge;
    }
    if (merge.state === "applying") {
      if (!config) return undefined;
      let applying: DevelopmentMerge = merge;
      if (!applying.mergeCommit) {
        const updated = await service
          .updateMerge(projectId, applying.mergeId, {
            expectedRevision: applying.revision,
            mergeCommit: intent.mergedCommit,
            expectedTarget: intent.expectedTarget ?? applying.combinedBase ?? null,
            ...(intent.combinedBase && !applying.combinedBase ? { combinedBase: intent.combinedBase } : {})
          })
          .catch(() => undefined);
        if (updated) applying = updated;
      }
      const reconciled = await reconcileApplying(projectId, config, applying);
      if (reconciled.state === "merged") {
        await syncDelivery(projectId, reconciled).catch(() => undefined);
        return reconciled;
      }
      if (
        reconciled.state === "waiting" ||
        (reconciled.state === "failed" && reconciled.reasons.includes("target_missing"))
      )
        await deliveryOutbox.remove(projectId, intent.mergeId).catch(() => undefined);
      return reconciled.state === "waiting" ? undefined : reconciled;
    }
    // Any other state means the record did not finish as `merged`. The actual
    // branch still decides: a later failure can have overwritten a staged
    // attempt even though the commit reached the target. Without the merge
    // configuration the repository is unknown, so keep the local fact for a
    // later read instead of dropping it.
    if (!config) return undefined;
    const tip = await targetTip(config.repository, merge.targetBranch).catch(() => undefined);
    if (tip && (await isAncestor(config.repository, intent.mergedCommit, tip).catch(() => false))) {
      const updated = await service
        .updateMerge(projectId, merge.mergeId, {
          expectedRevision: merge.revision,
          state: "merged",
          reasons: [],
          detail: null,
          mergeCommit: intent.mergedCommit
        })
        .catch(() => undefined);
      if (updated) {
        await syncDelivery(projectId, updated).catch(() => undefined);
        return updated;
      }
      return undefined;
    }
    // The commit is not on the target: this outbox entry is stale and must not
    // turn into a delivery.
    await deliveryOutbox.remove(projectId, intent.mergeId).catch(() => undefined);
    return undefined;
  }

  /**
   * Complete locally published deliveries and any merged row still missing its
   * delivery. Called before reads and applies, so a recovered shared service is
   * caught up automatically on the next access; failures stay pending instead
   * of breaking the read.
   */
  async function replayDeliveries(projectId: string): Promise<DevelopmentMerge[]> {
    const running = deliveryReplays.get(projectId);
    if (running) return running;
    const resolved = new Map<string, DevelopmentMerge>();
    const task = (async () => {
      try {
        const service = await gateway();
        const config = await service.mergeConfig(projectId).catch(() => undefined);
        for (const intent of await deliveryOutbox.list(projectId)) {
          const resumed = await resumeDeliveryIntent(projectId, config, intent).catch(() => undefined);
          if (resumed) resolved.set(resumed.mergeId, resumed);
        }
        // Only the backend that published an operation completes its merged
        // row: the pending fact and the checkout belong to that host, and
        // another backend's read must not claim its delivery on its behalf.
        for (const merge of await service.queryMerges(projectId)) {
          if (merge.state !== "merged" || merge.executionBackendId !== ports.backendId) continue;
          if (resolved.has(merge.mergeId)) continue;
          const deliveries = await service.queryDeliveries(projectId, merge.developmentId);
          if (deliveries.some((entry) => entry.mergeId === merge.mergeId && entry.state === "synced"))
            continue;
          const delivery = await syncDelivery(projectId, merge).catch(() => undefined);
          if (delivery?.state === "synced") resolved.set(merge.mergeId, merge);
        }
      } catch {
        // An unreachable shared store leaves the outbox and merged rows intact;
        // the next read or apply retries them.
      } finally {
        deliveryReplays.delete(projectId);
      }
      return [...resolved.values()];
    })();
    deliveryReplays.set(projectId, task);
    return task;
  }

  async function applyMerges(projectId: string): Promise<DevelopmentMerge[]> {
    await project(projectId);
    const config = await requiredMergeConfig(projectId);
    if (config.executionBackendId !== ports.backendId)
      throw conflict(
        `该项目合入归属后端 ${config.executionBackendId}，当前后端不能更新目标分支`,
        "project_git_owner_mismatch"
      );
    return serialized(projectId, async () => {
      const service = await gateway();
      // This host's own published operations come first: an interrupted or
      // unreachable shared record is completed from the local fact, including
      // when the interruption happened in this same process.
      const processed: DevelopmentMerge[] = await replayDeliveries(projectId);
      const recorded = new Set(processed.map((entry) => entry.mergeId));
      const remember = (entry: DevelopmentMerge) => {
        if (recorded.has(entry.mergeId)) return;
        recorded.add(entry.mergeId);
        processed.push(entry);
      };
      // Reconcile next: a previous process of this backend may have died
      // between the Git update and its record. A shared read that fails after
      // an operation already ran returns that result instead of hiding it.
      let known: DevelopmentMerge[];
      try {
        known = await service.queryMerges(projectId);
      } catch (error) {
        if (processed.length) return processed;
        throw error;
      }
      for (const entry of known) {
        if (entry.state !== "applying") continue;
        if (entry.executionBackendId !== ports.backendId) continue;
        if (entry.ownerStartedAt === startedAt) continue;
        const reconciled = await reconcileApplying(projectId, config, entry);
        // A requeued operation is claimed below; only a terminal reconciliation
        // is its result for this call.
        if (reconciled.state !== "waiting") remember(reconciled);
      }
      for (;;) {
        let waiting: DevelopmentMerge[];
        try {
          waiting = (await service.queryMerges(projectId)).filter((entry) => entry.state === "waiting");
        } catch (error) {
          if (processed.length) break;
          throw error;
        }
        const next = waiting[0];
        if (!next) break;
        let claimed: DevelopmentMerge;
        try {
          claimed = await service.claimMerge(projectId, next.mergeId, {
            expectedRevision: next.revision,
            ownerStartedAt: startedAt
          });
        } catch (error) {
          // Another process owns the project's update window (or this one
          // changed underneath us); its own run will record the result.
          if (
            error instanceof ProjectDataConflictError &&
            (error.code === "merge_busy" || error.code === "merge_not_claimable")
          )
            break;
          throw error;
        }
        remember(await executeMerge(projectId, config, claimed));
      }
      return processed;
    });
  }

  // ---- delivery read model -----------------------------------------------------

  /** The committed change between the baseline and the candidate this host holds. */
  async function deliveryDiff(record: DevelopmentRecord): Promise<DeliveryDiff | undefined> {
    const workspace = record.workspace;
    if (!workspace || workspace.state !== "ready") return undefined;
    try {
      const head = await git(workspace.directory, ["rev-parse", "HEAD"]);
      const raw = await git(workspace.directory, ["diff", "--numstat", `${record.baseline.commit}..${head}`]);
      const files = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [additions, deletions, ...path] = line.split("\t");
          return {
            path: path.join("\t"),
            additions: /^\d+$/.test(additions ?? "") ? Number(additions) : 0,
            deletions: /^\d+$/.test(deletions ?? "") ? Number(deletions) : 0
          };
        })
        .filter((file) => Boolean(file.path));
      return { base: record.baseline.commit, head, files };
    } catch {
      // A checkout this host no longer has cannot produce a diff; the shared
      // commits and checks above remain readable without pretending otherwise.
      return undefined;
    }
  }

  /**
   * Role progress from the durable work item and its review facts.
   *
   * A role is read from the recorded Executor author / Reviewer binding, never
   * from a model report. The work item's own status is used when this host still
   * has it; otherwise the recorded review state is the fallback.
   */
  async function deliveryRoles(
    record: DevelopmentRecord,
    reviews: DevelopmentReview[]
  ): Promise<DeliveryRoleProgress[]> {
    const known = async (callId: string): Promise<string | undefined> => {
      if (!record.taskId || !ports.call) return undefined;
      const fact = await ports.call(record.taskId, callId).catch(() => undefined);
      return fact?.status;
    };
    const roles: DeliveryRoleProgress[] = [];
    const seen = new Set<string>();
    const push = async (input: Omit<DeliveryRoleProgress, "state">, fallback: string) => {
      if (!input.callId || seen.has(`${input.role}:${input.callId}`)) return;
      seen.add(`${input.role}:${input.callId}`);
      roles.push({ ...input, state: (await known(input.callId)) ?? fallback });
    };
    const author = [...reviews].reverse().find((review) => review.author)?.author;
    if (author)
      await push(
        { role: "executor", callId: author.callId, agentId: author.agentId, workspace: author.workspace },
        "candidate_frozen"
      );
    for (const review of reviews)
      for (const rework of review.reworks)
        await push(
          {
            role: "executor",
            callId: rework.continuationCallId,
            agentId: rework.agentId,
            ...(rework.workspace ? { workspace: rework.workspace } : {})
          },
          "rework_recorded"
        );
    const latest = reviews.at(-1);
    if (latest?.reviewer)
      await push(
        {
          role: "reviewer",
          callId: latest.reviewer.callId,
          agentId: latest.reviewer.agentId,
          workspace: latest.reviewer.workspace
        },
        latest.state
      );
    return roles;
  }

  function deliveryStage(
    merges: DevelopmentMerge[],
    reviews: DevelopmentReview[],
    delivery: DevelopmentDelivery | undefined
  ): DeliveryStage {
    if (delivery?.state === "synced") return "delivered";
    if (delivery?.state === "pending" || merges.some((merge) => merge.state === "merged")) return "merged";
    if (merges.some((merge) => merge.state === "waiting" || merge.state === "applying"))
      return "merge_pending";
    if (reviews.at(-1)?.state === "in_review") return "reviewing";
    return "developing";
  }

  /**
   * The delivery view one project, Task or requirement can read.
   *
   * It reuses the authoritative records and only adds what a reader needs to
   * follow the delivery: the phase, role progress, the committed diff this host
   * can read, the merge receipt and its synchronization state, and the board
   * projection (present only for an external demand).
   */
  async function deliveryView(
    projectId: string,
    input: { developmentId?: unknown; requirementId?: unknown }
  ): Promise<DeliveryView> {
    await project(projectId);
    const developmentId =
      input.developmentId === undefined || input.developmentId === null
        ? undefined
        : developmentIdentifier(input.developmentId, "开发记录 ID");
    const requirementId =
      input.requirementId === undefined || input.requirementId === null
        ? undefined
        : developmentIdentifier(input.requirementId, "需求 ID");
    if (!developmentId && !requirementId)
      throw conflict("交付视图需要 developmentId 或 requirementId", "delivery_view_target_missing");
    await replayDeliveries(projectId).catch(() => undefined);
    const service = await gateway();
    const record = developmentId
      ? await service.getDevelopment(projectId, developmentId, ports.backendId)
      : await service.findDevelopmentByRequirement(projectId, requirementId!, ports.backendId);
    if (!record) throw new ProjectDataNotFoundError("该需求还没有开发记录");
    const [plan, reviews, merges, deliveries, boardEntries] = await Promise.all([
      service.reviewPlan(projectId, record.developmentId),
      service.queryReviews(projectId, record.developmentId),
      service.queryMerges(projectId, record.developmentId),
      service.queryDeliveries(projectId, record.developmentId),
      service.boardEntries(projectId)
    ]);
    const delivery = deliveries.at(-1);
    const board = boardEntries.find((entry) => entry.requirementId === record.requirementId);
    const qualification = await deliveryQualification(projectId, record.developmentId).catch(() => undefined);
    const diff = await deliveryDiff(record);
    const roles = await deliveryRoles(record, reviews);
    const pending = [...(await deliveryOutbox.list(projectId).catch(() => []))]
      .reverse()
      .find((intent) => intent.developmentId === record.developmentId);
    const latestMerged = [...merges].reverse().find((merge) => merge.state === "merged");
    const waitingSync = pending
      ? {
          mergeId: pending.mergeId,
          ...(pending.error ? { error: pending.error } : {})
        }
      : !delivery && latestMerged
        ? { mergeId: latestMerged.mergeId }
        : undefined;
    return {
      projectId,
      development: record,
      stage: deliveryStage(merges, reviews, delivery),
      ...(plan ? { plan } : {}),
      reviews,
      ...(qualification ? { qualification } : {}),
      merges,
      ...(delivery ? { delivery } : {}),
      ...(board ? { board } : {}),
      ...(diff ? { diff } : {}),
      roles,
      ...(waitingSync ? { pendingSync: waitingSync } : {})
    };
  }

  return {
    async mergeConfig(projectId: string) {
      await project(projectId);
      return (await gateway()).mergeConfig(projectId);
    },

    async setMergeConfig(projectId: string, input: MergeConfigInput) {
      await project(projectId);
      const repository = mergeRepository(input.repository);
      const targetBranch = mergeTargetBranch(input.targetBranch);
      const executionBackendId =
        input.executionBackendId === undefined
          ? undefined
          : mergeExecutionBackendId(input.executionBackendId);
      await resolveDevelopmentBaseline({ repository, branch: targetBranch });
      return (await gateway()).setMergeConfig(
        projectId,
        { repository, targetBranch, executionBackendId },
        ports.backendId
      );
    },

    async list(projectId: string, backendId = ports.backendId) {
      await project(projectId);
      await replayDeliveries(projectId).catch(() => undefined);
      return (await gateway()).queryDevelopments(projectId, backendId);
    },

    async listForTask(taskId: string, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      await replayDeliveries(found.projectId).catch(() => undefined);
      return (await gateway()).queryDevelopments(found.projectId, backendId);
    },

    async get(projectId: string, developmentId: string, backendId = ports.backendId) {
      await project(projectId);
      await replayDeliveries(projectId).catch(() => undefined);
      return (await gateway()).getDevelopment(projectId, developmentId, backendId);
    },

    async getForTask(taskId: string, developmentId: string, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      await replayDeliveries(found.projectId).catch(() => undefined);
      return (await gateway()).getDevelopment(found.projectId, developmentId, backendId);
    },

    async find(projectId: string, requirementId: unknown, backendId = ports.backendId) {
      await project(projectId);
      await replayDeliveries(projectId).catch(() => undefined);
      return (await gateway()).findDevelopmentByRequirement(projectId, requirementId, backendId);
    },

    async findForTask(taskId: string, requirementId: unknown, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      await replayDeliveries(found.projectId).catch(() => undefined);
      return (await gateway()).findDevelopmentByRequirement(found.projectId, requirementId, backendId);
    },

    /** Delivery rows for a project or one development; a pending row is readable with its error. */
    async deliveries(projectId: string, developmentId?: unknown) {
      await project(projectId);
      await replayDeliveries(projectId).catch(() => undefined);
      return (await gateway()).queryDeliveries(
        projectId,
        developmentId === undefined ? undefined : developmentIdentifier(developmentId, "开发记录 ID")
      );
    },

    async deliveriesForTask(taskId: string, developmentId?: unknown) {
      const found = await taskProject(taskId);
      await replayDeliveries(found.projectId).catch(() => undefined);
      return (await gateway()).queryDeliveries(
        found.projectId,
        developmentId === undefined ? undefined : developmentIdentifier(developmentId, "开发记录 ID")
      );
    },

    async getDelivery(projectId: string, deliveryId: string) {
      await project(projectId);
      return (await gateway()).getDelivery(projectId, deliveryId);
    },

    async getDeliveryForTask(taskId: string, deliveryId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).getDelivery(found.projectId, deliveryId);
    },

    /** Retry a pending delivery from its persisted receipt; safe to click repeatedly. */
    async retryDelivery(projectId: string, deliveryId: string) {
      await project(projectId);
      return (await gateway()).retryDelivery(projectId, deliveryId);
    },

    async retryDeliveryForTask(taskId: string, deliveryId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).retryDelivery(found.projectId, deliveryId);
    },

    /** Retry by development, for a local fact that never reached the shared row. */
    async retryDevelopmentDelivery(projectId: string, developmentId: string) {
      return retryDevelopmentDelivery(projectId, developmentId);
    },

    async retryDevelopmentDeliveryForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return retryDevelopmentDelivery(found.projectId, developmentId);
    },

    /** One startup pass over this host's persisted facts; failures stay pending. */
    async resumeDeliveries() {
      for (const projectId of await deliveryOutbox.projects().catch(() => []))
        await replayDeliveries(projectId).catch(() => undefined);
    },

    async deliveryView(projectId: string, input: Record<string, unknown>) {
      return deliveryView(projectId, input);
    },

    async deliveryViewForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return deliveryView(found.projectId, input);
    },

    /** Record the receipt a remote execution backend produced for a real merge. */
    async recordDelivery(projectId: string, receipt: unknown, backendId: string) {
      await project(projectId);
      const value = deliveryReceipt(receipt);
      const merge = await (await gateway()).getMerge(projectId, value.mergeId);
      if (merge.executionBackendId !== backendId)
        throw conflict(`合入操作归属后端 ${merge.executionBackendId}`, "delivery_owner_mismatch");
      return (await gateway()).syncDelivery(projectId, value);
    },

    async recordWorkspace(projectId: string, developmentId: string, workspace: unknown) {
      await project(projectId);
      return (await gateway()).recordDevelopmentWorkspace(projectId, developmentId, workspace);
    },

    async create(projectId: string, input: DevelopmentCreate) {
      return create(projectId, input);
    },

    async createForTask(taskId: string, input: DevelopmentCreate) {
      const found = await taskProject(taskId);
      return create(found.projectId, input, taskId);
    },

    update(projectId: string, developmentId: string, input: DevelopmentUpdate, backendId = ports.backendId) {
      return gateway().then((service) =>
        service.updateDevelopment(projectId, developmentId, input, backendId)
      );
    },

    async updateForTask(
      taskId: string,
      developmentId: string,
      input: DevelopmentUpdate,
      backendId = ports.backendId
    ) {
      const found = await taskProject(taskId);
      return (await gateway()).updateDevelopment(found.projectId, developmentId, input, backendId);
    },

    /** Record a shared merge entry that the caller already validated on its own host. */
    async recordMergeConfig(projectId: string, input: MergeConfigInput, backendId: string) {
      // The data authority only checks the shared project; the execution owner
      // checked the repository path and branch where they actually exist.
      return (await gateway()).setMergeConfig(projectId, input, backendId);
    },

    /** Record a shared development fact without preparing any checkout here. */
    async record(projectId: string, input: DevelopmentCreate) {
      return (await gateway()).createDevelopment(projectId, input);
    },

    /**
     * Continue an existing workspace: return it when it is still the recorded
     * checkout, otherwise prepare it again at the recorded baseline. A failure
     * is written to the record instead of replacing what was there.
     */
    async ensureWorkspace(projectId: string, developmentId: string) {
      return ensureWorkspace(projectId, developmentId);
    },

    async ensureWorkspaceForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return ensureWorkspace(found.projectId, developmentId);
    },

    // ---- review actions --------------------------------------------------------
    async reviewPlan(projectId: string, developmentId: string) {
      await project(projectId);
      return (await gateway()).reviewPlan(projectId, developmentId);
    },

    async reviewPlanForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).reviewPlan(found.projectId, developmentId);
    },

    async setReviewPlan(projectId: string, input: Record<string, unknown>) {
      return setReviewPlan(projectId, input);
    },

    async setReviewPlanForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return setReviewPlan(found.projectId, input);
    },

    async startReview(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
      return startReview(projectId, taskId, input);
    },

    async startReviewForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return startReview(found.projectId, taskId, input);
    },

    async attachReviewer(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
      return attachReviewer(projectId, taskId, input);
    },

    async attachReviewerForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return attachReviewer(found.projectId, taskId, input);
    },

    async recordFinding(projectId: string, input: Record<string, unknown>) {
      return recordFinding(projectId, input);
    },

    async recordFindingForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return recordFinding(found.projectId, input);
    },

    async ruleFinding(projectId: string, input: Record<string, unknown>) {
      return ruleFinding(projectId, input);
    },

    async ruleFindingForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return ruleFinding(found.projectId, input);
    },

    async recordRework(projectId: string, taskId: string | undefined, input: Record<string, unknown>) {
      return recordRework(projectId, taskId, input);
    },

    async recordReworkForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return recordRework(found.projectId, taskId, input);
    },

    async completeReview(projectId: string, input: Record<string, unknown>) {
      return completeReview(projectId, input);
    },

    async completeReviewForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return completeReview(found.projectId, input);
    },

    async delivery(projectId: string, developmentId: string) {
      return deliveryQualification(projectId, developmentId);
    },

    async deliveryForTask(taskId: string, developmentId: string) {
      const found = await taskProject(taskId);
      return deliveryQualification(found.projectId, developmentId);
    },

    async queryReviews(projectId: string, developmentId?: string) {
      await project(projectId);
      return (await gateway()).queryReviews(projectId, developmentId);
    },

    async queryReviewsForTask(taskId: string, developmentId?: string) {
      const found = await taskProject(taskId);
      return (await gateway()).queryReviews(found.projectId, developmentId);
    },

    async getReview(projectId: string, reviewId: string) {
      await project(projectId);
      return (await gateway()).getReview(projectId, reviewId);
    },

    async getReviewForTask(taskId: string, reviewId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).getReview(found.projectId, reviewId);
    },

    // ---- project merge actions -------------------------------------------------
    async requestMerge(projectId: string, input: Record<string, unknown>) {
      return requestMerge(projectId, input);
    },

    async requestMergeForTask(taskId: string, input: Record<string, unknown>) {
      const found = await taskProject(taskId);
      return requestMerge(found.projectId, input);
    },

    async applyMerges(projectId: string) {
      return applyMerges(projectId);
    },

    async applyMergesForTask(taskId: string) {
      const found = await taskProject(taskId);
      return applyMerges(found.projectId);
    },

    async queryMerges(projectId: string, developmentId?: string) {
      await project(projectId);
      await replayDeliveries(projectId).catch(() => undefined);
      return (await gateway()).queryMerges(projectId, developmentId);
    },

    async queryMergesForTask(taskId: string, developmentId?: string) {
      const found = await taskProject(taskId);
      await replayDeliveries(found.projectId).catch(() => undefined);
      return (await gateway()).queryMerges(found.projectId, developmentId);
    },

    async getMerge(projectId: string, mergeId: string) {
      await project(projectId);
      return (await gateway()).getMerge(projectId, mergeId);
    },

    async getMergeForTask(taskId: string, mergeId: string) {
      const found = await taskProject(taskId);
      return (await gateway()).getMerge(found.projectId, mergeId);
    },

    /**
     * Record the operation a remote backend qualified on its own host. The
     * authority stores the shared row from the configured entry; it never runs
     * Git or trusts a request body's repository or target.
     */
    async recordMerge(projectId: string, developmentId: unknown, input: unknown, backendId: string) {
      await project(projectId);
      const config = await requiredMergeConfig(projectId);
      const value =
        input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      const checks = mergeCheckCommands(value.checks);
      if (!checks.length) throw conflict("合入须记录在组合版本上运行的检查命令", "merge_checks_missing");
      return (await gateway()).createMerge(projectId, developmentId, {
        candidate: reviewCandidate(value.candidate),
        acceptance: mergeAcceptance(value.acceptance),
        checks,
        requestedBy: backendId,
        executionBackendId: config.executionBackendId,
        targetBranch: config.targetBranch
      });
    },

    async recordMergeClaim(projectId: string, mergeId: unknown, input: unknown, backendId: string) {
      const id = developmentIdentifier(mergeId, "合入操作 ID");
      const merge = await (await gateway()).getMerge(projectId, id);
      if (merge.executionBackendId !== backendId)
        throw conflict(`合入操作归属后端 ${merge.executionBackendId}`, "merge_owner_mismatch");
      return (await gateway()).claimMerge(projectId, id, input);
    },

    async recordMergeUpdate(projectId: string, mergeId: unknown, input: unknown, backendId: string) {
      const id = developmentIdentifier(mergeId, "合入操作 ID");
      const merge = await (await gateway()).getMerge(projectId, id);
      if (merge.executionBackendId !== backendId)
        throw conflict(`合入操作归属后端 ${merge.executionBackendId}`, "merge_owner_mismatch");
      return (await gateway()).updateMerge(projectId, id, input);
    },

    /**
     * Record a fact the caller already validated on the host that owns the
     * checkout. The data authority stores reviews but never runs Git or reads
     * another host's work items.
     */
    async recordReviewPlan(projectId: string, developmentId: unknown, input: unknown) {
      await project(projectId);
      return (await gateway()).setReviewPlan(projectId, developmentId, input);
    },

    async recordReview(projectId: string, developmentId: unknown, input: unknown) {
      await project(projectId);
      return (await gateway()).createReview(projectId, developmentId, input);
    },

    async recordReviewUpdate(projectId: string, reviewId: unknown, input: unknown) {
      await project(projectId);
      return (await gateway()).updateReview(projectId, reviewId, input);
    }
  };
}

export type ProjectDevelopmentService = ReturnType<typeof createProjectDevelopmentService>;
