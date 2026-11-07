import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createComposerSession } from "../web/assets/controllers/composer-session.js";
import { createDraftRecovery } from "../web/assets/controllers/draft-recovery.js";
import { createManagementClient } from "../web/assets/controllers/management-client.js";
import { createFileUpload } from "../web/assets/controllers/file-upload.js";
import { createManagedMedia } from "../web/assets/controllers/managed-media.js";
import { createArtifactViewer } from "../web/assets/controllers/artifact-viewer.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const { createComposerDraftStore } = createRequire(import.meta.url)("../desktop/composer-drafts.cjs");

function draftFixture(existingStorage, locks) {
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
    locks,
    getAttachments: () => attachments,
    setAttachments: (files) => {
      attachments = files;
    }
  });
  return {
    input,
    session,
    storage,
    files: () => attachments,
    setFiles: (value) => (attachments = value),
    setUnavailable: (value) => (unavailable = value)
  };
}

function migrationStorage(capacity = Infinity) {
  const records = new Map();
  let unavailable = false;
  const size = (values) => [...values].reduce((total, [key, value]) => total + key.length + value.length, 0);
  return {
    records,
    get length() {
      return records.size;
    },
    key: (index) => [...records.keys()][index] ?? null,
    getItem: (key) => records.get(key) ?? null,
    setItem(key, value) {
      if (unavailable) throw new DOMException("Storage unavailable", "QuotaExceededError");
      const next = new Map(records);
      next.set(key, String(value));
      if (size(next) > capacity) throw new DOMException("Quota exceeded", "QuotaExceededError");
      records.set(key, String(value));
    },
    removeItem(key) {
      if (unavailable) throw new DOMException("Storage unavailable", "QuotaExceededError");
      records.delete(key);
    },
    setUnavailable: (value) => (unavailable = value),
    size: () => size(records)
  };
}

const attached = { name: "notes.txt", text: "attachment content", size: 18 };

function lockFixture() {
  const held = new Set();
  const waiting = new Map();
  return {
    async request(name, options, callback) {
      while (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await new Promise((resolve) => {
          const queue = waiting.get(name) || [];
          queue.push(resolve);
          waiting.set(name, queue);
        });
      }
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
        waiting.get(name)?.shift()?.();
      }
    }
  };
}

for (const kind of ["project", "global"]) {
  test(`P3: an unbound ${kind} draft survives successful close and actual process restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), "prebind-process-"));
    const store = join(root, "storage.json");
    const script = `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const { createComposerSession } = await import(process.argv[1]);
      const file = process.argv[2], stage = process.argv[3], kind = process.argv[4];
      const records = new Map(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
      const persist = () => writeFileSync(file, JSON.stringify([...records]));
      const storage = {
        get length() { return records.size; }, key: (i) => [...records.keys()][i] ?? null,
        getItem: (key) => records.get(key) ?? null,
        setItem(key, value) { records.set(key, String(value)); persist(); },
        removeItem(key) { records.delete(key); persist(); }
      };
      function fixture() {
        const input = { value: "", addEventListener() {} }; let files = [];
        const session = createComposerSession({ input, storage, getAttachments: () => files, setAttachments: (v) => { files = v; } });
        return { input, session, files: () => files, setFiles: (v) => { files = v; } };
      }
      if (stage === "write" && kind === "global") {
        storage.setItem("atria.composer.v1:new", JSON.stringify({text:"legacy A",attachments:[]}));
        storage.setItem("atria.composer.v1:backend-a:new", JSON.stringify({text:"existing A",attachments:[]}));
        const a = fixture(); a.session.activate(null); a.session.setBackend("backend-a"); a.session.activate(null); a.session.prepareClose();
      }
      const view = fixture(); view.session.activate(null);
      if (stage === "write") {
        if (kind === "project") view.session.activate(null, { projectId: "p1" });
        view.input.value = "unbound " + kind; view.setFiles([${JSON.stringify(attached)}]); view.session.save();
        console.log(JSON.stringify({ close: view.session.prepareClose(), records: Object.fromEntries(records) }));
      } else if (stage === "interrupt") {
        console.log(JSON.stringify({ interrupted: true, records: Object.fromEntries(records) }));
        process.exit(79);
      } else {
        view.session.setBackend(kind === "project" ? "backend-a" : "backend-b");
        view.session.activate(null, kind === "project" ? { projectId: "p1" } : {});
        const restored = { text: view.input.value, attachments: view.files() };
        if (stage === "delete") { view.input.value = ""; view.setFiles([]); view.session.save(); }
        console.log(JSON.stringify({ restored, close: view.session.prepareClose(), records: Object.fromEntries(records) }));
      }
    `;
    const run = (stage) => {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          pathToFileURL(resolve("web/assets/controllers/composer-session.js")).href,
          store,
          stage,
          kind
        ],
        { encoding: "utf8" }
      );
      assert.equal(child.status, stage === "interrupt" ? 79 : 0, child.stderr);
      const result = JSON.parse(child.stdout);
      console.log(
        JSON.stringify({
          event: "prebind-process",
          kind,
          stage,
          pid: child.pid,
          exitCode: child.status,
          result
        })
      );
      return result;
    };
    try {
      assert.equal(run("write").close, true);
      assert.equal(run("interrupt").interrupted, true);
      const recovered = run("delete");
      assert.deepEqual(recovered.restored, { text: `unbound ${kind}`, attachments: [attached] });
      assert.equal(recovered.close, true);
      const deleted = run("restart");
      assert.deepEqual(deleted.restored, { text: "", attachments: [] });
      assert.equal(deleted.close, true);
      if (kind === "global") assert.match(deleted.records["atria.composer.v1:backend-a:new"], /existing A/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("P3: multiple projects in one completed unbound session recover separately", () => {
  const storage = migrationStorage();
  const first = draftFixture(storage);
  first.session.activate(null, { projectId: "p1" });
  first.input.value = "project one";
  first.setFiles([attached]);
  first.session.save();
  first.session.activate(null, { projectId: "p2" });
  first.input.value = "project two";
  first.setFiles([]);
  first.session.save();
  assert.equal(first.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "project one");
  assert.deepEqual(restarted.files(), [attached]);
  restarted.session.activate(null, { projectId: "p2" });
  assert.equal(restarted.input.value, "project two");
  assert.deepEqual(restarted.files(), []);
});

test("P3: another live unbound session is not adopted with a completed session", () => {
  const storage = migrationStorage();
  const live = draftFixture(storage);
  live.session.activate(null, { projectId: "live" });
  live.input.value = "live A";
  live.session.save();
  const closed = draftFixture(storage);
  closed.session.activate(null, { projectId: "closed" });
  closed.input.value = "closed B";
  closed.setFiles([attached]);
  closed.session.save();
  assert.equal(closed.session.prepareClose(), true);
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-b");
  next.session.activate(null, { projectId: "closed" });
  assert.equal(next.input.value, "closed B");
  assert.deepEqual(next.files(), [attached]);
  next.session.activate(null, { projectId: "live" });
  assert.equal(next.input.value, "");
  live.session.setBackend("backend-a");
  live.session.activate(null, { projectId: "live" });
  assert.equal(live.input.value, "live A");
});

test("P3: an unindexed prior candidate's single saved prebind project is recoverable", () => {
  const storage = migrationStorage();
  const key = "atria.composer.v1:__prebind__:0123456789abcdef0123456789abcdef:new:p1";
  storage.setItem(key, JSON.stringify({ text: "old saved project", attachments: [attached] }));
  storage.setItem("atria.composer.v1:active", JSON.stringify("new:p1"));
  const view = draftFixture(storage);
  view.session.activate(null);
  view.session.setBackend("backend-a");
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.input.value, "old saved project");
  assert.deepEqual(view.files(), [attached]);
});

test("P3: an unindexed prior global draft survives a legacy ownership conflict", () => {
  const storage = migrationStorage();
  storage.setItem("atria.composer.v1:new", JSON.stringify({ text: "legacy A", attachments: [] }));
  storage.setItem("atria.composer.v1:backend-a:new", JSON.stringify({ text: "existing A", attachments: [] }));
  storage.setItem("atria.composer.v1:legacy-owner:active", JSON.stringify("backend-a"));
  storage.setItem("atria.composer.v1:active", JSON.stringify("new"));
  storage.setItem(
    "atria.composer.v1:__prebind__:0123456789abcdef0123456789abcdef:new",
    JSON.stringify({ text: "old B", attachments: [attached] })
  );
  const view = draftFixture(storage);
  view.session.activate(null);
  view.session.setBackend("backend-b");
  view.session.activate(null);
  assert.equal(view.input.value, "old B");
  assert.deepEqual(view.files(), [attached]);
  view.session.setBackend("backend-a");
  view.session.activate(null);
  assert.equal(view.input.value, "existing A");
});

test("P3: a conflicting recovered destination stays deleted after restart", () => {
  const storage = migrationStorage();
  const first = draftFixture(storage);
  first.session.activate(null, { projectId: "p1" });
  first.input.value = "recovery source";
  first.setFiles([attached]);
  first.session.save();
  assert.equal(first.session.prepareClose(), true);
  storage.setItem(
    "atria.composer.v1:backend-a:new:p1",
    JSON.stringify({ text: "existing A", attachments: [] })
  );
  const a = draftFixture(storage);
  a.session.activate(null);
  a.session.setBackend("backend-a");
  a.session.activate(null, { projectId: "p1" });
  assert.equal(a.input.value, "existing A");
  a.input.value = "";
  a.session.save();
  assert.equal(a.session.prepareClose(), true);
  const restart = draftFixture(storage);
  restart.session.activate(null);
  restart.session.setBackend("backend-b");
  restart.session.activate(null, { projectId: "p1" });
  assert.equal(restart.input.value, "");
  restart.session.setBackend("backend-a");
  restart.session.activate(null, { projectId: "p1" });
  assert.equal(restart.input.value, "");
  assert.ok([...storage.records.values()].some((value) => value.includes("recovery source")));
});

test("P3: a resumed prior owner cannot delete a successor's adopted source", () => {
  const storage = migrationStorage();
  const previous = draftFixture(storage);
  previous.session.activate(null, { projectId: "p1" });
  previous.input.value = "original content";
  previous.setFiles([attached]);
  previous.session.save();
  assert.equal(previous.session.prepareClose(), true);
  const successor = draftFixture(storage);
  successor.session.activate(null);
  previous.input.value = "";
  previous.setFiles([]);
  previous.session.save();
  successor.session.setBackend("backend-b");
  successor.session.activate(null, { projectId: "p1" });
  assert.equal(successor.input.value, "original content");
  assert.deepEqual(successor.files(), [attached]);
});

test("P3: a detached former owner cannot remove a successor's live marker", () => {
  const storage = migrationStorage();
  const previous = draftFixture(storage);
  previous.session.activate(null, { projectId: "p1" });
  previous.input.value = "original";
  previous.session.save();
  previous.session.detach();
  assert.equal(previous.session.prepareClose(), true);
  const successor = draftFixture(storage);
  successor.session.activate(null);
  previous.session.setBackend("backend-a");
  const other = draftFixture(storage);
  other.session.activate(null);
  other.session.setBackend("backend-c");
  other.session.activate(null, { projectId: "p1" });
  assert.equal(other.input.value, "");
  successor.session.setBackend("backend-b");
  successor.session.activate(null, { projectId: "p1" });
  assert.equal(successor.input.value, "original");
});

test("P3: another close preparation cannot release a successor's live marker", () => {
  const storage = migrationStorage();
  const prior = draftFixture(storage);
  prior.session.activate(null, { projectId: "p1" });
  prior.input.value = "original";
  prior.session.save();
  prior.session.detach();
  assert.equal(prior.session.prepareClose(), true);
  const successor = draftFixture(storage);
  successor.session.activate(null);
  assert.equal(prior.session.prepareClose(), true);
  const other = draftFixture(storage);
  other.session.activate(null);
  other.session.setBackend("backend-c");
  other.session.activate(null, { projectId: "p1" });
  successor.session.setBackend("backend-b");
  successor.session.activate(null, { projectId: "p1" });
  assert.equal(successor.input.value, "original");
});

test("P3: separately closed sessions can be explicitly recovered without overwriting a conflict", async () => {
  const storage = migrationStorage();
  const first = draftFixture(storage),
    second = draftFixture(storage);
  first.session.activate(null, { projectId: "p1" });
  first.input.value = "first";
  first.setFiles([attached]);
  first.session.save();
  second.session.activate(null, { projectId: "p2" });
  second.input.value = "second";
  second.setFiles([attached]);
  second.session.save();
  assert.equal(first.session.prepareClose(), true);
  assert.equal(second.session.prepareClose(), true);
  const before = [...storage.records.values()];
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-b");
  const candidates = await next.session.listRecoverableDrafts();
  assert.equal(candidates.length, 2);
  const one = candidates.find((entry) => entry.projectId === "p1");
  const two = candidates.find((entry) => entry.projectId === "p2");
  assert.ok(one && two);
  assert.deepEqual(await next.session.recoverDraft(one.id, { projectId: "p1" }), { ok: true });
  next.session.activate(null, { projectId: "p1" });
  assert.equal(next.input.value, "first");
  assert.deepEqual(next.files(), [attached]);
  assert.deepEqual(await next.session.recoverDraft(two.id, { projectId: "p1" }), {
    ok: false,
    reason: "conflict"
  });
  assert.equal(next.input.value, "first");
  assert.deepEqual(await next.session.recoverDraft(two.id, { projectId: "p2" }), { ok: true });
  next.session.activate(null, { projectId: "p2" });
  assert.equal(next.input.value, "second");
  assert.deepEqual(next.files(), [attached]);
  assert.ok(
    before.some((value) => value.includes("first")) && before.some((value) => value.includes("second"))
  );
  assert.equal(next.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-b");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "first");
  restarted.session.activate(null, { projectId: "p2" });
  assert.equal(restarted.input.value, "second");
});

test("P3: older unindexed groups can be individually assigned without losing their sources", async () => {
  // These are the key/value shapes emitted by two 90b7bfd0 production
  // sessions which saved p1 and p2 and successfully prepared to close.
  const storage = migrationStorage();
  for (const [id, project] of [
    ["1".repeat(32), "p1"],
    ["2".repeat(32), "p2"]
  ]) {
    storage.setItem(
      `atria.composer.v1:__prebind__:${id}:new:${project}`,
      JSON.stringify({
        text: `saved ${project}`,
        attachments: [{ name: `${project}.txt`, text: `bytes ${project}` }]
      })
    );
  }
  const view = draftFixture(storage);
  view.session.activate(null);
  view.session.setBackend("backend-a");
  const candidates = await view.session.listRecoverableDrafts();
  assert.equal(candidates.length, 2);
  for (const projectId of ["p1", "p2"]) {
    const source = candidates.find((candidate) => candidate.projectId === projectId);
    assert.ok(source);
    assert.deepEqual(await view.session.recoverDraft(source.id, { projectId }), { ok: true });
    view.session.activate(null, { projectId });
    assert.equal(view.input.value, `saved ${projectId}`);
    assert.deepEqual(view.files(), [{ name: `${projectId}.txt`, text: `bytes ${projectId}` }]);
    assert.ok(storage.getItem(source.id), "unmarked historical source stays available");
  }
  view.input.value = "";
  view.setFiles([]);
  view.session.save();
  assert.equal(view.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "saved p1");
  restarted.session.activate(null, { projectId: "p2" });
  assert.equal(restarted.input.value, "");
  assert.deepEqual(restarted.files(), []);
});

test("P3: a ready group alongside unmarked history requires an explicit choice", async () => {
  const storage = migrationStorage();
  const original = draftFixture(storage);
  original.session.activate(null, { projectId: "p1" });
  original.input.value = "ready";
  original.session.save();
  assert.equal(original.session.prepareClose(), true);
  storage.setItem(
    `atria.composer.v1:__prebind__:${"a".repeat(32)}:new:p2`,
    JSON.stringify({ text: "history", attachments: [attached] })
  );
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-b");
  next.session.activate(null, { projectId: "p1" });
  assert.equal(next.input.value, "");
  assert.deepEqual((await next.session.listRecoverableDrafts()).map((draft) => draft.text).sort(), [
    "history",
    "ready"
  ]);
});

test("P3: a legacy live marker from an exited owner remains manually recoverable", async () => {
  const storage = migrationStorage();
  const prefix = `atria.composer.v1:__prebind__:${"b".repeat(32)}:`;
  storage.setItem(prefix + "active", JSON.stringify(`live:${"c".repeat(32)}`));
  storage.setItem(prefix + "new:p1", JSON.stringify({ text: "interrupted legacy", attachments: [attached] }));
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-a");
  const [draft] = await next.session.listRecoverableDrafts();
  assert.equal(draft.text, "interrupted legacy");
  assert.deepEqual(await next.session.recoverDraft(draft.id, { projectId: "p1" }), { ok: true });
  next.session.activate(null, { projectId: "p1" });
  assert.deepEqual(next.files(), [attached]);
  next.input.value = "";
  next.setFiles([]);
  next.session.save();
  assert.equal(next.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "");
  assert.ok(storage.getItem(prefix + "new:p1"), "the potentially active old source is retained");
  assert.equal((await restarted.session.listRecoverableDrafts())[0].text, "interrupted legacy");
});

for (const marker of [null, "ready:old-writer"]) {
  test(`P3: an old ${marker === null ? "unmarked" : "ready"} writer is never consumed without a shared lease`, async () => {
    const storage = migrationStorage();
    const prefix = `atria.composer.v1:__prebind__:${"d".repeat(32)}:`;
    if (marker) storage.setItem(prefix + "active", JSON.stringify(marker));
    const source = JSON.stringify({ text: "old writer content", attachments: [attached] });
    storage.setItem(prefix + "new:p1", source);
    const next = draftFixture(storage, lockFixture());
    await next.session.ready;
    next.session.activate(null);
    next.session.setBackend("backend-a");
    next.session.activate(null, { projectId: "p1" });
    assert.equal(next.input.value, "");
    assert.equal(storage.getItem(prefix + "new:p1"), source);
    const [draft] = await next.session.listRecoverableDrafts();
    assert.deepEqual(await next.session.recoverDraft(draft.id, { projectId: "p1" }), { ok: true });
    assert.equal(next.input.value, "old writer content");
    assert.deepEqual(next.files(), [attached]);
    assert.equal(storage.getItem(prefix + "new:p1"), source);
    await next.session.dispose();
  });
}

test("P3: replay of an old writer's journal preserves its potentially live source", async () => {
  const storage = migrationStorage();
  const prefix = `atria.composer.v1:__prebind__:${"e".repeat(32)}:`;
  const sourceKey = prefix + "new:p1";
  const destination = "atria.composer.v1:backend-a:new:p1";
  const source = JSON.stringify({ text: "legacy journal source", attachments: [attached] });
  storage.setItem(sourceKey, source);
  storage.setItem(destination, source);
  storage.setItem(
    "atria.composer.v1:migration-journal:active",
    JSON.stringify(JSON.stringify([{ sourceKey, destination }]))
  );
  const view = draftFixture(storage, lockFixture());
  await view.session.ready;
  assert.equal(storage.getItem(sourceKey), source);
  view.session.activate(null);
  view.session.setBackend("backend-a");
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.input.value, "legacy journal source");
  view.input.value = "";
  view.setFiles([]);
  view.session.save();
  assert.equal(view.session.prepareClose(), true);
  await view.session.dispose();
  const restarted = draftFixture(storage, lockFixture());
  await restarted.session.ready;
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "");
  assert.equal(storage.getItem(sourceKey), source);
  await restarted.session.dispose();
});

test("P3: an old journal persists protection before retrying a missing destination", async () => {
  const storage = migrationStorage();
  const sourceKey = `atria.composer.v1:__prebind__:${"f".repeat(32)}:new:p1`;
  const destination = "atria.composer.v1:backend-a:new:p1";
  const source = JSON.stringify({ text: "old interrupted write", attachments: [attached] });
  storage.setItem(sourceKey, source);
  storage.setItem(
    "atria.composer.v1:migration-journal:active",
    JSON.stringify(JSON.stringify([{ sourceKey, destination }]))
  );
  const write = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (key, value) => {
    if (fail && key === "atria.composer.v1:migration-journal:active") throw new Error("journal unavailable");
    write(key, value);
  };
  const view = draftFixture(storage, lockFixture());
  await view.session.ready;
  assert.equal(view.session.prepareClose(), false);
  assert.equal(storage.getItem(sourceKey), source);
  assert.equal(storage.getItem(destination), null);
  fail = false;
  assert.equal(view.session.prepareClose(), true);
  assert.equal(storage.getItem(sourceKey), source);
  assert.equal(storage.getItem(destination), source);
  view.session.activate(null);
  view.session.setBackend("backend-a");
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.input.value, "old interrupted write");
  assert.deepEqual(view.files(), [attached]);
  await view.session.dispose();
});

test("P3: a browser without cross-context locks preserves journal sources", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const storage = migrationStorage();
    const prefix = `atria.composer.v1:__prebind__:${"a".repeat(32)}:`;
    const sourceKey = prefix + "new:p1";
    const destination = "atria.composer.v1:backend-a:new:p1";
    const source = JSON.stringify({ text: "unlocked source", attachments: [attached] });
    storage.setItem(prefix + "active", JSON.stringify(`ready:lease:${"a".repeat(32)}`));
    storage.setItem(sourceKey, source);
    storage.setItem(destination, source);
    storage.setItem(
      "atria.composer.v1:migration-journal:active",
      JSON.stringify(JSON.stringify([{ sourceKey, destination }]))
    );
    const view = draftFixture(storage);
    assert.equal(storage.getItem(sourceKey), source);
    view.session.activate(null);
    view.session.setBackend("backend-a");
    view.session.activate(null, { projectId: "p1" });
    assert.equal(view.input.value, "unlocked source");
    assert.equal(view.session.prepareClose(), true);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("P3: an automatic migration conflict remains selectable for another project", async () => {
  const storage = migrationStorage();
  storage.setItem(
    "atria.composer.v1:backend-a:new:p1",
    JSON.stringify({ text: "existing", attachments: [] })
  );
  const original = draftFixture(storage);
  original.session.activate(null, { projectId: "p1" });
  original.input.value = "staged";
  original.setFiles([attached]);
  original.session.save();
  assert.equal(original.session.prepareClose(), true);
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-a");
  next.session.activate(null, { projectId: "p1" });
  assert.equal(next.input.value, "existing");
  const candidates = await next.session.listRecoverableDrafts();
  assert.equal(candidates.length, 1);
  assert.deepEqual(await next.session.recoverDraft(candidates[0].id, { projectId: "p1" }), {
    ok: false,
    reason: "conflict"
  });
  assert.deepEqual(await next.session.recoverDraft(candidates[0].id, { projectId: "p2" }), { ok: true });
  next.session.activate(null, { projectId: "p2" });
  assert.equal(next.input.value, "staged");
  assert.deepEqual(next.files(), [attached]);
  next.session.activate(null, { projectId: "p1" });
  assert.equal(next.input.value, "existing");
});

test("P3: explicit recovery retries a failed journal before consuming its source", async () => {
  const storage = migrationStorage();
  const sessions = [];
  for (const [projectId, text] of [
    ["p1", "one"],
    ["p2", "two"]
  ]) {
    const view = draftFixture(storage);
    sessions.push(view.session);
    view.session.activate(null, { projectId });
    view.input.value = text;
    view.setFiles([attached]);
    view.session.save();
  }
  for (const session of sessions) assert.equal(session.prepareClose(), true);
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-a");
  const source = (await next.session.listRecoverableDrafts()).find((draft) => draft.projectId === "p1");
  const write = storage.setItem.bind(storage);
  let failed = true;
  storage.setItem = (key, value) => {
    if (failed && key === "atria.composer.v1:migration-journal:active")
      throw new Error("journal unavailable");
    write(key, value);
  };
  assert.deepEqual(await next.session.recoverDraft(source.id, { projectId: "p1" }), {
    ok: false,
    reason: "save"
  });
  assert.ok(storage.getItem(source.id));
  assert.equal(storage.getItem("atria.composer.v1:backend-a:new:p1"), null);
  failed = false;
  assert.equal(next.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "one");
  assert.deepEqual(restarted.files(), [attached]);
});

test("P3: a live lease isolates a closed source; releasing it restores recovery", async () => {
  const locks = lockFixture();
  const storage = migrationStorage();
  const owner = draftFixture(storage, locks);
  await owner.session.ready;
  owner.session.activate(null, { projectId: "p1" });
  owner.input.value = "owned content";
  owner.setFiles([attached]);
  owner.session.save();
  assert.equal(owner.session.prepareClose(), true);
  const concurrent = draftFixture(storage, locks);
  await concurrent.session.ready;
  concurrent.session.activate(null);
  concurrent.session.setBackend("backend-b");
  concurrent.session.activate(null, { projectId: "p1" });
  assert.equal(concurrent.input.value, "");
  assert.deepEqual(await concurrent.session.listRecoverableDrafts(), []);
  assert.ok([...storage.records.values()].some((value) => value.includes("owned content")));
  owner.session.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  const interrupted = draftFixture(storage, locks);
  await interrupted.session.ready;
  interrupted.session.activate(null);
  interrupted.session.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  const restarted = draftFixture(storage, locks);
  await restarted.session.ready;
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "owned content");
  assert.deepEqual(restarted.files(), [attached]);
  restarted.session.dispose();
  concurrent.session.dispose();
});

test("P3: journal replay cannot consume a source held by a live instance", async () => {
  const locks = lockFixture();
  const storage = migrationStorage();
  const owner = draftFixture(storage, locks);
  await owner.session.ready;
  owner.session.activate(null, { projectId: "p1" });
  owner.input.value = "source held during cleanup";
  owner.setFiles([attached]);
  owner.session.save();
  assert.equal(owner.session.prepareClose(), true);
  const remove = storage.removeItem.bind(storage);
  let failCleanup = true;
  storage.removeItem = (key) => {
    if (failCleanup && key.includes(":__prebind__:") && key.endsWith(":new:p1"))
      throw new Error("cleanup unavailable");
    remove(key);
  };
  owner.session.setBackend("backend-a");
  assert.equal(owner.session.prepareClose(), false);
  const source = [...storage.records.keys()].find(
    (key) => key.includes(":__prebind__:") && key.endsWith(":new:p1")
  );
  assert.ok(source && storage.getItem(source));
  failCleanup = false;
  const other = draftFixture(storage, locks);
  await other.session.ready;
  assert.ok(storage.getItem(source), "a different live session must not consume the owner's source");
  await owner.session.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.getItem(source), null);
  assert.equal(other.session.prepareClose(), true);
  other.session.activate(null);
  other.session.setBackend("backend-a");
  other.session.activate(null, { projectId: "p1" });
  assert.equal(other.input.value, "source held during cleanup");
  assert.deepEqual(other.files(), [attached]);
  await other.session.dispose();
});

test("P3: an unavailable browser lease blocks a false successful close", async () => {
  const storage = migrationStorage();
  const view = draftFixture(storage, {
    request() {
      throw new Error("lease unavailable");
    }
  });
  await view.session.ready;
  view.session.activate(null, { projectId: "p1" });
  view.input.value = "not yet durable";
  view.setFiles([attached]);
  view.session.save();
  assert.equal(view.session.prepareClose(), false);
  assert.equal(
    [...storage.records.values()].some((value) => value.includes("not yet durable")),
    false
  );
  assert.equal(view.input.value, "not yet durable");
});

test("P3: a browser without cross-context locks copies only on explicit selection", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const storage = migrationStorage();
    const first = draftFixture(storage);
    first.session.activate(null, { projectId: "p1" });
    first.input.value = "explicit fallback";
    first.setFiles([attached]);
    first.session.save();
    assert.equal(first.session.prepareClose(), true);
    const second = draftFixture(storage);
    second.session.activate(null);
    second.session.setBackend("backend-a");
    second.session.activate(null, { projectId: "p1" });
    assert.equal(second.input.value, "");
    const [source] = await second.session.listRecoverableDrafts();
    assert.deepEqual(await second.session.recoverDraft(source.id, { projectId: "p1" }), { ok: true });
    assert.equal(second.input.value, "explicit fallback");
    assert.deepEqual(second.files(), [attached]);
    assert.ok(storage.getItem(source.id), "without cross-context locks the source is retained");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("P3: a late recovery result cannot navigate after an A-B-A switch", async () => {
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML("<html><body><button id='recovery'></button></body></html>");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.document = document;
  globalThis.window = window;
  window.HTMLElement.prototype.getClientRects = () => [{}];
  try {
    let backend = "backend-a";
    let context = 1;
    let finish;
    const opened = [];
    const session = {
      listRecoverableDrafts: async () => [
        { id: "source-one", projectId: "p1", text: "saved draft", attachments: [] }
      ],
      recoverDraft: () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    };
    const button = document.querySelector("#recovery");
    const controller = createDraftRecovery({
      button,
      session,
      getBackend: () => backend,
      getContext: () => context,
      getProjects: () => [{ projectId: "p1", projectName: "Project one" }],
      openDraft: (projectId) => opened.push({ backend, projectId })
    });
    await controller.refresh();
    button.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setImmediate(resolve));
    const form = document.querySelector("form");
    form.querySelector('[name="source"] option[value="source-one"]').selected = true;
    form.querySelector('[name="project"] option[value="project:p1"]').selected = true;
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    assert.equal(typeof finish, "function");
    backend = "backend-b";
    context += 1;
    backend = "backend-a";
    context += 1;
    finish({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, []);
    assert.match(document.querySelector('[role="alert"]').textContent, /原后端/);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});

test("P3: an A-B-A switch cancels a pending recovery before it writes", async () => {
  const storage = migrationStorage();
  const first = draftFixture(storage);
  const second = draftFixture(storage);
  for (const [view, projectId] of [
    [first, "p1"],
    [second, "p2"]
  ]) {
    view.session.activate(null, { projectId });
    view.input.value = projectId;
    view.setFiles([attached]);
    view.session.save();
  }
  assert.equal(first.session.prepareClose(), true);
  assert.equal(second.session.prepareClose(), true);
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-a");
  const [source] = await next.session.listRecoverableDrafts();
  const pending = next.session.recoverDraft(source.id, { projectId: "p1" });
  next.session.setBackend("backend-b");
  next.session.setBackend("backend-a");
  assert.deepEqual(await pending, { ok: false, reason: "backend" });
  assert.ok(storage.getItem(source.id));
  assert.equal(storage.getItem("atria.composer.v1:backend-a:new:p1"), null);
});

test("P3: an unbound draft is not published when its ownership marker cannot be stored", () => {
  const storage = migrationStorage();
  const setItem = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (key, value) => {
    if (fail && key.includes(":__prebind__:") && key.endsWith(":active"))
      throw new Error("marker unavailable");
    setItem(key, value);
  };
  const view = draftFixture(storage);
  view.session.activate(null, { projectId: "p1" });
  view.input.value = "marker protected";
  view.setFiles([attached]);
  view.session.save();
  assert.equal(view.session.prepareClose(), false);
  assert.equal(
    [...storage.records.values()].some((value) => value.includes("marker protected")),
    false
  );
  fail = false;
  assert.equal(view.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "marker protected");
  assert.deepEqual(restarted.files(), [attached]);
});

test("P3: a failed recovery journal retries and restores the visible draft", () => {
  const storage = migrationStorage();
  const first = draftFixture(storage);
  first.session.activate(null, { projectId: "p1" });
  first.input.value = "retry recovery";
  first.setFiles([attached]);
  first.session.save();
  assert.equal(first.session.prepareClose(), true);
  const setItem = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (key, value) => {
    if (fail && key === "atria.composer.v1:migration-journal:active") throw new Error("journal unavailable");
    setItem(key, value);
  };
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-a");
  next.session.activate(null, { projectId: "p1" });
  assert.equal(next.session.prepareClose(), false);
  fail = false;
  assert.equal(next.session.prepareClose(), true);
  assert.equal(next.input.value, "retry recovery");
  assert.deepEqual(next.files(), [attached]);
  next.session.activate(null);
  next.session.activate(null, { projectId: "p1" });
  assert.equal(next.input.value, "retry recovery");
  assert.deepEqual(next.files(), [attached]);
});

test("P3: a failed claim retains its first backend across another switch", () => {
  const storage = migrationStorage();
  const first = draftFixture(storage);
  first.session.activate(null, { projectId: "p1" });
  first.input.value = "belongs to B";
  first.setFiles([attached]);
  first.session.save();
  assert.equal(first.session.prepareClose(), true);
  const setItem = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (key, value) => {
    if (
      fail &&
      key.includes(":__prebind__:") &&
      key.endsWith(":active") &&
      JSON.parse(value).startsWith("live:")
    )
      throw new Error("claim unavailable");
    setItem(key, value);
  };
  const next = draftFixture(storage);
  next.session.activate(null);
  next.session.setBackend("backend-b");
  next.session.activate(null, { projectId: "p1" });
  next.session.setBackend("backend-a");
  next.session.activate(null, { projectId: "p1" });
  fail = false;
  assert.equal(next.session.prepareClose(), true);
  assert.equal(next.input.value, "");
  assert.deepEqual(next.files(), []);
  next.session.setBackend("backend-b");
  next.session.activate(null, { projectId: "p1" });
  assert.equal(next.input.value, "belongs to B");
  assert.deepEqual(next.files(), [attached]);
});

test("P3: a recovered journal removes the now-empty session marker", () => {
  const storage = migrationStorage();
  const view = draftFixture(storage);
  view.session.activate(null, { projectId: "p1" });
  view.input.value = "retry journal";
  view.setFiles([attached]);
  view.session.save();
  const setItem = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (key, value) => {
    if (fail && key === "atria.composer.v1:migration-journal:active") throw new Error("journal unavailable");
    setItem(key, value);
  };
  view.session.setBackend("backend-a");
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.session.prepareClose(), false);
  fail = false;
  assert.equal(view.session.prepareClose(), true);
  assert.equal(view.input.value, "retry journal");
  assert.deepEqual(view.files(), [attached]);
  assert.equal(
    [...storage.records.keys()].some((key) => key.includes(":__prebind__:")),
    false
  );
});

test("P3: interruption between multiple project migrations retains every project's backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "prebind-batch-"));
  const file = join(root, "storage.json");
  const script = `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const { createComposerSession } = await import(process.argv[1]);
    const file = process.argv[2], stage = process.argv[3];
    const records = new Map(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
    const persist = () => writeFileSync(file, JSON.stringify([...records]));
    const storage = {
      get length() { return records.size; }, key: (i) => [...records.keys()][i] ?? null,
      getItem: (key) => records.get(key) ?? null,
      setItem(key, value) { records.set(key, String(value)); persist(); },
      removeItem(key) {
        records.delete(key); persist();
        if (stage === "bind" && key === "atria.composer.v1:migration-journal:active") process.exit(79);
      }
    };
    const input = { value: "", addEventListener() {} }; let files = [];
    const session = createComposerSession({ input, storage, getAttachments: () => files, setAttachments: (next) => { files = next; } });
    session.activate(null);
    if (stage === "write") {
      for (const project of ["p1", "p2"]) {
        session.activate(null, {projectId:project}); input.value = "draft " + project;
        files = [${JSON.stringify(attached)}]; session.save();
      }
      console.log(JSON.stringify({close:session.prepareClose()}));
    } else if (stage === "bind") {
      session.setBackend("backend-a");
    } else {
      session.setBackend("backend-b"); session.activate(null,{projectId:"p2"}); const b = input.value;
      session.setBackend("backend-a"); session.activate(null,{projectId:"p2"});
      console.log(JSON.stringify({b,text:input.value,attachments:files}));
    }
  `;
  const run = (stage) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        pathToFileURL(resolve("web/assets/controllers/composer-session.js")).href,
        file,
        stage
      ],
      { encoding: "utf8" }
    );
  try {
    const before = run("write");
    assert.equal(before.status, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).close, true);
    const interrupted = run("bind");
    assert.equal(interrupted.status, 79, interrupted.stderr);
    const restarted = run("restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(JSON.parse(restarted.stdout), { b: "", text: "draft p2", attachments: [attached] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a web client can create its draft session without secure-context randomUUID", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (values) => values.fill(1) }
  });
  try {
    const view = draftFixture();
    view.session.activate(null);
    view.input.value = "remote browser draft";
    view.session.save();
    assert.equal(view.session.prepareClose(), true);
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
});

test("S1: recovered preconnection migration does not resurrect deleted text or attachments", () => {
  const storage = migrationStorage();
  const first = draftFixture(storage);
  first.session.activate(null);
  storage.setUnavailable(true);
  first.input.value = "connecting draft";
  first.setFiles([attached]);
  first.session.save();
  first.session.setBackend("backend-a");
  first.session.activate(null);
  assert.equal(first.input.value, "connecting draft");
  assert.deepEqual(first.files(), [attached]);
  storage.setUnavailable(false);
  assert.equal(first.session.prepareClose(), true);
  first.input.value = "";
  first.setFiles([]);
  first.session.save();
  assert.equal(first.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "");
  assert.deepEqual(restarted.files(), []);
});

test("S1: deleting a destination with a conflicting legacy source remains deleted", () => {
  const storage = migrationStorage();
  const source = JSON.stringify({ text: "unclaimed legacy", attachments: [attached] });
  storage.setItem("atria.composer.v1:new", source);
  storage.setItem("atria.composer.v1:backend-a:new", JSON.stringify({ text: "newer A", attachments: [] }));
  storage.setItem("atria.composer.v1:backend-a:active", JSON.stringify("new"));
  const first = draftFixture(storage);
  first.session.activate(null);
  first.session.setBackend("backend-a");
  first.session.activate(null);
  assert.equal(first.input.value, "newer A");
  first.input.value = "";
  first.session.save();
  assert.equal(first.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "");
  assert.deepEqual(restarted.files(), []);
  assert.equal(storage.getItem("atria.composer.v1:new"), source);
});

test("S1: a conflict remains protected when restarting in B before deleting in A", () => {
  const storage = migrationStorage();
  const source = JSON.stringify({ text: "legacy source", attachments: [attached] });
  storage.setItem("atria.composer.v1:new", source);
  storage.setItem(
    "atria.composer.v1:backend-a:new",
    JSON.stringify({ text: "A destination", attachments: [attached] })
  );
  const initial = draftFixture(storage);
  initial.session.activate(null);
  initial.session.setBackend("backend-a");
  initial.session.activate(null);
  assert.equal(initial.input.value, "A destination");
  assert.equal(initial.session.prepareClose(), true);
  const restartedB = draftFixture(storage);
  restartedB.session.activate(null);
  restartedB.session.setBackend("backend-b");
  restartedB.session.activate(null);
  restartedB.session.setBackend("backend-a");
  restartedB.session.activate(null);
  assert.equal(restartedB.input.value, "A destination");
  restartedB.input.value = "";
  restartedB.setFiles([]);
  restartedB.session.save();
  assert.equal(restartedB.session.prepareClose(), true);
  const restartedA = draftFixture(storage);
  restartedA.session.activate(null);
  restartedA.session.setBackend("backend-a");
  restartedA.session.activate(null);
  assert.equal(restartedA.input.value, "");
  assert.deepEqual(restartedA.files(), []);
  assert.equal(storage.getItem("atria.composer.v1:new"), source);
});

test("S2: quota failure cannot move an unmarked backend task into another backend", () => {
  const capacity = 1200;
  const storage = migrationStorage(capacity);
  const filler = "fixture.other-cache";
  storage.setItem(filler, "x".repeat(capacity - filler.length));
  const first = draftFixture(storage);
  first.session.activate(null);
  first.session.setBackend("backend-a");
  first.session.activate("task-a");
  const draft = JSON.stringify({ text: "saved work A", attachments: [attached] });
  const taskKey = "atria.composer.v1:backend-a:task-a";
  storage.setItem(filler, "x".repeat(capacity - filler.length - taskKey.length - draft.length));
  first.input.value = "saved work A";
  first.setFiles([attached]);
  first.session.save();
  assert.equal(storage.size(), capacity);
  assert.equal(storage.getItem(taskKey), draft);
  assert.equal(storage.getItem("atria.composer.v1:backend-a:active"), null);
  assert.equal(first.session.prepareClose(), false);
  storage.removeItem(filler);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-b");
  restarted.session.activate("task-b");
  assert.equal(restarted.input.value, "");
  assert.equal(storage.getItem(taskKey), draft);
  restarted.session.setBackend("backend-a");
  restarted.session.activate("task-a");
  assert.equal(restarted.input.value, "saved work A");
  assert.deepEqual(restarted.files(), [attached]);
});

test("S2: quota-limited task survives actual process exit and another backend's first connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "draft-quota-process-"));
  const store = join(root, "local-storage.json");
  const modulePath =
    process.env.COWORK_TEST_DRAFT_SESSION_FILE || resolve("web/assets/controllers/composer-session.js");
  const script = `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const { createComposerSession } = await import(process.argv[1]);
    const path = process.argv[2], stage = process.argv[3], capacity = 1200;
    const records = new Map(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []);
    const size = (map) => [...map].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
    const persist = () => writeFileSync(path, JSON.stringify([...records]));
    const storage = {
      get length() { return records.size; },
      key: (index) => [...records.keys()][index] ?? null,
      getItem: (key) => records.get(key) ?? null,
      setItem(key, value) {
        const next = new Map(records); next.set(key, String(value));
        if (size(next) > capacity) throw new DOMException("quota exceeded", "QuotaExceededError");
        records.set(key, String(value)); persist();
      },
      removeItem(key) { records.delete(key); persist(); }
    };
    const input = { value: "", addEventListener() {} };
    let files = [];
    const session = createComposerSession({ input, storage, getAttachments: () => files, setAttachments: (next) => { files = next; } });
    const task = "atria.composer.v1:backend-a:task-a", filler = "fixture.other-cache";
    if (stage === "write") {
      storage.setItem(filler, "x".repeat(capacity - filler.length));
      session.activate(null); session.setBackend("backend-a"); session.activate("task-a");
      const draft = JSON.stringify({ text: "saved work A", attachments: [${JSON.stringify(attached)}] });
      storage.setItem(filler, "x".repeat(capacity - filler.length - task.length - draft.length));
      input.value = "saved work A"; files = [${JSON.stringify(attached)}]; session.save();
      console.log(JSON.stringify({ used: size(records), task: storage.getItem(task), active: storage.getItem("atria.composer.v1:backend-a:active") }));
    } else {
      storage.removeItem(filler);
      session.activate(null); session.setBackend("backend-b"); session.activate("task-b");
      const afterB = { visible: input.value, source: storage.getItem(task) };
      session.setBackend("backend-a"); session.activate("task-a");
      console.log(JSON.stringify({ afterB, text: input.value, attachments: files, source: storage.getItem(task) }));
    }
  `;
  const run = (stage) => {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, pathToFileURL(modulePath).href, store, stage],
      { encoding: "utf8" }
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    console.log(
      JSON.stringify({ event: "quota-process", stage, pid: child.pid, exitCode: child.status, result })
    );
    return result;
  };
  try {
    const written = run("write");
    assert.equal(written.used, 1200);
    assert.equal(written.active, null);
    assert.deepEqual(JSON.parse(written.task), { text: "saved work A", attachments: [attached] });
    const restored = run("restart");
    assert.equal(restored.afterB.visible, "");
    assert.equal(restored.afterB.source, written.task);
    assert.equal(restored.source, written.task);
    assert.equal(restored.text, "saved work A");
    assert.deepEqual(restored.attachments, [attached]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S2: an ambiguous saved key is preserved until its backend is known", () => {
  const storage = migrationStorage();
  const key = "atria.composer.v1:new:task-a";
  const saved = JSON.stringify({ text: "ambiguous backend task", attachments: [attached] });
  storage.setItem(key, saved);
  const session = draftFixture(storage);
  session.session.activate(null);
  session.session.setBackend("backend-b");
  session.session.activate(null);
  assert.equal(storage.getItem(key), saved);
  session.session.setBackend("new");
  session.session.activate("task-a");
  assert.equal(session.input.value, "ambiguous backend task");
  assert.deepEqual(session.files(), [attached]);
});

test("S2: a preconnection project cannot overwrite an ambiguous backend task key", () => {
  const storage = migrationStorage();
  const key = "atria.composer.v1:new:task-a";
  const saved = JSON.stringify({ text: "backend task", attachments: [attached] });
  storage.setItem(key, saved);
  const view = draftFixture(storage);
  view.session.activate(null, { projectId: "task-a" });
  assert.equal(view.input.value, "");
  view.input.value = "preconnection project";
  view.setFiles([attached]);
  view.session.save();
  view.session.setBackend("backend-b");
  view.session.activate(null, { projectId: "task-a" });
  assert.equal(view.input.value, "preconnection project");
  assert.equal(view.session.prepareClose(), true);
  assert.equal(storage.getItem(key), saved);
  view.session.setBackend("new");
  view.session.activate("task-a");
  assert.equal(view.input.value, "backend task");
  assert.deepEqual(view.files(), [attached]);
});

test("P2: a conflicting preconnection project stays with its first backend", () => {
  const storage = migrationStorage();
  storage.setItem(
    "atria.composer.v1:backend-a:new:p1",
    JSON.stringify({ text: "existing A", attachments: [] })
  );
  const first = draftFixture(storage);
  first.session.activate(null, { projectId: "p1" });
  first.input.value = "preconnection A";
  first.setFiles([attached]);
  first.session.save();
  first.session.setBackend("backend-a");
  first.session.activate(null, { projectId: "p1" });
  assert.equal(first.input.value, "existing A");
  assert.equal(first.session.prepareClose(), true);
  first.session.setBackend("backend-b");
  first.session.activate(null, { projectId: "p1" });
  assert.equal(first.input.value, "");
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-b");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "");
  assert.ok([...storage.records.values()].some((value) => value.includes("preconnection A")));
});

test("P1: a persisted journal restores a preconnection project after an interrupted destination write", () => {
  const storage = migrationStorage();
  const setItem = storage.setItem.bind(storage);
  let failDestination = true;
  storage.setItem = (key, value) => {
    if (failDestination && key === "atria.composer.v1:backend-a:new:p1") throw new Error("quota");
    setItem(key, value);
  };
  const first = draftFixture(storage);
  first.session.activate(null, { projectId: "p1" });
  first.input.value = "before interruption";
  first.setFiles([attached]);
  first.session.save();
  first.session.setBackend("backend-a");
  assert.equal(storage.getItem("atria.composer.v1:backend-a:new:p1"), null);
  assert.ok(storage.getItem("atria.composer.v1:migration-journal:active"));
  failDestination = false;
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "before interruption");
  assert.deepEqual(restarted.files(), [attached]);
  assert.equal(restarted.session.prepareClose(), true);
});

test("P1: project migration cleanup survives switching backends and later deletion", () => {
  const storage = migrationStorage();
  const first = draftFixture(storage);
  first.session.setBackend("backend-a");
  first.session.activate(null);
  first.input.value = "legacy instruction";
  first.setFiles([attached]);
  first.session.save();
  storage.setUnavailable(true);
  first.session.activate(null, { projectId: "p1" });
  assert.equal(first.input.value, "legacy instruction");
  assert.deepEqual(first.files(), [attached]);
  first.session.setBackend("backend-b");
  first.session.activate(null);
  storage.setUnavailable(false);
  assert.equal(first.session.prepareClose(), true);
  first.session.setBackend("backend-a");
  first.session.activate(null, { projectId: "p1" });
  assert.equal(first.input.value, "legacy instruction");
  assert.deepEqual(first.files(), [attached]);
  first.input.value = "";
  first.setFiles([]);
  first.session.save();
  assert.equal(first.session.prepareClose(), true);
  first.session.activate(null);
  assert.equal(first.input.value, "");
  assert.deepEqual(first.files(), []);
  first.session.activate(null, { projectId: "p2" });
  assert.equal(first.input.value, "");
  assert.deepEqual(first.files(), []);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "");
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "");
  assert.deepEqual(restarted.files(), []);
  restarted.session.activate(null, { projectId: "p2" });
  assert.equal(restarted.input.value, "");
  assert.deepEqual(restarted.files(), []);
});

test("P1: a changed source is kept while its older migrated copy is recovered", () => {
  const storage = migrationStorage();
  const view = draftFixture(storage);
  view.session.setBackend("backend-a");
  view.session.activate(null);
  view.input.value = "original source";
  view.setFiles([attached]);
  view.session.save();
  storage.setUnavailable(true);
  view.session.activate(null, { projectId: "p1" });
  view.session.activate(null);
  view.input.value = "new independent source";
  view.setFiles([]);
  view.session.save();
  storage.setUnavailable(false);
  assert.equal(view.session.prepareClose(), true);
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.input.value, "original source");
  assert.deepEqual(view.files(), [attached]);
  view.session.activate(null);
  assert.equal(view.input.value, "new independent source");
});

test("P1: a destination changed by another window cannot consume its unchanged source", () => {
  const storage = migrationStorage();
  const remove = storage.removeItem.bind(storage);
  let failCleanup = false;
  storage.removeItem = (key) => {
    if (failCleanup && key === "atria.composer.v1:backend-a:new") throw new Error("cleanup unavailable");
    remove(key);
  };
  const view = draftFixture(storage);
  view.session.setBackend("backend-a");
  view.session.activate(null);
  view.input.value = "original source";
  view.setFiles([attached]);
  view.session.save();
  failCleanup = true;
  view.session.activate(null, { projectId: "p1" });
  view.session.setBackend("backend-b");
  view.session.activate(null);
  const changed = JSON.stringify({ text: "other window", attachments: [] });
  storage.setItem("atria.composer.v1:backend-a:new:p1", changed);
  failCleanup = false;
  assert.equal(view.session.prepareClose(), true);
  assert.deepEqual(JSON.parse(storage.getItem("atria.composer.v1:backend-a:new")), {
    text: "original source",
    attachments: [attached]
  });
  assert.equal(storage.getItem("atria.composer.v1:backend-a:new:p1"), changed);
});

test("P1: a failed source cleanup blocks close and can be retried after a backend switch", () => {
  const storage = migrationStorage();
  const remove = storage.removeItem.bind(storage);
  let failCleanup = false;
  storage.removeItem = (key) => {
    if (failCleanup && key === "atria.composer.v1:backend-a:new") throw new Error("cleanup unavailable");
    remove(key);
  };
  const view = draftFixture(storage);
  view.session.setBackend("backend-a");
  view.session.activate(null);
  view.input.value = "move and retain";
  view.setFiles([attached]);
  view.session.save();
  failCleanup = true;
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.session.prepareClose(), false);
  view.session.setBackend("backend-b");
  view.session.activate(null);
  assert.equal(view.session.prepareClose(), false);
  failCleanup = false;
  assert.equal(view.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "move and retain");
  assert.deepEqual(restarted.files(), [attached]);
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "");
});

test("P1: an interrupted cleanup cannot resurrect a subsequently deleted project draft", () => {
  const storage = migrationStorage();
  const remove = storage.removeItem.bind(storage);
  let failCleanup = false;
  storage.removeItem = (key) => {
    if (failCleanup && key === "atria.composer.v1:backend-a:new") throw new Error("cleanup unavailable");
    remove(key);
  };
  const first = draftFixture(storage);
  first.session.setBackend("backend-a");
  first.session.activate(null);
  first.input.value = "interrupted transfer";
  first.setFiles([attached]);
  first.session.save();
  failCleanup = true;
  first.session.activate(null, { projectId: "p1" });
  assert.equal(first.session.prepareClose(), false);
  failCleanup = false;
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "interrupted transfer");
  restarted.input.value = "";
  restarted.setFiles([]);
  restarted.session.save();
  assert.equal(restarted.session.prepareClose(), true);
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "");
  restarted.session.activate(null, { projectId: "p2" });
  assert.equal(restarted.input.value, "");
});

test("P1: a failed migration journal prevents the destination committing before its recovery record", () => {
  const storage = migrationStorage();
  const put = storage.setItem.bind(storage);
  let failJournal = false;
  storage.setItem = (key, value) => {
    if (failJournal && key === "atria.composer.v1:migration-journal:active")
      throw new Error("journal unavailable");
    put(key, value);
  };
  const view = draftFixture(storage);
  view.session.setBackend("backend-a");
  view.session.activate(null);
  view.input.value = "journal protected";
  view.setFiles([attached]);
  view.session.save();
  failJournal = true;
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.input.value, "journal protected");
  assert.deepEqual(view.files(), [attached]);
  assert.equal(view.session.prepareClose(), false);
  assert.equal(storage.getItem("atria.composer.v1:backend-a:new:p1"), null);
  assert.match(storage.getItem("atria.composer.v1:backend-a:new"), /journal protected/);
  failJournal = false;
  assert.equal(view.session.prepareClose(), true);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "journal protected");
  assert.deepEqual(restarted.files(), [attached]);
});

test("P1: restart preserves a changed migration source and a later destination deletion", () => {
  const storage = migrationStorage();
  const remove = storage.removeItem.bind(storage);
  let failCleanup = false;
  storage.removeItem = (key) => {
    if (failCleanup && key === "atria.composer.v1:backend-a:new") throw new Error("cleanup unavailable");
    remove(key);
  };
  const first = draftFixture(storage);
  first.session.setBackend("backend-a");
  first.session.activate(null);
  first.input.value = "old source";
  first.setFiles([attached]);
  first.session.save();
  failCleanup = true;
  first.session.activate(null, { projectId: "p1" });
  assert.equal(first.session.prepareClose(), false);
  failCleanup = false;
  const newer = JSON.stringify({ text: "new independent source", attachments: [attached] });
  storage.setItem("atria.composer.v1:backend-a:new", newer);
  const restarted = draftFixture(storage);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "old source");
  restarted.input.value = "";
  restarted.setFiles([]);
  restarted.session.save();
  assert.equal(restarted.session.prepareClose(), true);
  const again = draftFixture(storage);
  again.session.activate(null);
  again.session.setBackend("backend-a");
  again.session.activate(null, { projectId: "p1" });
  assert.equal(again.input.value, "");
  assert.equal(storage.getItem("atria.composer.v1:backend-a:new"), newer);
});

test("P1: a damaged recovery journal blocks closing without consuming drafts", () => {
  const storage = migrationStorage();
  storage.setItem("atria.composer.v1:migration-journal:active", "{broken");
  storage.setItem(
    "atria.composer.v1:backend-a:new",
    JSON.stringify({ text: "preserve recovery data", attachments: [attached] })
  );
  const view = draftFixture(storage);
  view.session.activate(null);
  view.session.setBackend("backend-a");
  view.session.activate(null);
  assert.equal(view.input.value, "preserve recovery data");
  view.session.activate(null, { projectId: "p1" });
  assert.equal(view.input.value, "preserve recovery data");
  assert.equal(view.session.prepareClose(), false);
  assert.equal(storage.getItem("atria.composer.v1:migration-journal:active"), "{broken");
  assert.equal(storage.getItem("atria.composer.v1:backend-a:new:p1"), null);
});

test("P1: desktop profile persists and replays an interrupted migration journal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cowork-migration-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = migrationStorage();
  const remove = storage.removeItem.bind(storage);
  let failCleanup = false;
  storage.removeItem = (key) => {
    if (failCleanup && key === "atria.composer.v1:backend-a:new") throw new Error("cleanup unavailable");
    remove(key);
  };
  const first = draftFixture(storage);
  first.session.setBackend("backend-a");
  first.session.activate(null);
  first.input.value = "profile migration";
  first.setFiles([attached]);
  first.session.save();
  failCleanup = true;
  first.session.activate(null, { projectId: "p1" });
  assert.equal(first.session.prepareClose(), false);
  assert.ok(storage.getItem("atria.composer.v1:migration-journal:active"));
  const store = createComposerDraftStore(directory);
  await store.load();
  await store.save(Object.fromEntries(storage.records), "http://127.0.0.1:45111");
  const restartedStore = createComposerDraftStore(directory);
  await restartedStore.load();
  const recovered = migrationStorage();
  for (const [key, value] of Object.entries(restartedStore.snapshot().entries)) recovered.setItem(key, value);
  const restarted = draftFixture(recovered);
  restarted.session.activate(null);
  restarted.session.setBackend("backend-a");
  restarted.session.activate(null, { projectId: "p1" });
  assert.equal(restarted.input.value, "profile migration");
  assert.deepEqual(restarted.files(), [attached]);
  assert.equal(restarted.session.prepareClose(), true);
  restarted.input.value = "";
  restarted.setFiles([]);
  restarted.session.save();
  assert.equal(restarted.session.prepareClose(), true);
  restarted.session.activate(null);
  assert.equal(restarted.input.value, "");
});

test("P2: startup navigation metadata cannot assign B's new input to A", () => {
  const storage = migrationStorage();
  const initial = draftFixture(storage);
  initial.session.activate(null);
  initial.session.setBackend("backend-a");
  initial.session.activate("task-a");
  initial.input.value = "A task draft";
  initial.session.save();
  const a = draftFixture(storage);
  a.session.activate(null);
  a.session.setBackend("backend-a");
  a.session.activate(a.session.activeTask);
  assert.equal(a.input.value, "A task draft");
  a.session.setBackend("backend-b");
  a.session.activate(null);
  assert.equal(a.session.prepareClose(), true);
  const b = draftFixture(storage);
  b.session.activate(null);
  b.input.value = "typed while connecting B";
  b.setFiles([attached]);
  b.session.save();
  b.session.setBackend("backend-b");
  b.session.activate(b.session.activeTask);
  assert.equal(b.input.value, "typed while connecting B");
  assert.deepEqual(b.files(), [attached]);
  assert.equal(b.session.prepareClose(), true);
  const reloadedB = draftFixture(storage);
  reloadedB.session.activate(null);
  reloadedB.session.setBackend("backend-b");
  reloadedB.session.activate(null);
  assert.equal(reloadedB.input.value, "typed while connecting B");
  assert.deepEqual(reloadedB.files(), [attached]);
  const returnA = draftFixture(storage);
  returnA.session.activate(null);
  returnA.session.setBackend("backend-a");
  returnA.session.activate(null);
  assert.equal(returnA.input.value, "");
  assert.deepEqual(returnA.files(), []);
});

test("P2: a retained legacy conflict cannot capture or overwrite later preconnection input", () => {
  const storage = migrationStorage();
  const source = JSON.stringify({ text: "unclaimed A source", attachments: [attached] });
  storage.setItem("atria.composer.v1:new", source);
  storage.setItem(
    "atria.composer.v1:backend-a:new",
    JSON.stringify({ text: "A destination", attachments: [] })
  );
  const a = draftFixture(storage);
  a.session.activate(null);
  a.session.setBackend("backend-a");
  a.session.activate(null);
  assert.equal(a.input.value, "A destination");
  assert.equal(a.session.prepareClose(), true);
  const b = draftFixture(storage);
  b.session.activate(null);
  b.input.value = "B preconnection";
  b.setFiles([attached]);
  b.session.save();
  b.session.setBackend("backend-b");
  b.session.activate(null);
  assert.equal(b.input.value, "B preconnection");
  assert.deepEqual(b.files(), [attached]);
  assert.equal(b.session.prepareClose(), true);
  assert.equal(storage.getItem("atria.composer.v1:new"), source);
  const restartB = draftFixture(storage);
  restartB.session.activate(null);
  restartB.session.setBackend("backend-b");
  restartB.session.activate(null);
  assert.equal(restartB.input.value, "B preconnection");
  assert.deepEqual(restartB.files(), [attached]);
});

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
