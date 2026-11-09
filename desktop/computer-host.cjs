/** Bound host capability: neither business nor approval credentials reach the page. */
function createComputerHost({ expected, inspect, isCurrent = () => true, fetchImpl = fetch }) {
  let approval;
  let pending;
  let pendingController;
  let generation = 0;
  const identity = {
    backendId: expected.backendId,
    pid: expected.pid,
    startedAt: expected.startedAt
  };
  function cancelPending() {
    generation++;
    pendingController?.abort();
  }
  async function currentInstance() {
    if (!isCurrent()) throw new Error("后端已切换，请重新操作窗口访问");
    const instance = await inspect();
    if (
      !isCurrent() ||
      instance.backendId !== expected.backendId ||
      instance.pid !== expected.pid ||
      instance.url !== expected.url ||
      instance.startedAt !== expected.startedAt
    )
      throw new Error("后端身份已改变，请重新连接");
    const response = await fetchImpl(`${instance.url}/api/backend`, {
      headers: { "x-atria-token": instance.token },
      redirect: "error",
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error("无法验证窗口访问后端身份");
    const actual = await response.json();
    if (
      !isCurrent() ||
      actual.backendId !== expected.backendId ||
      actual.pid !== expected.pid ||
      actual.startedAt !== expected.startedAt
    )
      throw new Error("窗口访问后端身份不一致");
    return instance;
  }
  async function revokeToken(instance, token) {
    const response = await fetchImpl(`${instance.url}/api/host/computer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-atria-token": instance.token,
        "x-computer-approval": token
      },
      body: JSON.stringify({ ...identity, input: { operation: "revoke-approval" } }),
      redirect: "error",
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok && response.status !== 403) throw new Error("撤销窗口访问确认失败");
  }
  async function requestApproval(instance, version) {
    if (!pending) {
      pendingController = new AbortController();
      const controller = pendingController;
      pending = (async () => {
        const response = await fetchImpl(`${instance.url}/api/host/computer/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-atria-token": instance.token },
          body: JSON.stringify(identity),
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125000)])
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "本机身份验证失败");
        if (
          value.backendId !== identity.backendId ||
          value.pid !== identity.pid ||
          value.startedAt !== identity.startedAt ||
          typeof value.approval?.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.approval.token) ||
          typeof value.approval.expiresAt !== "number"
        )
          throw new Error("本机身份验证结果已失效，请重试");
        // eslint-disable-next-line no-restricted-syntax -- inspect() re-reads the instance record from disk; an unreadable record must take the revoke-and-retry path instead of leaking an fs error
        const latest = await inspect().catch(() => undefined);
        if (
          !isCurrent() ||
          generation !== version ||
          !latest ||
          latest.backendId !== expected.backendId ||
          latest.pid !== expected.pid ||
          latest.url !== expected.url ||
          latest.startedAt !== expected.startedAt
        ) {
          // eslint-disable-next-line no-restricted-syntax -- the approval is being discarded and the caller is about to reject the request, so a failed revoke must not mask that error
          await revokeToken(instance, value.approval.token).catch(() => {});
          throw new Error("本机身份验证结果已失效，请重试");
        }
        approval = value.approval.token;
        return approval;
      })().finally(() => {
        if (pendingController === controller) {
          pending = undefined;
          pendingController = undefined;
        }
      });
    }
    return pending;
  }
  const computer = async (input) => {
    const privileged =
      (input?.operation === "policy" && input.enabled === true) ||
      input?.operation === "resume" ||
      input?.operation === "authorize";
    if (
      input?.operation === "pause" ||
      input?.operation === "end" ||
      input?.operation === "release-sessions" ||
      (input?.operation === "policy" && input.enabled === false)
    )
      cancelPending();
    if (input?.operation === "policy" && input.enabled === false) approval = undefined;
    const version = generation;
    const instance = await currentInstance();
    const send = async () => {
      if (privileged && !approval) await requestApproval(instance, version);
      if (!isCurrent() || (privileged && version !== generation)) throw new Error("窗口访问操作已取消");
      const response = await fetchImpl(`${instance.url}/api/host/computer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-atria-token": instance.token,
          ...(privileged && approval ? { "x-computer-approval": approval } : {})
        },
        body: JSON.stringify({ ...identity, input }),
        redirect: "error",
        signal: AbortSignal.timeout(input?.operation === "permissions" ? 305000 : 20000)
      });
      return { response, value: await response.json() };
    };
    let result = await send();
    if (privileged && result.response.status === 403 && result.value.code === "host_approval_required") {
      approval = undefined;
      result = await send();
    }
    if (!result.response.ok)
      throw new Error(typeof result.value.error === "string" ? result.value.error : "窗口访问请求失败");
    if (
      result.value.backendId !== expected.backendId ||
      result.value.pid !== expected.pid ||
      result.value.startedAt !== expected.startedAt
    )
      throw new Error("窗口访问响应的后端身份不一致");
    if (!isCurrent()) throw new Error("后端已切换，请重新操作窗口访问");
    return result.value.result;
  };
  computer.revoke = async () => {
    cancelPending();
    const token = approval;
    approval = undefined;
    if (!token) return;
    const instance = await currentInstance();
    await revokeToken(instance, token);
  };
  return computer;
}
module.exports = { createComputerHost };
