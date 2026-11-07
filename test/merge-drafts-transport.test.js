import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";
import { createManagementClient } from "../web/assets/controllers/management-client.js";

const require = createRequire(import.meta.url);
const { createBackendAuthorization } = require("../desktop/backend-authorization.cjs");
const { createSessionCredentialStore } = require("../desktop/session-credentials.cjs");
const { createSessionTransport } = require("../desktop/session-transport.cjs");
const { createComposerDraftStore } = require("../desktop/composer-drafts.cjs");

function storageFixture() {
  const records = new Map();
  return {
    records,
    get length() {
      return records.size;
    },
    key: (index) => [...records.keys()][index] ?? null,
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, String(value)),
    removeItem: (key) => records.delete(key)
  };
}
function draftFixture(storage) {
  const input = { value: "", addEventListener() {} };
  let files = [];
  const session = createComposerSession({
    input,
    storage,
    getAttachments: () => files,
    setAttachments: (next) => {
      files = next;
    }
  });
  return {
    input,
    session,
    files: () => files,
    setFiles: (next) => {
      files = next;
    }
  };
}
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test(
  "host-managed session protects drafts and delayed responses across A-B-A",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cowork-merge-host-"));
    const { startBackend, stopBackend } = await import("../dist/src/cli/backend.js");
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:COWORK_|ATRIA_|PI_|ELECTRON_|NODE_OPTIONS$)/.test(key)
      )
    );
    const instances = [];
    let client;
    t.after(async () => {
      client?.stop();
      for (const item of instances) {
        const stopped = await stopBackend(item.env, item.instance);
        console.log(JSON.stringify({ event: "backend-stop", pid: item.instance.pid, state: stopped.state }));
        assert.equal(stopped.state, "stopped");
      }
      await rm(root, { recursive: true, force: true });
    });
    for (const name of ["a", "b"]) {
      const home = join(root, name),
        workspace = join(root, `workspace-${name}`),
        config = join(root, `config-${name}.json`);
      await mkdir(workspace, { recursive: true });
      await writeFile(config, "{}");
      const env = {
        ...inherited,
        HOME: join(root, "user-home"),
        ATRIA_HOME: home,
        PI_CODING_AGENT_DIR: join(root, `pi-${name}`),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        COWORK_HARNESS_ROOT: resolve("."),
        COWORK_WORKSPACE: workspace,
        COWORK_CONFIG: config,
        COWORK_DISABLE_WATCH_SUPERVISOR: "1"
      };
      await mkdir(env.HOME, { recursive: true });
      const started = await startBackend(env, resolve("."), process.execPath);
      const instance = JSON.parse(await readFile(join(home, "runtime/backend-instance.json"), "utf8"));
      assert.equal(started.pid, instance.pid);
      instances.push({ env, instance, home });
    }
    const cryptoStore = {
      isEncryptionAvailable: async () => true,
      encryptString: async (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
      decryptString: async (value) =>
        Buffer.from(value)
          .map((byte) => byte ^ 0x5a)
          .toString()
    };
    const sessions = createSessionCredentialStore({ userData: join(root, "client"), storage: cryptoStore });
    const host = createBackendAuthorization({ appRoot: resolve("."), sessionStore: sessions });
    let selected = await host.select(instances[0].home);
    const transport = createSessionTransport({
      getSelected: () => selected,
      requestToken: (identity) => host.requestToken(identity)
    });
    const headers = { "x-cowork-desktop-nonce": transport.rotate() };
    const rendererStorage = storageFixture();
    const draftStorage = storageFixture();
    const view = draftFixture(draftStorage);
    view.session.activate(null);
    let lastBound;
    let control;
    let authorizationPending = true;
    const authStarted = gate(),
      authRelease = gate();
    client = createManagementClient({
      hostManagedSession: true,
      transportHeaders: headers,
      storage: rendererStorage,
      authorizeSession: async (input) => {
        if (authorizationPending) {
          authorizationPending = false;
          authStarted.release();
          await authRelease.promise;
        }
        return host.authorize({ ...input, baseUrl: selected.url, backendId: selected.backendId });
      },
      fetch: async (url, options) => {
        const sourceHeaders = new Headers(options?.headers);
        assert.equal(sourceHeaders.has("x-atria-token"), false);
        const absolute = new URL(url, selected.url).href;
        const request = transport.authorize(new Request(absolute, options));
        if (new URL(absolute).pathname === "/api/model-settings" && control) {
          const delayed = control;
          control = undefined;
          assert.equal(request.headers.has("x-atria-token"), true);
          assert.equal(request.headers.has("x-cowork-desktop-nonce"), false);
          const response = await fetch(request);
          assert.equal(response.status, 200);
          return {
            ok: delayed.status === 200,
            status: delayed.status,
            async text() {
              delayed.started.release();
              await delayed.release.promise;
              return delayed.status === 401
                ? JSON.stringify({ error: "old session" })
                : JSON.stringify({ backend: "old" });
            }
          };
        }
        return fetch(request);
      },
      onStateChange: (state) => {
        if (state.status === "connected" && state.backendId !== lastBound) {
          lastBound = state.backendId;
          view.session.setBackend(state.backendId);
          view.session.activate(null);
        }
      }
    });
    const connecting = client.connect();
    await authStarted.promise;
    view.input.value = "typed while host authorization waits";
    view.setFiles([{ name: "held.txt", text: "attachment A" }]);
    view.session.save();
    authRelease.release();
    assert.equal((await connecting).backendId, instances[0].instance.backendId);
    assert.equal(view.input.value, "typed while host authorization waits");
    assert.deepEqual(view.files(), [{ name: "held.txt", text: "attachment A" }]);
    assert.equal(rendererStorage.getItem("cowork.management.sessions.v1"), null);
    const switchTo = async (index) => {
      const oldNonce = headers["x-cowork-desktop-nonce"];
      selected = await host.select(instances[index].home);
      headers["x-cowork-desktop-nonce"] = transport.rotate();
      const rejected = transport.authorize(
        new Request(`${selected.url}/api/backend`, { headers: { "x-cowork-desktop-nonce": oldNonce } })
      );
      assert.equal(rejected.headers.has("x-atria-token"), false);
      const foreign = transport.authorize(new Request("http://example.invalid/api/backend", { headers }));
      assert.equal(foreign.headers.has("x-atria-token"), false);
      assert.equal(
        (await client.switchBackend({ baseUrl: "" })).backendId,
        instances[index].instance.backendId
      );
    };
    for (const status of [200, 401]) {
      const started = gate(),
        release = gate();
      control = { status, started, release };
      const pending = client.request("/api/model-settings");
      await started.promise;
      await switchTo(1);
      assert.equal(view.input.value, status === 200 ? "" : "draft B");
      view.input.value = "draft B";
      view.setFiles([{ name: "b.txt", text: "attachment B" }]);
      view.session.save();
      await switchTo(0);
      release.release();
      await assert.rejects(pending, (error) => error.code === "stale_client");
      assert.equal(client.state().status, "connected");
      assert.equal(view.input.value, "typed while host authorization waits");
      assert.deepEqual(view.files(), [{ name: "held.txt", text: "attachment A" }]);
    }
    const started = gate(),
      release = gate(),
      cancellation = new AbortController();
    control = { status: 401, started, release };
    const pending = client.request("/api/model-settings", { signal: cancellation.signal });
    await started.promise;
    cancellation.abort();
    release.release();
    await assert.rejects(pending, (error) => error.name === "AbortError");
    assert.equal(client.state().status, "connected");
    assert.equal((await client.request("/api/backend")).backendId, instances[0].instance.backendId);
    assert.equal(view.session.prepareClose(), true);
    const store = createComposerDraftStore(join(root, "client"));
    await store.load();
    await store.save(Object.fromEntries(draftStorage.records));
    const reopenedStore = createComposerDraftStore(join(root, "client"));
    await reopenedStore.load();
    const restoredStorage = storageFixture();
    for (const [key, value] of Object.entries(reopenedStore.snapshot().entries))
      restoredStorage.setItem(key, value);
    const restored = draftFixture(restoredStorage);
    restored.session.activate(null);
    restored.session.setBackend(instances[0].instance.backendId);
    restored.session.activate(null);
    assert.equal(restored.input.value, "typed while host authorization waits");
    assert.deepEqual(restored.files(), [{ name: "held.txt", text: "attachment A" }]);
    restored.session.setBackend(instances[1].instance.backendId);
    restored.session.activate(null);
    assert.equal(restored.input.value, "draft B");
    assert.deepEqual(restored.files(), [{ name: "b.txt", text: "attachment B" }]);
    const preCancelled = new AbortController();
    preCancelled.abort();
    await assert.rejects(
      client.request("/api/backend", { signal: preCancelled.signal }),
      (error) => error.name === "AbortError"
    );
    assert.equal(client.state().status, "connected");
    const liveStarted = gate(),
      liveRelease = gate();
    control = { status: 401, started: liveStarted, release: liveRelease };
    const live401 = client.request("/api/model-settings");
    await liveStarted.promise;
    liveRelease.release();
    await assert.rejects(live401, (error) => error.status === 401);
    assert.equal(client.state().status, "unauthorized");
    console.log(
      JSON.stringify({
        event: "combined-host-drafts",
        backends: instances.map(({ instance }) => ({ backendId: instance.backendId, pid: instance.pid })),
        stale: [200, 401],
        cancelled: 401,
        rendererSessionStore: null,
        a: "typed while host authorization waits",
        b: "draft B"
      })
    );
  }
);
