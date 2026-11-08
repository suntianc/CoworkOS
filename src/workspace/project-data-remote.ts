import {
  type BoardActor,
  type BoardAction,
  type BoardActionContext,
  type BoardActionInput,
  type BoardEntry,
  type BoardEvent,
  type BoardPublishInput
} from "../domain/project-board.js";
import {
  ProjectDataAuthError,
  ProjectDataConflictError,
  ProjectDataError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError,
  ProjectDataUnavailableError,
  ledgerProjectDirectory,
  ledgerProjectId,
  ledgerProjectName,
  type ProjectIdentity
} from "../domain/project-ledger.js";
import type {
  MainSessionRecord,
  ProjectDataBackup,
  ProjectDataDescription,
  ProjectDataGateway,
  ProjectDataRestore,
  DevelopmentCreate,
  DevelopmentUpdate,
  MergeConfigInput,
  RequirementCreate,
  RequirementQuery,
  RequirementUpdate
} from "./project-data-service.js";
import { DevelopmentExistsError } from "../domain/project-development.js";
import type { DevelopmentRecord, MergeConfig } from "../domain/project-development.js";
import type { DevelopmentReview, ReviewPlan } from "../domain/development-review.js";
import type { DevelopmentMerge, MergeCreate } from "../domain/development-merge.js";
import type { DevelopmentDelivery } from "../domain/development-delivery.js";
import type { MainSessionRun } from "../domain/main-session.js";
import type { RequirementDetail, RequirementSummary, SharedProject } from "../domain/project-ledger.js";

export interface RemoteProjectDataOptions {
  /** The authority's origin, without a path. */
  url: string;
  /** Host credential used once to authorize this client's session. */
  token: string;
  /** This backend's stable id; a namespace, never a Task id or directory. */
  backendId: string;
  source: string;
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 10_000;
const BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProjectDataInvalidError("共享项目数据服务地址无效");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new ProjectDataInvalidError("共享项目数据服务地址只接受协议、主机和端口");
  return parsed.origin;
}

function projectPath(projectId: unknown, suffix: string): string {
  return `/api/projects/${encodeURIComponent(ledgerProjectId(projectId))}${suffix}`;
}

/**
 * The authenticated client a secondary backend uses for shared project data.
 *
 * One host credential authorizes one local session at startup; every later
 * request presents that session. A revoked session or an unreachable authority
 * is reported as an explicit error and never retried with the host credential,
 * so a failed claim cannot be shown as a success or transferred silently.
 */
export class RemoteProjectDataService implements ProjectDataGateway {
  readonly description: ProjectDataDescription;
  private readonly origin: string;
  private readonly token: string;
  private readonly backendId: string;
  private readonly fetchImpl: typeof fetch;

  private constructor(
    options: RemoteProjectDataOptions,
    sessionToken: string,
    description: ProjectDataDescription
  ) {
    this.origin = originOf(options.url);
    this.token = sessionToken;
    this.backendId = options.backendId;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.description = description;
  }

  /** Authorize, then read the authority's engine/version; failure refuses startup. */
  static async open(options: RemoteProjectDataOptions): Promise<RemoteProjectDataService> {
    const origin = originOf(options.url);
    if (!BACKEND_ID.test(options.backendId))
      throw new ProjectDataInvalidError("当前后端身份不合法，不能连接共享项目数据服务");
    const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    const session = await callAsAuthority(fetchImpl, origin, "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-atria-token": options.token },
      body: JSON.stringify({ clientName: "project-data-client", protocolVersion: "1.0" })
    });
    const sessionToken = (session.session as { token?: unknown } | undefined)?.token;
    if (typeof sessionToken !== "string" || !sessionToken)
      throw new ProjectDataAuthError("共享项目数据服务没有返回本地会话凭据");
    const info = await callAsAuthority(fetchImpl, origin, "/api/project-data", {
      method: "GET",
      headers: { "x-atria-token": sessionToken }
    });
    if (info.engine !== "sqlite" && info.engine !== "postgres")
      throw new ProjectDataUnavailableError("共享项目数据服务没有报告可用引擎");
    return new RemoteProjectDataService(options, sessionToken, {
      engine: info.engine,
      // The authority's file path stays on that host; this backend only names the origin.
      target: origin,
      serverVersion: String(info.serverVersion ?? "unknown"),
      schemaVersion: Number(info.schemaVersion ?? 0),
      source: options.source
    });
  }

  private actorHeader(actor: BoardActor): string {
    // The authority sees one credential for all of this backend's users; the
    // actor keeps its local identity, namespaced by this backend, for ownership.
    return actor.id.startsWith("backend:") ? actor.id : `backend:${this.backendId}:${actor.id}`;
  }

  private async request(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      actor?: BoardActor;
      backend?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "x-atria-token": this.token };
    if (options.backend !== false) headers["x-cowork-backend-id"] = this.backendId;
    if (options.actor) headers["x-cowork-actor"] = this.actorHeader(options.actor);
    if (options.body) headers["content-type"] = "application/json";
    try {
      return await call(this.fetchImpl, this.origin, path, {
        method: options.method ?? (options.body ? "POST" : "GET"),
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
    } catch (error) {
      if (error instanceof ProjectDataError) throw error;
      throw unavailable(this.origin, error);
    }
  }

  async ensureProject(input: {
    projectId: unknown;
    projectName: unknown;
    projectDirectory: unknown;
    backendId: string;
  }): Promise<ProjectIdentity> {
    const result = await this.request("/api/project-data/bindings", {
      body: {
        projectId: ledgerProjectId(input.projectId),
        projectName: ledgerProjectName(input.projectName),
        projectDirectory: ledgerProjectDirectory(input.projectDirectory)
      }
    });
    return result.project as unknown as ProjectIdentity;
  }

  async projects(): Promise<SharedProject[]> {
    const result = await this.request("/api/project-data/projects");
    return (result.projects as SharedProject[]) ?? [];
  }

  async createRequirement(projectId: unknown, input: RequirementCreate): Promise<RequirementDetail> {
    const result = await this.request(projectPath(projectId, "/ledger"), {
      body: { action: "create", ...input }
    });
    return result.requirement as RequirementDetail;
  }

  async updateRequirement(
    projectId: unknown,
    requirementId: unknown,
    input: RequirementUpdate
  ): Promise<RequirementDetail> {
    const result = await this.request(projectPath(projectId, "/ledger"), {
      body: { action: "update", requirementId, ...input }
    });
    return result.requirement as RequirementDetail;
  }

  async addDecision(
    projectId: unknown,
    requirementId: unknown,
    input: { expectedRevision?: unknown; text?: unknown; effective?: unknown; source?: unknown }
  ): Promise<RequirementDetail> {
    const result = await this.request(projectPath(projectId, "/ledger"), {
      body: { action: "decide", requirementId, ...input }
    });
    return result.requirement as RequirementDetail;
  }

  async setDecisionEffective(
    projectId: unknown,
    requirementId: unknown,
    decisionId: unknown,
    input: { expectedRevision?: unknown; effective?: unknown }
  ): Promise<RequirementDetail> {
    const result = await this.request(projectPath(projectId, "/ledger"), {
      body: { action: "set_decision_effective", requirementId, decisionId, ...input }
    });
    return result.requirement as RequirementDetail;
  }

  async getRequirement(projectId: unknown, requirementId: unknown): Promise<RequirementDetail> {
    const result = await this.request(projectPath(projectId, "/ledger"), {
      body: { action: "get", requirementId }
    });
    return result.requirement as RequirementDetail;
  }

  async queryRequirements(projectId: unknown, query: RequirementQuery = {}): Promise<RequirementSummary[]> {
    const result = await this.request(projectPath(projectId, "/ledger"), {
      body: { action: "query", q: query.text, status: query.status, limit: query.limit }
    });
    return (result.requirements as RequirementSummary[]) ?? [];
  }

  /**
   * Main sessions are shared facts, so a secondary backend reads and writes
   * them through the same authenticated business surface. The authority derives
   * this backend's identity from the session, never from a body field.
   */
  private async sessionRequest(
    projectId: unknown,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(projectPath(projectId, "/main-sessions"), { body });
  }

  async createMainSession(
    projectId: unknown,
    input: {
      title?: unknown;
      entryKind?: unknown;
      kind?: unknown;
      backendId: unknown;
      taskId: unknown;
      requirementId?: unknown;
    }
  ): Promise<MainSessionRecord> {
    const result = await this.sessionRequest(projectId, {
      action: "create",
      title: input.title,
      entryKind: input.entryKind,
      kind: input.kind,
      taskId: input.taskId,
      requirementId: input.requirementId
    });
    return result.record as MainSessionRecord;
  }

  async adoptMainSessionTasks(
    projectId: unknown,
    _backendId: unknown,
    tasks: ReadonlyArray<{ taskId: string; title?: string; goal?: string }>
  ): Promise<number> {
    const result = await this.sessionRequest(projectId, { action: "adopt", tasks });
    return Number(result.adopted ?? 0);
  }

  async listMainSessions(projectId: unknown): Promise<MainSessionRecord[]> {
    const result = await this.request(projectPath(projectId, "/main-sessions"));
    return (result.records as MainSessionRecord[]) ?? [];
  }

  async getMainSession(projectId: unknown, sessionId: unknown): Promise<MainSessionRecord> {
    const result = await this.request(
      projectPath(projectId, `/main-sessions/${encodeURIComponent(String(sessionId))}`)
    );
    return result.record as MainSessionRecord;
  }

  async findMainSessionByTask(
    projectId: unknown,
    _backendId: unknown,
    taskId: unknown
  ): Promise<MainSessionRecord | undefined> {
    try {
      const result = await this.sessionRequest(projectId, { action: "find_by_task", taskId });
      return result.record as MainSessionRecord;
    } catch (error) {
      // The lookup is explicitly optional: no session for this Task is not a failure.
      if (error instanceof ProjectDataNotFoundError) return undefined;
      throw error;
    }
  }

  async setMainSessionRequirement(
    projectId: unknown,
    sessionId: unknown,
    requirementId: unknown
  ): Promise<MainSessionRecord> {
    const result = await this.sessionRequest(projectId, {
      action: "set_requirement",
      sessionId,
      requirementId
    });
    return result.record as MainSessionRecord;
  }

  async recordMainSessionRun(
    projectId: unknown,
    sessionId: unknown,
    input: { runId: unknown; taskId: unknown; requirementId?: unknown; state?: unknown }
  ): Promise<MainSessionRun> {
    const result = await this.sessionRequest(projectId, {
      action: "record_run",
      sessionId,
      runId: input.runId,
      taskId: input.taskId,
      requirementId: input.requirementId,
      state: input.state
    });
    return result.run as MainSessionRun;
  }

  async settleMainSessionRun(
    projectId: unknown,
    taskId: unknown,
    runId: unknown,
    state: unknown
  ): Promise<number> {
    const result = await this.sessionRequest(projectId, {
      action: "settle_run",
      taskId,
      runId,
      state
    });
    return Number(result.settled ?? 0);
  }

  /**
   * The merge entry and development records travel through the same
   * authenticated surface. The authority derives this backend from the session,
   * so the checkout directory a remote backend reports stays its own fact.
   */
  async mergeConfig(projectId: unknown): Promise<MergeConfig | undefined> {
    const result = await this.request(projectPath(projectId, "/merge-config"));
    return (result.mergeConfig as MergeConfig | null) ?? undefined;
  }

  async setMergeConfig(
    projectId: unknown,
    input: MergeConfigInput,
    _backendId: string
  ): Promise<MergeConfig> {
    const result = await this.request(projectPath(projectId, "/merge-config"), {
      body: {
        repository: input.repository,
        targetBranch: input.targetBranch,
        executionBackendId: input.executionBackendId
      }
    });
    return result.mergeConfig as MergeConfig;
  }

  async createDevelopment(projectId: unknown, input: DevelopmentCreate): Promise<DevelopmentRecord> {
    const result = await this.request(projectPath(projectId, "/developments"), {
      body: { action: "create", ...input }
    });
    return result.development as DevelopmentRecord;
  }

  async updateDevelopment(
    projectId: unknown,
    developmentId: unknown,
    input: DevelopmentUpdate,
    _backendId?: string
  ): Promise<DevelopmentRecord> {
    const result = await this.request(projectPath(projectId, "/developments"), {
      body: { action: "update", developmentId, ...input }
    });
    return result.development as DevelopmentRecord;
  }

  async getDevelopment(
    projectId: unknown,
    developmentId: unknown,
    _backendId?: string
  ): Promise<DevelopmentRecord> {
    const result = await this.request(
      projectPath(projectId, `/developments/${encodeURIComponent(String(developmentId))}`)
    );
    return result.development as DevelopmentRecord;
  }

  async queryDevelopments(projectId: unknown, _backendId?: string): Promise<DevelopmentRecord[]> {
    const result = await this.request(projectPath(projectId, "/developments"));
    return (result.developments as DevelopmentRecord[]) ?? [];
  }

  async findDevelopmentByRequirement(
    projectId: unknown,
    requirementId: unknown,
    _backendId?: string
  ): Promise<DevelopmentRecord | undefined> {
    try {
      const result = await this.request(projectPath(projectId, "/developments"), {
        body: { action: "find_by_requirement", requirementId }
      });
      return result.development as DevelopmentRecord;
    } catch (error) {
      // The lookup is explicitly optional: no record for this requirement is not a failure.
      if (error instanceof ProjectDataNotFoundError) return undefined;
      throw error;
    }
  }

  async recordDevelopmentWorkspace(
    projectId: unknown,
    developmentId: unknown,
    workspace: unknown
  ): Promise<DevelopmentRecord> {
    const result = await this.request(projectPath(projectId, "/developments"), {
      body: { action: "record_workspace", developmentId, workspace }
    });
    return result.development as DevelopmentRecord;
  }

  /**
   * Review facts travel through the same authority surface. The backend that
   * owns the checkout decides the candidate and drift, then stores the result;
   * the authority only keeps the shared record.
   */
  async reviewPlan(projectId: unknown, developmentId: unknown): Promise<ReviewPlan | undefined> {
    const result = await this.reviewRequest(projectId, { action: "query", developmentId });
    return (result.plan as ReviewPlan | null) ?? undefined;
  }

  async setReviewPlan(projectId: unknown, developmentId: unknown, input: unknown): Promise<ReviewPlan> {
    const value = (input ?? {}) as Record<string, unknown>;
    const result = await this.reviewRequest(projectId, {
      action: "plan",
      developmentId,
      channel: value.channel,
      basis: value.basis,
      checks: value.checks,
      candidate: value.candidate
    });
    return result.plan as ReviewPlan;
  }

  async createReview(projectId: unknown, developmentId: unknown, input: unknown): Promise<DevelopmentReview> {
    const result = await this.reviewRequest(projectId, {
      action: "start",
      developmentId,
      ...(input && typeof input === "object" && !Array.isArray(input) ? input : {})
    });
    return result.review as DevelopmentReview;
  }

  async updateReview(projectId: unknown, reviewId: unknown, input: unknown): Promise<DevelopmentReview> {
    const result = await this.reviewRequest(projectId, {
      action: "update",
      reviewId,
      ...(input && typeof input === "object" && !Array.isArray(input) ? input : {})
    });
    return result.review as DevelopmentReview;
  }

  async getReview(projectId: unknown, reviewId: unknown): Promise<DevelopmentReview> {
    const result = await this.request(
      projectPath(projectId, `/reviews/${encodeURIComponent(String(reviewId))}`)
    );
    return result.review as DevelopmentReview;
  }

  async queryReviews(projectId: unknown, developmentId?: unknown): Promise<DevelopmentReview[]> {
    const result = await this.reviewRequest(projectId, {
      action: "query",
      ...(developmentId === undefined ? {} : { developmentId })
    });
    return (result.reviews as DevelopmentReview[]) ?? [];
  }

  private reviewRequest(projectId: unknown, body: Record<string, unknown>) {
    return this.request(projectPath(projectId, "/reviews"), { body });
  }

  /**
   * Merge operations are shared queue facts. This backend records what it owns
   * and claims a waiting operation only when it is the configured executor; the
   * authority stores the row and refuses a claim for another backend.
   */
  async createMerge(
    projectId: unknown,
    developmentId: unknown,
    input: MergeCreate
  ): Promise<DevelopmentMerge> {
    const result = await this.mergeRequest(projectId, {
      action: "create",
      developmentId,
      ...input
    });
    return result.merge as DevelopmentMerge;
  }

  async getMerge(projectId: unknown, mergeId: unknown): Promise<DevelopmentMerge> {
    const result = await this.request(
      projectPath(projectId, `/merges/${encodeURIComponent(String(mergeId))}`)
    );
    return result.merge as DevelopmentMerge;
  }

  async queryMerges(projectId: unknown, developmentId?: unknown): Promise<DevelopmentMerge[]> {
    const result = await this.mergeRequest(projectId, {
      action: "query",
      ...(developmentId === undefined ? {} : { developmentId })
    });
    return (result.merges as DevelopmentMerge[]) ?? [];
  }

  async claimMerge(projectId: unknown, mergeId: unknown, input: unknown): Promise<DevelopmentMerge> {
    const result = await this.mergeRequest(projectId, {
      action: "claim",
      mergeId,
      ...(input && typeof input === "object" && !Array.isArray(input) ? input : {})
    });
    return result.merge as DevelopmentMerge;
  }

  async updateMerge(projectId: unknown, mergeId: unknown, input: unknown): Promise<DevelopmentMerge> {
    const result = await this.mergeRequest(projectId, {
      action: "update",
      mergeId,
      ...(input && typeof input === "object" && !Array.isArray(input) ? input : {})
    });
    return result.merge as DevelopmentMerge;
  }

  private mergeRequest(projectId: unknown, body: Record<string, unknown>) {
    return this.request(projectPath(projectId, "/merges"), { body });
  }

  /**
   * Delivery rows are shared facts. A remote execution backend reports the
   * receipt of a merge it actually performed; the authority verifies it against
   * its merged row before writing the ledger and board.
   */
  async syncDelivery(projectId: unknown, receipt: unknown): Promise<DevelopmentDelivery> {
    const result = await this.deliveryRequest(projectId, { action: "sync", receipt });
    return result.delivery as DevelopmentDelivery;
  }

  async queryDeliveries(projectId: unknown, developmentId?: unknown): Promise<DevelopmentDelivery[]> {
    const result = await this.deliveryRequest(projectId, {
      action: "query",
      ...(developmentId === undefined ? {} : { developmentId })
    });
    return (result.deliveries as DevelopmentDelivery[]) ?? [];
  }

  async getDelivery(projectId: unknown, deliveryId: unknown): Promise<DevelopmentDelivery> {
    const result = await this.request(
      projectPath(projectId, `/deliveries/${encodeURIComponent(String(deliveryId))}`)
    );
    return result.delivery as DevelopmentDelivery;
  }

  async retryDelivery(projectId: unknown, deliveryId: unknown): Promise<DevelopmentDelivery> {
    const result = await this.deliveryRequest(projectId, { action: "retry", deliveryId });
    return result.delivery as DevelopmentDelivery;
  }

  private deliveryRequest(projectId: unknown, body: Record<string, unknown>) {
    return this.request(projectPath(projectId, "/deliveries"), { body });
  }

  async boardEntries(projectId: unknown): Promise<BoardEntry[]> {
    const result = await this.request(projectPath(projectId, "/board"));
    return (result.entries as BoardEntry[]) ?? [];
  }

  async boardEntry(projectId: unknown, boardId: unknown): Promise<BoardEntry> {
    const result = await this.request(
      projectPath(projectId, `/board/${encodeURIComponent(String(boardId))}`)
    );
    return result.entry as BoardEntry;
  }

  async boardEvents(projectId: unknown, boardId: unknown): Promise<BoardEvent[]> {
    const result = await this.request(
      projectPath(projectId, `/board/${encodeURIComponent(String(boardId))}`)
    );
    return (result.events as BoardEvent[]) ?? [];
  }

  async publishBoardEntry(
    projectId: unknown,
    input: BoardPublishInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    const result = await this.request(projectPath(projectId, "/board"), {
      body: { action: "publish", ...input },
      actor: context.actor
    });
    return result.entry as BoardEntry;
  }

  async boardAction(
    projectId: unknown,
    boardId: unknown,
    action: BoardAction,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    const result = await this.request(projectPath(projectId, "/board"), {
      body: { action, boardId, ...input },
      actor: context.actor
    });
    return result.entry as BoardEntry;
  }

  async backupTo(_path: string): Promise<ProjectDataBackup> {
    throw new ProjectDataInvalidError("共享项目数据需要在权威服务所在后端备份，当前后端只读取同一服务");
  }

  async restoreFrom(_path: string): Promise<ProjectDataRestore> {
    throw new ProjectDataInvalidError("共享项目数据需要在权威服务所在后端恢复，当前后端只读取同一服务");
  }

  async close(): Promise<void> {}
}

/** Keep a refusal's own code; only a transport failure becomes "unavailable". */
async function callAsAuthority(
  fetchImpl: typeof fetch,
  origin: string,
  path: string,
  init: RequestInit
): Promise<Record<string, unknown>> {
  try {
    return await call(fetchImpl, origin, path, init);
  } catch (error) {
    if (error instanceof ProjectDataError) throw error;
    throw unavailable(origin, error);
  }
}

async function call(
  fetchImpl: typeof fetch,
  origin: string,
  path: string,
  init: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw unavailable(origin, error);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message =
    typeof body.error === "string" && body.error
      ? body.error
      : `共享项目数据服务请求失败（HTTP ${response.status}）`;
  if (response.status === 401) throw new ProjectDataAuthError(`共享项目数据服务认证已失效：${message}`);
  if (response.status === 404) throw new ProjectDataNotFoundError(message);
  if (response.status === 409) {
    const code = typeof body.code === "string" ? body.code : "revision_conflict";
    // The existing record is part of the conflict contract: a create retry can
    // continue that record instead of guessing a new one.
    if (code === "development_exists" && typeof body.developmentId === "string")
      throw new DevelopmentExistsError(message, body.developmentId);
    throw new ProjectDataConflictError(
      message,
      typeof body.currentRevision === "number" ? body.currentRevision : undefined,
      code
    );
  }
  if (response.status === 503) throw new ProjectDataUnavailableError(message);
  if (!response.ok)
    throw new ProjectDataError(
      message,
      response.status,
      typeof body.code === "string" ? body.code : undefined
    );
  return body;
}

function unavailable(origin: string, error: unknown): ProjectDataUnavailableError {
  const detail = error instanceof Error ? error.message : String(error);
  return new ProjectDataUnavailableError(
    `无法连接共享项目数据服务 ${origin}：${detail === "fetch failed" ? "连接失败" : detail}`
  );
}
