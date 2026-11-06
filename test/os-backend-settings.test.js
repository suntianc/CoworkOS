import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { createModelSettings } from "../dist/src/dashboard/model-settings.js";
import { createWebSearchSettings } from "../dist/src/dashboard/web-search-settings.js";
import { migrateDesktopCredentials } from "../dist/src/security/desktop-credentials-migration.js";
import { HostCredentialStore } from "../dist/src/security/host-credentials.js";
import { readCoworkConfig, readHostCoworkConfig } from "../dist/src/runtime/config.js";

const configureTimeout = { timeout: 120_000 };

/** A strict Responses provider that only answers the key stored by the settings route. */
async function hostModelFixture(expectedKey, text) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ data: [{ id: "host-fixture" }] }));
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
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

    const saved = await call("/api/model-settings", {
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
    assert.equal(credentials.modelConnections[saved.activeProfileId], sentinel);
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

test("host settings keep multi-connection, default model, vision and search semantics across restart", async (t) => {
  const model = await hostModelFixture("unused-for-this-test", "ignored");
  t.after(() => model.close());
  const dashboard = await startDashboard();
  t.after(() => dashboard.stop());
  const call = api(dashboard);

  const first = await call("/api/model-settings", {
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
  const second = await call("/api/model-settings", {
    profileId: "",
    profileName: "视觉连接",
    baseUrl: model.baseUrl,
    model: "b-model",
    api: "openai-completions",
    apiKey: "vision-connection-key",
    supportsImages: true,
    vision: true,
    contextWindow: 128000,
    activate: false
  });
  const secondId = second.profiles.find((profile) => profile.name === "视觉连接").id;
  assert.equal(second.activeProfileId, firstId, "saving an inactive connection keeps the active one");
  assert.equal(second.visionProfileId, secondId);
  assert.equal(second.profiles.length, 2);
  assert.equal(second.model, "a-model");
  assert.equal(second.contextWindow, 64000);
  assert.equal(second.profiles.find((profile) => profile.id === secondId).supportsImages, true);
  assert.equal(JSON.stringify(second).includes("connection-key"), false);

  const search = await call("/api/web-search-settings", { provider: "exa", exaApiKey: "search-key" });
  assert.equal(search.authenticated, true);
  assert.equal(JSON.stringify(search).includes("search-key"), false);

  const config = JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8"));
  assert.equal(JSON.stringify(config).includes("connection-key"), false);
  assert.equal(JSON.stringify(config).includes("search-key"), false);
  const stored = new HostCredentialStore(join(dashboard.root, "credentials.json"));
  assert.equal(stored.value.modelConnections[firstId], "main-connection-key");
  assert.equal(stored.value.modelConnections[secondId], "vision-connection-key");
  assert.equal(stored.value.webSearch.exaApiKey, "search-key");

  await dashboard.restart();
  const restarted = await call("/api/model-settings");
  assert.equal(restarted.configured, true);
  assert.equal(restarted.activeProfileId, firstId);
  assert.equal(restarted.visionProfileId, secondId);
  assert.equal(restarted.model, "a-model");
  assert.equal(restarted.contextWindow, 64000);
  assert.equal(restarted.mainMaxTokens, 4096);
  assert.equal(restarted.profiles.length, 2);
  assert.equal(JSON.stringify(restarted).includes("connection-key"), false);
  assert.equal((await call("/api/web-search-settings")).authenticated, true);
});

test("encrypted desktop credentials report a concrete error instead of a configured connection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-host-credentials-"));
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith("COWORK_"))
  );
  for (const name of Object.keys(savedEnv)) delete process.env[name];
  const path = join(root, "config.json");
  process.env.COWORK_CONFIG = path;
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (name.startsWith("COWORK_")) delete process.env[name];
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  });
  const legacy = {
    workspaceRoot: "/keep",
    apiKey: "plain-legacy-top",
    modelConnections: {
      version: 1,
      activeId: "old",
      profiles: [
        {
          id: "old",
          name: "旧桌面连接",
          baseUrl: "https://old.example/v1",
          model: "old-model",
          api: "openai-responses",
          contextWindow: 64000,
          supportsImages: true,
          encryptedApiKey: "old-desktop-ciphertext"
        }
      ]
    },
    webSearch: { provider: "exa", encryptedExaApiKey: "old-search-ciphertext" }
  };
  await writeFile(path, JSON.stringify(legacy));
  const config = readCoworkConfig(root);
  const model = createModelSettings(root, config, () => false);
  const status = model.status();
  assert.equal(status.configured, false, "an undecryptable key is not a configured connection");
  assert.equal(status.credentialUnavailable, true);
  assert.match(status.credentialError, /旧版桌面宿主/);
  assert.match(status.credentialError, /API Key/);
  assert.equal(status.profiles[0].configured, false);
  await assert.rejects(model.test({}), /旧版桌面宿主/);

  const saved = await model.save({
    profileId: "old",
    profileName: "旧桌面连接",
    baseUrl: "https://old.example/v1",
    model: "old-model",
    api: "openai-responses",
    supportsImages: true,
    apiKey: "replacement-host-key",
    activate: true
  });
  assert.equal(saved.configured, true);
  assert.equal(saved.credentialUnavailable, false);
  const configText = await readFile(path, "utf8");
  assert.equal(configText.includes("replacement-host-key"), false);
  assert.equal(configText.includes("old-desktop-ciphertext"), false);
  const stored = new HostCredentialStore(join(root, "credentials.json"));
  assert.equal(stored.value.modelConnections.old, "replacement-host-key");

  const search = createWebSearchSettings(root, config, () => false);
  const searchStatus = search.status();
  assert.equal(searchStatus.authenticated, false, "an undecryptable search key is not authenticated");
  assert.equal(searchStatus.secretUnavailable, true);
  assert.match(searchStatus.credentialError, /旧版桌面宿主/);
  const blank = await search.save({ provider: "exa" });
  assert.equal(blank.authenticated, false, "saving without a key must not claim success");
  const rekeyed = await search.save({ provider: "exa", exaApiKey: "replacement-search-key" });
  assert.equal(rekeyed.authenticated, true);
  assert.equal(rekeyed.secretUnavailable, false);
  assert.equal((await readFile(path, "utf8")).includes("replacement-search-key"), false);
  assert.equal(
    new HostCredentialStore(join(root, "credentials.json")).value.webSearch.exaApiKey,
    "replacement-search-key"
  );

  // A damaged host store is reported and left for recovery instead of being replaced.
  const credentialsPath = join(root, "credentials.json");
  await writeFile(credentialsPath, "{not json");
  const damaged = createModelSettings(root, readCoworkConfig(root), () => false);
  assert.equal(damaged.status().configured, false);
  assert.match(damaged.status().credentialError, /凭据存储无法读取/);
  await assert.rejects(
    damaged.save({
      profileId: "old",
      baseUrl: "https://old.example/v1",
      model: "old-model",
      apiKey: "another-key"
    }),
    /凭据存储无法读取/
  );
  assert.equal(await readFile(credentialsPath, "utf8"), "{not json");
});

test("desktop migration decrypts once, backs up the original and keeps it on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "model-config.json");
  const credentialsPath = join(root, "credentials.json");
  const backupPath = `${configPath}.before-host-credentials`;
  const legacy = {
    workspaceRoot: "/keep",
    apiKey: "plain-legacy-top",
    modelConnections: {
      version: 1,
      activeId: "a",
      profiles: [
        {
          id: "a",
          name: "连接 A",
          baseUrl: "https://a.example/v1",
          model: "a-model",
          api: "openai-completions",
          supportsImages: false,
          encryptedApiKey: Buffer.from("cipher-a").toString("base64")
        },
        {
          id: "b",
          name: "连接 B",
          baseUrl: "https://b.example/v1",
          model: "b-model",
          api: "openai-responses",
          supportsImages: true,
          encryptedApiKey: Buffer.from("cipher-b").toString("base64")
        }
      ]
    },
    webSearch: { provider: "exa", encryptedExaApiKey: Buffer.from("cipher-search").toString("base64") }
  };
  const original = JSON.stringify(legacy);
  await writeFile(configPath, original);
  const decrypt = async (ciphertext) => {
    const text = ciphertext.toString();
    if (!text.startsWith("cipher-")) throw new Error("not old host ciphertext");
    return `plain-${text.slice("cipher-".length)}`;
  };

  await assert.rejects(
    migrateDesktopCredentials({
      configPath,
      decrypt: async (ciphertext) => {
        if (ciphertext.toString() === "cipher-b") throw new Error("keychain unavailable");
        return decrypt(ciphertext);
      }
    }),
    /无法使用旧版桌面宿主/
  );
  assert.equal(await readFile(configPath, "utf8"), original, "a failed migration keeps the old file");
  await assert.rejects(readFile(backupPath), { code: "ENOENT" });
  await assert.rejects(readFile(credentialsPath), { code: "ENOENT" });

  const result = await migrateDesktopCredentials({ configPath, decrypt });
  assert.equal(result.status, "migrated");
  assert.equal(result.modelConnections, 2);
  assert.equal(result.webSearch, true);
  assert.equal(result.backupPath, backupPath);
  assert.equal(await readFile(backupPath, "utf8"), original, "the original is retained byte for byte");
  const migrated = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(migrated.workspaceRoot, "/keep");
  assert.equal(migrated.modelConnections.profiles.length, 2);
  assert.equal(
    migrated.modelConnections.profiles.some((profile) => "encryptedApiKey" in profile),
    false
  );
  assert.equal(migrated.webSearch.provider, "exa");
  assert.equal(JSON.stringify(migrated).includes("plain-"), false, "plaintext stays out of the config");
  assert.equal("apiKey" in migrated, false, "a stray plaintext top-level key also moves to the store");
  const stored = new HostCredentialStore(credentialsPath);
  assert.equal(stored.value.modelConnections.a, "plain-a");
  assert.equal(stored.value.modelConnections.b, "plain-b");
  assert.equal(stored.value.webSearch.exaApiKey, "plain-search");
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);

  const again = await migrateDesktopCredentials({ configPath, decrypt });
  assert.equal(again.status, "already-migrated");
  assert.equal(again.modelConnections, 0);
  assert.equal(
    JSON.parse(await readFile(configPath, "utf8")).modelConnections.profiles.length,
    2,
    "re-running does not create duplicate connections"
  );
  assert.equal(Object.keys(new HostCredentialStore(credentialsPath).value.modelConnections).length, 2);
  const effective = readHostCoworkConfig(root, { COWORK_CONFIG: configPath });
  assert.equal(
    effective.modelConnections.profiles.find((profile) => profile.id === "a").apiKey,
    "plain-a",
    "the execution host resolves migrated keys for its runs"
  );
  assert.equal(effective.webSearch.exaApiKey, "plain-search");
});

test("desktop migration converts a legacy single connection secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "model-config.json");
  await writeFile(
    configPath,
    JSON.stringify({ baseUrl: "https://legacy.example/v1", model: "legacy-model" })
  );
  await writeFile(join(root, "model-secret.bin"), Buffer.from("cipher-legacy"));
  const result = await migrateDesktopCredentials({
    configPath,
    decrypt: async (ciphertext) => {
      assert.equal(ciphertext.toString(), "cipher-legacy");
      return "plain-legacy";
    }
  });
  assert.equal(result.status, "migrated");
  assert.equal(result.legacySecret, true);
  assert.equal(result.modelConnections, 1);
  assert.equal(
    new HostCredentialStore(join(root, "credentials.json")).value.modelConnections.default,
    "plain-legacy"
  );
});
