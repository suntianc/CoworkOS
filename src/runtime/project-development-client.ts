/**
 * The Main-side client for requirement development records and their reviews.
 *
 * It addresses one Task, never a project id: the Dashboard resolves the Task's
 * project from its own catalog, so an Agent cannot name a project it is not
 * working in. The host credential stays in this process; only the scoped
 * request leaves it.
 */
export interface ProjectDevelopmentClientError extends Error {
  status?: number;
  code?: string;
  currentRevision?: number;
  developmentId?: string;
}

export interface ProjectDevelopmentClient {
  (input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Fixed-candidate review facts for the same Task. */
  reviews(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The project merge entry for the same Task. */
  merges(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Delivery receipts and the development view for the same Task. */
  deliveries(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const TASK_ID = /^[A-Za-z0-9._-]+$/;
const TIMEOUT_MS = 10_000;

function loopback(dashboardUrl: string): string {
  let url: URL;
  try {
    url = new URL(dashboardUrl);
  } catch {
    throw new Error("需求开发工具不可用：本地服务地址无效");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("需求开发工具不可用：本地服务地址不是回环 HTTP 地址");
  return url.origin;
}

/**
 * Build the client, or explain why this run cannot record a development.
 *
 * Every check lives here rather than at registration: a delegated subprocess
 * keeps the Dashboard URL while the run credential is deliberately removed, and
 * a missing credential must cost that one tool call, not the extension.
 */
export function createProjectDevelopmentClient(options: {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}): ProjectDevelopmentClient {
  const origin = loopback(options.dashboardUrl);
  if (!TASK_ID.test(options.taskId)) throw new Error("需求开发工具不可用：当前会话 ID 不合法");
  const token = options.token ?? process.env.COWORK_API_TOKEN;
  if (!token) throw new Error("需求开发工具不可用：本次运行没有本地服务凭据");
  const base = `${origin}/api/tasks/${encodeURIComponent(options.taskId)}`;

  const send = async (
    path: "developments" | "reviews" | "merges" | "deliveries",
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}/${path}`, {
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
          : `需求开发请求失败（HTTP ${response.status}）`
      ) as ProjectDevelopmentClientError;
      error.status = response.status;
      if (typeof body.code === "string") error.code = body.code;
      if (typeof body.currentRevision === "number") error.currentRevision = body.currentRevision;
      if (typeof body.developmentId === "string") error.developmentId = body.developmentId;
      throw error;
    }
    return body;
  };

  const request = ((input: Record<string, unknown>) =>
    send("developments", input)) as ProjectDevelopmentClient;
  request.reviews = (input) => send("reviews", input);
  request.merges = (input) => send("merges", input);
  request.deliveries = (input) => send("deliveries", input);
  return request;
}
