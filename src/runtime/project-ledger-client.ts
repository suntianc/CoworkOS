/**
 * The Main-side client for the project ledger.
 *
 * It addresses one Task, never a project id: the Dashboard resolves the Task's
 * project from its own catalog, so an Agent cannot name a project it is not
 * working in. The host credential stays in this process; only the scoped
 * request leaves it.
 */
export interface ProjectLedgerClientError extends Error {
  status?: number;
  code?: string;
  currentRevision?: number;
}

export interface ProjectLedgerClient {
  request(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const TASK_ID = /^[A-Za-z0-9._-]+$/;
const TIMEOUT_MS = 10_000;

function loopback(dashboardUrl: string): string {
  let url: URL;
  try {
    url = new URL(dashboardUrl);
  } catch {
    throw new Error("台账工具需要本地服务地址");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("台账工具只连接本机服务");
  return url.origin;
}

export function createProjectLedgerClient(options: {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}): ProjectLedgerClient {
  const origin = loopback(options.dashboardUrl);
  if (!TASK_ID.test(options.taskId)) throw new Error("台账工具需要当前会话 ID");
  const token = options.token ?? process.env.COWORK_API_TOKEN;
  if (!token) throw new Error("台账工具需要当前运行的本地服务凭据");
  const endpoint = `${origin}/api/tasks/${encodeURIComponent(options.taskId)}/ledger`;
  return {
    async request(input) {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "x-atria-token": token },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const error = new Error(
          typeof body.error === "string" && body.error
            ? body.error
            : `台账请求失败（HTTP ${response.status}）`
        ) as ProjectLedgerClientError;
        error.status = response.status;
        if (typeof body.code === "string") error.code = body.code;
        if (typeof body.currentRevision === "number") error.currentRevision = body.currentRevision;
        throw error;
      }
      return body;
    }
  };
}
