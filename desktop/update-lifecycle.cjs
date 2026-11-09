const taskStatuses = new Set(["created", "running", "waiting", "completed", "failed", "cancelled"]);

/** Save the renderer only after confirming idle execution, then confirm it again before host shutdown. */
async function prepareDesktopChange({ backend, documents, action = "更新 Formicand", fetchImpl = fetch }) {
  const unavailable = () => new Error(`无法确认任务运行状态，暂时不能${action}，请稍后重试。`);
  const running = () => new Error(`仍有任务正在运行，请等待任务结束或取消任务后再${action}。`);
  let base;
  try {
    base = new URL(backend?.url);
    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
      !base.port ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      typeof backend?.token !== "string" ||
      !backend.token.trim() ||
      /[\r\n]/.test(backend.token) ||
      typeof fetchImpl !== "function"
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
  if (typeof documents?.request !== "function") throw new Error(`无法保存文档和草稿，暂时不能${action}。`);

  async function get(relative) {
    try {
      const response = await fetchImpl(new URL(relative, base).href, {
        method: "GET",
        headers: { "x-atria-token": backend.token },
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw unavailable();
      return await response.json();
    } catch {
      throw unavailable();
    }
  }
  async function assertIdle() {
    const payload = await get("/api/tasks");
    if (!payload || !Array.isArray(payload.tasks)) throw unavailable();
    const seen = new Set();
    for (const task of payload.tasks) {
      if (
        !task ||
        typeof task.taskId !== "string" ||
        !task.taskId.trim() ||
        seen.has(task.taskId) ||
        !taskStatuses.has(task.status) ||
        (task.activeRunId !== undefined && (typeof task.activeRunId !== "string" || !task.activeRunId.trim()))
      )
        throw unavailable();
      seen.add(task.taskId);
      if (task.status === "running") throw running();
    }
    for (const task of payload.tasks.filter((entry) => entry.activeRunId)) {
      const detail = await get(`/api/tasks/${encodeURIComponent(task.taskId)}`);
      if (
        detail?.task?.taskId !== task.taskId ||
        !taskStatuses.has(detail?.task?.status) ||
        typeof detail?.runtime?.active !== "boolean"
      )
        throw unavailable();
      if (detail.task.status === "running" || detail.runtime.active) throw running();
    }
  }

  await assertIdle();
  let saved;
  try {
    saved = await documents.request();
  } catch {
    throw new Error(`文档和草稿未能保存，请保留当前窗口，保存成功后再${action}。`);
  }
  if (saved !== true) throw new Error(`文档和草稿未能保存，请保留当前窗口，保存成功后再${action}。`);
  await assertIdle();
}

module.exports = { prepareDesktopChange };
