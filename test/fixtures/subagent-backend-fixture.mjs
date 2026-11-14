import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableScheduler, InboxStore } from "../../dist/src/runtime/scheduler.js";
import { agentDisplayName } from "../../dist/src/runtime/agent-identity.js";

/**
 * A scripted subagent backend for tests that drive Main's delegation tools.
 *
 * It speaks the same one-endpoint protocol a Dashboard or CLI host serves: Main
 * dispatches a work item, the backend writes the durable queue row every status
 * and wait tool reads, and settling the call writes the callback Main claims.
 * No process is launched; the point of these tests is the Main-side contract.
 */
export async function startSubagentBackend({
  workspaceRoot,
  taskId,
  runId,
  agentId = "subagent_1",
  name = agentDisplayName(agentId),
  settleSync = true
}) {
  const token = randomUUID();
  const requests = [];
  const queue = new DurableScheduler(join(workspaceRoot, taskId, "runs", runId, "queue.json"));
  const inbox = new InboxStore(
    join(workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
  );
  const settled = new Map();

  const settle = async (callId, { status = "succeeded", response = "fixture result", error } = {}) => {
    const item = (await queue.list()).find((entry) => entry.stepId === callId);
    if (!item || ["completed", "failed", "cancelled"].includes(item.status))
      throw new Error(`fixture cannot settle ${callId}: ${item?.status ?? "missing"}`);
    if (status === "cancelled") {
      await queue.cancel(callId);
    } else if (status === "succeeded") {
      const claimed = await queue.claim("fixture", 60_000, callId);
      await queue.complete(callId, claimed.lease.token);
    } else {
      const claimed = await queue.claim("fixture", 60_000, callId);
      await queue.fail(callId, claimed.lease.token, error ?? "fixture failure");
    }
    await inbox.enqueue({
      messageId: `callback-${callId}-${status}`,
      recipientAgentId: "main",
      kind: "callback",
      callId,
      eventId: `event-${callId}-${status}`,
      priority: 1,
      state: "ready",
      payload: { callId, status, ...(response ? { response } : {}), ...(error ? { error } : {}) },
      createdAt: new Date().toISOString()
    });
    settled.set(callId, status);
  };

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.headers["x-atria-token"] !== token) {
      response.writeHead(401).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push(body);
    const reply = (value) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (body.action === "dispatch") {
      const callId = `call-${randomUUID()}`;
      await queue.enqueue({
        stepId: callId,
        taskId,
        runId,
        agentId,
        importance: "normal",
        payload: {
          task: body.task,
          mode: body.mode,
          delegation: { role: body.role ?? "executor" },
          ...(Array.isArray(body.dependsOn) ? { dependsOn: body.dependsOn } : {})
        },
        maxAttempts: 1
      });
      const accepted = {
        accepted: true,
        callId,
        taskId,
        runId,
        agentId,
        name,
        role: body.role ?? "executor",
        mode: body.mode,
        ...(body.continueCallId ? { continuedFrom: body.continueCallId } : {}),
        ...(Array.isArray(body.dependsOn) ? { dependsOn: body.dependsOn } : {})
      };
      if (settleSync && body.mode === "sync") await settle(callId, { response: `${name} finished` });
      reply(accepted);
      return;
    }
    if (body.action === "cancel") {
      const item = (await queue.list()).find((entry) => entry.stepId === body.callId);
      if (item && !["completed", "failed", "cancelled"].includes(item.status))
        await settle(body.callId, { status: "cancelled", response: "" });
      reply({ callId: body.callId, agentId, status: "cancelled", previousStatus: item?.status ?? "queued" });
      return;
    }
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown subagent action" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    queue,
    inbox,
    settle,
    settled,
    async close() {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    }
  };
}
