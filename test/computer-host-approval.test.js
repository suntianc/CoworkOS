import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createDashboardApplication } from "../dist/src/dashboard/application.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "cowork-host-approval-"));
  const old = { ...process.env };
  for (const key of Object.keys(process.env))
    if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    ATRIA_HOME: root,
    COWORK_WORKSPACE: join(root, "workspace"),
    COWORK_CONFIG: join(root, "config.json"),
    COWORK_API_TOKEN: "business-fixture-token",
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  await writeFile(join(root, "config.json"), "{}\n");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const identity = {
    backendId: options.backendId ?? "backend_fixture",
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z"
  };
  const app = createDashboardApplication({
    projectRoot: resolve("."),
    port,
    backendIdentity: identity,
    computerApprovalAuthenticate: options.authenticate ?? (async () => true),
    ...(options.clock ? { computerApprovalClock: options.clock } : {}),
    ...(options.ttl ? { computerApprovalTtlMs: options.ttl } : {})
  });
  app.server.listen(port, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await app.stop();
    for (const key of Object.keys(process.env))
      if (/^(COWORK_|ATRIA_|PI_|ELECTRON_)/.test(key)) delete process.env[key];
    Object.assign(process.env, old);
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });
  const post = async (path, body, approval, token = "business-fixture-token") => {
    const response = await fetch(`${app.dashboardUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-atria-token": token,
        ...(approval ? { "x-computer-approval": approval } : {})
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const host = (input, approval, token) =>
    post("/api/host/computer", { ...identity, input }, approval, token);
  return { app, identity, post, host };
}

test("a business credential cannot grant window access before or after local approval", async (t) => {
  let requests = 0;
  const f = await fixture(t, { authenticate: async () => (++requests, true) });
  const enable = { operation: "policy", enabled: true, mode: "control" };
  assert.equal((await f.host(enable)).status, 403);
  const approved = await f.post("/api/host/computer/approve", f.identity);
  assert.equal(approved.status, 200);
  assert.equal(requests, 1);
  assert.equal(typeof approved.body.approval.token, "string");
  assert.equal((await f.host(enable)).status, 403);
  const authorization = await f.post("/api/session", { clientName: "fixture", protocolVersion: "1.0" });
  assert.equal(authorization.status, 201);
  assert.equal((await f.host(enable, undefined, authorization.body.session.token)).status, 403);
  assert.equal((await f.host(enable, approved.body.approval.token)).status, 200);
  for (const input of [
    { operation: "resume" },
    { operation: "authorize", taskId: "fixture", pid: 1, windowId: 1, mode: "control" }
  ]) {
    assert.equal((await f.host(input)).status, 403);
    assert.equal((await f.host(input, undefined, authorization.body.session.token)).status, 403);
  }
  const state = await fetch(`${f.app.dashboardUrl}/api/computer/access`, {
    headers: { "x-atria-token": "business-fixture-token" }
  });
  assert.equal((await state.json()).policy.enabled, true);
});

test("approval is scoped to its backend, expires, and can be revoked", async (t) => {
  let now = 1000;
  const a = await fixture(t, { backendId: "backend_a", clock: () => now, ttl: 100 });
  const b = await fixture(t, { backendId: "backend_b", clock: () => now, ttl: 100 });
  const enable = { operation: "policy", enabled: true, mode: "control" };
  const first = await a.post("/api/host/computer/approve", a.identity);
  assert.equal(first.status, 200);
  assert.equal((await b.host(enable, first.body.approval.token)).status, 403);
  assert.equal((await a.host(enable, first.body.approval.token)).status, 200);
  now += 100;
  assert.equal((await a.host(enable, first.body.approval.token)).status, 403);
  const second = await a.post("/api/host/computer/approve", a.identity);
  assert.notEqual(second.body.approval.token, first.body.approval.token);
  assert.equal((await a.host({ operation: "revoke-approval" }, second.body.approval.token)).status, 200);
  assert.equal((await a.host(enable, second.body.approval.token)).status, 403);
});

test("a stale backend identity cannot start approval", async (t) => {
  let calls = 0;
  const f = await fixture(t, { authenticate: async () => (++calls, true) });
  assert.equal(
    (await f.post("/api/host/computer/approve", { ...f.identity, startedAt: "2020-01-01T00:00:00Z" })).status,
    409
  );
  assert.equal(calls, 0);
  assert.equal((await f.post("/api/host/computer/approve", { ...f.identity, approved: true })).status, 400);
  assert.equal(calls, 0);
});

test("denied or unavailable native authentication issues no approval", async (t) => {
  let fail = false;
  const f = await fixture(t, {
    authenticate: async () => {
      if (fail) throw new Error("native authentication unavailable");
      return false;
    }
  });
  assert.equal((await f.post("/api/host/computer/approve", f.identity)).status, 403);
  fail = true;
  assert.equal((await f.post("/api/host/computer/approve", f.identity)).status, 503);
  assert.equal((await f.host({ operation: "resume" })).status, 403);
});

test("a pending approval is serialized and a cancelled request cannot create a capability", async (t) => {
  const started = Promise.withResolvers();
  const ended = Promise.withResolvers();
  let calls = 0;
  const f = await fixture(t, {
    authenticate: async (_identity, signal) => {
      if (++calls > 1) return true;
      started.resolve();
      await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
      ended.resolve();
      return true;
    }
  });
  const abort = new AbortController();
  const pending = fetch(`${f.app.dashboardUrl}/api/host/computer/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-atria-token": "business-fixture-token" },
    body: JSON.stringify(f.identity),
    signal: abort.signal
  });
  await started.promise;
  assert.equal((await f.post("/api/host/computer/approve", f.identity)).status, 409);
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await ended.promise;
  assert.equal((await f.host({ operation: "resume" })).status, 403);
  assert.equal((await f.post("/api/host/computer/approve", f.identity)).status, 200);
});

test("pause cancels an in-flight approval and disabling revokes an existing approval", async (t) => {
  const started = Promise.withResolvers();
  let first = true;
  const f = await fixture(t, {
    authenticate: async (_identity, signal) => {
      if (!first) return true;
      first = false;
      started.resolve();
      await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
      return true;
    }
  });
  const pending = f.post("/api/host/computer/approve", f.identity);
  await started.promise;
  assert.equal((await f.host({ operation: "pause" })).status, 200);
  assert.equal((await pending).status, 409);
  const approved = await f.post("/api/host/computer/approve", f.identity);
  assert.equal(approved.status, 200);
  assert.equal((await f.host({ operation: "policy", enabled: false, mode: "control" })).status, 200);
  assert.equal(
    (await f.host({ operation: "policy", enabled: true, mode: "control" }, approved.body.approval.token))
      .status,
    403
  );
});
