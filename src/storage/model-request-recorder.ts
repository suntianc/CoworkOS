import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelRequestIdentity {
  taskId: string;
  runId: string;
  agentId: string;
}

/** Request archives are separate from the compact UI trace. Never store auth headers. */
export class ModelRequestRecorder {
  private readonly recorderId = randomUUID();
  private writes = Promise.resolve();
  private sequence = 0;
  private readonly producer = recordingProducer();

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
    const snapshot = sanitizeRecording(payload, this.secrets);
    const sequence = ++this.sequence;
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
    this.writes = write.catch(() => {});
    return write;
  }
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
