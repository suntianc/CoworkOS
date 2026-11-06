import { createHash, randomUUID } from "node:crypto";

/**
 * The generic contracts every workbench application shares.
 *
 * The platform understands envelopes, versions and actors. It never understands
 * what an operation means: `text.replace` and a future `cad.set_parameter` reach
 * the store through the same path, and only the owning Adapter knows how to
 * validate, apply, summarize or invert them. Nothing in this file may name a
 * text-specific concept — that is the architectural acceptance condition for the
 * MVP, not a stylistic preference.
 */

export type ActorType = "user" | "agent" | "system";

export interface Actor {
  type: ActorType;
  id: string;
}

export type AppCapability = "view" | "edit" | "select" | "history" | "export" | "agent-commands";

/** What an Adapter declares about one operation, for discovery and prompting. */
export interface OperationSchema {
  description: string;
  required: string[];
  optional?: string[];
}

export interface ApplicationDefinition {
  appType: string;
  displayName: string;
  version: string;
  /** Discovery only; compatibility applications still open their existing resources. Defaults to primary. */
  catalogVisibility?: "primary" | "compatibility";
  /** Resource kinds this application can open, e.g. "text/markdown". */
  resourceKinds: string[];
  /** Binary/interchange files converted by the UI Adapter before creating a native resource. */
  fileImportFormats?: Array<{ mimeType: string; resourceKind: string }>;
  /** Trusted adapter-specific document ceiling; defaults to 2 MiB. */
  contentBytes?: number;
  capabilities: AppCapability[];
  operationSchemas: Record<string, OperationSchema>;
  /** App-owned instructions for creating a resource before any window is open. */
  creationHint?: string;
  /** Parameterless read entry point offered after creating and binding a resource. */
  entryReadTool?: string;
  /**
   * Selection schemas this application understands, e.g. "text.range/v1".
   *
   * Declared so the platform can refuse a selection an Adapter cannot read,
   * without knowing what any of them mean. An Adapter that omits this accepts
   * any schema, which is what a viewer with no selection model wants; one that
   * declares them gets a `invalid_operation` instead of a summary derived from
   * fields it never found — that silently reported a caret at line 1 for any
   * unrecognised payload.
   */
  selectionSchemas?: string[];
  exportFormats: string[];
  /** Default file extension per kind, used when deriving a workspace path. */
  fileExtensions?: Record<string, string>;
  /**
   * Skills this application brings with it, relative to the harness root.
   *
   * Generic resource tools describe *how* to change a resource; a skill
   * describes how to work in the domain — what a tolerance means, which
   * conventions a drawing follows. They load for a bound application or explicitly scoped delegation;
   * an unrelated Task does not inherit domain tools.
   */
  skillRoots?: string[];
  /**
   * An MCP server this application brings with it.
   *
   * Declared, not registered: the platform stays the one place that decides
   * when a tool becomes visible to the model, so unbinding can take the tools
   * away again. The process lives and dies with the application window, so an
   * application nobody opened costs nothing.
   *
   * This is what `agentTools` cannot do. An in-process hook must be harness
   * TypeScript; a server speaks a protocol over a pipe, so real software can
   * be driven by a program written in any language and shipped separately.
   */
  mcpServer?: McpServerSpec;
  /**
   * Eager orchestration prompt injected into a bound conversation for this
   * application (conversation-mode extensions). Mirrors coderix_main's
   * `agent.systemPrompt`: it carries the domain workflow as a system prompt rather
   * than a skill loaded on demand. Optional; most apps omit it and rely on
   * `skillRoots` + tools.
   */
  systemPrompt?: string;
}

/** How to start an application's MCP server. */
export interface McpServerSpec {
  command: string;
  args?: string[];
  /** Resolved against the harness root, as `skillRoots` are. */
  cwd?: string;
  env?: Record<string, string>;
}

export type ResourceStatus = "ready" | "recovery_required";

/** Durable project membership; absent on old records, null means explicitly unassigned. */
export interface ApplicationProject {
  projectId: string;
  projectName: string;
  projectDirectory: string;
  projectCatalogPath?: string;
}

export interface WorkspaceResource {
  project?: ApplicationProject | null;
  resourceId: string;
  /** Stable project ownership, independent of the file root and referencing conversations. */
  projectId?: string;
  appType: string;
  kind: string;
  title: string;
  /**
   * Where the content lives, relative to the owning application's `files/`
   * directory.
   *
   * A resource *is* a file, not a private object that has to be exported to
   * become real. The user sees it, Main's ordinary file tools see it, and saving
   * is saving — there is no separate publish step to explain. `resourceId`
   * remains the reference key so a rename does not break anything pointing at
   * it.
   *
   * Deliberately not under a Task: a resource belongs to no conversation, and
   * conversations reference it — several at once — through their own mapping.
   * Ownership by one Task is what forced "bind from elsewhere" to be a
   * destructive move.
   */
  path: string;
  /**
   * Set when this resource *is* one of the user's own files, somewhere else.
   *
   * Then `path` is not used and nothing is copied: reads and writes go to this
   * absolute path, so editing through the protocol and opening the file in
   * another program are the same act on the same bytes. Every access is checked
   * against the harness's protected paths.
   */
  externalPath?: string;
  /** Explicit exported destinations; the managed resource and revisions remain authoritative. */
  savedCopies?: Array<{
    path: string;
    format: string;
    contentVersion: string;
    revision: number;
    project?: ApplicationProject | null;
  }>;
  /** Original interchange file; workspace content is its editable representation. */
  sourceFile?: {
    path: string;
    format: string;
    contentVersion: string;
    savedRevision: number;
    pending?: { contentVersion: string; revision: number };
  };
  /** Immutable source identity for an editable copy of a Task artifact. */
  importedArtifact?: {
    storageRoot: string;
    taskId: string;
    relativePath: string;
    sha256: string;
  };
  revision: number;
  contentVersion: string;
  status: ResourceStatus;
  operationCount: number;
  createdBy: Actor;
  updatedBy: Actor;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when the file was changed by something other than this protocol.
   *
   * The file being real is what makes it useful and also what makes this
   * possible: Main can edit it with `write`, and a person can edit it in vim.
   * The revision chain cannot describe that edit, so it is recorded as an
   * external change rather than silently folded into history.
   */
  externalChangeAt?: string;
}

export interface ResourceSnapshot {
  resourceId: string;
  revision: number;
  contentVersion: string;
  /** Adapter-owned payload. Text uses a string; another Adapter may use an object. */
  content: unknown;
  updatedAt: string;
}

export interface AppOperationEvent<T = unknown> {
  eventId: string;
  operationId: string;
  /**
   * Which conversation the write came from, when it came from one.
   *
   * Informational only: the resource itself belongs to no Task, and the log is
   * one stream per resource regardless of how many conversations reference it.
   * Recorded so history can say where a change originated — with several agents
   * editing at once, "who did this" needs the conversation as well as the actor.
   */
  taskId?: string;
  resourceId: string;
  appType: string;
  appInstanceId?: string;
  actor: Actor;
  operationType: string;
  baseRevision: number;
  revision: number;
  payload: T;
  /** Short human-readable description produced by the Adapter. */
  summary: string;
  /** Adapter-produced reverse operation, used by undo. */
  inverse?: { operationType: string; payload: unknown };
  /**
   * The event this one reversed, when it was produced by undo.
   *
   * Undo appends rather than rewriting history, so without this marker an undo
   * is indistinguishable from an ordinary edit and the next undo reverses the
   * undo — a toggle instead of a stack.
   */
  undoneEventId?: string;
  occurredAt: string;
}

export interface AppSelection {
  schema: string;
  data: unknown;
  summary: string;
  appInstanceId?: string;
  updatedBy: Actor;
  updatedAt: string;
}

export type AppInstanceStatus = "open" | "background" | "closed";

export interface AppInstance {
  project?: ApplicationProject | null;
  appInstanceId: string;
  appType: string;
  resourceIds: string[];
  status: AppInstanceStatus;
  title: string;
  uiState?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceChangeSummary {
  revision: number;
  actor: Actor;
  operationType: string;
  summary: string;
  occurredAt: string;
}

export interface ActiveAppContext {
  appType: string;
  /**
   * The window the document is shown in, when there is a single one.
   *
   * Optional because a document is no longer shown through one window per
   * conversation: it has one tab, shared by every conversation referencing it.
   * Nothing in the injected context depends on it.
   */
  appInstanceId?: string;
  resource: WorkspaceResource;
  capabilities: AppCapability[];
  /** Serialized size on disk. Platform-measured; the adapter is never asked. */
  sizeBytes: number;
  /** Adapter-owned, one line, no positions. See `ContextSummary.shape`. */
  shape: string;
  /** Tool names the model can call on this resource, derived from the adapter. */
  availableToolNames: string[];
  selection?: { schema: string; summary: string };
  changesSinceAgentRevision: ResourceChangeSummary[];
  /** Changes elided by the prompt budget; the Agent can read them on demand. */
  omittedChangeCount: number;
  agentRevision: number;
}

/** What an Adapter is handed to describe the current collaboration state. */
export interface ContextRequest {
  resource: WorkspaceResource;
  content: unknown;
  selection?: AppSelection;
  changes: ResourceChangeSummary[];
}

export interface ContextSummary {
  /**
   * One line naming what this resource is made of — never where anything is.
   *
   * The platform writes the shell around it: kind, size, revision, title. This
   * is the one thing only the application knows:
   *
   *     text         "3 个标题：产品方案 / 目标用户 / 核心功能"
   *     spreadsheet  "3 个工作表，1200 行"
   *     CAD          "一个支架，47 个特征"
   *
   * A count is fine — "8 行", "47 个特征" — because a count is not something a
   * model can pass as an argument. An address is not: "第 3 行", "A1:C5", an
   * offset, an element id.
   *
   * That distinction is not stylistic. This line lands in the prompt beside
   * tools that locate by content, and a real run bridged the two: it read
   * "第 3 行 ## 目标用户" out of this very summary and passed `from: 4` to
   * text.replace — a valid offset in a 33-character document, so the write was
   * accepted, landed in line 1, and was reported as a success.
   *
   * Where something *is* belongs in `selectionSummary`, which describes a place
   * the user chose and may name a position, or in the application's own read
   * tool, which the model calls when it needs to act on a location.
   *
   * The platform bounds this and collapses it to one line; do not pre-truncate.
   */
  shape: string;
  selectionSummary?: string;
}

export interface OperationResult {
  content: unknown;
  summary: string;
  inverse?: { operationType: string; payload: unknown };
}

export interface ExportResult {
  fileName: string;
  mimeType: string;
  body: string | Uint8Array;
}

/**
 * The only code allowed to understand a domain.
 *
 * Every write reaches a resource through `applyOperation`, whether it came from
 * a person typing or from a model calling a tool, so history, versioning and
 * conflict behaviour are identical for both.
 */
export interface WorkbenchRuntimeAdapter {
  definition: ApplicationDefinition;
  /** Validate and normalize the initial payload for a new resource. */
  createContent(input: { kind: string; title: string; initialContent?: unknown }): unknown;
  /**
   * Convert between the adapter's model and the bytes on disk.
   *
   * The file is the source of truth, so these two must round-trip: whatever
   * `serialize` writes, `parse` has to read back as the same model, or an
   * external edit would be misread as a content change.
   */
  serialize(content: unknown): string;
  /** Read-only user-facing projection for revision comparison. Defaults to serialized content. */
  reviewContent?(content: unknown): Promise<string>;
  parse(raw: string, kind: string): unknown;
  /** Apply one validated operation, producing the next content and its summary. */
  applyOperation(input: {
    operationType: string;
    payload: unknown;
    content: unknown;
    actor: Actor;
  }): OperationResult;
  /** Validate durable references before a reducer commits, without changing v1 serialization. */
  validateOperation?(input: {
    operationType: string;
    payload: unknown;
    content: unknown;
    resource: WorkspaceResource;
    signal?: AbortSignal;
  }): Promise<void>;
  /** Bound a selection into something a person and a model can both read. */
  summarizeSelection(input: { selection: { schema: string; data: unknown }; content: unknown }): string;
  /** Describe the resource and its recent changes without the caller parsing content. */
  summarizeContext(input: ContextRequest): ContextSummary;
  /** Compute a draft without saving it; the adapter owns validation and execution. */
  previewResource?(input: {
    content: unknown;
    resource?: WorkspaceResource;
    savedContent?: unknown;
    options?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown>;
  /** App-owned binary derivatives, served only after the resource reference check. */
  readAttachment?(input: { content: unknown; name: string }): Promise<ExportResult>;
  importResource?(input: {
    content: unknown;
    body: Uint8Array;
    signal?: AbortSignal;
  }): ReturnType<AdapterToolDefinition["execute"]>;
  exportResource(input: {
    resource: WorkspaceResource;
    content: unknown;
    format: string;
    options?: Record<string, unknown>;
    signal?: AbortSignal;
  }): ExportResult | Promise<ExportResult>;
  /**
   * Tools that only make sense while this application is bound.
   *
   * Declared rather than registered, so the platform stays the one place that
   * decides when a tool becomes visible to the model.
   */
  agentTools?(input?: { content: unknown }): AdapterToolDefinition[];
}

/**
 * A domain tool an Adapter contributes.
 *
 * It receives the bound resource and returns a plain result. The Adapter never
 * writes the resource itself — it returns operations for the store to apply, so
 * a specialized tool still goes through revision CAS like everything else.
 */
export interface AdapterToolDefinition {
  /** Only explicitly read-only tools are exposed to read-scoped delegates. */
  access?: "read" | "write";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Replacement edits must be based on a snapshot observed by this session. */
  requiresFreshRead?: boolean;
  execute(input: {
    params: Record<string, unknown>;
    content: unknown;
    resource: WorkspaceResource;
    selection?: AppSelection;
    signal?: AbortSignal;
  }): Promise<{
    result: unknown;
    operations?: Array<{ operationType: string; payload: unknown }>;
    /** Optional native image feedback; kept outside JSON/text payloads. */
    images?: Array<{ mimeType: "image/png"; data: string }>;
  }>;
}

export type ApplicationErrorCode =
  | "application_not_found"
  | "resource_not_found"
  | "instance_not_found"
  | "unsupported_resource_kind"
  | "invalid_operation"
  | "revision_conflict"
  | "operation_precondition_failed"
  | "execution_scope_changed"
  | "resource_too_large"
  | "resource_recovery_required"
  | "unsafe_path"
  | "source_file_conflict"
  | "source_file_write_failed";

const errorStatus: Record<ApplicationErrorCode, number> = {
  application_not_found: 404,
  resource_not_found: 404,
  instance_not_found: 404,
  unsupported_resource_kind: 422,
  invalid_operation: 422,
  revision_conflict: 409,
  operation_precondition_failed: 409,
  execution_scope_changed: 409,
  resource_too_large: 413,
  resource_recovery_required: 503,
  unsafe_path: 400,
  source_file_conflict: 409,
  source_file_write_failed: 503
};

const retryable: ApplicationErrorCode[] = [
  "revision_conflict",
  "operation_precondition_failed",
  "resource_recovery_required"
];

/**
 * One error shape for every new Application API and tool.
 *
 * A model that gets `revision_conflict` with the current revision can recover on
 * its own; a model that gets a prose sentence has to guess. Existing APIs keep
 * their old `{ error: string }` format so nothing currently shipped changes.
 */
export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApplicationError";
  }

  get status(): number {
    return errorStatus[this.code];
  }
  get retryable(): boolean {
    return retryable.includes(this.code);
  }

  toJSON(): {
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {})
      }
    };
  }
}

export function applicationErrorResponse(error: unknown): {
  status: number;
  body: ReturnType<ApplicationError["toJSON"]>;
} {
  if (error instanceof ApplicationError) return { status: error.status, body: error.toJSON() };
  const message = error instanceof Error ? error.message : String(error);
  return { status: 400, body: { error: { code: "invalid_operation", message, retryable: false } } };
}

/** Narrow enough that an id can always be one safe path segment. */
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function safeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !identifier.test(value) || value.includes("..")) {
    throw new ApplicationError("unsafe_path", `${field} 不是合法的标识符`, { field });
  }
  return value;
}

export function newResourceId(): string {
  return `res_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
export function newInstanceId(): string {
  return `app_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
export function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function contentVersion(content: unknown): string {
  const serialized = typeof content === "string" ? content : JSON.stringify(content ?? null);
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

/**
 * Hash a string over its UTF-16 units, matching the offset contract.
 *
 * `update(value, "utf8")` maps every unpaired surrogate to U+FFFD, so two
 * different halves of a split character hashed identically — a precondition
 * check whose entire purpose is to refuse a patch aimed at different text
 * would pass on the wrong text. Ranges are UTF-16 offsets, so a range may
 * legitimately split a pair; the hash has to be able to tell the halves apart.
 */
export function textHash(value: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Describe a rejected value without carrying it into the error.
 *
 * Error details travel into tool results, which the session recorder clones with
 * `structuredClone`. Describing rejected values instead of echoing functions or
 * other unclonable objects keeps argument errors safe to record and retry.
 *
 * A description is also what the model actually needs. It already knows what it
 * sent; what it lacks is which field was wrong and what belongs there.
 */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  const type = typeof value;
  if (type === "string") {
    const text = value as string;
    return text.length > 40 ? `string(${text.length})` : JSON.stringify(text);
  }
  if (type === "number" || type === "boolean" || type === "bigint") return String(value);
  return type;
}

/** Bound any Adapter-produced string before it reaches a prompt or a state file. */
export function bounded(value: unknown, limit: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export const RESOURCE_LIMITS = {
  /** Serialized content ceiling for one resource. */
  contentBytes: 2 * 1024 * 1024,
  /** Ceiling for trusted adapter overrides; HTTP leaves room for the operation envelope. */
  maxContentBytes: 32 * 1024 * 1024,
  /** New payload ceiling for one operation. */
  operationBytes: 256 * 1024,
  /** Beyond this the resource is read-only until it is published or copied. */
  operationCount: 10_000,
  /** Default page size when reading history. */
  historyPage: 100,
  selectionSummary: 1_000,
  operationSummary: 500,
  uiStateBytes: 16 * 1024
} as const;

export const CONTEXT_BUDGET = {
  total: 8 * 1024,
  /** One line. Anything longer is not a shape, it is a summary. */
  shape: 240,
  selection: 1_024,
  changeSummary: 500,
  changes: 20
} as const;

export function resourceContentLimit(definition: ApplicationDefinition): number {
  const value = definition.contentBytes ?? RESOURCE_LIMITS.contentBytes;
  if (!Number.isInteger(value) || value < 1 || value > RESOURCE_LIMITS.maxContentBytes)
    throw new Error("Invalid adapter content limit");
  return value;
}
