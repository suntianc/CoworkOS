import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { id, now } from "../domain/types.js";
import { atomicWrite } from "../storage/atomic-file.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { git } from "../workspace/development-workspace.js";
import { prepareReviewSite, releaseReviewSite, type ReviewSite } from "../workspace/review-site.js";
import { DurableScheduler, type WorkItem } from "./scheduler.js";
import { prepareWorkItemSite, type WorkItemSite } from "../workspace/work-item-workspace.js";
import {
  AgentProcessHost,
  agentProcessDirectory,
  type AgentProcessRecord,
  type AgentProcessRole,
  type AgentProcessStatus
} from "./agent-process.js";
import { enqueueMainCallback, formatSubagentSummary } from "./subagent-callback.js";
import { parseReviewConclusion, type ReviewConclusion } from "./subagent-review.js";
import {
  settleDelegatedExperiment,
  type DelegatedExperimentRef
} from "./experiment-settlement.js";

/**
 * The backend side of delegated agent processes.
 *
 * It turns a queued work item into a Pi process, keeps the queue lease alive
 * while that process runs, and projects the process's result record back into
 * the queue, the Run events and Main's Inbox. After a restart it adopts the
 * processes the previous backend was watching; a process that ended without a
 * result record is a failure, never a success with an empty answer.
 */
export interface SubagentProcessResult {
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  status: AgentProcessStatus;
  response: string;
  outputFiles: string[];
  diagnostics: { tracePath: string; resultPath: string };
  /** A Reviewer's structured conclusion; absent for an Executor result. */
  review?: ReviewConclusion;
  error?: string;
}

export interface SubagentProcessServiceOptions {
  workspaceRoot: string;
  harnessRoot: string;
  /** Model connection and configuration facts the launcher needs. */
  env: NodeJS.ProcessEnv;
  /**
   * Per-item environment, resolved when that item actually starts.
   *
   * A role binding and its connection are read on this host at the start
   * boundary, so a binding changed while an item waited applies to this start,
   * and a recovered item re-reads the configuration instead of replaying one.
   */
  envFor?: (item: WorkItem) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  /** How often an adopted process's identity is checked. */
  pollMs?: number;
  /** Queue lease period; renewed every service cycle while the process runs. */
  leaseMs?: number;
  graceMs?: number;
  onSettled?: (result: SubagentProcessResult) => void | Promise<void>;
}

/** The result record the subagent extension writes before its process exits. */
interface AgentResultRecord {
  version?: unknown;
  taskId?: unknown;
  runId?: unknown;
  callId?: unknown;
  agentId?: unknown;
  token?: unknown;
  termination?: unknown;
  stopReason?: unknown;
  response?: unknown;
  outputFiles?: unknown;
  diagnostics?: unknown;
  review?: unknown;
  error?: unknown;
}

interface WorkPayload {
  task?: string;
  projectDirectory?: string;
  workItemSite?: WorkItemSite;
  /** The frozen candidate a Reviewer examines, when the dispatcher knows it. */
  reviewSite?: unknown;
  delegation?: { role?: string };
  dependsOn?: string[];
  /** The Executor session this item appends to; absent for a fresh call. */
  continuation?: { fromCallId: string; reviewId?: string; sessionCallId?: string };
  /** Capability grants this work item was dispatched with. */
  capabilityGrants?: unknown[];
  /** The experiment-ledger row this delegation opened when it was dispatched. */
  experimentRef?: DelegatedExperimentRef;
}

/** The roles this service launches and settles; Main belongs to the run service. */
const DELEGATED_ROLES = ["executor", "reviewer"] as const;

export class SubagentProcessService {
  private readonly host: AgentProcessHost;
  private readonly workspaceRoot: string;
  private readonly leaseMs: number;

  constructor(private readonly options: SubagentProcessServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
    this.host = new AgentProcessHost({
      workspaceRoot: options.workspaceRoot,
      harnessRoot: options.harnessRoot,
      env: options.env,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      onExit: (record) => this.settle(record)
    });
  }

  /** Take over the still-running processes of a Run and settle those already gone. */
  async adopt(input: { taskId: string; runId: string }): Promise<void> {
    // A Run's directory also holds Main's process record; only delegated roles
    // belong to this service, and adopting Main's record would settle the Main.
    await this.host.adopt({ ...input, roles: DELEGATED_ROLES });
  }

  /** This Run's delegated process records, never Main's. */
  private async delegatedRecords(input: { taskId: string; runId: string }) {
    return (await this.host.records(input.taskId, input.runId)).filter((record) => record.role !== "main");
  }

  /**
   * Launch every queued item whose prerequisites are terminal.
   *
   * An item with a live process record is already being executed by this or a
   * previous backend. It is never started twice.
   */
  async startQueued(input: { taskId: string; runId: string }): Promise<SubagentProcessResult[]> {
    const scheduler = new DurableScheduler(this.queuePath(input));
    await scheduler.reclaimExpired();
    const items = await scheduler.list();
    const records = await this.delegatedRecords(input);
    const active = new Set(records.filter((record) => !record.settledAt).map((record) => record.callId));
    const statusOf = new Map(items.map((item) => [item.stepId, item.status]));
    const terminal = new Set(items.filter((item) => isTerminal(item.status)).map((item) => item.stepId));
    const results: SubagentProcessResult[] = [];
    const workerId = `subagent-process-${process.pid}`;
    for (const item of items) {
      if (item.status !== "queued") continue;
      // A running process whose lease expired (this backend was slow or away)
      // gets that lease back instead of a second process for the same call.
      if (active.has(item.stepId)) {
        const running = records.find((record) => record.callId === item.stepId && !record.settledAt);
        const reclaimed = await scheduler.claim(workerId, this.leaseMs, item.stepId);
        if (running && reclaimed?.lease) await this.host.updateLease(running, reclaimed.lease.token);
        continue;
      }
      const payload = (item.payload ?? {}) as WorkPayload;
      const dependsOn = [...new Set(payload.dependsOn ?? [])];
      // A work item with an unfinished prerequisite stays queued and holds no
      // lease, so it is visible as pending without a worker owning it.
      if (dependsOn.some((stepId) => !terminal.has(stepId))) continue;
      // Every prerequisite is terminal. One that did not complete ends this
      // item without starting it: an item that can never run must be settled
      // too, or its Task would wait for it forever.
      const failed = dependsOn.filter((stepId) => statusOf.get(stepId) !== "completed");
      if (failed.length > 0) {
        const reason = `前置工作 ${failed.join("、")} 未成功完成，本工作项未执行`;
        const result = await this.settleUnstarted(item, payload, reason);
        if (result) results.push(result);
        continue;
      }
      const claimed = await scheduler.claim(workerId, this.leaseMs, item.stepId);
      if (!claimed?.lease) continue;
      try {
        await this.launch(claimed, payload, claimed.lease.token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedItem = await scheduler
          .fail(claimed.stepId, claimed.lease.token, message)
          // eslint-disable-next-line no-restricted-syntax -- 队列写入失败时仍要把启动失败通知 Main；租约到期后由 reclaimExpired 接管，不能因此丢掉这次失败
          .catch(() => undefined);
        const retryScheduled = failedItem?.status === "queued";
        if (!retryScheduled) {
          const role: AgentProcessRole = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
          results.push(await this.projectFailure(input, claimed, role, message));
        }
      }
    }
    return results;
  }

  /**
   * Settle an item whose prerequisites ended without completing.
   *
   * It never starts, so no process, lease or callback would otherwise exist for
   * it; the queue row, the dependency event and Main's callback are the whole
   * outcome. Recording them here is what keeps a cancelled prerequisite from
   * leaving a work item Main would wait for forever.
   */
  private async settleUnstarted(
    item: WorkItem,
    payload: WorkPayload,
    reason: string
  ): Promise<SubagentProcessResult | undefined> {
    const scheduler = new DurableScheduler(this.queuePath({ taskId: item.taskId, runId: item.runId }));
    await scheduler.failUnstarted(item.stepId, reason);
    const role: AgentProcessRole = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
    await new JsonlEventStore(join(this.workspaceRoot, item.taskId, "runs", item.runId, "run_events.jsonl"))
      .append({
        eventId: id("event"),
        type: "call.dependency_failed",
        taskId: item.taskId,
        runId: item.runId,
        agentId: item.agentId,
        callId: item.stepId,
        occurredAt: now(),
        payload: { callId: item.stepId, dependsOn: payload.dependsOn ?? [], error: reason }
      })
      // eslint-disable-next-line no-restricted-syntax -- 诊断事件写失败不能阻止给 Main 的失败回调，队列行已经带着原因
      .catch(() => undefined);
    return await this.projectFailure({ taskId: item.taskId, runId: item.runId }, item, role, reason);
  }

  /** Renew the leases of running processes so a second backend cannot claim them. */
  async maintain(input: { taskId: string; runId: string }): Promise<void> {
    const scheduler = new DurableScheduler(this.queuePath(input));
    for (const record of await this.delegatedRecords(input)) {
      if (record.settledAt || !record.leaseToken) continue;
      try {
        await scheduler.renew(record.callId, record.leaseToken, this.leaseMs);
        // eslint-disable-next-line no-restricted-syntax -- 续租失败说明租约已被其他后端收回；该过程仍由身份核对观察，不能因此误杀或重复启动
      } catch {
        /* another backend owns the lease; identity polling still observes this process */
      }
    }
  }

  /**
   * Stop one delegated process group and record it as cancelled.
   *
   * The durable queue is the authority: a call that already reached a terminal
   * state keeps that outcome and is never rewritten by a late stop request. A
   * process whose pid no longer matches its launch record is already gone, so
   * it is settled from its records without any signal being sent.
   */
  async stop(input: {
    taskId: string;
    runId: string;
    callId: string;
  }): Promise<SubagentProcessResult | undefined> {
    const record = await this.findRecord(input);
    if (!record) return undefined;
    const settled = settledResult(record);
    if (settled) return settled;
    const item = await this.findQueueItem(input.taskId, input.runId, input.callId);
    if (item && isTerminal(item.status)) return this.findSettled(record);
    if (await this.host.owns(record)) await this.markQueueCancelled(input.taskId, input.runId, record.callId);
    await this.host.stop(record);
    // Stopping settled the record: its durable outcome is the answer, and
    // reading it here avoids taking the queue lock again on a path that just
    // contended for it.
    const afterStop = settledResult((await this.findRecord(record)) ?? record);
    return afterStop ?? (await this.findSettled(record));
  }

  /** Whether any process this Run launched is still running. */
  async running(input: { taskId: string; runId: string }): Promise<boolean> {
    const records = await this.delegatedRecords(input);
    return records.some((record) => !record.settledAt);
  }

  close(): void {
    this.host.close();
  }

  private async launch(item: WorkItem, payload: WorkPayload, leaseToken: string): Promise<void> {
    const role = payload.delegation?.role === "reviewer" ? "reviewer" : "executor";
    const site = await this.workingSite(item, payload, role);
    const taskWorkspace = join(this.workspaceRoot, item.taskId);
    // A continuation appends one turn to the Executor's own Pi session: the
    // session directory and id are the original call's, not this call's. The
    // chain root is recorded on the item, so a rework of a rework opens the
    // transcript that already contains every earlier round.
    const sessionCallId = payload.continuation
      ? (payload.continuation.sessionCallId ?? payload.continuation.fromCallId)
      : item.stepId;
    const sessionDirectory = join(taskWorkspace, "sessions", item.agentId, "pi", sessionCallId);
    const directory = agentProcessDirectory(this.workspaceRoot, item.taskId, item.runId, role, item.agentId);
    await mkdir(sessionDirectory, { recursive: true });
    // A continuation opens the earlier transcript by its file: the session id
    // lookup compares the header's working directory with this process's, and
    // the two spellings of the same symlinked work site need not agree.
    const sessionFile = payload.continuation ? await resumeSessionFile(sessionDirectory) : undefined;
    if (site.reviewSite) {
      // The marker goes first: a worktree that exists without one could never be
      // found and cleaned after a backend restart. A failed creation removes it.
      await atomicWrite(reviewSiteMarker(directory), `${JSON.stringify(site.reviewSite)}\n`);
      try {
        await prepareReviewSite(site.reviewSite);
      } catch (error) {
        await rm(reviewSiteMarker(directory), { force: true });
        throw error;
      }
    }
    try {
      await this.host.launch({
        taskId: item.taskId,
        runId: item.runId,
        callId: item.stepId,
        agentId: item.agentId,
        role,
        workingDirectory: site.directory,
        // A resumed session takes the rework brief as its prompt argument: the
        // transcript it opened already owns stdin's role for the first turn.
        prompt: sessionFile ? "" : delegatedPrompt(payload.task ?? "Continue the delegated task."),
        sessionDirectory,
        ...(sessionFile
          ? {
              sessionArgs: ["--session", sessionFile],
              args: ["--", delegatedPrompt(payload.task ?? "Continue the delegated task.")]
            }
          : {}),
        resultPath: join(directory, "result.json"),
        env: await this.childEnv(item, role),
        leaseToken
      });
    } catch (error) {
      if (site.reviewSite) await this.discardReviewSite(site.reviewSite, directory);
      throw error;
    }
  }

  /**
   * The site this work item runs in.
   *
   * A Reviewer never shares the Executor's checkout: an explicit review site
   * names the frozen candidate, and a requirement-bound work item is detached
   * at the development checkout's candidate commit instead of forking a branch
   * of its own. The checkout is removed when the review process ends.
   */
  private async workingSite(
    item: WorkItem,
    payload: WorkPayload,
    role: AgentProcessRole
  ): Promise<{ directory: string; reviewSite?: ReviewSite }> {
    if (role !== "reviewer" && payload.reviewSite !== undefined)
      throw new Error(
        "Executor work item must not carry a reviewSite; a candidate checkout belongs to a Reviewer"
      );
    const explicit = role === "reviewer" ? reviewSiteInput(payload.reviewSite) : undefined;
    if (explicit) return { directory: resolve(explicit.directory), reviewSite: explicit };
    if (role === "reviewer" && payload.workItemSite) {
      const directory = resolve(payload.workItemSite.directory);
      const reviewSite: ReviewSite = {
        repository: resolve(payload.workItemSite.developmentDirectory),
        commit: await git(payload.workItemSite.developmentDirectory, ["rev-parse", "HEAD"]),
        directory
      };
      return { directory, reviewSite };
    }
    if (role === "reviewer") {
      // A Reviewer without a requirement site still needs its own candidate
      // copy: its shell must never run in the user's project directory.
      const projectDirectory = payload.projectDirectory ? resolve(payload.projectDirectory) : undefined;
      if (!projectDirectory)
        throw new Error(
          "Reviewer work item has no candidate checkout: dispatch it with a projectDirectory, workItemSite or reviewSite"
        );
      const commit = await reviewerCandidate(projectDirectory);
      const directory = join(
        agentProcessDirectory(this.workspaceRoot, item.taskId, item.runId, role, item.agentId),
        "review-site"
      );
      return { directory, reviewSite: { repository: projectDirectory, commit, directory } };
    }
    return { directory: await this.workingDirectory(payload) };
  }

  /**
   * The item's own checkout when the requirement assigned one, otherwise the
   * project directory it was dispatched with. Site preparation stays the
   * existing implementation; this service only names the directory to run in.
   */
  private async workingDirectory(payload: WorkPayload): Promise<string> {
    if (payload.workItemSite) {
      await prepareWorkItemSite(payload.workItemSite);
      return resolve(payload.workItemSite.directory);
    }
    if (!payload.projectDirectory) throw new Error("Subagent work item has no working site");
    return resolve(payload.projectDirectory);
  }

  private async childEnv(item: WorkItem, role: AgentProcessRole): Promise<NodeJS.ProcessEnv> {
    const payload = (item.payload ?? {}) as WorkPayload;
    return {
      ...this.options.env,
      ...(this.options.envFor ? await this.options.envFor(item) : {}),
      COWORK_AGENT_ROLE: role,
      // A delegated process has no Dashboard tools; the host credential belongs
      // to the requesting Run and must not let a Subagent act as Main.
      COWORK_API_TOKEN: undefined,
      COWORK_DASHBOARD_URL: undefined,
      ...(payload.capabilityGrants && payload.capabilityGrants.length > 0
        ? { COWORK_AGENT_GRANTS: JSON.stringify(payload.capabilityGrants) }
        : {})
    };
  }

  private async settle(record: AgentProcessRecord): Promise<void> {
    const result = await this.projectOutcome(record);
    // A Reviewer's checkout is the evidence its review was recorded against:
    // Main binds the review and checks the candidate's drift after the call is
    // over, so a successful review keeps the site. One that never produced a
    // conclusion leaves nothing to examine, and a retry recreates it.
    if (result.status !== "succeeded") await this.cleanupReviewSite(record);
  }

  private async projectOutcome(record: AgentProcessRecord): Promise<SubagentProcessResult> {
    const result = await this.findSettled(record);
    const runRoot = join(this.workspaceRoot, record.taskId, "runs", record.runId);
    const scheduler = new DurableScheduler(join(runRoot, "queue.json"));
    const payload =
      ((await scheduler.list()).find((item) => item.stepId === record.callId)?.payload as
        | WorkPayload
        | undefined) ?? {};
    // A retryable failure is still in flight, so it is not an outcome Main may
    // act on; the callback follows the terminal attempt like an in-process call.
    const publishOutcome = async (): Promise<{ messageId: string; queued: boolean }> => {
      // The ledger row settles at the same terminal boundary as the callback: a
      // retryable failure is not an outcome, so the row stays open for its retry.
      await settleDelegatedExperiment({
        workspaceRoot: this.workspaceRoot,
        taskId: record.taskId,
        runId: record.runId,
        callId: record.callId,
        agentId: record.agentId,
        ref: payload.experimentRef,
        status: result.status,
        workingDirectory: record.workingDirectory,
        summary: result.response,
        outputFiles: result.outputFiles,
        ...(result.error === undefined ? {} : { error: result.error })
      });
      return await enqueueMainCallback({
        workspaceRoot: this.workspaceRoot,
        taskId: record.taskId,
        runId: record.runId,
        callId: record.callId,
        agentId: record.agentId,
        status: result.status,
        // The ledger reference rides with the callback exactly as the
        // in-process path wrote it, so Main reads one shape either way.
        callbackMetadata: {
          ...(payload.experimentRef ?? {}),
          ...(result.review ? { review: result.review } : {})
        },
        response: formatSubagentSummary({
          status: result.status,
          rawResponse: result.response,
          outputFiles: result.outputFiles,
          diagnostics: result.diagnostics,
          ...(result.error ? { error: result.error } : {})
        }),
        outputFiles: result.outputFiles,
        diagnostics: result.diagnostics,
        ...(result.error ? { error: result.error } : {})
      });
    };
    // The queue row is the durable "this call is over" fact every reader polls,
    // so its terminal write comes last: a callback that is not yet queued must
    // not be readable as an outcome, or Main completes between the two writes
    // and the callback arrives for a closed Task.
    let retryScheduled = false;
    let callback: { messageId: string; queued: boolean } | undefined;
    if (result.status === "cancelled") {
      callback = await publishOutcome();
      await this.markQueueCancelled(record.taskId, record.runId, record.callId);
    } else if (result.status === "succeeded") {
      callback = await publishOutcome();
      await this.completeQueue(scheduler, record.callId, record.leaseToken);
    } else {
      const outcome = await this.failQueue(
        scheduler,
        record,
        result.error ?? "Subagent process failed",
        async () => {
          callback = await publishOutcome();
        }
      );
      // Another owner holds the call: its settlement is the outcome, so this
      // attempt records no failure event and no failure callback for it.
      if (outcome === "foreign") {
        await this.host.markSettled(record, {
          status: result.status,
          response: result.response,
          outputFiles: result.outputFiles,
          diagnostics: result.diagnostics,
          ...(result.error ? { error: result.error } : {})
        });
        return result;
      }
      retryScheduled = outcome === "retry";
    }

    const events = new JsonlEventStore(join(runRoot, "run_events.jsonl"));
    // A retry the queue scheduled is not an outcome Main may act on yet, but
    // the Run still records that this attempt is being replaced.
    if (retryScheduled)
      await events.append({
        eventId: id("event"),
        type: "run.retry_scheduled",
        taskId: record.taskId,
        runId: record.runId,
        agentId: record.agentId,
        callId: record.callId,
        occurredAt: now(),
        payload: { callId: record.callId, error: result.error }
      });
    const eventType =
      result.status === "succeeded"
        ? "run.completed"
        : result.status === "cancelled"
          ? "run.cancelled"
          : "run.failed";
    await events.append({
      eventId: id("event"),
      type: eventType,
      taskId: record.taskId,
      runId: record.runId,
      agentId: record.agentId,
      callId: record.callId,
      occurredAt: now(),
      payload: {
        callId: record.callId,
        ...(result.status === "succeeded" ? {} : { error: result.error, state: result.status }),
        ...(retryScheduled ? { retryScheduled: true } : {}),
        outputFiles: result.outputFiles,
        diagnostics: result.diagnostics,
        ...(callback?.queued ? { callbackMessageId: callback.messageId } : {})
      }
    });
    await this.host.markSettled(record, {
      status: result.status,
      response: result.response,
      outputFiles: result.outputFiles,
      diagnostics: result.diagnostics,
      ...(result.review ? { review: result.review } : {}),
      ...(result.error ? { error: result.error } : {})
    });
    await this.options.onSettled?.(result);
    return result;
  }

  /** Remove the Reviewer checkout and its marker after the process settled. */
  private async cleanupReviewSite(record: AgentProcessRecord): Promise<void> {
    const directory = agentProcessDirectory(
      this.workspaceRoot,
      record.taskId,
      record.runId,
      record.role,
      record.agentId
    );
    const site = await readReviewSiteMarker(reviewSiteMarker(directory));
    if (!site) return;
    await this.discardReviewSite(site, directory);
  }

  private async discardReviewSite(site: ReviewSite, processDirectory: string): Promise<void> {
    try {
      await releaseReviewSite(site);
      await rm(reviewSiteMarker(processDirectory), { force: true });
    } catch (error) {
      console.error(
        `[cowork] review site cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async findSettled(record: AgentProcessRecord): Promise<SubagentProcessResult> {
    const taskWorkspace = join(this.workspaceRoot, record.taskId);
    const result = await readResult(record.resultPath);
    const diagnostics = {
      tracePath: relative(taskWorkspace, record.sessionDirectory),
      resultPath: relative(taskWorkspace, record.resultPath)
    };
    const base = {
      taskId: record.taskId,
      runId: record.runId,
      callId: record.callId,
      agentId: record.agentId,
      outputFiles: [] as string[],
      diagnostics
    };
    // Cancellation is a durable queue fact, so the backend that observes the
    // exit and the backend that requested the stop agree even across restarts.
    const item = (
      await new DurableScheduler(
        join(this.workspaceRoot, record.taskId, "runs", record.runId, "queue.json")
      ).list()
    ).find((candidate) => candidate.stepId === record.callId);
    if (item?.status === "cancelled")
      return { ...base, status: "cancelled", response: "", error: "Subagent was cancelled by the backend" };
    if (!result || result.token !== record.token || typeof result.termination !== "string")
      return {
        ...base,
        status: "failed",
        response: "",
        error: "Subagent exited without writing a result record"
      };
    const outputFiles = Array.isArray(result.outputFiles)
      ? result.outputFiles.filter((path): path is string => typeof path === "string")
      : [];
    const response = typeof result.response === "string" ? result.response.trim() : "";
    // A Reviewer's conclusion is the result Main acts on; a record with a
    // completed turn but no usable conclusion is a failed call, not a review
    // Main has to interpret from prose.
    let review: ReviewConclusion | undefined;
    if (record.role === "reviewer" && result.termination === "completed") {
      const parsed = parseReviewConclusion(result.review);
      if (!parsed.ok)
        return {
          ...base,
          status: "failed",
          response,
          outputFiles,
          error: `Reviewer result has no valid review conclusion: ${parsed.errors.join("; ")}`
        };
      review = parsed.review;
    }
    if (result.termination !== "completed")
      return {
        ...base,
        status: "failed",
        response,
        outputFiles,
        error:
          typeof result.error === "string" && result.error
            ? result.error
            : `Subagent ended with termination ${result.termination}`
      };
    if (!response)
      return {
        ...base,
        status: "failed",
        response: "",
        outputFiles,
        error: "Subagent completed without returning a textual summary"
      };
    return { ...base, status: "succeeded", response, outputFiles, ...(review ? { review } : {}) };
  }

  private async projectFailure(
    input: { taskId: string; runId: string },
    item: WorkItem,
    role: AgentProcessRole,
    message: string
  ): Promise<SubagentProcessResult> {
    const taskWorkspace = join(this.workspaceRoot, item.taskId);
    const diagnostics = {
      tracePath: `sessions/${item.agentId}/pi/${item.stepId}`,
      resultPath: relative(
        taskWorkspace,
        join(
          agentProcessDirectory(this.workspaceRoot, item.taskId, item.runId, role, item.agentId),
          "result.json"
        )
      )
    };
    const payload = (item.payload ?? {}) as WorkPayload;
    const result: SubagentProcessResult = {
      ...input,
      callId: item.stepId,
      agentId: item.agentId,
      status: "failed",
      response: "",
      outputFiles: [],
      diagnostics,
      error: message
    };
    // A work item that never started still had a ledger row opened for it; its
    // failure is the row's outcome.
    await settleDelegatedExperiment({
      workspaceRoot: this.workspaceRoot,
      taskId: item.taskId,
      runId: item.runId,
      callId: item.stepId,
      agentId: item.agentId,
      ref: payload.experimentRef,
      status: "failed",
      workingDirectory: payload.projectDirectory ?? "",
      summary: "",
      outputFiles: [],
      error: message
    });
    await new JsonlEventStore(join(this.workspaceRoot, item.taskId, "runs", item.runId, "run_events.jsonl"))
      .append({
        eventId: id("event"),
        type: "run.failed",
        taskId: item.taskId,
        runId: item.runId,
        agentId: item.agentId,
        callId: item.stepId,
        occurredAt: now(),
        payload: {
          callId: item.stepId,
          error: message,
          state: "failed",
          retryScheduled: false,
          outputFiles: [],
          diagnostics
        }
      })
      // eslint-disable-next-line no-restricted-syntax -- 启动失败的诊断事件写失败不能阻止给 Main 的失败回调，原始错误已经随回调与队列返回
      .catch(() => undefined);
    await enqueueMainCallback({
      workspaceRoot: this.workspaceRoot,
      taskId: item.taskId,
      runId: item.runId,
      callId: item.stepId,
      agentId: item.agentId,
      status: "failed",
      ...(payload.experimentRef ? { callbackMetadata: { ...payload.experimentRef } } : {}),
      response: formatSubagentSummary({
        status: "failed",
        rawResponse: "",
        outputFiles: [],
        diagnostics,
        error: message
      }),
      outputFiles: [],
      diagnostics,
      error: message
    });
    return result;
  }

  private async completeQueue(
    scheduler: DurableScheduler,
    callId: string,
    token: string | undefined
  ): Promise<void> {
    if (!token) return;
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === callId);
    if (!item || isTerminal(item.status)) return;
    // eslint-disable-next-line no-restricted-syntax -- 终态已由结果记录与回调表达；队列写入失败时租约到期会由 reclaimExpired 复核，不能让回调因排队长写失败而丢失
    await scheduler.complete(callId, token).catch(() => undefined);
  }

  /**
   * Record a failed attempt, publishing its outcome first when it is terminal.
   *
   * The pre-terminal hook runs only when the queue will not retry: it publishes
   * the callback while the row still reads as in flight, so a reader that sees
   * the terminal row also finds that call's callback.
   */
  private async failQueue(
    scheduler: DurableScheduler,
    record: AgentProcessRecord,
    error: string,
    beforeTerminal?: () => Promise<void>
  ): Promise<"retry" | "foreign" | "terminal"> {
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === record.callId);
    // A terminal item was settled by someone else: this attempt is not the
    // outcome, and a second callback would report work twice.
    if (item && isTerminal(item.status)) return "foreign";
    const ownsLease =
      Boolean(record.leaseToken) && item?.status === "leased" && item.lease?.token === record.leaseToken;
    // A lease this attempt does not hold belongs to another owner.
    if (item?.status === "leased" && !ownsLease) return "foreign";
    if (item && ownsLease && item.attempts < (item.maxAttempts ?? 1)) return "retry";
    await beforeTerminal?.();
    const updated = ownsLease
      ? await scheduler
          .fail(record.callId, record.leaseToken!, error)
          // eslint-disable-next-line no-restricted-syntax -- 失败本身才是结果；队列写入失败时租约到期重试，回调已经记录了这次失败
          .catch(() => undefined)
      : await scheduler
          .failUnstarted(record.callId, error)
          // eslint-disable-next-line no-restricted-syntax -- 同上：队列写入失败不改变这次失败结果，未结算的项仍会被后续恢复看到
          .catch(() => undefined);
    return updated?.status === "queued" ? "retry" : "terminal";
  }

  private async markQueueCancelled(taskId: string, runId: string, callId: string): Promise<void> {
    const scheduler = new DurableScheduler(join(this.workspaceRoot, taskId, "runs", runId, "queue.json"));
    const item = (await scheduler.list()).find((candidate) => candidate.stepId === callId);
    if (!item || isTerminal(item.status)) return;
    // eslint-disable-next-line no-restricted-syntax -- 取消已由进程组与回调表达；队列写入失败时下一次取消或租约回收会补上终态
    await scheduler.cancel(callId).catch(() => undefined);
  }

  private async findQueueItem(taskId: string, runId: string, callId: string): Promise<WorkItem | undefined> {
    const scheduler = new DurableScheduler(join(this.workspaceRoot, taskId, "runs", runId, "queue.json"));
    return (await scheduler.list()).find((candidate) => candidate.stepId === callId);
  }

  private async findRecord(record: {
    taskId: string;
    runId: string;
    callId: string;
  }): Promise<AgentProcessRecord | undefined> {
    const records = await this.delegatedRecords(record);
    return records.find((candidate) => candidate.callId === record.callId);
  }

  private queuePath(input: { taskId: string; runId: string }): string {
    return join(this.workspaceRoot, input.taskId, "runs", input.runId, "queue.json");
  }
}

/** The commit a Reviewer without a recorded candidate can copy; refuse when there is none. */
async function reviewerCandidate(directory: string): Promise<string> {
  try {
    await git(directory, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(
      `Reviewer work item has no candidate checkout: ${directory} is not a Git repository; dispatch it under a developmentId or pass a reviewSite with the candidate commit`
    );
  }
  try {
    return await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new Error(
      `Reviewer work item has no candidate checkout: ${directory} has no commit; commit the candidate or pass a reviewSite with the candidate commit`
    );
  }
}

function reviewSiteMarker(processDirectory: string): string {
  return join(processDirectory, "review-site.json");
}

/** Validate an explicit review site; a malformed one is a locatable launch error. */
function reviewSiteInput(value: unknown): ReviewSite | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Subagent review site is not an object");
  const input = value as Record<string, unknown>;
  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  const commit = typeof input.commit === "string" ? input.commit.trim() : "";
  const directory = typeof input.directory === "string" ? input.directory.trim() : "";
  if (!repository || !commit || !directory)
    throw new Error("Subagent review site requires repository, commit and directory");
  return { repository, commit, directory };
}

async function readReviewSiteMarker(path: string): Promise<ReviewSite | undefined> {
  try {
    return reviewSiteInput(JSON.parse(await readFile(path, "utf8")));
    // eslint-disable-next-line no-restricted-syntax -- 标记不存在或已损坏时没有可清理的审查现场；进程终态仍按结果记录结算
  } catch {
    return undefined;
  }
}

function delegatedPrompt(task: string): string {
  return [
    `Main 分配的任务：${task}`,
    "完成后请返回完整结论；如果创建了 deliverables/ 文件，请列出路径。证据直接写在总结中；不要返回‘正在处理’之类的过程叙述，也不要声称没有执行过的操作。"
  ].join("\n");
}

function isTerminal(status: WorkItem["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** The recorded outcome of a process this backend already settled. */
function settledResult(record: AgentProcessRecord): SubagentProcessResult | undefined {
  if (!record.settledAt || !record.outcome) return undefined;
  return {
    taskId: record.taskId,
    runId: record.runId,
    callId: record.callId,
    agentId: record.agentId,
    ...record.outcome
  };
}

/** The transcript a continuation appends to; absent when the earlier attempt left none. */
async function resumeSessionFile(directory: string): Promise<string> {
  const files = (
    await readdir(directory)
      // eslint-disable-next-line no-restricted-syntax -- 会话目录不存在就是没有可续接的记录，下面的报错是给调用方的结论
      .catch(() => [] as string[])
  )
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (!files[0])
    throw new Error(`没有可续接的会话记录：${directory} 中没有 Pi 会话文件；不能新建 Agent 冒充原上下文`);
  return join(directory, files[0]);
}

async function readResult(path: string): Promise<AgentResultRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as AgentResultRecord;
    return value;
    // eslint-disable-next-line no-restricted-syntax -- 结果记录缺失或损坏就是“没有结果记录”，调用方据此把退出记为失败
  } catch {
    return undefined;
  }
}
