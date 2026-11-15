import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyEnvironment, createHttpTransport } from "../dist/src/runtime/http-transport.js";
import { testModelConnection } from "../dist/src/runtime/model-connection.js";
import { availableModelIds } from "../dist/src/runtime/model-catalog.js";
import { runtimeSettingsEnv } from "../dist/src/runtime/runtime-settings.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
function environment(t, values = {}) {
  const saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of proxyKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

async function tunnel(t, port) {
  const targets = [];
  const sockets = new Set();
  const server = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on("connect", (req, client, head) => {
    assert.equal(req.url, `model.fixture.test:${port}`);
    targets.push(req.url);
    const upstream = createConnection({ host: "127.0.0.1", port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, targets, sockets };
}

test("proxy settings honor either environment spelling, validate config and always bypass local control traffic", (t) => {
  environment(t);
  const env = proxyEnvironment(
    { httpProxy: "http://config.example:8080", noProxy: "direct.example" },
    {
      http_proxy: "http://environment.example:8081"
    }
  );
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.http_proxy, "http://environment.example:8081");
  assert.equal(env.NO_PROXY, "direct.example,localhost,127.0.0.1,::1");
  assert.deepEqual(proxyEnvironment({}, env), env, "resolving twice does not grow NO_PROXY");
  assert.equal(
    proxyEnvironment({}, { HTTP_PROXY: "http://proxy.example", NO_PROXY: "*" }).NO_PROXY,
    "*",
    "an all-host bypass remains an all-host bypass"
  );
  assert.equal(
    runtimeSettingsEnv({ httpProxy: "http://config.example:8080" }).HTTP_PROXY,
    "http://config.example:8080"
  );
  for (const value of [false, "socks://proxy.example", "http://proxy.example/?token=private-test-secret"]) {
    assert.throws(
      () => proxyEnvironment({ httpProxy: value }, {}),
      (error) => {
        assert.doesNotMatch(error.message, /private-test-secret/);
        return /httpProxy/.test(error.message);
      }
    );
  }
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: the connection check and catalog reads use the environment proxy`, async (t) => {
    environment(t);
    const provider = await modelProtocolFixture(api, () => ({ text: "Proxy evidence received" }));
    t.after(() => provider.close());
    const port = Number(new URL(provider.baseUrl).port);
    const proxy = await tunnel(t, port);
    process.env.HTTP_PROXY = proxy.url;
    const baseUrl = `http://model.fixture.test:${port}/v1`;
    const root = await mkdtemp(join(tmpdir(), "atria-proxy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const connection = {
      api,
      baseUrl,
      apiKey: "fake-proxy-fixture",
      model: "protocol-fixture",
      supportsReasoningEffort: false
    };
    await testModelConnection(connection);
    assert.equal(provider.requests.length, 1);
    assert.equal(proxy.targets.length, 1, "the connection check opened one proxy tunnel");
    assert.deepEqual(await availableModelIds({ ...connection, model: "selected-model" }), [
      "selected-model",
      "protocol-fixture"
    ]);
    // NO_PROXY bypasses the proxy for a real loopback endpoint.
    const before = proxy.targets.length;
    const transport = createHttpTransport();
    assert.equal((await transport.fetch(`${provider.baseUrl}/models`)).status, 200);
    await transport.close();
    assert.equal(proxy.targets.length, before);
  });
}

test("abort closes a pending proxy body and a later request uses a fresh transport", async (t) => {
  environment(t);
  const provider = createServer((_req, res) => {
    res.writeHead(200);
    res.write("pending");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
  });
  const proxy = await tunnel(t, provider.address().port);
  const transport = createHttpTransport({ HTTP_PROXY: proxy.url });
  const controller = new AbortController();
  const url = `http://model.fixture.test:${provider.address().port}/pending`;
  const response = await transport.fetch(url, { signal: controller.signal });
  const body = response.text();
  controller.abort();
  await assert.rejects(body);
  await transport.close();
  const again = await transport.fetch(url);
  await again.body.cancel();
  await transport.close();
  assert.equal(proxy.targets.length, 2);
});

test("catalog discovery filters unsafe/unsupported IDs and retains the selected model after HTTP failure", async (t) => {
  environment(t);
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        { id: "selected" },
        { id: " supported:model ", supported_endpoint_types: ["openai"] },
        { id: "other-provider", supported_endpoint_types: ["anthropic"] },
        { id: "bad id" },
        { id: "x".repeat(161) }
      ]
    })
  );
  const input = { model: "selected", baseUrl: "https://fixture.example", apiKey: "fake-catalog-key" };
  assert.deepEqual(await availableModelIds(input), ["selected", "supported:model"]);
  fetch.mock.mockImplementation(async () => new Response("private-fixture-provider-body", { status: 503 }));
  assert.deepEqual(await availableModelIds(input), ["selected"]);
});

test(
  "native Main gets a config proxy through the launcher without forwarding local control traffic",
  { timeout: 45000 },
  async (t) => {
    environment(t);
    const provider = await modelProtocolFixture("openai-completions", () => ({
      text: "Native proxy evidence"
    }));
    t.after(() => provider.close());
    const port = Number(new URL(provider.baseUrl).port);
    const proxy = await tunnel(t, port);
    const root = await mkdtemp(join(tmpdir(), "atria-main-proxy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project"),
      workspace = join(root, "workspace");
    await Promise.all([mkdir(project), mkdir(workspace)]);
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: `http://model.fixture.test:${port}/v1`,
        apiKey: "fake-main-proxy",
        model: "protocol-fixture",
        reasoningEffort: "off",
        supportsReasoningEffort: false,
        httpProxy: proxy.url
      })
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(COWORK_|PI_|ATRIA_|SERPER_)/.test(key))
    );
    const pending = promisify(execFile)(
      process.execPath,
      ["scripts/start-pi.mjs", "--print", "--mode", "json", "Reply with proxy evidence"],
      {
        timeout: 35000,
        maxBuffer: 4000000,
        env: {
          ...env,
          COWORK_CONFIG: configPath,
          COWORK_PROJECT_DIR: project,
          COWORK_WORKSPACE: workspace,
          COWORK_TASK_ID: "proxy-task",
          COWORK_RUN_ID: "proxy-run",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          COWORK_DISABLE_MAIN_GUARDIAN: "1",
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0"
        }
      }
    );
    pending.child.stdin.end();
    const { stdout, stderr } = await pending;
    assert.ok(stdout.includes("Native proxy evidence"), stderr);
    assert.ok(proxy.targets.length);
    assert.ok(provider.requests.length);
  }
);
