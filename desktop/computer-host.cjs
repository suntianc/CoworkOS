/** Bound host capability: never exposes a bootstrap credential to the page. */
function createComputerHost({ expected, inspect, isCurrent = () => true, fetchImpl = fetch }) {
  return async (input) => {
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
    const identityResponse = await fetchImpl(`${instance.url}/api/backend`, {
      headers: { "x-atria-token": instance.token },
      redirect: "error",
      signal: AbortSignal.timeout(3000)
    });
    if (!identityResponse.ok) throw new Error("无法验证窗口访问后端身份");
    const identity = await identityResponse.json();
    if (
      !isCurrent() ||
      identity.backendId !== expected.backendId ||
      identity.pid !== expected.pid ||
      identity.startedAt !== expected.startedAt
    )
      throw new Error("窗口访问后端身份不一致");
    const response = await fetchImpl(`${instance.url}/api/host/computer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atria-token": instance.token },
      body: JSON.stringify({ backendId: expected.backendId, pid: expected.pid, input }),
      redirect: "error",
      signal: AbortSignal.timeout(input?.operation === "permissions" ? 305000 : 20000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "窗口访问请求失败");
    if (value.backendId !== expected.backendId || value.pid !== expected.pid)
      throw new Error("窗口访问响应的后端身份不一致");
    if (!isCurrent()) throw new Error("后端已切换，请重新操作窗口访问");
    return value.result;
  };
}
module.exports = { createComputerHost };
