import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  CapabilityGrant,
  CapabilityProvider,
  CapabilityContext
} from "../runtime/capability-provider.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { DurableScheduler } from "../runtime/scheduler.js";
import type { RuntimeTool } from "../runtime/tool.js";
import { ApplicationService, type ApplicationEventSink } from "./application-service.js";
import { ApplicationError, safeIdentifier, type AdapterToolDefinition, type Actor } from "./types.js";
import { atomicWrite, json, missing } from "./fs-utils.js";
import { batchOperations } from "./resource-store.js";
import { assertApplicationExecutionTarget, type ApplicationExecutionTarget } from "./execution-target.js";

export interface ResourceGrant {
  resourceId: string;
  access: "read" | "candidate";
  baseRevision: number;
}
interface Candidate {
  /** Written as 1; a receipt read back from deliverables is validated against that version. */
  version: number;
  taskId: string;
  runId: string;
  callId: string;
  agentId: string;
  resourceId: string;
  appType: string;
  baseRevision: number;
  operationId: string;
  operations: Array<{ operationType: string; payload: unknown }>;
}
interface Draft {
  content: unknown;
  operations: Candidate["operations"];
  baseRevision: number;
}

/** Same adapter execution path for Main commits and scoped Subagent candidates. */
export class ApplicationToolSession {
  readonly observedRevisions = new Map<string, number>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly drafts = new Map<string, Draft>();
  constructor(
    public service: ApplicationService,
    private readonly options: {
      taskId: string;
      actor: Actor;
      emit?: ApplicationEventSink;
      candidateContext?: CapabilityContext;
    }
  ) {}

  async execute(
    resourceId: string,
    definition: AdapterToolDefinition,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    expectedTarget?: ApplicationExecutionTarget
  ) {
    const previous = this.pending.get(resourceId) ?? Promise.resolve();
    const result = previous
      // eslint-disable-next-line no-restricted-syntax -- 上一次同资源调用的失败已作为它自己的返回值抛给调用方，这里只需等它结束后再排队
      .catch(() => {})
      .then(() => this.executeOrdered(resourceId, definition, params, signal, expectedTarget));
    this.pending.set(resourceId, result);
    try {
      return await result;
    } finally {
      if (this.pending.get(resourceId) === result) this.pending.delete(resourceId);
    }
  }

  private async executeOrdered(
    resourceId: string,
    definition: AdapterToolDefinition,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    expectedTarget?: ApplicationExecutionTarget
  ) {
    const { taskId, actor, candidateContext } = this.options;
    signal?.throwIfAborted();
    const service = await this.service.serviceForResource(taskId, resourceId);
    const read = await service.readResource(taskId, resourceId, {
      limit: 1,
      expectedResourceWorkspaceRoot: expectedTarget?.resourceWorkspaceRoot
    });
    if (expectedTarget) await assertApplicationExecutionTarget(service, read.resource, expectedTarget);
    const adapter = service.registry.require(read.resource.appType);
    let draft = this.drafts.get(resourceId);
    if (candidateContext && !draft) {
      const statePath = join(
        candidateContext.workingDirectory,
        "work",
        `resource-${safeIdentifier(candidateContext.callId, "callId")}-${safeIdentifier(resourceId, "resourceId")}.json`
      );
      try {
        draft = JSON.parse(await readFile(statePath, "utf8")) as Draft;
        batchOperations({ operations: draft.operations });
        this.drafts.set(resourceId, draft);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    const observed = this.observedRevisions.get(resourceId);
    if (definition.requiresFreshRead || (candidateContext && definition.access !== "read")) {
      if (observed === undefined)
        throw new ApplicationError(
          "operation_precondition_failed",
          "先用应用读取工具查看当前文档，再生成或提交修改",
          {}
        );
      if (observed !== read.resource.revision || (draft && draft.baseRevision !== read.resource.revision))
        throw new ApplicationError("revision_conflict", "资源已更新，请重新委派或重新读取并结合修改重算", {
          currentRevision: read.resource.revision,
          baseRevision: draft?.baseRevision ?? observed
        });
    }
    const content = draft?.content ?? read.snapshot.content;
    const currentDefinition = adapter.agentTools?.({ content }).find((tool) => tool.name === definition.name);
    if (!currentDefinition) throw new ApplicationError("invalid_operation", "当前文档格式不支持这个工具", {});
    const outcome = await currentDefinition.execute({
      params,
      content,
      resource: read.resource,
      selection: read.selection,
      signal
    });
    signal?.throwIfAborted();
    if (definition.access === "read" && outcome.operations?.length)
      throw new ApplicationError("invalid_operation", "只读工具不能返回写操作", {});
    let candidate: { candidatePath: string; baseRevision: number; operationCount: number } | undefined;
    let applied: Array<{ revision: number; summary: string }> = [];
    let revision = read.resource.revision;
    if (outcome.operations?.length && candidateContext) {
      let nextContent = structuredClone(content);
      for (const operation of outcome.operations) {
        const reducer = service.registry.requireOperation(read.resource.appType, operation.operationType);
        await reducer.validateOperation?.({
          ...operation,
          content: nextContent,
          resource: read.resource,
          signal
        });
        signal?.throwIfAborted();
        nextContent = reducer.applyOperation({ ...operation, content: nextContent, actor }).content;
      }
      const nextDraft: Draft = {
        content: nextContent,
        operations: [...(draft?.operations ?? []), ...outcome.operations],
        baseRevision: draft?.baseRevision ?? revision
      };
      batchOperations({ operations: nextDraft.operations });
      const operationId = `candidate-${randomUUID()}`;
      const receipt: Candidate = {
        version: 1,
        taskId,
        runId: candidateContext.runId,
        callId: candidateContext.callId,
        agentId: candidateContext.agentId,
        resourceId,
        appType: read.resource.appType,
        baseRevision: nextDraft.baseRevision,
        operationId,
        operations: nextDraft.operations
      };
      const path = join(candidateContext.workingDirectory, "deliverables", `${operationId}.json`);
      await atomicWrite(path, json(receipt));
      await atomicWrite(
        join(
          candidateContext.workingDirectory,
          "work",
          `resource-${safeIdentifier(candidateContext.callId, "callId")}-${safeIdentifier(resourceId, "resourceId")}.json`
        ),
        json(nextDraft)
      );
      this.drafts.set(resourceId, nextDraft);
      candidate = {
        candidatePath: relative(join(candidateContext.workspaceRoot, taskId), path),
        baseRevision: receipt.baseRevision,
        operationCount: receipt.operations.length
      };
    } else if (outcome.operations?.length) {
      const operation =
        outcome.operations.length === 1
          ? outcome.operations[0]
          : { operationType: "resource.batch", payload: { operations: outcome.operations } };
      const result = await service.applyOperation(
        {
          expectedResourceWorkspaceRoot: expectedTarget?.resourceWorkspaceRoot,
          taskId,
          resourceId,
          appType: read.resource.appType,
          operationId: `op_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          ...operation,
          baseRevision: revision,
          actor,
          signal
        },
        this.options.emit
      );
      revision = result.resource.revision;
      applied = [{ revision, summary: result.event.summary }];
      // eslint-disable-next-line no-restricted-syntax -- 游标只是上下文注入的进度标记，写入失败时下次仍会重算未读变更
      await this.service.context.recordAcknowledged(taskId, actor.id, resourceId, revision).catch(() => {});
    }
    if (definition.name === adapter.definition.entryReadTool || applied.length)
      this.observedRevisions.set(resourceId, revision);
    return { result: outcome.result, applied, candidate, images: outcome.images ?? [] };
  }
}

export async function resourceGrants(
  service: ApplicationService,
  taskId: string,
  input: unknown
): Promise<CapabilityGrant[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 16)
    throw new Error("resources must contain at most 16 explicit grants");
  const seen = new Set<string>();
  const scope: ResourceGrant[] = [];
  for (const item of input) {
    if (
      !item ||
      typeof item.resourceId !== "string" ||
      !["read", "candidate"].includes(item.access) ||
      seen.has(item.resourceId)
    )
      throw new Error("Each delegated resource needs a unique resourceId and read/candidate access");
    const read = await service.readResource(taskId, item.resourceId, { limit: 1 });
    seen.add(item.resourceId);
    scope.push({ resourceId: item.resourceId, access: item.access, baseRevision: read.resource.revision });
  }
  return scope.length ? [{ provider: "applications", scope }] : [];
}

export function applicationCapabilityProvider(
  service: ApplicationService,
  harnessRoot: string
): CapabilityProvider {
  return async (grants, context) => {
    const tools = new Map<string, RuntimeTool>();
    const roots = new Set<string>();
    const applications = new Set<string>();
    const scope = new Map<string, ResourceGrant>();
    const descriptions: string[] = [];
    const definitions = new Map<string, Map<string, AdapterToolDefinition>>();
    for (const grant of grants) {
      if (grant.provider !== "applications" || !Array.isArray(grant.scope))
        throw new Error(`Unsupported delegated capability: ${grant.provider}`);
      for (const item of grant.scope as ResourceGrant[]) {
        if (
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 委派作用域来自持久化队列里的 JSON，条目可能缺失或为 null
          !item ||
          !["read", "candidate"].includes(item.access) ||
          !Number.isSafeInteger(item.baseRevision) ||
          scope.has(item.resourceId)
        )
          throw new Error("Invalid delegated resource scope");
        const resourceService = await service.serviceForResource(context.taskId, item.resourceId);
        const read = await resourceService.readResource(context.taskId, item.resourceId, { limit: 1 });
        if (item.access === "candidate" && read.resource.revision !== item.baseRevision)
          throw new ApplicationError("revision_conflict", "委派后资源已更新，请重新读取再委派", {});
        scope.set(item.resourceId, item);
        const adapter = resourceService.registry.require(read.resource.appType);
        applications.add(read.resource.appType);
        const available = adapter.agentTools?.({ content: read.snapshot.content }) ?? [];
        descriptions.push(
          `${item.resourceId}: ${read.resource.title} (${item.access}, revision ${item.baseRevision})`
        );
        for (const root of adapter.definition.skillRoots ?? []) roots.add(resolve(harnessRoot, root));
        for (const definition of available) {
          if (item.access === "read" && definition.access !== "read") continue;
          const byResource = definitions.get(definition.name) ?? new Map();
          byResource.set(item.resourceId, definition);
          definitions.set(definition.name, byResource);
        }
      }
    }
    const readSession = new ApplicationToolSession(service, {
      taskId: context.taskId,
      actor: { type: "agent", id: context.agentId }
    });
    const session = new ApplicationToolSession(service, {
      taskId: context.taskId,
      actor: { type: "agent", id: context.agentId },
      candidateContext: context
    });
    for (const [name, byResource] of definitions) {
      const example = byResource.values().next().value!;
      tools.set(name, {
        description: `${example.description}\nScoped to explicitly delegated resources. Edits produce private candidates for Main; they never save the shared document. Return the latest candidatePath to Main. resourceId can be omitted only when one resource supports this tool.`,
        parameters: {
          ...example.parameters,
          properties: {
            ...(example.parameters.properties as object),
            resourceId: { type: "string", enum: [...byResource.keys()] }
          },
          ...(byResource.size > 1
            ? { required: [...((example.parameters.required as string[] | undefined) ?? []), "resourceId"] }
            : {})
        },
        async execute(input, signal) {
          try {
            const params = input as Record<string, unknown>;
            const resourceId =
              typeof params.resourceId === "string"
                ? params.resourceId
                : byResource.size === 1
                  ? byResource.keys().next().value!
                  : "";
            const grant = scope.get(resourceId);
            if (!grant || !byResource.has(resourceId))
              throw new Error("Resource/tool outside delegated scope");
            const definition = byResource.get(resourceId)!;
            if (grant.access === "read" && definition.access !== "read")
              throw new Error("Read-only resource grant");
            const { resourceId: _resourceId, ...arguments_ } = params;
            const outcome = await (grant.access === "read" ? readSession : session).execute(
              resourceId,
              definition,
              arguments_,
              signal
            );
            const payload = {
              ok: true,
              result: outcome.result,
              ...(outcome.candidate ? { candidate: outcome.candidate, saved: false } : {}),
              ...(outcome.images.length
                ? {
                    visualFeedback: {
                      images: outcome.images.length,
                      delivered: context.supportsImages,
                      ...(!context.supportsImages
                        ? {
                            reason:
                              "Model image input is unavailable; use text diagnostics and do not claim visual inspection."
                          }
                        : {})
                    }
                  }
                : {})
            };
            return {
              content: [
                { type: "text", text: JSON.stringify(payload) },
                ...(context.supportsImages
                  ? outcome.images.map((image) => ({ type: "image", ...image }))
                  : [])
              ],
              details: payload
            };
          } catch (error) {
            const payload = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              code: error instanceof ApplicationError ? error.code : "invalid_operation",
              nextAction:
                "Read the delegated resource; on revision conflict ask Main to re-delegate against the current revision."
            };
            return {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              details: payload,
              isError: true
            };
          }
        }
      });
    }
    return {
      tools,
      skillRoots: [...roots],
      skillApplications: [...applications],
      prompt: `Explicitly delegated resources:\n${descriptions.join("\n")}\nUse the scoped application tools for these resources. No other binding or Main application tools are inherited. Read before editing. Changes are private candidates, not saved documents. Report the latest candidatePath and evidence to Main for review and acceptance. CLI and App use this same contract. Do not write resource files with file or shell tools.`
    };
  };
}

/** Main accepts exactly the reviewed candidate; CAS prevents automatic rebasing over human edits. */
export async function acceptResourceCandidate(
  service: ApplicationService,
  input: {
    workspaceRoot: string;
    taskId: string;
    candidatePath: string;
    actor: Actor;
    signal?: AbortSignal;
    emit?: ApplicationEventSink;
  }
) {
  const taskRoot = await realpath(join(input.workspaceRoot, input.taskId));
  const path = await realpath(resolve(taskRoot, input.candidatePath));
  const rel = relative(taskRoot, path);
  if (
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    resolve(taskRoot, rel) !== path ||
    !rel.split(sep).includes("deliverables")
  )
    throw new Error("Candidate must be inside this Task's delegated deliverables");
  const candidate = JSON.parse(await readFile(path, "utf8")) as Candidate;
  if (
    candidate.version !== 1 ||
    candidate.taskId !== input.taskId ||
    typeof candidate.operationId !== "string" ||
    !Number.isSafeInteger(candidate.baseRevision)
  )
    throw new Error("Invalid resource candidate");
  const runId = safeIdentifier(candidate.runId, "runId");
  const agentId = safeIdentifier(candidate.agentId, "agentId");
  const callId = safeIdentifier(candidate.callId, "callId");
  const agentDeliverables = await realpath(
    join(
      new LocalWorkspaceStore(input.workspaceRoot).agentWorkDir(input.taskId, runId, agentId),
      "deliverables"
    )
  );
  if (!path.startsWith(`${agentDeliverables}${sep}`))
    throw new Error("Candidate path does not belong to its recorded delegate");
  const item = (await new DurableScheduler(join(taskRoot, "runs", runId, "queue.json")).list()).find(
    (entry) => entry.stepId === callId && entry.agentId === agentId
  );
  const grants =
    (item?.payload as { capabilityGrants?: CapabilityGrant[] } | undefined)?.capabilityGrants ?? [];
  const allowed = grants.some(
    (grant) =>
      grant.provider === "applications" &&
      Array.isArray(grant.scope) &&
      grant.scope.some(
        (scope: ResourceGrant) =>
          scope.resourceId === candidate.resourceId &&
          scope.access === "candidate" &&
          scope.baseRevision === candidate.baseRevision
      )
  );
  if (!allowed) throw new Error("Candidate is outside its durable delegation grant");
  if (path !== join(agentDeliverables, `${safeIdentifier(candidate.operationId, "operationId")}.json`))
    throw new Error("Candidate filename differs from its operation ID");
  const operations = batchOperations({ operations: candidate.operations });
  const outcome = await service.applyOperation(
    {
      taskId: input.taskId,
      resourceId: candidate.resourceId,
      appType: candidate.appType,
      operationId: candidate.operationId,
      operationType: "resource.batch",
      payload: { operations },
      baseRevision: candidate.baseRevision,
      actor: input.actor,
      signal: input.signal
    },
    input.emit
  );
  return {
    resourceId: candidate.resourceId,
    revision: outcome.resource.revision,
    summary: outcome.event.summary,
    deduplicated: outcome.deduplicated
  };
}
