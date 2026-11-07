import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";
import { createManagementClient } from "../web/assets/controllers/management-client.js";
import { createFileUpload } from "../web/assets/controllers/file-upload.js";
import { createManagedMedia } from "../web/assets/controllers/managed-media.js";
import { createArtifactViewer } from "../web/assets/controllers/artifact-viewer.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const { createComposerDraftStore } = createRequire(import.meta.url)("../desktop/composer-drafts.cjs");

function draftFixture(existingStorage) {
  const records = new Map();
  let unavailable = false;
  const storage = existingStorage || {
    get length() {
      return records.size;
    },
    key: (index) => [...records.keys()][index] ?? null,
    getItem: (key) => records.get(key) ?? null,
    setItem(key, value) {
      if (unavailable) throw new Error("storage unavailable");
      records.set(key, String(value));
    },
    removeItem(key) {
      if (unavailable) throw new Error("storage unavailable");
      records.delete(key);
    }
  };
  const input = { value: "", addEventListener() {} };
  let attachments = [];
  const session = createComposerSession({
    input,
    storage,
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    }
  });
  return { input, session, storage, setUnavailable: (value) => (unavailable = value) };
}

test("failed draft writes remain recoverable after changing backends", () => {
  const { input, session, setUnavailable } = draftFixture();
  session.setBackend("backend-a");
  session.activate("task-a");
  input.value = "last saved";
  session.save();
  setUnavailable(true);
  input.value = "unsaved latest";
  session.save();
  session.setBackend("backend-b");
  session.activate("task-b");
  assert.equal(session.prepareClose(), false);
  setUnavailable(false);
  assert.equal(session.prepareClose(), true);
  session.setBackend("backend-a");
  session.activate("task-a");
  assert.equal(input.value, "unsaved latest");
});

test("a legacy new draft is claimed by one backend across restarts", () => {
  const original = draftFixture();
  original.session.activate(null);
  original.input.value = "legacy draft";
  original.session.save();
  original.session.setBackend("backend-a");
  original.session.activate(null);
  assert.equal(original.input.value, "legacy draft");

  const restarted = draftFixture(original.storage);
  restarted.session.setBackend("backend-b");
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "");
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "legacy draft");
});

test("a draft typed before the first connection survives a temporary storage failure", () => {
  const { input, session, setUnavailable } = draftFixture();
  session.activate(null);
  setUnavailable(true);
  input.value = "typed while connecting";
  session.save();
  session.setBackend("backend-a");
  session.activate(null);
  assert.equal(input.value, "typed while connecting");
  assert.equal(session.prepareClose(), false);
  setUnavailable(false);
  assert.equal(session.prepareClose(), true);
  session.setBackend("backend-b");
  session.activate(null);
  assert.equal(input.value, "");
  session.setBackend("backend-a");
  session.activate(null);
  assert.equal(input.value, "typed while connecting");
});

test("a response body finishing after a backend switch is rejected", async (t) => {
  let releaseBody;
  let bodyStarted;
  const started = new Promise((resolve) => (bodyStarted = resolve));
  const body = new Promise((resolve) => (releaseBody = resolve));
  const protocol = {
    version: "1.0",
    minClientVersion: "1.0",
    capabilities: ["session.authorize", "events.snapshot", "events.stream"]
  };
  const client = createManagementClient({
    authorizeSession: async ({ baseUrl }) => ({
      backend: { backendId: baseUrl },
      protocol,
      session: { token: `token-${baseUrl}`, sessionId: baseUrl }
    }),
    fetch: async (url, options) => {
      const target = new URL(url);
      if (target.pathname === "/api/events/snapshot")
        return Response.json({ backendId: target.origin, cursor: 0 });
      if (target.pathname === "/api/events/stream")
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      return {
        ok: true,
        status: 200,
        async text() {
          bodyStarted();
          await body;
          return JSON.stringify({ taskId: "task-from-a" });
        }
      };
    }
  });
  t.after(() => client.stop());
  assert.equal((await client.connect({ baseUrl: "http://backend-a.test" })).status, "connected");
  const result = client.request("/api/tasks/late").then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await started;
  assert.equal((await client.switchBackend({ baseUrl: "http://backend-b.test" })).status, "connected");
  releaseBody();
  assert.equal((await result).error?.code, "stale_client");
});

test("cancelled upload cannot block or add files to a different draft", async () => {
  let release;
  let context = "first";
  let files = [];
  const busy = [];
  const uploader = createFileUpload({
    getContext: () => context,
    getFiles: () => files,
    setFiles: (value) => (files = value),
    onStatus() {},
    onBusy: (value) => busy.push(value),
    onError: (message) => assert.fail(message),
    upload: (file) =>
      file.name === "first.txt"
        ? new Promise((resolve) => (release = resolve))
        : Promise.resolve({ name: file.name, sha256: "second", uploadId: "upload-second" })
  });
  const first = uploader.add([new File(["first"], "first.txt")]);
  context = "second";
  uploader.navigate();
  await uploader.add([new File(["second"], "second.txt")]);
  release({ name: "first.txt", sha256: "first", uploadId: "upload-first" });
  await first;
  assert.deepEqual(
    files.map((file) => file.name),
    ["second.txt"]
  );
  assert.equal(busy.at(-1), false);
});

test("an evicted pending preview cannot replace a newer read of the same path", async () => {
  const pending = [];
  const revoked = [];
  const media = createManagedMedia({
    limit: 1,
    read: (path) => new Promise((resolve) => pending.push({ path, resolve })),
    createObjectURL: (blob) => `blob:${blob.label}`,
    revokeObjectURL: (url) => revoked.push(url)
  });
  const old = media.get("/first").catch((error) => error);
  const other = media.get("/other");
  pending[1].resolve({ blob: { label: "other" } });
  assert.equal(await other, "blob:other");
  const latest = media.get("/first");
  pending[0].resolve({ blob: { label: "old" } });
  await old;
  assert.equal(media.get("/first"), latest);
  pending[2].resolve({ blob: { label: "latest" } });
  assert.equal(await latest, "blob:latest");
  media.clear();
  await Promise.resolve();
  assert.ok(revoked.includes("blob:latest"));
});

test("desktop profile restores backend and project drafts including a durable deletion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cowork-drafts-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createComposerDraftStore(directory);
  await store.load();
  const first = draftFixture();
  first.session.setBackend("backend-a");
  first.session.activate(null, { projectId: "project-a" });
  first.input.value = "project A new draft";
  first.session.save();
  first.session.activate("task-a");
  first.input.value = "task A draft";
  first.session.save();
  first.session.setBackend("backend-b");
  first.session.activate(null, { projectId: "project-b" });
  first.input.value = "project B new draft";
  first.session.save();
  first.session.setBackend("backend-a");
  first.session.activate("task-a");
  first.input.value = "";
  first.session.save();
  assert.equal(first.session.prepareClose(), true);

  const entries = {};
  for (let i = 0; i < first.storage.length; i++) {
    const key = first.storage.key(i);
    if (key.startsWith("atria.composer.v1:")) entries[key] = first.storage.getItem(key);
  }
  await store.save(entries, "http://127.0.0.1:10001");
  const restartedStore = createComposerDraftStore(directory);
  await restartedStore.load();
  const restored = draftFixture();
  for (const [key, value] of Object.entries(restartedStore.snapshot().entries))
    restored.storage.setItem(key, value);
  restored.session.setBackend("backend-a");
  restored.session.activate("task-a");
  assert.equal(restored.input.value, "");
  restored.session.activate(null, { projectId: "project-a" });
  assert.equal(restored.input.value, "project A new draft");
  restored.session.setBackend("backend-b");
  restored.session.activate(null, { projectId: "project-b" });
  assert.equal(restored.input.value, "project B new draft");
});

test("a rejected native save keeps the last snapshot and accepts a later recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cowork-draft-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createComposerDraftStore(directory, { limit: 512 });
  await store.load();
  const key = "atria.composer.v1:backend-a:new";
  const entry = (text) => ({ [key]: JSON.stringify({ text, attachments: [] }) });
  await store.save(entry("last good"));
  await assert.rejects(store.save(entry("x".repeat(1000))), /过大/);
  assert.equal(JSON.parse(store.snapshot().entries[key]).text, "last good");
  await store.save(entry("recovered latest"));
  const restarted = createComposerDraftStore(directory, { limit: 512 });
  await restarted.load();
  assert.equal(JSON.parse(restarted.snapshot().entries[key]).text, "recovered latest");
});

test("selected bytes and artifacts stay with their authorized backend", { timeout: 90000 }, async (t) => {
  const { startBackend, stopBackend } = await import("../dist/src/cli/backend.js");
  let uploadId;
  let modelStep = 0;
  const modelFailures = [];
  const model = await modelProtocolFixture("openai-completions", (request) => {
    try {
      if (modelStep++ === 0) {
        assert.match(JSON.stringify(request.messages), new RegExp(uploadId));
        return { name: "read_attachment", arguments: { id: uploadId } };
      }
      assert.match(
        JSON.stringify(request.messages.findLast((message) => message.role === "tool")),
        /first bytes/
      );
      return { text: "fixture read complete" };
    } catch (error) {
      modelFailures.push(error.message);
      return { text: "fixture failed" };
    }
  });
  t.after(() => model.close());
  const root = await mkdtemp(join(tmpdir(), "cowork-electron-files-"));
  const repository = resolve(new URL("..", import.meta.url).pathname);
  const instances = [];
  t.after(async () => {
    for (const { env, instance } of instances) await stopBackend(env, instance);
    await rm(root, { recursive: true, force: true });
  });
  for (const side of ["a", "b"]) {
    const home = join(root, side, "home");
    const workspace = join(root, side, "workspace");
    const userHome = join(root, side, "user-home");
    await mkdir(workspace, { recursive: true });
    await mkdir(userHome, { recursive: true });
    const config = join(root, side, "config.json");
    await writeFile(config, "{}");
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(COWORK_|PI_|ATRIA_|ELECTRON_)/.test(key))
      ),
      HOME: userHome,
      ATRIA_HOME: home,
      PI_CODING_AGENT_DIR: join(root, side, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      COWORK_HARNESS_ROOT: repository,
      COWORK_WORKSPACE: workspace,
      COWORK_GLOBAL_INDEX: join(home, "runtime", "workspaces.json"),
      COWORK_TABS_INDEX: join(home, "runtime", "tabs.json"),
      COWORK_CONFIG: config,
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_API_BASE: model.baseUrl,
      COWORK_API_KEY: "local-fixture",
      COWORK_MODEL: "protocol-fixture",
      COWORK_REASONING_EFFORT: "off",
      COWORK_SUPPORTS_REASONING_EFFORT: "0"
    };
    await startBackend(env, repository, process.execPath);
    const instance = JSON.parse(await readFile(join(home, "runtime", "backend-instance.json"), "utf8"));
    instances.push({ env, instance, workspace });
  }

  const originals = { XMLHttpRequest: globalThis.XMLHttpRequest, document: globalThis.document };
  t.after(() => {
    if (originals.XMLHttpRequest === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = originals.XMLHttpRequest;
    if (originals.document === undefined) delete globalThis.document;
    else globalThis.document = originals.document;
  });
  globalThis.XMLHttpRequest = class {
    constructor() {
      this.headers = {};
      this.upload = {};
      this.controller = new AbortController();
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    abort() {
      this.controller.abort();
    }
    send(file) {
      fetch(this.url, {
        method: this.method,
        headers: this.headers,
        body: file,
        signal: this.controller.signal
      })
        .then(async (response) => {
          this.status = response.status;
          this.responseText = await response.text();
          this.onload();
        })
        .catch(() => (this.controller.signal.aborted ? this.onabort() : this.onerror()));
    }
  };

  const client = createManagementClient({
    fetch: (url, options = {}) => {
      const instance = instances.find((item) => item.instance.url === new URL(url).origin)?.instance;
      const authorize = options.method === "POST" && new URL(url).pathname === "/api/session";
      return fetch(url, {
        ...options,
        headers: { ...options.headers, ...(authorize ? { "x-atria-token": instance.token } : {}) }
      });
    }
  });
  t.after(() => client.stop());
  let context = 1;
  let files = [];
  const uploader = createFileUpload({
    getContext: () => context,
    getFiles: () => files,
    setFiles: (value) => (files = value),
    onStatus() {},
    onBusy() {},
    onError: (message) => assert.fail(message),
    upload: (file, options) => client.upload(file, options)
  });
  const [a, b] = instances;
  for (const item of instances) {
    assert.equal((await client.connect({ baseUrl: item.instance.url })).status, "connected");
    await client.command("/api/tasks", { body: { taskId: "shared-task", goal: "fixture task" } });
    const artifacts = join(item.workspace, "shared-task", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "report.txt"), item === a ? "artifact A" : "artifact B");
  }
  assert.equal((await client.switchBackend({ baseUrl: a.instance.url })).status, "connected");
  await uploader.add([new File(["first bytes"], "same.txt"), new File(["second bytes"], "same.txt")]);
  assert.equal(files.length, 2);
  assert.notEqual(files[0].uploadId, files[1].uploadId);
  assert.equal(await (await client.blob(`/api/uploads/${files[0].uploadId}`)).blob.text(), "first bytes");
  assert.equal(await (await client.blob(`/api/uploads/${files[1].uploadId}`)).blob.text(), "second bytes");
  uploadId = files[0].uploadId;
  await client.request("/api/tasks/shared-task/run", {
    method: "POST",
    json: { prompt: "read the selected file", attachmentIds: [uploadId] }
  });
  let detail;
  for (let i = 0; i < 200; i++) {
    detail = await client.request("/api/tasks/shared-task");
    if (!detail.runtime?.active && detail.messages?.some((message) => message.role === "assistant")) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.deepEqual(modelFailures, []);
  assert.equal(modelStep, 2);
  assert.match(JSON.stringify(detail.messages), /fixture read complete/);
  await assert.rejects(
    client.request("/api/tasks/shared-task/run", {
      method: "POST",
      json: { prompt: "fixture", attachmentIds: ["/client/private/same.txt"] }
    }),
    (error) => error.status === 400
  );
  const artifact = "/api/tasks/shared-task/artifact?path=report.txt&raw=1";
  assert.equal((await fetch(a.instance.url + artifact)).status, 401);
  let opened;
  const viewer = createArtifactViewer({
    read: (path) => client.blob(path),
    identity: () => client.state(),
    host: { onClosed: () => () => {}, open: async (url) => (opened = url) }
  });
  t.after(() => viewer.dispose());
  await viewer.open(artifact);
  assert.equal(await (await fetch(opened)).text(), "artifact A");
  const oldUrl = opened;
  viewer.reset();
  context += 1;
  uploader.navigate();
  files = [];
  assert.equal((await client.switchBackend({ baseUrl: b.instance.url })).status, "connected");
  await assert.rejects(fetch(oldUrl));
  await uploader.add([new File(["backend B bytes"], "same.txt")]);
  const preview = await client.request(`/api/uploads/${files[0].uploadId}/preview`);
  assert.equal(preview.text, "backend B bytes");
  await viewer.open(artifact);
  assert.equal(await (await fetch(opened)).text(), "artifact B");
  let downloaded;
  globalThis.document = {
    body: { append() {} },
    createElement: () => ({
      dataset: {},
      click() {
        downloaded = this.href;
      },
      remove() {}
    })
  };
  await client.download("/api/tasks/shared-task/artifact?path=report.txt&download=1", "report.txt");
  assert.equal(await (await fetch(downloaded)).text(), "artifact B");
});
