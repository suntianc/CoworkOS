import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { createModelSettings } from "../dist/src/dashboard/model-settings.js";
import { createWebSearchSettings } from "../dist/src/dashboard/web-search-settings.js";
import { HostCredentialStore } from "../dist/src/security/host-credentials.js";
import { readCoworkConfig } from "../dist/src/runtime/config.js";
import { connectionsOf, providerConfig, saveTestConnection } from "./model-provider-fixture.mjs";

const configureTimeout = { timeout: 120_000 };
const execute = promisify(execFile);

/** A strict Responses provider that only answers the key stored by the settings route. */
async function hostModelFixture(expectedKey, text) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ data: [{ id: "host-fixture" }] }));
    }
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(raw) });
    if (request.url !== "/v1/responses") {
      response.writeHead(400);
      return response.end('{"error":{"message":"unexpected path"}}');
    }
    if (request.headers.authorization !== `Bearer ${expectedKey}`) {
      response.writeHead(401);
      return response.end('{"error":{"message":"unauthorized"}}');
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream("openai-responses", { text }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}

async function readTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push([path, await readFile(path, "utf8").catch(() => "")]);
    }
  }
  await visit(root);
  return files;
}

function api(dashboard) {
  return async (path, body) => {
    const response = await fetch(dashboard.base + path, {
      signal: AbortSignal.timeout(10_000),
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
}

/** Save a connection (a provider with one model) with this file's client. */
const saveConnection = (call, value) =>
  saveTestConnection(async (path, body) => ({ status: 200, body: await call(path, body) }), value);
const providerOf = (profileId) => profileId.split("#")[0];

test(
  "standalone backend stores a host model connection and runs real Pi without exposing the key",
  configureTimeout,
  async (t) => {
    const sentinel = "settings-host-secret-7d2c";
    const answer = "主机凭据连接已生效。";
    const model = await hostModelFixture(sentinel, answer);
    t.after(() => model.close());
    const dashboard = await startDashboard();
    t.after(() => dashboard.stop());
    const call = api(dashboard);
    let backendOutput = "";
    const record = (chunk) => {
      backendOutput += String(chunk);
    };
    dashboard.child.stdout.on("data", record);
    dashboard.child.stderr.on("data", record);

    const initial = await call("/api/model-settings");
    assert.equal(initial.configured, false);
    assert.equal(JSON.stringify(initial).includes(sentinel), false);

    const saved = await saveConnection(call, {
      profileName: "主机连接",
      baseUrl: model.baseUrl,
      model: "host-fixture",
      api: "openai-responses",
      apiKey: sentinel,
      supportsImages: false
    });
    assert.equal(saved.configured, true);
    assert.equal(saved.activeProfileId, saved.profiles[0].id);
    assert.equal(JSON.stringify(saved).includes(sentinel), false, "status never returns the key");

    const configPath = join(dashboard.root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(JSON.stringify(config).includes(sentinel), false, "public config never stores the key");
    const credentialsPath = join(dashboard.root, "credentials.json");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.equal(credentials.version, 1);
    assert.equal(credentials.modelProviders[providerOf(saved.activeProfileId)], sentinel);
    assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);

    await call("/api/tasks", {
      taskId: "host-settings",
      goal: "使用主机保存的模型连接完成一次请求",
      projectId: dashboard.projectId
    });
    await call("/api/tasks/host-settings/run", { prompt: "回答一句确认。" });
    let detail;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      detail = await call("/api/tasks/host-settings");
      if (!detail.runtime.active && ["completed", "failed", "cancelled"].includes(detail.task.status)) break;
      await delay(50);
    }
    assert.equal(detail.task.status, "completed", backendOutput);
    assert.ok(model.requests.length >= 1, "the real Pi session reached the local provider");
    assert.ok(model.requests.every((entry) => entry.authorization === `Bearer ${sentinel}`));
    assert.ok(
      JSON.stringify(detail).includes(answer),
      "the model answer reached the conversation through the stored connection"
    );

    assert.equal(JSON.stringify(await call("/api/model-settings")).includes(sentinel), false);
    assert.equal(JSON.stringify(await call("/api/models")).includes(sentinel), false);
    assert.equal(backendOutput.includes(sentinel), false, "backend logs never contain the key");
    for (const [path, content] of await readTree(join(dashboard.workspaceRoot, "host-settings")))
      assert.equal(content.includes(sentinel), false, `run file leaked the key: ${path}`);
  }
);

test("host settings keep multi-connection, default model, image input and search semantics across restart", async (t) => {
  const model = await hostModelFixture("unused-for-this-test", "ignored");
  t.after(() => model.close());
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const call = api(dashboard);

  const first = await saveConnection(call, {
    profileName: "主连接",
    baseUrl: model.baseUrl,
    model: "a-model",
    api: "openai-responses",
    apiKey: "main-connection-key",
    supportsImages: false,
    contextWindow: 64000,
    mainMaxTokens: 4096
  });
  const firstId = first.activeProfileId;
  const second = await saveConnection(call, {
    profileId: "",
    profileName: "备用连接",
    baseUrl: model.baseUrl,
    model: "b-model",
    api: "openai-completions",
    apiKey: "review-connection-key",
    supportsImages: true,
    contextWindow: 128000,
    activate: false
  });
  const secondId = second.profiles.find((profile) => profile.name === "备用连接").id;
  assert.equal(second.activeProfileId, firstId, "saving an inactive connection keeps the active one");
  assert.equal(second.profiles.length, 2);
  assert.equal(second.model, "a-model");
  assert.equal(connectionsOf(second).find((profile) => profile.id === firstId).contextWindow, 64000);
  assert.equal(second.profiles.find((profile) => profile.id === secondId).supportsImages, true);
  assert.equal(JSON.stringify(second).includes("connection-key"), false);

  const search = await call("/api/web-search-settings", { provider: "exa", exaApiKey: "search-key" });
  assert.equal(search.authenticated, true);
  assert.equal(JSON.stringify(search).includes("search-key"), false);

  const config = JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8"));
  assert.equal(JSON.stringify(config).includes("connection-key"), false);
  assert.equal(JSON.stringify(config).includes("search-key"), false);
  const stored = new HostCredentialStore(join(dashboard.root, "credentials.json"));
  assert.equal(stored.value.modelProviders[providerOf(firstId)], "main-connection-key");
  assert.equal(stored.value.modelProviders[providerOf(secondId)], "review-connection-key");
  assert.equal(stored.value.webSearch.exaApiKey, "search-key");

  await dashboard.restart();
  const restarted = await call("/api/model-settings");
  assert.equal(restarted.configured, true);
  assert.equal(restarted.activeProfileId, firstId);
  assert.equal(restarted.model, "a-model");
  const active = connectionsOf(restarted).find((profile) => profile.id === firstId);
  assert.equal(active.contextWindow, 64000);
  assert.equal(active.mainMaxTokens, 4096);
  assert.equal(connectionsOf(restarted).length, 2);
  assert.equal(JSON.stringify(restarted).includes("connection-key"), false);
  assert.equal((await call("/api/web-search-settings")).authenticated, true);
});

test("a damaged host credential store is reported and left for recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-host-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  const credentialsPath = join(root, "credentials.json");
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(?:COWORK_|EXA_)/.test(name))
  );
  for (const name of Object.keys(savedEnv)) delete process.env[name];
  t.after(() => {
    for (const name of Object.keys(process.env)) if (/^(?:COWORK_|EXA_)/.test(name)) delete process.env[name];
    Object.assign(process.env, savedEnv);
  });
  process.env.COWORK_CONFIG = path;
  t.after(() => delete process.env.COWORK_CONFIG);
  await writeFile(
    path,
    JSON.stringify({
      ...providerConfig([
        { id: "a", name: "连接 A", baseUrl: "https://a.example/v1", model: "a-model", api: "openai-responses" }
      ])
    })
  );
  await writeFile(credentialsPath, "{not json");
  const config = readCoworkConfig(root);
  const model = createModelSettings(root, config, () => false);
  assert.equal(model.status().configured, false);
  assert.match(model.status().credentialError, /凭据存储无法读取/);
  await assert.rejects(
    model.saveProvider({ id: "a", apiKey: "another-key" }),
    /凭据存储无法读取/
  );
  assert.equal(await readFile(credentialsPath, "utf8"), "{not json");
  const search = createWebSearchSettings(root, config, () => false);
  assert.match(search.status().credentialError, /凭据存储无法读取/);
});

test("session export redacts host-stored connection and search keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-host-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const sentinels = ["export-sentinel-model-key", "export-sentinel-review-key", "export-sentinel-search-key"];
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl: "http://unused.test",
      model: "fixture-model",
      workspaceRoot: join(root, "workspace"),
      ...providerConfig([
        {
          id: "main",
          name: "Main",
          baseUrl: "http://unused.test",
          model: "fixture-model",
          api: "openai-completions",
          supportsImages: false
        },
        {
          id: "review",
          name: "Reviewer",
          baseUrl: "http://review.test/v1",
          model: "review-model",
          api: "openai-completions",
          supportsImages: true
        }
      ])
    })
  );
  await writeFile(
    join(root, "credentials.json"),
    JSON.stringify({
      version: 1,
      modelProviders: { main: sentinels[0], review: sentinels[1] },
      webSearch: { exaApiKey: sentinels[2] }
    }),
    { mode: 0o600 }
  );
  const timestamp = new Date().toISOString();
  const sessionId = "22222222-3333-4444-5555-666666666666";
  const sessionPath = join(root, "session.jsonl");
  const sessionText =
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: `保留的会话内容 ${sentinels[0]} ${sentinels[2]}` }],
          timestamp: Date.now()
        }
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `助手答复 ${sentinels[1]}` }],
          stopReason: "stop",
          timestamp: Date.now()
        }
      }
    ]
      .map(JSON.stringify)
      .join("\n") + "\n";
  await writeFile(sessionPath, sessionText);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|ATRIA_|PI_|EXA_)/.test(name))
  );
  Object.assign(env, {
    ATRIA_HOME: join(root, "home"),
    COWORK_CONFIG: configPath,
    COWORK_DISABLE_MAIN_GUARDIAN: "1",
    PI_OFFLINE: "1"
  });
  const exportSession = async (args) => {
    const { stdout } = await execute(
      process.execPath,
      [resolve("scripts/atria.mjs"), "session", "export", ...args],
      {
        cwd: root,
        env,
        timeout: 30_000
      }
    );
    return JSON.parse(stdout);
  };

  for (const [format, output] of [
    ["json", "export.json"],
    ["html", "export.html"]
  ]) {
    const result = await exportSession([sessionPath, "--format", format, "--output", output]);
    const text = await readFile(result.outputPath, "utf8");
    assert.match(text, /保留的会话内容/, `${format} export keeps the user message`);
    assert.match(text, /助手答复/, `${format} export keeps the assistant answer`);
    for (const sentinel of sentinels)
      assert.equal(text.includes(sentinel), false, `${format} export leaked ${sentinel}`);
  }
  assert.equal(await readFile(sessionPath, "utf8"), sessionText, "export never rewrites the source session");
});

test("the CLI config writer never copies a host-stored key into the public config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-host-writer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl: "http://unused.test/v1",
      model: "fixture-model",
      ...providerConfig([
        {
          id: "main",
          name: "Main",
          baseUrl: "http://unused.test/v1",
          model: "fixture-model",
          api: "openai-completions",
          supportsImages: false
        }
      ])
    })
  );
  const credentialsPath = join(root, "credentials.json");
  const credentials = {
    version: 1,
    modelProviders: { main: "host-store-writer-sentinel" }
  };
  await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|ATRIA_|PI_|EXA_)/.test(name))
  );
  Object.assign(env, {
    ATRIA_HOME: join(root, "home"),
    COWORK_CONFIG: configPath,
    WRITER_FIXTURE_KEY: "init-plaintext-key"
  });
  await execute(
    process.execPath,
    [
      resolve("scripts/atria.mjs"),
      "init",
      "--force",
      "--base-url",
      "http://new.example/v1",
      "--model",
      "new-model",
      "--api-key-env",
      "WRITER_FIXTURE_KEY"
    ],
    { cwd: root, env, timeout: 30_000 }
  );
  const written = await readFile(configPath, "utf8");
  assert.equal(written.includes("host-store-writer-sentinel"), false);
  assert.equal(JSON.parse(written).apiKey, "init-plaintext-key");
  assert.deepEqual(JSON.parse(await readFile(credentialsPath, "utf8")), credentials);
});
