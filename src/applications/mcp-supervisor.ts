import { resolve } from "node:path";
import type { McpServerSpec } from "./types.js";

/** Tool calls may compute for minutes; startup and discovery retain SDK deadlines. */
export const MCP_TOOL_TIMEOUT_MS = 10 * 60_000;

/**
 * A running application MCP server, or the reason there isn't one.
 *
 * A failure is reported rather than thrown: a server that will not start means
 * this application has no tools of its own, which is a lesser state, not a
 * broken one. Opening a window must still work.
 */
export interface McpServerStatus {
  key: string;
  appType: string;
  state: "running" | "failed";
  pid?: number;
  toolNames: string[];
  error?: string;
  startedAt: string;
}

/** What an application tool returns: a result, plus operations for the platform to apply. */
export interface McpToolOutcome {
  result: unknown;
  operations: Array<{ operationType: string; payload: unknown }>;
}

interface Session {
  key: string;
  appType: string;
  client: {
    listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
    callTool(
      request: unknown,
      resultSchema?: undefined,
      options?: { timeout: number; maxTotalTimeout: number; signal?: AbortSignal }
    ): Promise<unknown>;
    close(): Promise<void>;
  };
  pid?: number;
  toolNames: string[];
  startedAt: string;
}

/**
 * Which open window a tool call is about.
 *
 * Still the unit callers name, because a window is what a person opens and
 * closes. It is no longer the unit a *process* is created for: see
 * `serverKey`.
 */
export function mcpKey(taskId: string, appInstanceId: string): string {
  return `${taskId}:${appInstanceId}`;
}

/**
 * Which document a tool call is about.
 *
 * A document has one tab and one consumer however many conversations
 * reference it. Keying by conversation counted the same document twice, so
 * closing one conversation's view left a consumer nothing would ever release.
 */
export function resourceConsumer(resourceId: string): string {
  return `resource:${resourceId}`;
}

/**
 * Which process serves a window.
 *
 * One process per application, not per window. These servers are stateless by
 * contract: every call carries its document in `atria/resource` metadata and
 * reads the content back over HTTP, so a second process for a second document
 * computes exactly the same answers from exactly the same inputs.
 *
 * Measured before changing it: each window cost its own Node process and about
 * 72 MB, so six open documents held six identical servers and ~490 MB. Sharing
 * makes that one process regardless of how many documents are open — which also
 * matters because relating a standalone editor to a conversation adopts every
 * document it holds, and would otherwise start a server for each one at once.
 *
 * The spec is part of the key: an application whose command, arguments, cwd or
 * environment differ is a different program and must not share a process.
 */
export function serverKey(appType: string, spec: McpServerSpec): string {
  return JSON.stringify([appType, spec.command, spec.args ?? [], spec.cwd ?? null, spec.env ?? null]);
}

/**
 * Owns one MCP server process per open application window.
 *
 * The Dashboard holds these, not the Agent. A window's lifetime is the
 * Dashboard's to manage, while an Agent process is rebuilt for every run — if
 * the Agent owned the server, the window would still be open with its server
 * already dead. Stdio ownership cannot be handed over, so the Agent reaches
 * these through HTTP instead.
 *
 * Process management follows `src/tools/jobs.ts`: the child gets its own group
 * so stopping it takes the whole pipeline, and a SIGTERM is given a grace
 * period before SIGKILL.
 */
export class McpSupervisor {
  private readonly sessions = new Map<string, Promise<Session | McpServerStatus>>();
  private readonly ready = new Map<string, Session>();
  private readonly failures = new Map<string, McpServerStatus>();
  /**
   * Which windows each process serves, and which process each window uses.
   *
   * A shared process may only be stopped once the last window using it has
   * gone: without the count, closing one document would take the tools away
   * from every other document still open in that application.
   */
  private readonly users = new Map<string, Set<string>>();
  private readonly windowServer = new Map<string, string>();

  /**
   * @param dashboardUrl Where this Dashboard answers. A server reads its
   * resources back through the HTTP API, so it has to be told which Dashboard
   * is its own — assuming the default port breaks every non-default instance,
   * including every test.
   */
  constructor(
    private readonly harnessRoot: string,
    private readonly dashboardUrl: string,
    private readonly graceMs = 3_000,
    private readonly toolTimeoutMs = MCP_TOOL_TIMEOUT_MS
  ) {
    if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > MCP_TOOL_TIMEOUT_MS)
      throw new Error("MCP tool timeout must be between 1 and 600000ms");
  }

  /**
   * Attach this window to its application's server, starting it if needed.
   *
   * The in-flight promise is stored rather than the finished session: starting
   * a process is slow, and a second caller arriving in that window would
   * otherwise spawn a second server that nothing could ever stop.
   */
  async ensure(input: { consumer: string; appType: string; spec?: McpServerSpec }): Promise<McpServerStatus> {
    const window = input.consumer;
    if (!input.spec) {
      // Most applications declare no server. That is not a failure and must not
      // be recorded as one.
      return {
        key: window,
        appType: input.appType,
        state: "failed",
        toolNames: [],
        error: "这个应用没有声明 MCP 服务器",
        startedAt: new Date().toISOString()
      };
    }
    const key = serverKey(input.appType, input.spec);
    // Recorded before the await: a window that asked for this server must be
    // counted even if another caller is still starting it.
    this.windowServer.set(window, key);
    (this.users.get(key) ?? this.users.set(key, new Set()).get(key)!).add(window);

    const existing = this.sessions.get(key);
    if (existing) return this.describe(window, input.appType, await existing);

    const starting = this.start(key, input.appType, input.spec);
    this.sessions.set(key, starting);
    this.failures.delete(key);
    const settled = await starting;
    // A failed start must not be cached as a session: the next open should try
    // again rather than report a stale failure forever.
    if (this.sessions.get(key) === starting) {
      if (!("client" in settled)) {
        this.sessions.delete(key);
        this.failures.set(key, settled);
      } else {
        this.ready.set(key, settled);
      }
    }
    return this.describe(window, input.appType, settled);
  }

  private async start(key: string, appType: string, spec: McpServerSpec): Promise<Session | McpServerStatus> {
    const startedAt = new Date().toISOString();
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ? resolve(this.harnessRoot, spec.cwd) : this.harnessRoot,
        // The server's own env, on top of ours: it may need a token or a path
        // we do not know about.
        env: {
          ...(process.env as Record<string, string>),
          ATRIA_DASHBOARD_URL: this.dashboardUrl,
          ...(spec.env ?? {})
        },
        // Captured instead of inherited, so a chatty server cannot scribble
        // over the Dashboard's own output.
        stderr: "pipe"
      });
      const client = new Client({ name: "atria-workbench", version: "1" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      return {
        key,
        appType,
        client: client as unknown as Session["client"],
        pid: transport.pid ?? undefined,
        toolNames: tools.map((tool) => tool.name),
        startedAt
      };
    } catch (error) {
      return {
        key,
        appType,
        state: "failed",
        toolNames: [],
        error: error instanceof Error ? error.message : String(error),
        startedAt
      };
    }
  }

  /** The tools this window's server offers, in Pi's parameter shape. */
  async listTools(
    consumer: string
  ): Promise<Array<{ name: string; description: string; parameters: Record<string, unknown> }>> {
    const session = await this.sessionForWindow(consumer);
    if (!session) return [];
    const { tools } = await session.client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      // An absent schema still has to be a valid object schema, or the model
      // provider rejects the whole tool list.
      parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
        type: "object",
        properties: {}
      }
    }));
  }

  /**
   * Call a tool, telling the server which resource it is working on.
   *
   * The resource travels as request metadata rather than as a parameter, so a
   * server cannot be aimed at someone else's document by a model that invents
   * an id, and a tool's own parameters stay about its domain.
   */
  async callTool(input: {
    consumer: string;
    taskId: string;
    name: string;
    params: Record<string, unknown>;
    resource: { resourceId: string; revision: number; path?: string; kind?: string };
    signal?: AbortSignal;
  }): Promise<McpToolOutcome> {
    input.signal?.throwIfAborted();
    const window = input.consumer;
    const session = await this.sessionForWindow(window);
    if (!session) {
      const failure = this.failures.get(this.windowServer.get(window) ?? "");
      throw new Error(failure?.error ?? "这个应用窗口没有可用的 MCP 服务器");
    }
    input.signal?.throwIfAborted();
    const response = (await session.client.callTool(
      {
        name: input.name,
        arguments: input.params,
        _meta: { "atria/resource": input.resource, "atria/task": { taskId: input.taskId } }
      },
      undefined,
      { timeout: this.toolTimeoutMs, maxTotalTimeout: this.toolTimeoutMs, signal: input.signal }
    )) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: { atria?: { operations?: unknown } };
    };
    input.signal?.throwIfAborted();
    const text = (response.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    if (response.isError) throw new Error(text || `${input.name} 调用失败`);
    // Operations are read from a namespaced key so a server's own structured
    // output cannot be mistaken for instructions to write.
    const declared = response.structuredContent?.atria?.operations;
    const operations = Array.isArray(declared)
      ? declared.filter(
          (entry): entry is { operationType: string; payload: unknown } =>
            Boolean(entry) && typeof (entry as { operationType?: unknown }).operationType === "string"
        )
      : [];
    return { result: response.structuredContent?.atria ?? text, operations };
  }

  /** Stop this window's server; the child exits with its transport. */
  async stop(consumer: string): Promise<void> {
    const window = consumer;
    const key = this.windowServer.get(window);
    this.windowServer.delete(window);
    if (!key) return;
    // One process serves every window of an application, so it may only be
    // ended once the last of them has closed. Stopping it on the first close
    // took the tools away from every document still open.
    const remaining = this.users.get(key);
    remaining?.delete(window);
    if (remaining && remaining.size > 0) return;
    this.users.delete(key);
    this.ready.delete(key);
    this.failures.delete(key);
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (!pending) return;
    // eslint-disable-next-line no-restricted-syntax -- 启动失败的服务器已由 this.failures 记录原因，这里只需要判断有没有可用 client
    const settled = await pending.catch(() => undefined);
    if (!settled || !("client" in settled)) return;
    const pid = settled.pid;
    // eslint-disable-next-line no-restricted-syntax -- transport 关闭失败不影响随后的 reap 结束子进程
    await settled.client.close().catch(() => {});
    // Closing the transport normally ends the child. Verify rather than assume:
    // a server that ignores a closed pipe would otherwise linger for the life
    // of the Dashboard.
    if (pid !== undefined) await this.reap(pid);
  }

  private async reap(pid: number): Promise<void> {
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline) {
      if (!alive()) return;
      await new Promise((settle) => setTimeout(settle, 50));
    }
    // Negative pid: the child was given its own group, so this takes anything
    // it started with it rather than orphaning the real work.
    try {
      process.kill(-pid, "SIGKILL");
      // eslint-disable-next-line no-restricted-syntax -- 子进程组可能已经不存在，此时按单个 pid 再杀一次
    } catch {
      try {
        process.kill(pid, "SIGKILL");
        // eslint-disable-next-line no-restricted-syntax -- 子进程已退出，SIGKILL 找不到目标属于正常结束
      } catch {
        /* already gone */
      }
    }
  }

  /** Stop every server. The Dashboard calls this on the way out. */
  async stopAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    this.windowServer.clear();
    this.users.clear();
    // eslint-disable-next-line no-restricted-syntax -- 退出流程里单个服务器关闭失败不应阻止其余服务器清理
    await Promise.all(keys.map((key) => this.stopServer(key).catch(() => {})));
  }

  /** End one process outright, regardless of who was using it. */
  private async stopServer(key: string): Promise<void> {
    this.ready.delete(key);
    this.failures.delete(key);
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (!pending) return;
    // eslint-disable-next-line no-restricted-syntax -- 该服务器的启动失败已记录在 this.failures，这里没有 client 就无需停止
    const settled = await pending.catch(() => undefined);
    if (!settled || !("client" in settled)) return;
    const pid = settled.pid;
    // eslint-disable-next-line no-restricted-syntax -- transport 关闭失败不影响随后的 reap 结束子进程
    await settled.client.close().catch(() => {});
    if (pid !== undefined) await this.reap(pid);
  }

  /** Last settled status, without waiting for another application's startup. */
  async statuses(): Promise<McpServerStatus[]> {
    // Reported per window, which is what the strip and the composer ask about:
    // "does this document's application have its tools?" Several windows now
    // name the same pid, and that is the point.
    return [...this.windowServer.entries()].flatMap(([window, key]) => {
      const settled = this.ready.get(key) ?? this.failures.get(key);
      return settled ? [{ ...this.describe(window, settled.appType, settled), key: window }] : [];
    });
  }

  /** The process serving this window, if it has one running. */
  private async sessionForWindow(window: string): Promise<Session | undefined> {
    const key = this.windowServer.get(window);
    return key ? this.session(key) : undefined;
  }

  private async session(key: string): Promise<Session | undefined> {
    const pending = this.sessions.get(key);
    if (!pending) return undefined;
    // eslint-disable-next-line no-restricted-syntax -- 启动失败的原因已由 this.failures 交给 callTool 上报，这里只判断能否拿到 client
    const settled = await pending.catch(() => undefined);
    return settled && "client" in settled ? settled : undefined;
  }

  private describe(key: string, appType: string, settled: Session | McpServerStatus): McpServerStatus {
    if (!("client" in settled)) return settled;
    return {
      key,
      appType,
      state: "running",
      pid: settled.pid,
      toolNames: settled.toolNames,
      startedAt: settled.startedAt
    };
  }
}
