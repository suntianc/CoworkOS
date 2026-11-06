const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** Keep bootstrap credentials in the host and bind authorization to a selected local data root. */
function createBackendAuthorization({ appRoot, fetchImpl = fetch }) {
  let selected;
  async function inspect(home) {
    if (typeof home !== "string" || !path.isAbsolute(home) || home.length > 4096 || home.includes("\0"))
      throw new Error("无效的后端数据目录");
    const entry = path.join(appRoot, "dist/src/dashboard/backend-instance.js");
    const { backendPaths, readBackendInstance, readBackendIdentity, processIsAlive } = await import(
      pathToFileURL(entry).href
    );
    const paths = backendPaths(home);
    const instance = (await readBackendInstance(paths)).value;
    const identity = (await readBackendIdentity(paths)).value;
    if (!instance || !identity || identity.backendId !== instance.backendId)
      throw new Error("后端身份记录无效或不一致");
    let url;
    try {
      url = new URL(instance.url);
    } catch {
      throw new Error("后端地址无效");
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      Number(url.port) !== instance.port ||
      url.origin !== instance.url ||
      !processIsAlive(instance.pid)
    )
      throw new Error("后端地址或进程无效");
    const response = await fetchImpl(`${instance.url}/api/backend`, {
      headers: { "x-atria-token": instance.token },
      redirect: "error",
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error("无法验证后端身份");
    const info = await response.json();
    if (info.backendId !== instance.backendId || info.pid !== instance.pid)
      throw new Error("后端身份与实例记录不一致");
    return instance;
  }
  return {
    async select(home) {
      const instance = await inspect(home);
      selected = { home, backendId: instance.backendId, url: instance.url };
      return { backendId: instance.backendId, url: instance.url };
    },
    async authorize(input) {
      if (
        !selected ||
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        input.baseUrl !== selected.url ||
        input.backendId !== selected.backendId ||
        typeof input.clientName !== "string" ||
        !input.clientName.trim() ||
        input.clientName.length > 120 ||
        // eslint-disable-next-line no-control-regex
        /[\x00-\x1f\x7f]/u.test(input.clientName) ||
        typeof input.protocolVersion !== "string" ||
        !/^\d{1,4}\.\d{1,4}$/u.test(input.protocolVersion)
      )
        throw new Error("后端授权参数或身份不一致");
      const instance = await inspect(selected.home);
      if (instance.backendId !== selected.backendId || instance.url !== selected.url)
        throw new Error("后端身份或地址已经改变，请重新选择");
      const response = await fetchImpl(`${instance.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atria-token": instance.token },
        body: JSON.stringify({ clientName: input.clientName, protocolVersion: input.protocolVersion }),
        redirect: "error",
        signal: AbortSignal.timeout(10000)
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(
          result?.error?.message || result?.error || `授权失败（HTTP ${response.status}）`
        );
        error.status = response.status;
        error.code = result?.error?.code || result?.code;
        throw error;
      }
      if (result?.backend?.backendId !== instance.backendId || result?.backend?.pid !== instance.pid)
        throw new Error("授权返回的后端身份不一致");
      return result;
    }
  };
}
module.exports = { createBackendAuthorization };
