import { readCoworkConfig } from "../runtime/config.js";
import { applyProxyEnvironment } from "../runtime/http-transport.js";
import { createDashboardApplication } from "../dashboard/application.js";
import { backendPaths, ensureBackendIdentity } from "../dashboard/backend-instance.js";
import { atriaHome } from "../../scripts/data-home.cjs";

applyProxyEnvironment(readCoworkConfig());
/**
 * Serve the data root's backend identity, not a new one per process.
 *
 * A Backend keeps its identity across restarts (that is what lets a client
 * recognise a restarted process and scope its drafts and sessions to it). The
 * detached daemon already persists this record; the UI entry has to read the
 * same one, or every `ui` restart would look like a different backend.
 */
const identity = await ensureBackendIdentity(backendPaths(atriaHome()));
const dashboard = createDashboardApplication({
  backendIdentity: { backendId: identity.backendId, startedAt: new Date().toISOString() }
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
dashboard.server.listen(port, "127.0.0.1", () => {
  console.log(`Cowork dashboard listening on ${dashboard.dashboardUrl}`);
  if (process.send) process.send({ type: "dashboard.ready", url: dashboard.dashboardUrl });
});
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forced = setTimeout(() => process.exit(130), 4_000);
    forced.unref();
    void dashboard.stop().then(() => {
      clearTimeout(forced);
      process.exit(0);
    });
  });
