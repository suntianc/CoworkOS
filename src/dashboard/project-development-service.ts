import { dirname, join, resolve } from "node:path";
import {
  dismissalCategory,
  reviewBasis,
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
  /** Where isolated checkouts live, outside every user working copy. */
  developmentRoot: string;
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

  async function requiredMergeConfig(projectId: string): Promise<MergeConfig> {
    const config = await (await gateway()).mergeConfig(projectId);
    if (!config)
      throw new ProjectDataConflictError(
        "项目合入配置缺失：请先设置 repository、targetBranch 与 executionBackendId",
        undefined,
        "project_git_missing"
      );
    if (config.executionBackendId !== ports.backendId)
      throw new ProjectDataConflictError(
        `该项目的合入配置归属后端 ${config.executionBackendId}，当前后端不能准备需求现场`,
        undefined,
        "project_git_owner_mismatch"
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
    if (config.executionBackendId !== ports.backendId)
      return markFailed(
        projectId,
        record,
        directory,
        branch,
        `该项目的合入配置归属后端 ${config.executionBackendId}，当前后端不能继续需求现场`
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
      return (await gateway()).queryDevelopments(projectId, backendId);
    },

    async listForTask(taskId: string, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      return (await gateway()).queryDevelopments(found.projectId, backendId);
    },

    async get(projectId: string, developmentId: string, backendId = ports.backendId) {
      await project(projectId);
      return (await gateway()).getDevelopment(projectId, developmentId, backendId);
    },

    async getForTask(taskId: string, developmentId: string, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      return (await gateway()).getDevelopment(found.projectId, developmentId, backendId);
    },

    async find(projectId: string, requirementId: unknown, backendId = ports.backendId) {
      await project(projectId);
      return (await gateway()).findDevelopmentByRequirement(projectId, requirementId, backendId);
    },

    async findForTask(taskId: string, requirementId: unknown, backendId = ports.backendId) {
      const found = await taskProject(taskId);
      return (await gateway()).findDevelopmentByRequirement(found.projectId, requirementId, backendId);
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
