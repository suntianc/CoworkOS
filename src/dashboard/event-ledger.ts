import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "./management-commands.js";

/**
 * The durable event ledger of project and Task catalog changes.
 *
 * A client that reconnects has two things to reconcile: the authoritative
 * catalog and the events that explain how it changed. Both come from here. The
 * ledger owns a backend-wide sequence, a per-object revision and the last state
 * it published for each object; a snapshot is taken from the same serialized
 * section that assigns those numbers, so the handoff from snapshot to
 * subscription cannot drop or repeat an event.
 *
 * It is a file, not an in-memory bus: appends are written and fsynced before a
 * response leaves, a restart reloads the sequence and revisions, and the log is
 * compacted against a persisted index so it stays bounded. A cursor older than
 * the retained log is refused instead of silently skipping events; the client
 * then takes a fresh snapshot.
 *
 * An event is a full object view, not a delta. Applying one twice, or applying
 * an older one after a newer snapshot, is therefore a decision the client makes
 * by revision, and it can never lose a field the event did not mention.
 */
export const LEDGER_VERSION = 1;
export const DEFAULT_LEDGER_RECORDS = 2_000;

export type ManagementScope = "project" | "task";

export type ManagementEventType = "project.changed" | "task.changed" | "task.deleted";

export interface ManagementEventRecord {
  version: 1;
  backendId: string;
  /** Backend-wide order; the replay cursor is the last sequence the client applied. */
  seq: number;
  /** Stable identity: it names this event for the lifetime of this backend. */
  eventId: string;
  scope: ManagementScope;
  objectId: string;
  /** Per-object revision, assigned by this ledger; 1 is the object's first published state. */
  revision: number;
  type: ManagementEventType;
  occurredAt: string;
  /** The whole object as published; empty for a deletion tombstone. */
  payload: Record<string, unknown>;
}

export interface PublishedObject {
  scope: ManagementScope;
  objectId: string;
  revision: number;
  /** sha256 of the published payload, so a real change is distinguishable from a replay. */
  digest: string;
  /** The object's own `updatedAt`; orders a candidate state against what was published. */
  business: string;
  deleted: boolean;
}

/** The cursor and object revisions taken atomically with the state they describe. */
export interface LedgerTicket {
  cursor: number;
  revisions: Record<string, number>;
  live: { projects: string[]; tasks: string[] };
}

export interface LedgerOptions {
  /** Retained records; older ones are compacted into the persisted index. */
  maxRecords?: number;
  /**
   * Test-only crash injection: `crash:<scope>:<objectId>@<revision>` kills the
   * process at the moment that event would be written, reproducing "the state
   * was committed but the event is not visible yet" with a real process.
   */
  faultInject?: string;
}

interface IndexDocument {
  version: 1;
  backendId: string;
  seq: number;
  objects: PublishedObject[];
}

export function objectKey(scope: ManagementScope, objectId: string): string {
  return `${scope}:${objectId}`;
}

/**
 * Fields a catalog item derives from other objects.
 *
 * A project's `tasks` list changes every time one of its conversations changes;
 * each of those has its own event. Publishing that as a project change too would
 * double the stream and give a client two reasons to redraw the same project.
 */
const DERIVED_FIELDS = new Set(["tasks", "hasApplications"]);

function comparable(scope: ManagementScope, payload: Record<string, unknown>): Record<string, unknown> {
  if (scope !== "project") return payload;
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) if (!DERIVED_FIELDS.has(key)) own[key] = value;
  return own;
}

function digestOf(scope: ManagementScope, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(stableJson(comparable(scope, payload)))
    .digest("hex");
}

/** The object's own revision; every catalog item carries an ISO `updatedAt`. */
function businessRevision(payload: Record<string, unknown>): string {
  const updatedAt = payload.updatedAt;
  return typeof updatedAt === "string" ? updatedAt : "";
}

function validRecord(value: unknown): value is ManagementEventRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManagementEventRecord>;
  return (
    record.version === 1 &&
    typeof record.backendId === "string" &&
    Number.isInteger(record.seq) &&
    typeof record.eventId === "string" &&
    (record.scope === "project" || record.scope === "task") &&
    typeof record.objectId === "string" &&
    Number.isInteger(record.revision) &&
    typeof record.type === "string" &&
    typeof record.occurredAt === "string" &&
    Boolean(record.payload) &&
    typeof record.payload === "object"
  );
}

function validObject(value: unknown): value is PublishedObject {
  if (!value || typeof value !== "object") return false;
  const object = value as Partial<PublishedObject>;
  return (
    (object.scope === "project" || object.scope === "task") &&
    typeof object.objectId === "string" &&
    Number.isInteger(object.revision) &&
    typeof object.digest === "string" &&
    typeof object.business === "string" &&
    typeof object.deleted === "boolean"
  );
}

interface Fault {
  scope: ManagementScope;
  objectId: string;
  revision: number;
}

function parseFault(value: string | undefined): Fault | undefined {
  if (!value) return undefined;
  const match = value.match(/^crash:(project|task):(.+)@(\d+)$/);
  if (!match) return undefined;
  return { scope: match[1] as ManagementScope, objectId: match[2], revision: Number(match[3]) };
}

export class EventLedger {
  readonly directory: string;
  readonly backendId: string;
  readonly logPath: string;
  readonly indexPath: string;
  private readonly maxRecords: number;
  private readonly fault: Fault | undefined;
  private records: ManagementEventRecord[] = [];
  private objects = new Map<string, PublishedObject>();
  private seq = 0;
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Objects seen by a full reconciliation in this process; only these may be tombstoned. */
  private observed = new Set<string>();
  private sawCompleteCatalog = false;

  private constructor(directory: string, backendId: string, options: LedgerOptions) {
    this.directory = directory;
    this.backendId = backendId;
    this.logPath = join(directory, "events.jsonl");
    this.indexPath = join(directory, "index.json");
    const requested = options.maxRecords ?? DEFAULT_LEDGER_RECORDS;
    if (!Number.isInteger(requested) || requested < 4 || requested > 100_000)
      throw new Error(`事件保留条数必须是 4–100000 的整数：${String(requested)}`);
    this.maxRecords = requested;
    this.fault = parseFault(options.faultInject);
  }

  /** Load the persisted index and retained log; a foreign backend identity starts clean. */
  static async open(directory: string, backendId: string, options: LedgerOptions = {}): Promise<EventLedger> {
    const ledger = new EventLedger(directory, backendId, options);
    await mkdir(directory, { recursive: true });
    await ledger.load();
    await ledger.compactIfNeeded();
    if (!ledger.handle) ledger.handle = await open(ledger.logPath, "a", 0o600);
    return ledger;
  }

  private async load(): Promise<void> {
    const index = await this.readIndex();
    if (index && index.backendId === this.backendId) {
      this.seq = index.seq;
      for (const object of index.objects) this.objects.set(objectKey(object.scope, object.objectId), object);
    }
    let raw = "";
    try {
      raw = await readFile(this.logPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn final line is the tail of an append that never completed; the
        // state it described is recovered by the next reconciliation.
        continue;
      }
      if (!validRecord(parsed) || parsed.backendId !== this.backendId) continue;
      if (parsed.seq <= this.seq) continue;
      this.records.push(parsed);
      this.applyRecord(parsed);
    }
  }

  private async readIndex(): Promise<IndexDocument | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const document = parsed as Partial<IndexDocument>;
    if (
      document.version !== 1 ||
      typeof document.backendId !== "string" ||
      !Number.isInteger(document.seq) ||
      !Array.isArray(document.objects)
    )
      return undefined;
    return {
      version: 1,
      backendId: document.backendId,
      seq: document.seq as number,
      objects: document.objects.filter(validObject)
    };
  }

  private applyRecord(record: ManagementEventRecord): void {
    this.seq = Math.max(this.seq, record.seq);
    const key = objectKey(record.scope, record.objectId);
    const previous = this.objects.get(key);
    const deleted = record.type === "task.deleted";
    this.objects.set(key, {
      scope: record.scope,
      objectId: record.objectId,
      revision: record.revision,
      digest: digestOf(record.scope, record.payload),
      // A tombstone has no payload, but the object's own revision still orders
      // it: a snapshot read from before the deletion is older than the
      // tombstone and must not revive the object.
      business: deleted ? (previous?.business ?? "") : businessRevision(record.payload),
      deleted
    });
  }

  /** Sequence of the newest retained event. */
  cursor(): number {
    return this.seq;
  }

  /** Sequence of the oldest retained event, or `cursor() + 1` when the log is empty. */
  earliest(): number {
    return this.records[0]?.seq ?? this.seq + 1;
  }

  /**
   * Whether a client that applied everything up to `after` can be replayed.
   *
   * A cursor above the log is not a valid position in this backend's sequence:
   * it belongs to another identity or a lost history, so it needs a snapshot.
   */
  canReplay(after: number): boolean {
    return after >= this.earliest() - 1 && after <= this.seq;
  }

  replay(after: number, limit = 5_000): ManagementEventRecord[] {
    return this.records.filter((record) => record.seq > after).slice(0, limit);
  }

  /** The object revisions and live objects at this exact sequence. */
  private ticket(): LedgerTicket {
    const revisions: Record<string, number> = {};
    const live: LedgerTicket["live"] = { projects: [], tasks: [] };
    for (const object of this.objects.values()) {
      revisions[objectKey(object.scope, object.objectId)] = object.revision;
      if (object.deleted) continue;
      if (object.scope === "project") live.projects.push(object.objectId);
      else live.tasks.push(object.objectId);
    }
    return { cursor: this.seq, revisions, live };
  }

  /**
   * Run one publish/reconcile section and take the ticket inside it.
   *
   * Serializing the capture with the appends is what makes snapshot-plus-cursor
   * exact: nothing can be written between the numbers and the objects they name.
   */
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(record: ManagementEventRecord): Promise<void> {
    this.records.push(record);
    this.applyRecord(record);
    if (!this.handle) this.handle = await open(this.logPath, "a", 0o600);
    await this.handle.write(`${JSON.stringify(record)}\n`, null, "utf8");
    await this.handle.sync();
  }

  /** Publish one object state; returns the record and the ticket it produced. */
  publish(input: {
    scope: ManagementScope;
    objectId: string;
    type: ManagementEventType;
    payload: Record<string, unknown>;
  }): Promise<ManagementEventRecord> {
    return this.serialize(async () => this.publishNow(input));
  }

  private async publishNow(input: {
    scope: ManagementScope;
    objectId: string;
    type: ManagementEventType;
    payload: Record<string, unknown>;
  }): Promise<ManagementEventRecord> {
    const key = objectKey(input.scope, input.objectId);
    const previous = this.objects.get(key);
    const record: ManagementEventRecord = {
      version: 1,
      backendId: this.backendId,
      seq: this.seq + 1,
      eventId: `${this.backendId}:${this.seq + 1}`,
      scope: input.scope,
      objectId: input.objectId,
      revision: (previous?.revision ?? 0) + 1,
      type: input.type,
      occurredAt: new Date().toISOString(),
      payload: input.payload
    };
    if (
      this.fault &&
      this.fault.scope === record.scope &&
      this.fault.objectId === record.objectId &&
      this.fault.revision === record.revision
    )
      // The business write is already committed; the event never reaches disk.
      // A real kill, so nothing after this point can run or flush.
      process.kill(process.pid, "SIGKILL");
    await this.write(record);
    await this.compactIfNeeded();
    this.observed.add(key);
    return record;
  }

  /**
   * Align the ledger with the catalog a caller just read.
   *
   * This is the recovery seam for a state change whose event was never written
   * (a crash between the business commit and this append, or a writer that does
   * not publish at all). A candidate whose own revision is older than the
   * published one is skipped, so a snapshot that raced a newer publish cannot
   * roll the client back. Deletions are published only for objects this process
   * has already seen in a complete catalog read: a root that is temporarily
   * unreadable must not erase subscriptions.
   */
  reconcile(catalog: {
    projects: ReadonlyArray<object>;
    tasks: ReadonlyArray<object>;
  }): Promise<LedgerTicket> {
    return this.serialize(async () => {
      const seen = new Set<string>();
      for (const scope of ["project", "task"] as const) {
        const entries = scope === "project" ? catalog.projects : catalog.tasks;
        for (const entry of entries) {
          const payload = entry as Record<string, unknown>;
          const objectId = payload[scope === "project" ? "projectId" : "taskId"];
          if (typeof objectId !== "string" || !objectId) continue;
          const key = objectKey(scope, objectId);
          seen.add(key);
          const published = this.objects.get(key);
          const digest = digestOf(scope, payload);
          if (published && !published.deleted && published.digest === digest) continue;
          const business = businessRevision(payload);
          if (published?.deleted) {
            // Only a genuinely newer state revives a deleted object: an older
            // catalog read is exactly what a snapshot racing the deletion sees.
            if (!business || business <= published.business) continue;
          } else if (published && business && published.business && business < published.business) continue;
          await this.publishNow({
            scope,
            objectId,
            type: scope === "project" ? "project.changed" : "task.changed",
            payload
          });
        }
      }
      if (this.sawCompleteCatalog) {
        for (const key of [...this.observed]) {
          if (seen.has(key)) continue;
          const published = this.objects.get(key);
          if (!published || published.deleted) continue;
          await this.publishNow({
            scope: published.scope,
            objectId: published.objectId,
            type: "task.deleted",
            payload: {}
          });
        }
      }
      this.sawCompleteCatalog = true;
      for (const key of seen) this.observed.add(key);
      return this.ticket();
    });
  }

  private async compactIfNeeded(): Promise<void> {
    if (this.records.length <= this.maxRecords) return;
    // Write the index first: it is the only record of the events about to be
    // dropped, so a crash between the two writes must leave it ahead of the log.
    const document: IndexDocument = {
      version: 1,
      backendId: this.backendId,
      seq: this.seq,
      objects: [...this.objects.values()]
    };
    const temporaryIndex = `${this.indexPath}.tmp-${process.pid}`;
    await mkdir(this.directory, { recursive: true });
    const indexHandle = await open(temporaryIndex, "w", 0o600);
    try {
      await indexHandle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await indexHandle.sync();
    } finally {
      await indexHandle.close();
    }
    await rename(temporaryIndex, this.indexPath);
    this.records = this.records.slice(-this.maxRecords);
    const temporaryLog = `${this.logPath}.tmp-${process.pid}`;
    const logHandle = await open(temporaryLog, "w", 0o600);
    try {
      await logHandle.writeFile(this.records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
      await logHandle.sync();
    } finally {
      await logHandle.close();
    }
    await this.handle?.close();
    this.handle = undefined;
    await rename(temporaryLog, this.logPath);
    this.handle = await open(this.logPath, "a", 0o600);
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.handle?.close();
    this.handle = undefined;
  }
}
