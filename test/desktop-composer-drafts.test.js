import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createComposerDraftStore } = createRequire(import.meta.url)("../desktop/composer-drafts.cjs");
const draft = (text) => ({
  "atria.composer.v1:active": JSON.stringify("new"),
  "atria.composer.v1:new": JSON.stringify({ text, attachments: [] })
});

test("valid envelopes containing malformed draft records are backed up instead of silently cleared", async (t) => {
  for (const value of [
    "{invalid inner JSON",
    JSON.stringify({ text: 7, attachments: [] }),
    JSON.stringify({ text: "draft", attachments: [{ name: "bad-file", text: null }] })
  ]) {
    const root = await mkdtemp(join(tmpdir(), "atria-draft-inner-damaged-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "composer-drafts.json");
    const original = JSON.stringify({ version: 1, entries: { "atria.composer.v1:new": value } });
    await writeFile(path, original);
    const store = createComposerDraftStore(root);
    await store.load();
    assert.match(store.snapshot().warning, /损坏/);
    const backup = (await readdir(root)).find((name) => name.startsWith("composer-drafts.json.invalid-"));
    assert.equal(await readFile(join(root, backup), "utf8"), original);
    assert.equal((await stat(join(root, backup))).mode & 0o777, 0o600);
    await store.save(draft("replacement after backup"));
  }
});

test("draft validation retains compatible empty records and attachments while rejecting invalid active sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-draft-valid-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createComposerDraftStore(root);
  await store.load();
  const entries = {
    ...draft("attached draft"),
    "atria.composer.v1:old-empty": "null",
    "atria.composer.v1:with-file": JSON.stringify({
      text: "draft",
      attachments: [{ name: "notes.txt", text: "notes", size: 5 }]
    })
  };
  await store.save(entries);
  assert.deepEqual(store.snapshot().entries, entries);
  await assert.rejects(store.save({ "atria.composer.v1:active": "12" }), /会话/);
  assert.deepEqual(store.snapshot().entries, entries);
});

test("a backend-namespaced page keeps its session marker beside its own drafts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-draft-namespace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createComposerDraftStore(root);
  await store.load();
  const entries = {
    "atria.composer.v1:backend_fixture:active": JSON.stringify("new"),
    "atria.composer.v1:backend_fixture:new": JSON.stringify({ text: "namespaced", attachments: [] }),
    "atria.composer.v1:active": JSON.stringify("new")
  };
  await store.save(entries);
  assert.deepEqual(store.snapshot().entries, entries);
  await assert.rejects(store.save({ "atria.composer.v1:backend_fixture:active": "12" }), /会话/);
  await writeFile(join(root, "composer-drafts.json"), JSON.stringify({ version: 4, entries }));
  const restored = createComposerDraftStore(root);
  await restored.load();
  assert.deepEqual(restored.snapshot().entries, entries);
});

test("desktop drafts persist privately across origins without accepting other storage keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-draft-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createComposerDraftStore(root);
  await store.load();
  await store.save(draft("重启后继续这份草稿"), "http://127.0.0.1:12345");
  assert.equal((await stat(join(root, "composer-drafts.json"))).mode & 0o777, 0o600);
  const restarted = createComposerDraftStore(root);
  await restarted.load();
  assert.deepEqual(restarted.snapshot().entries, draft("重启后继续这份草稿"));
  assert.equal(restarted.snapshot().origin, "http://127.0.0.1:12345");
  assert.equal(restarted.snapshot().persisted, true);
  await assert.rejects(store.save({ ...draft("bad"), apiKey: "must-not-persist" }), /格式/);
  assert.ok(!(await readFile(join(root, "composer-drafts.json"), "utf8")).includes("must-not-persist"));
  assert.deepEqual(store.snapshot().entries, draft("重启后继续这份草稿"));
});

test("oversized drafts leave the last good snapshot intact and queued writes retain the newest one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-draft-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createComposerDraftStore(root, { limit: 256 });
  await store.load();
  await store.save(draft("saved"));
  await assert.rejects(store.save(draft("x".repeat(300))), /过大/);
  assert.deepEqual(store.snapshot().entries, draft("saved"));
  await Promise.all([store.save(draft("older")), store.save(draft("newest"))]);
  assert.deepEqual(store.snapshot().entries, draft("newest"));
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "composer-drafts.json"), "utf8")).entries,
    draft("newest")
  );
  assert.deepEqual(await readdir(root), ["composer-drafts.json"]);
});

test("damaged drafts are preserved for recovery and future versions cannot be overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-draft-damaged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "composer-drafts.json");
  await writeFile(path, "{damaged draft file", { mode: 0o600 });
  const store = createComposerDraftStore(root);
  await store.load();
  assert.match(store.snapshot().warning, /损坏/);
  const backup = (await readdir(root)).find((name) => name.startsWith("composer-drafts.json.invalid-"));
  assert.equal(await readFile(join(root, backup), "utf8"), "{damaged draft file");
  await store.save(draft("fresh draft"));
  await writeFile(path, JSON.stringify({ version: 5, entries: draft("future") }));
  const future = createComposerDraftStore(root);
  await future.load();
  await assert.rejects(future.save(draft("do not replace")), /较新版本/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 5);
});

test("human reply records upgrade a compatible profile and validate choices without capturing other data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-profile-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "composer-drafts.json");
  const original = draft("compatible composer");
  await writeFile(path, JSON.stringify({ version: 1, entries: original }));
  const store = createComposerDraftStore(root);
  await store.load();
  const humanKey = "atria.human.v1:task-id:request-id";
  const entries = { ...original, [humanKey]: JSON.stringify({ text: "人工回复 😀", choice: 1 }) };
  await store.save(entries, "http://127.0.0.1:43800");
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const restored = createComposerDraftStore(root);
  await restored.load();
  assert.deepEqual(restored.snapshot().entries, entries);
  for (const record of [
    null,
    { text: 3 },
    { text: "draft", choice: -1 },
    { text: "draft", choice: 0.5 },
    { text: "draft", apiKey: "must-not-persist" }
  ])
    await assert.rejects(restored.save({ ...original, [humanKey]: JSON.stringify(record) }), /人工回复/);
  assert.deepEqual(restored.snapshot().entries, entries);
  await restored.save(original);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
  assert.deepEqual(restored.snapshot().entries, original);
});

test("upload references survive a desktop restart without storing file contents in drafts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-upload-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = draft("带附件的草稿");
  const file = {
    uploadId: "upload-00000000-0000-0000-0000-000000000000",
    name: "截图.png",
    kind: "image",
    size: 100,
    mimeType: "image/png"
  };
  entries["atria.composer.v1:new"] = JSON.stringify({ text: "带附件的草稿", attachments: [file] });
  const store = createComposerDraftStore(root);
  await store.load();
  await store.save(entries, "http://127.0.0.1:45000");
  const saved = JSON.parse(await readFile(join(root, "composer-drafts.json"), "utf8"));
  assert.equal(saved.version, 3);
  const restored = createComposerDraftStore(root);
  await restored.load();
  assert.deepEqual(restored.snapshot().entries, entries);
  assert.equal(
    JSON.parse(restored.snapshot().entries["atria.composer.v1:new"]).attachments[0].text,
    undefined
  );
});

test("editing drafts use version 4 and preserve the original draft across a desktop origin change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-edit-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createComposerDraftStore(root);
  await store.load();
  const value = {
    text: "edited message",
    attachments: [],
    editing: {
      messageId: "message",
      versionId: "version",
      runId: "run",
      editId: "11111111-1111-4111-8111-111111111111",
      original: { text: "original unsent draft", attachments: [{ name: "original.txt", text: "retained" }] }
    }
  };
  const entries = {
    "atria.composer.v1:active": JSON.stringify("task"),
    "atria.composer.v1:task": JSON.stringify(value)
  };
  await store.save(entries, "http://127.0.0.1:10001");
  assert.equal(JSON.parse(await readFile(join(root, "composer-drafts.json"), "utf8")).version, 4);
  const resumed = createComposerDraftStore(root);
  await resumed.load();
  assert.deepEqual(resumed.snapshot().entries, entries);
  await resumed.save(entries, "http://127.0.0.1:10002");
  const malformed = {
    ...value,
    editing: { ...value.editing, original: { text: "retained", attachments: [{ name: "broken" }] } }
  };
  await assert.rejects(
    resumed.save({ ...entries, "atria.composer.v1:task": JSON.stringify(malformed) }),
    /草稿或附件/
  );
  assert.deepEqual(resumed.snapshot().entries, entries);
});
