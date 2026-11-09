import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { atomicWrite, json } from "./fs-utils.js";
import {
  CONTEXT_BUDGET,
  bounded,
  nowIso,
  safeIdentifier,
  type ActiveAppContext,
  type Actor,
  type ResourceChangeSummary
} from "./types.js";
import type { ApplicationRegistry } from "./registry.js";
import type { ResourceStore } from "./resource-store.js";
import type { InstanceStore } from "./instance-store.js";
import type { ResourceMappingStore } from "./mapping-store.js";

export interface AgentCursor {
  lastInjectedRevision: number;
  lastAcknowledgedRevision: number;
  updatedAt: string;
}

interface CursorFile {
  version: 1;
  cursors: Record<string, AgentCursor>;
}

/**
 * What the Agent is told about the applications the user has been working in.
 *
 * Two rules keep this from becoming a second copy of every document. Only the
 * active resource gets a full context; other open tabs contribute an unread
 * count and nothing else. And full content is never injected — the Agent is
 * given a bounded summary plus the changes since it last looked, and calls the
 * application's own read tool when it actually needs the content.
 *
 * The builder never parses resource content itself. It asks the owning Adapter
 * for the summary, which is what lets a CAD or spreadsheet Adapter describe its
 * own model later without this file changing.
 */
export class ApplicationContextBuilder {
  constructor(
    private readonly workspaceRoot: string,
    private readonly registry: ApplicationRegistry,
    private readonly resources: ResourceStore,
    private readonly instances: InstanceStore,
    private readonly mapping: ResourceMappingStore,
    private readonly resourceStoreFor?: (taskId: string, resourceId: string) => Promise<ResourceStore>
  ) {}

  /**
   * Build the context for the active application, if there is one.
   *
   * `agentId` scopes the cursor: two agents reading the same resource each track
   * what they have already been shown.
   */
  async build(input: { taskId: string; agentId: string }): Promise<ActiveAppContext | undefined> {
    const manifest = await this.instances.readManifest(input.taskId);
    // Binding is only ever explicit. There is deliberately no fallback to the
    // newest open tab: a conversation that was never bound must inject nothing,
    // or opening any application would silently attach it to every later
    // message and the binding control would be describing a choice the user
    // never made.
    const resourceId = manifest.boundResourceId;
    if (!resourceId) return undefined;
    // The reference is the access check. It is asked here rather than trusted
    // from the manifest so a conversation that dropped its reference stops
    // being handed the document, whatever the manifest still says.
    if (!(await this.mapping.references(input.taskId, resourceId))) return undefined;
    const resources = this.resourceStoreFor
      ? await this.resourceStoreFor(input.taskId, resourceId)
      : this.resources;
    // eslint-disable-next-line no-restricted-syntax -- 资源可能已被删除，读不到 appType 就当作没有可注入的上下文
    const appType = await resources.appTypeOf(resourceId).catch(() => undefined);
    if (!appType) return undefined;

    const read = await resources
      .readResource(appType, resourceId, { limit: CONTEXT_BUDGET.changes * 2 })
      // eslint-disable-next-line no-restricted-syntax -- 资源读不出来时本轮不注入上下文，下一轮会重新尝试
      .catch(() => undefined);
    if (!read) return undefined;
    const adapter = this.registry.require(read.resource.appType);
    const cursor = await this.readCursor(input.taskId, input.agentId, resourceId);
    const all = await resources.changesSince(appType, resourceId, cursor.lastAcknowledgedRevision);
    // The Agent's own writes are already in its transcript. Replaying them as
    // "changes you have not seen" would waste budget and invite it to redo work.
    const foreign = all.filter(
      (change) => !(change.actor.type === "agent" && change.actor.id === input.agentId)
    );
    const changes = foreign.slice(-CONTEXT_BUDGET.changes).map((change) => ({
      ...change,
      summary: bounded(change.summary, CONTEXT_BUDGET.changeSummary)
    }));
    const summary = adapter.summarizeContext({
      resource: read.resource,
      content: read.snapshot.content,
      selection: read.selection,
      changes
    });
    return {
      appType: read.resource.appType,
      appInstanceId: manifest.loadedInstanceId,
      resource: read.resource,
      capabilities: adapter.definition.capabilities,
      // Measured through the one generic handle the platform has on an
      // adapter's model: `serialize` is already the contract for "what this is
      // as a file", so measuring its output needs no knowledge of the domain.
      sizeBytes: Buffer.byteLength(adapter.serialize(read.snapshot.content), "utf8"),
      // `bounded` collapses every run of whitespace, so "one line" holds
      // mechanically rather than by asking an adapter to keep to it.
      shape: bounded(summary.shape, CONTEXT_BUDGET.shape),
      // Derive callable names from the tools the extension registers, keeping
      // context discovery consistent with the adapter's executable tools.
      availableToolNames: (adapter.agentTools?.({ content: read.snapshot.content }) ?? []).map(
        (tool) => tool.name
      ),
      ...(summary.selectionSummary
        ? {
            selection: {
              schema: read.selection?.schema ?? "unknown",
              summary: bounded(summary.selectionSummary, CONTEXT_BUDGET.selection)
            }
          }
        : {}),
      changesSinceAgentRevision: changes,
      omittedChangeCount: Math.max(0, foreign.length - changes.length),
      agentRevision: cursor.lastAcknowledgedRevision
    };
  }

  /** Unread user changes per non-active resource, for the tab badges and a compact index. */
  async unreadCounts(
    input: { taskId: string; agentId: string },
    known?: Array<{ resourceId: string; title: string; appType: string }>
  ): Promise<Array<{ resourceId: string; title: string; appType: string; unread: number }>> {
    // The conversation's own references, which is what a badge counts.
    const resources = known ?? (await this.resources.listResources(await this.mapping.list(input.taskId)));
    // One cursor file, read once. It was being re-read per resource, and each
    // iteration also waited on the previous one for no reason.
    const cursors = (await this.readCursorFile(input.taskId, input.agentId)).cursors;
    return Promise.all(
      resources.map(async (resource) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 游标来自磁盘 JSON，首次出现的新资源没有条目
        const acknowledged = cursors[resource.resourceId]?.lastAcknowledgedRevision ?? 0;
        const store = this.resourceStoreFor
          ? await this.resourceStoreFor(input.taskId, resource.resourceId)
          : this.resources;
        const changes = await store.changesSince(resource.appType, resource.resourceId, acknowledged, {
          excludeActor: (actor: Actor) => actor.type === "agent" && actor.id === input.agentId
        });
        return {
          resourceId: resource.resourceId,
          title: resource.title,
          appType: resource.appType,
          unread: changes.length
        };
      })
    );
  }

  /**
   * Render the context as the system-prompt section the model reads.
   *
   * It is emitted as a separate section rather than spliced into the user's
   * message, so the transcript keeps showing what the person actually typed.
   */
  render(context: ActiveAppContext): string {
    const lines = [
      `<active_application app_type="${escapeAttribute(context.appType)}" resource_id="${escapeAttribute(context.resource.resourceId)}" resource_kind="${escapeAttribute(context.resource.kind)}" title="${escapeAttribute(context.resource.title)}" revision="${context.resource.revision}" size_bytes="${context.sizeBytes}">`,
      // The application's one line. The shell around it — kind, size, revision,
      // title — is the platform's, because those are true of every resource and
      // an adapter made to restate them would eventually restate them wrong.
      `  <shape>${escapeText(context.shape)}</shape>`
    ];
    if (context.selection) {
      // A selection may name a position, unlike `shape`: it is a place the user
      // chose, and "改这一段" has to have a referent. Do not "fix" this to match
      // the shape contract — they constrain different things.
      lines.push(
        `  <selection schema="${escapeAttribute(context.selection.schema)}">${escapeText(context.selection.summary)}</selection>`
      );
    }
    if (context.changesSinceAgentRevision.length) {
      lines.push(`  <changes since_agent_revision="${context.agentRevision}">`);
      for (const change of context.changesSinceAgentRevision) {
        lines.push(
          `    <change revision="${change.revision}" actor="${escapeAttribute(change.actor.type)}">${escapeText(change.summary)}</change>`
        );
      }
      if (context.omittedChangeCount > 0) {
        lines.push(`    <note>还有 ${context.omittedChangeCount} 项更早的修改未列出。</note>`);
      }
      lines.push("  </changes>");
    }
    // Resource context describes the document. Editing instructions and tool
    // discovery belong to <bound_application> to avoid duplicate prompt rules.
    const rendered = lines.concat("</active_application>").join("\n");
    // The hard ceiling is the last line of defence: an Adapter that returns an
    // enormous summary must not be able to crowd out the user's own message.
    if (Buffer.byteLength(rendered, "utf8") <= CONTEXT_BUDGET.total) return rendered;
    // Enforce the UTF-8 byte budget rather than String.slice's UTF-16 length,
    // including summaries containing multibyte characters.
    const closing = "\n  <note>上下文已截断</note>\n</active_application>";
    const budget = CONTEXT_BUDGET.total - Buffer.byteLength(closing, "utf8");
    const buffer = Buffer.from(rendered, "utf8").subarray(0, budget);
    // A byte cut can land mid-character; decoding with `stream: true` drops the
    // incomplete tail rather than emitting a replacement character.
    return `${new TextDecoder("utf-8").decode(buffer, { stream: true })}${closing}`;
  }

  async readCursor(taskId: string, agentId: string, resourceId: string): Promise<AgentCursor> {
    const file = await this.readCursorFile(taskId, agentId);
    return (
      file.cursors[resourceId] ?? {
        lastInjectedRevision: 0,
        lastAcknowledgedRevision: 0,
        updatedAt: nowIso()
      }
    );
  }

  /**
   * Record that a revision was placed into a prompt.
   *
   * Injection alone does not advance what the Agent is considered to know: if
   * the model run fails before it ever sees the context, the same changes must
   * be injected again rather than silently dropped.
   */
  async recordInjected(taskId: string, agentId: string, resourceId: string, revision: number): Promise<void> {
    await this.writeCursor(taskId, agentId, resourceId, (cursor) => ({
      ...cursor,
      lastInjectedRevision: Math.max(cursor.lastInjectedRevision, revision)
    }));
  }

  /** Advance the acknowledged revision once a turn carrying the context completed. */
  async recordAcknowledged(
    taskId: string,
    agentId: string,
    resourceId: string,
    revision: number
  ): Promise<void> {
    await this.writeCursor(taskId, agentId, resourceId, (cursor) => ({
      ...cursor,
      lastInjectedRevision: Math.max(cursor.lastInjectedRevision, revision),
      lastAcknowledgedRevision: Math.max(cursor.lastAcknowledgedRevision, revision)
    }));
  }

  private cursorPath(taskId: string, agentId: string): string {
    return join(
      resolve(this.workspaceRoot),
      safeIdentifier(taskId, "taskId"),
      "agents",
      safeIdentifier(agentId, "agentId"),
      "context",
      "application-cursors.json"
    );
  }

  private async readCursorFile(taskId: string, agentId: string): Promise<CursorFile> {
    try {
      const value = JSON.parse(
        await readFile(this.cursorPath(taskId, agentId), "utf8")
      ) as Partial<CursorFile> | null;
      if (value?.version !== 1 || !value.cursors || typeof value.cursors !== "object")
        return { version: 1, cursors: {} };
      return { version: 1, cursors: value.cursors };
      // eslint-disable-next-line no-restricted-syntax -- 游标文件不存在或损坏时从零开始注入，损坏的进度不值得中断 Agent 运行
    } catch {
      return { version: 1, cursors: {} };
    }
  }

  private async writeCursor(
    taskId: string,
    agentId: string,
    resourceId: string,
    update: (cursor: AgentCursor) => AgentCursor
  ): Promise<void> {
    const path = this.cursorPath(taskId, agentId);
    await mkdir(join(path, ".."), { recursive: true });
    await withFileLock(path, async () => {
      const file = await this.readCursorFile(taskId, agentId);
      const current = file.cursors[resourceId] ?? {
        lastInjectedRevision: 0,
        lastAcknowledgedRevision: 0,
        updatedAt: nowIso()
      };
      file.cursors[resourceId] = { ...update(current), updatedAt: nowIso() };
      await atomicWrite(path, json(file));
    });
  }
}

function escapeAttribute(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string
  );
}

function escapeText(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] as string
  );
}

export type { ResourceChangeSummary };
