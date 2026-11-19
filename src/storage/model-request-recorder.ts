import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelRequestIdentity {
  taskId: string;
  runId: string;
  agentId: string;
}

/**
 * The fields of a request body that hold the conversation, by provider API.
 * Each request resends the whole conversation, so this is the array the
 * archive stores as "what is new since the last request".
 */
const HISTORY_FIELDS = ["input", "messages", "contents"] as const;

/** One earlier request this recorder can build the next one on. */
interface ArchiveBase {
  sequence: number;
  field: string;
  /** Serialized history items, so a shared prefix is found by comparing strings. */
  items: string[];
  /** Every other top-level body field, serialized. */
  fields: Map<string, string>;
  systemPromptSha256?: string;
  toolsSha256?: string;
}

/** How a `model_request` row refers to the earlier request it extends. */
export interface ArchivedRequestBase {
  /** `sequence` of the earlier row written by the same recorder. */
  sequence: number;
  /** The body field holding the conversation. */
  field: string;
  /** How many leading items of that field are the earlier request's. */
  reused: number;
  /** SHA-256 of those reused items as JSON, to reject a broken chain. */
  reusedSha256: string;
  /** Top-level body fields equal to the earlier request's, omitted here. */
  same: string[];
}

/**
 * Request archives are separate from the compact UI trace. Never store auth headers.
 *
 * Every request carries the whole conversation, so archiving each body in full
 * grows by the square of the conversation: one long Run reached 114MB. A
 * request that extends an earlier one written by this recorder therefore keeps
 * only what is new — the history items after the shared prefix and the body
 * fields that changed — plus a reference and hash of what it reuses; the
 * system prompt and tools are written when their hash changes. The first
 * request of a recorder, and one after compaction rewrote the history, is
 * written in full. `parseModelRequestArchive` rebuilds every row exactly.
 */
export class ModelRequestRecorder {
  private readonly recorderId = randomUUID();
  private writes = Promise.resolve();
  private sequence = 0;
  private readonly producer = recordingProducer();
  /** The last few requests, so an interleaved summary call does not break Main's chain. */
  private bases: ArchiveBase[] = [];

  constructor(
    readonly filePath: string,
    readonly identity: ModelRequestIdentity,
    private readonly secrets: readonly string[] = []
  ) {}

  record(
    type: "model_request" | "model_response" | "model_response_http",
    requestId: string,
    payload: unknown
  ) {
    // Serialize now: provider contexts and streaming messages are mutable.
    const sequence = ++this.sequence;
    const sanitized = sanitizeRecording(payload, this.secrets);
    const snapshot = type === "model_request" ? this.compact(sequence, sanitized) : sanitized;
    const occurredAt = new Date().toISOString();
    const write = this.writes.then(async () => {
      const line = JSON.stringify({
        schemaVersion: 1,
        eventId: randomUUID(),
        type,
        ...this.identity,
        requestId,
        recorderId: this.recorderId,
        sequence,
        occurredAt,
        producer: await this.producer,
        payload: snapshot
      });
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    });
    // One failed write must not poison every future attempt. The caller still sees it.
    // eslint-disable-next-line no-restricted-syntax -- 调用方拿到的是上面的 write（本次失败仍会上报），这里只让串行链继续接受后续记录，不能因为一次落盘失败让之后的归档全部拒绝
    this.writes = write.catch(() => {
      // A later row must not refer to one that never reached the disk.
      this.bases = [];
    });
    return write;
  }

  /** The request payload as written: what is new against the closest earlier request. */
  private compact(sequence: number, payload: unknown): unknown {
    if (!isRecord(payload)) return payload;
    const { systemPromptSha256, toolsSha256 } = payload;
    const request = payload.request;
    const field = isRecord(request)
      ? HISTORY_FIELDS.find((name) => Array.isArray(request[name]))
      : undefined;
    if (!isRecord(request) || !field) return payload;
    const history = request[field] as unknown[];
    const items = history.map((item) => JSON.stringify(item));
    const fields = new Map(
      Object.entries(request)
        .filter(([key]) => key !== field)
        .map(([key, value]) => [key, JSON.stringify(value)])
    );
    // The earlier request sharing the longest prefix is the one this extends.
    let previous: ArchiveBase | undefined;
    let reused = 0;
    for (const candidate of this.bases) {
      if (candidate.field !== field) continue;
      let shared = 0;
      while (shared < candidate.items.length && candidate.items[shared] === items[shared]) shared++;
      if (shared > reused) [previous, reused] = [candidate, shared];
    }
    this.bases = [
      ...this.bases.slice(-3),
      {
        sequence,
        field,
        items,
        fields,
        systemPromptSha256: systemPromptSha256 as string | undefined,
        toolsSha256: toolsSha256 as string | undefined
      }
    ];
    // Nothing shared: a new conversation or a rewritten one is written in full.
    if (!previous || reused === 0) return payload;
    const same = [...fields].filter(([key, value]) => previous.fields.get(key) === value).map(([key]) => key);
    const base: ArchivedRequestBase = {
      sequence: previous.sequence,
      field,
      reused,
      reusedSha256: recordingHash(history.slice(0, reused)),
      same
    };
    const { systemPrompt, tools, request: _request, ...rest } = payload;
    return {
      ...rest,
      ...(previous.systemPromptSha256 === systemPromptSha256 ? {} : { systemPrompt }),
      ...(previous.toolsSha256 === toolsSha256 ? {} : { tools }),
      request: Object.fromEntries([
        ...Object.entries(request).filter(([key]) => key !== field && !same.includes(key)),
        [field, history.slice(reused)]
      ]),
      requestBase: base
    };
  }
}

/**
 * Rebuild every row of a request archive as it was sent.
 *
 * A row that extends an earlier one gets back its full `request`, `systemPrompt`
 * and `tools`; `requestBase` is removed. A row whose base is missing or whose
 * reused prefix does not match its hash is an error, not a guess.
 */
export function parseModelRequestArchive(text: string): Array<Record<string, unknown>> {
  const full = new Map<string, Record<string, unknown>>();
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const payload = row.payload;
    if (row.type === "model_request" && isRecord(payload)) {
      const key = (sequence: unknown) => `${String(row.recorderId)}:${String(sequence)}`;
      const base = payload.requestBase as ArchivedRequestBase | undefined;
      let rebuilt: Record<string, unknown> = payload;
      if (base) {
        const earlier = full.get(key(base.sequence));
        if (!earlier) throw new Error(`request archive row ${String(row.sequence)} refers to a missing request`);
        const earlierRequest = earlier.request as Record<string, unknown>;
        const reused = (earlierRequest[base.field] as unknown[]).slice(0, base.reused);
        if (recordingHash(reused) !== base.reusedSha256)
          throw new Error(`request archive row ${String(row.sequence)} does not match the request it extends`);
        const { requestBase: _base, ...rest } = payload;
        const request = payload.request as Record<string, unknown>;
        rebuilt = {
          ...rest,
          systemPrompt: "systemPrompt" in payload ? payload.systemPrompt : earlier.systemPrompt,
          tools: "tools" in payload ? payload.tools : earlier.tools,
          request: Object.fromEntries(
            Object.keys({ ...earlierRequest, ...request })
              .filter((name) => name in request || base.same.includes(name))
              .map((name) => [
                name,
                name === base.field
                  ? [...reused, ...(request[name] as unknown[])]
                  : name in request
                    ? request[name]
                    : earlierRequest[name]
              ])
          )
        };
      }
      full.set(key(row.sequence), rebuilt);
      rows.push({ ...row, payload: rebuilt });
    } else rows.push(row);
  }
  return rows;
}

export async function readModelRequestArchive(path: string): Promise<Array<Record<string, unknown>>> {
  return parseModelRequestArchive(await readFile(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function recordingHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Preserve token counts and tool schemas; redact credential values, not broad key substrings. */
export function sanitizeRecording(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    const replaced = secrets
      .filter(Boolean)
      .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
    // Wire tool arguments and structured tool results are often JSON-encoded strings.
    // Preserve their exact representation unless a nested credential needs redaction.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value);
        const sanitized = sanitizeRecording(parsed, secrets);
        if (JSON.stringify(sanitized) !== JSON.stringify(parsed)) return JSON.stringify(sanitized);
        // eslint-disable-next-line no-restricted-syntax -- 该字符串只是形如 JSON 的普通文本，解析失败时按脱敏后的原文本返回，不改变记录内容
      } catch {
        // Plain text that resembles JSON remains plain text.
      }
    }
    return replaced;
  }
  if (Array.isArray(value)) return value.map((child) => sanitizeRecording(child, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /^(api[_-]?key|authorization|password|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret)$/i.test(
        key
      ) && typeof child === "string"
        ? "[REDACTED]"
        : sanitizeRecording(child, secrets)
    ])
  );
}

export async function recordingProducer() {
  // Both compiled dist/src/storage and direct source layouts are supported.
  for (const relative of ["../../../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
      if (
        !["coworkos", "coworkos-app", "atria-cowork-cli", "cowork-harness", "coworkos-cli"].includes(pkg.name)
      )
        continue;
      return {
        name: "CoworkOS",
        version: pkg.version,
        piAgentCore: pkg.dependencies?.["@earendil-works/pi-agent-core"],
        piAi: pkg.dependencies?.["@earendil-works/pi-ai"],
        piCodingAgent: pkg.dependencies?.["@earendil-works/pi-coding-agent"]
      };
      // eslint-disable-next-line no-restricted-syntax -- 源码直跑或打包布局下候选位置可能没有可读的 package.json，失败时继续尝试另一种布局，最终回退到 unknown 版本
    } catch {
      // An unavailable manifest does not discard the request itself.
    }
  }
  return { name: "CoworkOS", version: "unknown" };
}
