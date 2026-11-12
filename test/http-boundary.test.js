import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { localRequestUrl, readJsonBody } from "../dist/src/dashboard/http.js";
import { startDashboard } from "./dashboard-fixture.mjs";

test("the local boundary validates Host, Origin and browser site before routing", () => {
  const base = "http://127.0.0.1:3880";
  const request = (headers, url = "/api/tasks") => ({ headers, url });
  assert.equal(localRequestUrl(request({ host: "127.0.0.1:3880" }), base).pathname, "/api/tasks");
  assert.equal(
    localRequestUrl(request({ host: "localhost:3880", origin: "http://localhost:3880" }), base).hostname,
    "localhost"
  );
  for (const headers of [
    { host: "attacker.invalid:3880" },
    { host: "127.0.0.1:3880", origin: "https://attacker.invalid" },
    { host: "127.0.0.1:3880", origin: "null" },
    { host: "127.0.0.1:3880", "sec-fetch-site": "cross-site" }
  ])
    assert.throws(() => localRequestUrl(request(headers), base), { status: 403 });
  assert.throws(
    () => localRequestUrl(request({ host: "127.0.0.1:3880" }, "https://attacker.invalid/api/tasks"), base),
    { status: 403 }
  );
});

test("JSON parsing requires an object and rejects oversized streams before buffering them", async () => {
  const body = (value) => Readable.from([Buffer.from(value)]);
  assert.deepEqual(await readJsonBody(body("")), {});
  assert.deepEqual(await readJsonBody(body('{"name":"中文"}')), { name: "中文" });
  for (const value of ["null", "[]", '"text"', "1", "invalid"]) {
    await assert.rejects(readJsonBody(body(value)), { status: 400 });
  }
  await assert.rejects(readJsonBody(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10), { status: 413 });
});

test("every Dashboard surface rejects cross-origin access and no longer exposes wildcard CORS", async (t) => {
  const server = await startDashboard();
  t.after(server.stop);
  const page = await fetch(server.base);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  for (const endpoint of ["/api/tasks", "/api/models"]) {
    const blocked = await fetch(`${server.base}${endpoint}`, {
      headers: { origin: "https://attacker.invalid" }
    });
    assert.equal(blocked.status, 403, endpoint);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    const local = await fetch(`${server.base}${endpoint}`, { headers: { origin: server.base } });
    assert.equal(local.status, 200, endpoint);
  }
  const before = await (await fetch(`${server.base}/api/tasks`)).json();
  const blockedWrite = await fetch(`${server.base}/api/tasks`, {
    method: "POST",
    headers: { origin: "https://attacker.invalid", "content-type": "text/plain" },
    body: '{"goal":"must not create"}'
  });
  assert.equal(blockedWrite.status, 403);
  assert.deepEqual(await (await fetch(`${server.base}/api/tasks`)).json(), before);
});

test("routes validate request shape and size", async (t) => {
  const server = await startDashboard();
  t.after(server.stop);
  const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await fetch(`${server.base}/api/tasks`, post("null"))).status, 400);
  const malformed = await fetch(`${server.base}/api/tasks`, post("[]"));
  assert.equal(malformed.status, 400);
  const tooLarge = await fetch(
    `${server.base}/api/tasks`,
    post(JSON.stringify({ goal: "x".repeat(4 * 1024 * 1024) }))
  );
  assert.equal(tooLarge.status, 413);
});

test("a native dashboard authenticates header clients and HttpOnly browser sessions", () => {
  const saved = process.env.COWORK_API_TOKEN;
  process.env.COWORK_API_TOKEN = "native-test-session";
  const base = "http://127.0.0.1:3880";
  const request = (headers) => ({ headers: { host: "127.0.0.1:3880", ...headers }, url: "/api/tasks" });
  try {
    for (const headers of [{}, { "x-atria-token": "wrong" }, { cookie: "atria-session=wrong" }])
      assert.throws(() => localRequestUrl(request(headers), base), { status: 401 });
    assert.doesNotThrow(() => localRequestUrl(request({ "x-atria-token": "native-test-session" }), base));
    assert.doesNotThrow(() =>
      localRequestUrl(request({ cookie: "other=value; atria-session=native-test-session" }), base)
    );
  } finally {
    if (saved === undefined) delete process.env.COWORK_API_TOKEN;
    else process.env.COWORK_API_TOKEN = saved;
  }
});
