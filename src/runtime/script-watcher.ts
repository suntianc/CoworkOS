import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { isIP } from "node:net";
import { access, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import type { WebToolOptions } from "../tools/web-tools.js";
import type { VirtualAgentSpec } from "../domain/watch.js";
import { validateObservation, type WatcherEvent, type WatcherPoller } from "./watcher.js";

export interface ScriptWatcherOptions {
  watcherId: string;
  monitor: VirtualAgentSpec;
  workDirectory: string;
  web?: WebToolOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface ScriptWatcherContext {
  watcherId: string;
  task: string;
  sources: string[];
  previousState: unknown;
  readState: () => Promise<unknown>;
  writeState: (value: unknown) => Promise<void>;
  fetchUrl: (url: string) => Promise<unknown>;
  searchWeb: (query: string) => Promise<unknown>;
}
interface Checkpoint {
  formatVersion: 1;
  state: unknown;
  events: WatcherEvent[];
}

/** A bounded child process observes; one atomic checkpoint commits cursor and outbox together. */
export class ScriptWatcher implements WatcherPoller {
  readonly watcherId: string;
  private readonly checkpointPath: string;
  constructor(private readonly options: ScriptWatcherOptions) {
    this.watcherId = options.watcherId;
    if (!this.watcherId.trim()) throw new Error("watcherId must not be empty");
    this.checkpointPath = join(options.workDirectory, "watcher", "checkpoint.json");
  }
  async hasEntrypoint(): Promise<boolean> {
    return Boolean(await this.findEntrypoint());
  }
  async poll(): Promise<WatcherEvent[]> {
    return withFileLock(this.checkpointPath, async () => {
      const previous = await this.readCheckpoint();
      // Retry delivery without refetching a source that may have disappeared.
      if (previous.events.length) return previous.events;
      const entrypoint = await this.findEntrypoint();
      if (!entrypoint) throw new Error("monitor has no watcher/rule.mjs");
      const result = await this.execute(entrypoint, previous.state);
      const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const raw = Array.isArray(result) ? result : Array.isArray(record.events) ? record.events : [];
      if (raw.length > 100) throw new Error("watcher emitted more than 100 events");
      const events = raw.map((value) => normalizeEvent(this.watcherId, value));
      for (const event of events) validateObservation(event);
      const state = Object.hasOwn(record, "state") ? record.state : previous.state;
      const checkpoint: Checkpoint = { formatVersion: 1, state, events };
      if (Buffer.byteLength(JSON.stringify(checkpoint)) > 1_048_576)
        throw new Error("watcher checkpoint exceeds 1 MiB");
      await this.commit(checkpoint);
      return events;
    });
  }
  /** Called only after every returned event reached the idempotent Inbox. */
  async acknowledge(events: WatcherEvent[]): Promise<void> {
    await withFileLock(this.checkpointPath, async () => {
      const current = await this.readCheckpoint();
      const delivered = new Set(events.map((event) => event.dedupeKey));
      await this.commit({
        ...current,
        events: current.events.filter((event) => !delivered.has(event.dedupeKey))
      });
    });
  }
  private async commit(checkpoint: Checkpoint): Promise<void> {
    await atomicWrite(this.checkpointPath, checkpoint);
    // Compatibility projection; checkpoint.json is authoritative after migration.
    await atomicWrite(join(this.options.workDirectory, "watcher", "state.json"), checkpoint.state ?? {});
  }
  private async readCheckpoint(): Promise<Checkpoint> {
    try {
      const value = JSON.parse(await readFile(this.checkpointPath, "utf8")) as Checkpoint;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- checkpoint.json 是磁盘文件，旧版本写入的格式版本和事件数组必须按运行期内容校验
      if (value.formatVersion !== 1 || !Array.isArray(value.events))
        throw new Error("unsupported watcher checkpoint");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let state: unknown = {};
    try {
      state = JSON.parse(await readFile(join(this.options.workDirectory, "watcher", "state.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { formatVersion: 1, state, events: [] };
  }
  private async findEntrypoint(): Promise<string | undefined> {
    for (const name of ["rule.mjs", "rule.js"]) {
      const path = join(this.options.workDirectory, "watcher", name);
      try {
        await access(path);
        return path;
        // eslint-disable-next-line no-restricted-syntax -- access 失败只表示这个候选文件名不存在，继续试下一个，最终返回 undefined 表示没有入口
      } catch {
        /* next supported filename */
      }
    }
    return undefined;
  }
  private execute(entrypoint: string, previousState: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL("./script-watcher-worker.js", import.meta.url)), [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--max-old-space-size=64"],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG }
      });
      const timeoutMs = Math.max(50, this.options.timeoutMs ?? 30_000);
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", abort);
        child.kill("SIGKILL");
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => finish(new Error("watcher cancelled"));
      this.options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => finish(new Error(`watcher rule timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => finish(new Error(`watcher process exited before returning (${code})`)));
      child.on("message", (message: { error?: string; result?: unknown }) => {
        if (message.error) finish(new Error(message.error));
        else finish(undefined, message.result);
      });
      if (this.options.signal?.aborted) {
        abort();
        return;
      }
      child.send({
        entrypoint,
        watcherId: this.watcherId,
        task: this.options.monitor.task,
        sources: this.options.monitor.sourcesHint ?? [],
        previousState,
        timeoutMs,
        web: {
          ...this.options.web,
          serperApiKey:
            this.options.web?.serperApiKey ?? process.env.COWORK_SERPER_API_KEY ?? process.env.SERPER_API_KEY
        }
      });
    });
  }
}
async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

function normalizeEvent(watcherId: string, raw: unknown): WatcherEvent {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { payload: raw };
  const payload = value.payload ?? raw;
  const stable =
    typeof value.dedupeKey === "string" && value.dedupeKey.trim()
      ? value.dedupeKey
      : createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
  return {
    watcherId,
    source: typeof value.source === "string" && value.source.trim() ? value.source : "virtual-agent-script",
    type: typeof value.type === "string" && value.type.trim() ? value.type : "watcher.script_observation",
    dedupeKey: stable,
    payload,
    priority: typeof value.priority === "number" ? value.priority : 1,
    occurredAt: typeof value.occurredAt === "string" ? value.occurredAt : new Date().toISOString()
  };
}

export async function fetchPublicUrl(rawUrl: string, timeoutMs: number): Promise<unknown> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("watcher fetchUrl only supports http/https");
  if (isUnsafeHost(url.hostname))
    throw new Error("watcher fetchUrl refuses localhost/private network targets");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { "user-agent": "CoworkOS/0.1", accept: "text/html,text/plain,application/json" }
    });
    if (Number(response.headers.get("content-length")) > 262_144)
      throw new Error("watcher response exceeds 256 KiB");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 262_144) {
          controller.abort();
          throw new Error("watcher response exceeds 256 KiB");
        }
        chunks.push(chunk);
      }
    }
    const content = Buffer.concat(chunks).toString("utf8");
    return {
      url: url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      content
    };
  } finally {
    clearTimeout(timer);
  }
}

function isUnsafeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    ["localhost", "localhost.localdomain", "metadata.google.internal"].includes(host) ||
    host.endsWith(".localhost")
  )
    return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(host) === 6)
    return (
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    );
  return false;
}

export async function searchPublicWeb(
  query: string,
  options: WebToolOptions | undefined,
  timeoutMs: number
): Promise<unknown> {
  const apiKey = options?.serperApiKey ?? process.env.COWORK_SERPER_API_KEY ?? process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("watcher searchWeb requires COWORK_SERPER_API_KEY");
  const endpoint = options?.serperEndpoint ?? "https://google.serper.dev/search";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      redirect: "error",
      headers: { "content-type": "application/json", "X-API-KEY": apiKey, "user-agent": "CoworkOS/0.1" },
      body: JSON.stringify({ q: query, num: options?.maxResults ?? 10 })
    });
    if (!response.ok) throw new Error(`watcher searchWeb HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
