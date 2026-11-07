import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
