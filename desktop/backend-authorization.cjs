const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createComputerHost } = require("./computer-host.cjs");

/** Keep bootstrap credentials in the host and bind authorization to a selected local data root. */
function createBackendAuthorization({ appRoot, fetchImpl = fetch, sessionStore }) {
  let selected;
  let activeSession;
  let generation = 0;
  const preparedSelections = new WeakMap();
  const publicIdentity = ({ backendId, url, pid, startedAt }) => ({ backendId, url, pid, startedAt });
  const matches = (left, right) =>
    left &&
    right &&
    left.backendId === right.backendId &&
    left.url === right.url &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt;
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
    if (
      info.backendId !== instance.backendId ||
      info.pid !== instance.pid ||
      info.startedAt !== instance.startedAt
    )
      throw new Error("后端身份与实例记录不一致");
    return { ...instance, protocol: info.protocol };
  }
  return {
    async prepare(home) {
      const before = selected;
      const instance = await inspect(home);
      if (selected !== before) throw new Error("后端已切换，请重新选择");
      const candidate = Object.freeze({ home, ...publicIdentity(instance) });
      preparedSelections.set(candidate, before ?? null);
      return candidate;
    },
    commit(candidate) {
      if (!candidate || typeof candidate !== "object" || !preparedSelections.has(candidate))
        throw new Error("无效的后端选择");
      const previous = preparedSelections.get(candidate);
      preparedSelections.delete(candidate);
      if ((selected ?? null) !== previous) throw new Error("后端已切换，请重新选择");
      selected = candidate;
      activeSession = undefined;
      generation += 1;
      return publicIdentity(candidate);
    },
    async select(home) {
      return this.commit(await this.prepare(home));
    },
    async verifySelected(expected) {
      const selection = selected;
      if (!matches(selection, expected)) throw new Error("后端身份已改变，请重新连接");
      const instance = await inspect(selection.home);
      if (selection !== selected || !matches(instance, selection))
        throw new Error("后端身份已改变，请重新连接");
      return publicIdentity(instance);
    },
    computerBackend(expected) {
      const selection = selected;
      if (!matches(selection, expected)) throw new Error("后端身份已改变，请重新连接");
      const inspectSelection = () => inspect(selection.home);
      return {
        ...publicIdentity(selection),
        computer: createComputerHost({
          expected: selection,
          inspect: inspectSelection,
          isCurrent: () => selected === selection,
          fetchImpl
        }),
        // The emergency shortcut remains bound to the old host during a
        // transition, even after the selected identity changes. It may only
        // pause, and still checks the old process, record and credential.
        pauseRetired: () =>
          createComputerHost({ expected: selection, inspect: inspectSelection, fetchImpl })({
            operation: "pause"
          })
      };
    },
    requestToken(expected) {
      return activeSession?.selection === selected && matches(selected, expected)
        ? activeSession.token
        : undefined;
    },
    async authorize(input) {
      const selection = selected;
      if (
        !selection ||
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        input.baseUrl !== selection.url ||
        input.backendId !== selection.backendId ||
        typeof input.clientName !== "string" ||
        !input.clientName.trim() ||
        input.clientName.length > 120 ||
        // eslint-disable-next-line no-control-regex
        /[\x00-\x1f\x7f]/u.test(input.clientName) ||
        typeof input.protocolVersion !== "string" ||
        !/^\d{1,4}\.\d{1,4}$/u.test(input.protocolVersion) ||
        (input.reuse !== undefined && typeof input.reuse !== "boolean")
      )
        throw new Error("后端授权参数或身份不一致");
      const attempt = ++generation;
      activeSession = undefined;
      const current = () => selected === selection && generation === attempt;
      const instance = await inspect(selection.home);
      if (!current() || !matches(instance, selection)) throw new Error("后端身份或地址已经改变，请重新选择");
      if (sessionStore && input.reuse) {
        const saved = await sessionStore.read(selection.backendId);
        if (!current()) throw new Error("后端已切换，请重新授权");
        if (saved) {
          const check = await fetchImpl(`${instance.url}/api/session`, {
            headers: { "x-atria-token": saved.token },
            redirect: "error",
            signal: AbortSignal.timeout(10000)
          });
          const result = await check.json();
          if (!current()) throw new Error("后端已切换，请重新授权");
          if (!check.ok) {
            const error = new Error(
              result?.error?.message || result?.error || "客户端会话已失效，请重新授权"
            );
            error.status = check.status;
            error.code = result?.error?.code || result?.code;
            throw error;
          }
          if (result?.current?.sessionId !== saved.sessionId) throw new Error("客户端会话身份不一致");
          activeSession = { selection, token: saved.token };
          return {
            session: { sessionId: saved.sessionId },
            backend: publicIdentity(instance),
            protocol: instance.protocol
          };
        }
      }
      const response = await fetchImpl(`${instance.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atria-token": instance.token },
        body: JSON.stringify({ clientName: input.clientName, protocolVersion: input.protocolVersion }),
        redirect: "error",
        signal: AbortSignal.timeout(10000)
      });
      const result = await response.json();
      if (!current()) throw new Error("后端已切换，请重新授权");
      if (!response.ok) {
        const error = new Error(
          result?.error?.message || result?.error || `授权失败（HTTP ${response.status}）`
        );
        error.status = response.status;
        error.code = result?.error?.code || result?.code;
        throw error;
      }
      if (
        result?.backend?.backendId !== instance.backendId ||
        result?.backend?.pid !== instance.pid ||
        result?.backend?.startedAt !== instance.startedAt
      )
        throw new Error("授权返回的后端身份不一致");
      if (sessionStore) {
        if (typeof result.session?.token !== "string" || typeof result.session?.sessionId !== "string")
          throw new Error("后端未返回有效的客户端会话");
        await sessionStore.write(selection.backendId, result.session);
        if (!current()) throw new Error("后端已切换，请重新授权");
        activeSession = { selection, token: result.session.token };
        const { sessionId, clientName, protocolVersion, createdAt, revokedAt } = result.session;
        return {
          session: { sessionId, clientName, protocolVersion, createdAt, revokedAt },
          backend: publicIdentity(instance),
          protocol: result.protocol
        };
      }
      return result;
    }
  };
}
module.exports = { createBackendAuthorization };
