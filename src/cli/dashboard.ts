import { randomBytes } from "node:crypto";
import { readCoworkConfig } from "../runtime/config.js";
import { applyProxyEnvironment } from "../runtime/http-transport.js";
import { createDashboardApplication } from "../dashboard/application.js";
import {
  backendPaths,
  readBackendIdentity,
  removeBackendInstance,
  type BackendInstance
} from "../dashboard/backend-instance.js";
import { claimBackendServing, publishBackendServing, releaseBackendServing } from "./backend.js";
import { atriaHome } from "../../scripts/data-home.cjs";

applyProxyEnvironment(readCoworkConfig());

/**
 * The development dashboard: one serving process per data root, like the daemon.
 *
 * This entry predates the detached backend and stays the quick way to iterate on
 * the Web UI, so it keeps its own port and its open-loopback default when no
 * host credential is supplied. What it no longer does is become a second writer:
 * it asks for the data root's serving claim, reuses a verified running backend,
 * and publishes its own instance record so `backend start`/`stop` and the desktop
 * find it instead of starting another server.
 *
 * A Backend keeps its identity across restarts (that is what lets a client
 * recognise a restarted process and scope its drafts and sessions to it), so the
 * entry reads the persisted identity rather than minting one per process.
 */
const paths = backendPaths(atriaHome());
const enforcedToken = process.env.COWORK_API_TOKEN?.trim() || undefined;
const served = await claimBackendServing(paths, randomBytes(32).toString("hex"));
if (served.kind === "existing") {
  console.log(`Cowork dashboard already served on ${served.instance.url}`);
} else {
  const claimToken = served.claim.token;
  const identity = await readBackendIdentity(paths);
  if (!identity.value) throw new Error(`后端身份记录无法解析：${paths.identityPath}`);
  const startedAt = new Date().toISOString();
  const dashboard = createDashboardApplication({
    backendIdentity: { backendId: identity.value.backendId, startedAt }
  });
  // This IPC channel belongs to the Electron parent, not the HTTP/Agent surface.
  process.on("message", (value) => {
    if (!value || typeof value !== "object" || !("type" in value)) return;
    if (value.type !== "computer.host") return;
    const message = value as { requestId?: unknown; input?: unknown };
    if (typeof message.requestId !== "string") return;
    void dashboard.computerHostRequest(message.input).then(
      (result) => process.send?.({ type: "computer.reply", requestId: message.requestId, result }),
      (error) =>
        process.send?.({
          type: "computer.reply",
          requestId: message.requestId,
          error: error instanceof Error ? error.message : "Computer Use 请求失败"
        })
    );
  });
  const port = Number(process.env.COWORK_UI_PORT ?? 3880);
  await new Promise<void>((resolveListen, reject) => {
    dashboard.server.once("error", reject);
    dashboard.server.listen(port, "127.0.0.1", () => {
      dashboard.server.off("error", reject);
      resolveListen();
    });
  }).catch(async (error) => {
    dashboard.server.close();
    await releaseBackendServing(paths, claimToken);
    throw error;
  });
  // The record is the credential the desktop and `backend stop` use. Only a
  // caller that supplied a host credential has this process enforce it.
  const instance: BackendInstance = {
    version: 1,
    backendId: identity.value.backendId,
    createdAt: identity.value.createdAt,
    pid: process.pid,
    port,
    url: dashboard.dashboardUrl,
    token: enforcedToken ?? randomBytes(32).toString("hex"),
    startedAt
  };
  await publishBackendServing(paths, claimToken, instance).catch(async (error) => {
    dashboard.server.close();
    await releaseBackendServing(paths, claimToken);
    throw error;
  });
  console.log(`Cowork dashboard listening on ${dashboard.dashboardUrl}`);
  if (process.send) process.send({ type: "dashboard.ready", url: dashboard.dashboardUrl });
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const forced = setTimeout(() => process.exit(130), 4_000);
      forced.unref();
      void dashboard.stop().then(() => {
        clearTimeout(forced);
        return removeBackendInstance(paths, { pid: process.pid, token: instance.token }).then(() =>
          process.exit(0)
        );
      });
    });
}
