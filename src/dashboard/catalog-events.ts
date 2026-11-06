import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventLedger, ManagementEventRecord } from "./event-ledger.js";

/**
 * The catalog's public event surface: a snapshot with its cursor, and a
 * resumable subscription from that cursor.
 *
 * Reusing the existing task catalog as the state reader is deliberate: the
 * snapshot is the same authoritative list `/api/tasks` serves, not a second
 * projection of it. The ledger adds the sequence, the per-object revisions and
 * the durable backlog that turn that list into a resumable stream.
 */
export interface CatalogState {
  projects: ReadonlyArray<object>;
  tasks: ReadonlyArray<object>;
  [field: string]: unknown;
}

export interface CatalogSnapshot extends CatalogState {
  backendId: string;
  cursor: number;
  revisions: Record<string, number>;
}

export type CursorRefusal =
  { ok: true } | { ok: false; code: "cursor_expired" | "cursor_unknown"; cursor: number; earliest: number };

export interface CatalogEvents {
  snapshot(): Promise<CatalogSnapshot>;
  cursorState(after: number): Promise<CursorRefusal>;
  subscribe(request: IncomingMessage, response: ServerResponse, after: number): Promise<void>;
  task(item: object): Promise<void>;
  taskDeleted(taskId: string): Promise<void>;
  project(item: object): Promise<void>;
  close(): Promise<void>;
}

export interface CatalogEventsOptions {
  ledger: Promise<EventLedger>;
  readCatalog(): Promise<CatalogState>;
  /** How often a live subscription re-reads the catalog for writers that do not publish. */
  reconcileMs?: number;
  /** Poll interval for newly published records. */
  pollMs?: number;
}

const objectId = (scope: "project" | "task", value: object): string => {
  const id = (value as Record<string, unknown>)[scope === "project" ? "projectId" : "taskId"];
  return typeof id === "string" ? id : "";
};

const asRecord = (value: object): Record<string, unknown> => value as Record<string, unknown>;

export function createCatalogEvents(options: CatalogEventsOptions): CatalogEvents {
  const ledger = options.ledger;
  const reconcileMs = options.reconcileMs ?? 1_000;
  const pollMs = options.pollMs ?? 100;
  /**
   * One catalog read at a time, shared by every live subscription.
   *
   * Reconciling is a full catalog read; two clients watching must not double the
   * disk work or race each other into publishing the same difference twice.
   */
  let syncing: Promise<void> | undefined;
  function sync(): Promise<void> {
    syncing ??= options
      .readCatalog()
      .then(async (catalog) => {
        await (await ledger).reconcile(catalog);
      })
      .finally(() => {
        syncing = undefined;
      });
    return syncing;
  }

  /**
   * Publish and never fail the caller's request.
   *
   * The business write is already committed when this runs. A failed append
   * must not turn a committed command into an error response; the state is on
   * disk, the next snapshot or restart reconciles the missing event, and the
   * log line says which object was affected.
   */
  async function publish(
    scope: "project" | "task",
    objectId: string,
    type: ManagementEventRecord["type"],
    payload: object
  ) {
    if (!objectId) return;
    try {
      await (await ledger).publish({ scope, objectId, type, payload: asRecord(payload) });
    } catch (error) {
      console.error(
        `[cowork] 事件写入失败，将在下次快照时补齐：${scope}:${objectId} ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return {
    async snapshot() {
      const catalog = await options.readCatalog();
      const ticket = await (await ledger).reconcile(catalog);
      const liveProjects = new Set(ticket.live.projects);
      const liveTasks = new Set(ticket.live.tasks);
      // Lists come from the ledger's live objects, revisions from the same
      // ticket: a client can never be handed a revision without its object, or
      // an object whose deletion it already missed.
      return {
        ...catalog,
        backendId: (await ledger).backendId,
        cursor: ticket.cursor,
        revisions: ticket.revisions,
        projects: catalog.projects.filter((item) => liveProjects.has(objectId("project", item))),
        tasks: catalog.tasks.filter((item) => liveTasks.has(objectId("task", item)))
      };
    },

    async cursorState(after) {
      const current = await ledger;
      if (after > current.cursor())
        return { ok: false, code: "cursor_unknown", cursor: current.cursor(), earliest: current.earliest() };
      if (after < current.earliest() - 1)
        return { ok: false, code: "cursor_expired", cursor: current.cursor(), earliest: current.earliest() };
      return { ok: true };
    },

    async subscribe(request, response, after) {
      const current = await ledger;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-content-type-options": "nosniff"
      });
      response.write(`: cowork events connected at ${current.cursor()}\n\n`);
      let cursor = after;
      let closed = false;
      let emitting = false;
      let lastReconcile = performance.now();
      const write = (record: ManagementEventRecord) => {
        response.write(`id: ${record.eventId}\ndata: ${JSON.stringify(record)}\n\n`);
        cursor = record.seq;
      };
      const emit = async () => {
        if (closed || emitting) return;
        emitting = true;
        try {
          if (performance.now() - lastReconcile >= reconcileMs) {
            lastReconcile = performance.now();
            // A writer that does not publish (a Run transition, an MCP edit)
            // becomes an event while someone is listening.
            await sync();
          }
          for (;;) {
            if (!current.canReplay(cursor)) {
              // The retained log moved past a subscriber that fell behind:
              // say so explicitly instead of silently skipping its events.
              response.write(
                `data: ${JSON.stringify({
                  version: 1,
                  backendId: current.backendId,
                  type: "stream.reset",
                  code: "cursor_expired",
                  cursor: current.cursor()
                })}\n\n`
              );
              closed = true;
              response.end();
              break;
            }
            const records = current.replay(cursor);
            if (!records.length) break;
            for (const record of records) write(record);
          }
        } catch (error) {
          console.error(`[cowork] 事件流刷新失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          emitting = false;
        }
      };
      const timer = setInterval(() => {
        void emit();
      }, pollMs);
      const keepAlive = setInterval(() => {
        if (!closed) response.write(": keep-alive\n\n");
      }, 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(keepAlive);
      };
      request.once("close", close);
      response.once("close", close);
      await emit();
    },

    task: (item) => publish("task", objectId("task", item), "task.changed", item),
    project: (item) => publish("project", objectId("project", item), "project.changed", item),
    // The deletion names the object in `scope`/`objectId`; a full payload here
    // would be a snapshot of something that no longer exists.
    taskDeleted: (taskId) => publish("task", taskId, "task.deleted", {}),

    async close() {
      await (await ledger).close();
    }
  };
}
