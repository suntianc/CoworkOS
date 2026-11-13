import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const path = resolve(".pi/runtime/tools/cua-dispatch.ts");
const { createCuaDispatcher } = await createJiti(pathToFileURL(path).href).import(path);

function fixture() {
  const registered = new Map();
  const active = new Set();
  const ctx = { cwd: "/fixture", model: { input: ["text", "image"] } };
  const hooks = new Map();
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    getActiveTools: () => [...active],
    registerTool: (tool) => registered.set(tool.name, tool)
  };
  const bridge = createCuaDispatcher(pi);
  function add(name, execute, parameters = Type.Object({}, { additionalProperties: false })) {
    bridge.capturePi.registerTool({ name, label: name, description: name, parameters, execute });
  }
  return { registered, active, ctx, bridge, add, hooks };
}

test("CUA dispatch uses the registered tool with this cell's context and rechecks availability", async () => {
  const f = fixture();
  const calls = [];
  f.add(
    "browser_open",
    async (id, params, signal, update, ctx) => {
      calls.push({ id, params, signal, update, ctx });
      return { content: [{ type: "text", text: "opened" }], details: { pageId: "owned-page" } };
    },
    Type.Object({ url: Type.String() }, { additionalProperties: false })
  );
  assert.ok(f.registered.has("browser_open"));
  const unavailable = await f.bridge.dispatch(
    "browser_open",
    { url: "https://example.com" },
    undefined,
    f.ctx
  );
  assert.equal(unavailable.details.errorCode, "tool_unavailable");
  assert.equal(calls.length, 0);
  f.active.add("browser_open");
  const controller = new AbortController();
  const result = await f.bridge.dispatch(
    "browser_open",
    { url: "https://example.com" },
    controller.signal,
    f.ctx
  );
  assert.equal(result.details.pageId, "owned-page");
  assert.equal(calls[0].ctx, f.ctx);
  assert.equal(calls[0].signal, controller.signal);
  assert.match(calls[0].id, /^cua-rpc-/);
  f.active.delete("browser_open");
  assert.equal(
    (await f.bridge.dispatch("browser_open", { url: "https://example.com" }, undefined, f.ctx)).isError,
    true
  );
  assert.equal(calls.length, 1);
});

test("scripts cannot dispatch general tools, enable tools, read paths or bypass parameter validation", async () => {
  const f = fixture();
  let calls = 0;
  const execute = async () => {
    calls++;
    return { content: [{ type: "text", text: "ok" }], details: {} };
  };
  for (const name of ["bash", "enable_tools", "read_image", "browser_open"]) {
    f.add(
      name,
      execute,
      Type.Object({ imageRef: Type.Optional(Type.String()) }, { additionalProperties: false })
    );
    f.active.add(name);
  }
  for (const name of ["bash", "enable_tools"])
    assert.equal((await f.bridge.dispatch(name, {}, undefined, f.ctx)).details.errorCode, "tool_not_allowed");
  for (const params of [
    { path: "/private/file.png" },
    { imageRef: "invalid" },
    { imageRef: `img_${"a".repeat(36)}`, scope: "project" }
  ])
    assert.equal(
      (await f.bridge.dispatch("read_image", params, undefined, f.ctx)).details.errorCode,
      "invalid_argument"
    );
  assert.equal(
    (await f.bridge.dispatch("browser_open", { executablePath: "/bin/sh" }, undefined, f.ctx)).details
      .errorCode,
    "invalid_argument"
  );
  assert.equal(calls, 0);
  const imageRef = "img_01234567-89ab-4cde-8fab-0123456789ab";
  await f.bridge.dispatch("read_image", { imageRef }, undefined, f.ctx);
  assert.equal(calls, 1);
});

test("cancelled requests never dispatch and action errors preserve uncertainty or original evidence", async () => {
  const f = fixture();
  let calls = 0;
  f.add("computer_act", async () => {
    calls++;
    throw new Error("response lost");
  });
  f.active.add("computer_act");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await f.bridge.dispatch("computer_act", {}, controller.signal, f.ctx);
  assert.equal(cancelled.details.dispatchStatus, "not_sent");
  assert.equal(calls, 0);
  const unknown = await f.bridge.dispatch("computer_act", {}, undefined, f.ctx);
  assert.equal(unknown.details.dispatchStatus, "unknown");
  assert.equal(unknown.details.requiresObservation, true);
  assert.equal(calls, 1);
  const sent = {
    content: [{ type: "text", text: "capture failed" }],
    details: { errorCode: "capture_failed", dispatchStatus: "sent", requiresObservation: true },
    isError: true
  };
  f.add("computer_act", async () => sent);
  assert.equal(await f.bridge.dispatch("computer_act", {}, undefined, f.ctx), sent);
});

test("Pi bridge marks only trusted failed call IDs and preserves structured evidence", async () => {
  const f = fixture();
  const failure = {
    content: [{ type: "text", text: "sent but uncertain" }],
    details: { dispatchStatus: "sent", requiresObservation: true },
    isError: true
  };
  f.add("cua_script", async () => failure);
  assert.equal(
    await f.registered.get("cua_script").execute("outer-1", {}, undefined, undefined, f.ctx),
    failure
  );
  assert.deepEqual(f.hooks.get("tool_result")({ toolCallId: "outer-1" }), { isError: true });
  assert.equal(f.hooks.get("tool_result")({ toolCallId: "outer-1" }), undefined);
  assert.equal(
    f.hooks.get("tool_result")({ toolCallId: "unrelated", details: { isError: true } }),
    undefined
  );
});
