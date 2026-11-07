/**
 * Preserve a caller's backend credential for model commands only when that
 * backend identifies it as a business session. A host credential is never
 * forwarded, even when a standalone CLI was started with one.
 */
export async function businessCommandEnvironment(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<NodeJS.ProcessEnv> {
  signal?.throwIfAborted();
  const scoped: NodeJS.ProcessEnv = {
    COWORK_API_TOKEN: undefined,
    COWORK_DASHBOARD_URL: env.COWORK_DASHBOARD_URL
  };
  if (!env.COWORK_API_TOKEN || !env.COWORK_DASHBOARD_URL) return scoped;
  try {
    const origin = env.COWORK_DASHBOARD_URL.replace(/\/+$/, "");
    const base = new URL(origin);
    if (!["http:", "https:"].includes(base.protocol) || base.origin !== origin)
      throw new Error("invalid backend origin");
    scoped.COWORK_DASHBOARD_URL = origin;
    const response = await fetch(new URL("/api/session", base), {
      headers: { "x-atria-token": env.COWORK_API_TOKEN },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000)
    });
    signal?.throwIfAborted();
    if (!response.ok) return scoped;
    const result = (await response.json()) as { current?: { kind?: unknown; sessionId?: unknown } };
    if (result.current?.kind === "session" && typeof result.current.sessionId === "string")
      scoped.COWORK_API_TOKEN = env.COWORK_API_TOKEN;
  } catch (error) {
    signal?.throwIfAborted();
    console.warn(
      `[cowork] 无法核验后台命令的业务会话，已移除凭据：${error instanceof Error ? error.name : "Error"}`
    );
  }
  signal?.throwIfAborted();
  return scoped;
}
