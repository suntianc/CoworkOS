/**
 * The Main-side client for delegation.
 *
 * It addresses one Task, never a project or a path: the backend resolves the
 * Task's Run, requirement checkout and role connection from its own records.
 * The host credential stays in this process; only the scoped request leaves it.
 */
export interface SubagentClient {
  dispatch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancel(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const TASK_ID = /^[A-Za-z0-9._-]+$/;
const TIMEOUT_MS = 30_000;

/** Whether this run asks a backend to dispatch; a CLI run with no service keeps its own path. */
export function subagentBackendConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.COWORK_DASHBOARD_URL && env.COWORK_API_TOKEN);
}

function loopback(dashboardUrl: string): string {
  let url: URL;
  try {
    url = new URL(dashboardUrl);
  } catch {
    throw new Error("子代理派单不可用：本地服务地址无效");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("子代理派单不可用：本地服务地址不是回环 HTTP 地址");
  return url.origin;
}

export function createSubagentClient(options: {
  dashboardUrl?: string;
  taskId: string;
  token?: string;
}): SubagentClient {
  const dashboardUrl = options.dashboardUrl ?? process.env.COWORK_DASHBOARD_URL;
  if (!dashboardUrl) throw new Error("子代理派单不可用：本次运行没有本地服务地址");
  const origin = loopback(dashboardUrl);
  if (!TASK_ID.test(options.taskId)) throw new Error("子代理派单不可用：当前会话 ID 不合法");
  const token = options.token ?? process.env.COWORK_API_TOKEN;
  if (!token) throw new Error("子代理派单不可用：本次运行没有本地服务凭据");
  const base = `${origin}/api/tasks/${encodeURIComponent(options.taskId)}/subagents`;

  const send = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(base, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "x-atria-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    // eslint-disable-next-line no-restricted-syntax -- 失败响应可能不是 JSON（代理或网关返回 HTML），解析失败用空对象兜底，错误文案退回 HTTP 状态码
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(
        typeof payload.error === "string" && payload.error
          ? payload.error
          : `子代理派单失败（HTTP ${response.status}）`
      );
    return payload;
  };

  return {
    dispatch: (input) => send({ action: "dispatch", ...input }),
    cancel: (input) => send({ action: "cancel", ...input })
  };
}
