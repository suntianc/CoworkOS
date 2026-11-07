import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createComputerHost } = require("../desktop/computer-host.cjs");
const { createComputerPolicyController } = require("../desktop/computer-policy.cjs");

test("desktop requests approval only for an explicit privileged action and keeps it in the host", async () => {
  const instance = {
    backendId: "backend_a",
    pid: 123,
    startedAt: "2026-01-01T00:00:00.000Z",
    url: "http://127.0.0.1:12345",
    token: "business-token"
  };
  const requests = [];
  let approvals = 0;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, headers: options.headers });
    if (path === "/api/backend") return Response.json(instance);
    if (path === "/api/host/computer/approve")
      return Response.json({
        ...instance,
        approval: { token: String(++approvals).repeat(64), expiresAt: Date.now() + 60000 }
      });
    return Response.json({ ...instance, result: { enabled: true } });
  };
  const computer = createComputerHost({ expected: instance, inspect: async () => instance, fetchImpl });
  await computer({ operation: "status" });
  assert.equal(approvals, 0);
  const result = await computer({ operation: "policy", enabled: true, mode: "control" });
  assert.deepEqual(result, { enabled: true });
  assert.equal(approvals, 1);
  assert.equal(requests.at(-1).headers["x-computer-approval"], "1".repeat(64));
  await computer({ operation: "resume" });
  assert.equal(approvals, 1);
});

test("desktop initialization does not restore a saved grant or request approval", async () => {
  const calls = [];
  const backend = {
    computer: async (input) => {
      calls.push(input);
      if (input.operation === "access") return { policy: { enabled: false, mode: "observe" }, paused: false };
      throw new Error("initialization attempted a privileged action");
    }
  };
  const controller = createComputerPolicyController({
    store: { snapshot: () => ({ enabled: true, mode: "control" }) },
    getBackend: () => backend,
    registerTakeover: () => null
  });
  await controller.initialize(backend);
  assert.deepEqual(calls, [{ operation: "access" }]);
  assert.equal((await controller.request({ operation: "policy-status" })).approvalRequired, true);
});

test("an expired approval is renewed only when a privileged action is requested", async () => {
  const instance = {
    backendId: "backend_a",
    pid: 123,
    startedAt: "2026-01-01T00:00:00.000Z",
    url: "http://127.0.0.1:12345",
    token: "business-token"
  };
  let approvals = 0;
  let expired = false;
  const computer = createComputerHost({
    expected: instance,
    inspect: async () => instance,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === "/api/backend") return Response.json(instance);
      if (path === "/api/host/computer/approve")
        return Response.json({
          ...instance,
          approval: { token: String(++approvals).repeat(64), expiresAt: Date.now() + 60000 }
        });
      const input = JSON.parse(options.body).input;
      if (
        expired &&
        input.operation === "resume" &&
        options.headers["x-computer-approval"] === "1".repeat(64)
      )
        return Response.json({ code: "host_approval_required" }, { status: 403 });
      return Response.json({ ...instance, result: {} });
    }
  });
  await computer({ operation: "policy", enabled: true, mode: "control" });
  expired = true;
  await computer({ operation: "status" });
  assert.equal(approvals, 1);
  await computer({ operation: "resume" });
  assert.equal(approvals, 2);
});

test("a late approval from an unselected backend cannot issue a desktop action", async () => {
  const instance = {
    backendId: "backend_a",
    pid: 123,
    startedAt: "2026-01-01T00:00:00.000Z",
    url: "http://127.0.0.1:12345",
    token: "business-token"
  };
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let selected = true;
  let actions = 0;
  let revoked = 0;
  const computer = createComputerHost({
    expected: instance,
    inspect: async () => instance,
    isCurrent: () => selected,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === "/api/backend") return Response.json(instance);
      if (path === "/api/host/computer/approve") {
        started.resolve();
        await release.promise;
        return Response.json({
          ...instance,
          approval: { token: "a".repeat(64), expiresAt: Date.now() + 60000 }
        });
      }
      if (JSON.parse(options.body).input.operation === "revoke-approval") {
        revoked++;
        return Response.json({ ...instance, result: null });
      }
      actions++;
      return Response.json({ ...instance, result: {} });
    }
  });
  const pending = computer({ operation: "resume" });
  await started.promise;
  selected = false;
  release.resolve();
  await assert.rejects(pending, /失效/);
  assert.equal(actions, 0);
  assert.equal(revoked, 1);
});
