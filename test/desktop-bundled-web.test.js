import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createBundledWebHandler } = createRequire(import.meta.url)("../desktop/bundled-web.cjs");

test("desktop serves packaged frontend and leaves management traffic to the backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "desktop-bundled-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets", "nested"), { recursive: true });
  await writeFile(join(root, "index.html"), "packaged document");
  await writeFile(join(root, "assets", "nested", "app.js"), "packaged script");
  const calls = [];
  const handler = createBundledWebHandler({
    root,
    getOrigin: () => "http://127.0.0.1:12345",
    fetch: async (request, options) => {
      calls.push([request.url, options]);
      return new Response("backend response");
    }
  });
  const document = await handler(new Request("http://127.0.0.1:12345/?task=abc"));
  assert.equal(await document.text(), "packaged document");
  assert.match(document.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(document.headers.get("content-type"), /^text\/html/);
  const script = await handler(new Request("http://127.0.0.1:12345/assets/nested/app.js"));
  assert.equal(await script.text(), "packaged script");
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.equal((await handler(new Request("http://127.0.0.1:12345/assets/missing.js"))).status, 404);
  assert.equal((await handler(new Request("http://127.0.0.1:12345/assets/%2fsecret"))).status, 400);
  const api = await handler(new Request("http://127.0.0.1:12345/api/backend"));
  assert.equal(await api.text(), "backend response");
  const other = await handler(new Request("http://127.0.0.1:12346/assets/nested/app.js"));
  assert.equal(await other.text(), "backend response");
  assert.deepEqual(calls, [
    ["http://127.0.0.1:12345/api/backend", { bypassCustomProtocolHandlers: true }],
    ["http://127.0.0.1:12346/assets/nested/app.js", { bypassCustomProtocolHandlers: true }]
  ]);
});
