import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createUiPreferenceStore, isPreferenceKey } = createRequire(import.meta.url)(
  "../desktop/ui-preferences.cjs"
);

test("remembered choices are kept privately with the origin that wrote them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ui-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createUiPreferenceStore(root);
  await store.load();
  assert.deepEqual(store.snapshot(), { entries: {}, origin: undefined, persisted: false });
  const entries = {
    "atria.model.level-by-task": JSON.stringify({ "task-1": "high" }),
    "atria.time-format": "24h"
  };
  await store.save(entries, "http://127.0.0.1:5000");
  assert.equal((await stat(join(root, "ui-preferences.json"))).mode & 0o777, 0o600);
  const reopened = createUiPreferenceStore(root);
  await reopened.load();
  assert.deepEqual(reopened.snapshot(), { entries, origin: "http://127.0.0.1:5000", persisted: true });
});

test("drafts and foreign keys are refused, and a damaged file is set aside", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ui-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(isPreferenceKey("atria.composer.v1:new"), false);
  assert.equal(isPreferenceKey("atria.human.v1:x"), false);
  assert.equal(isPreferenceKey("other"), false);
  assert.equal(isPreferenceKey("atria.collapsed-projects.v1"), true);
  const store = createUiPreferenceStore(root);
  await store.load();
  await assert.rejects(store.save({ "atria.composer.v1:new": "{}" }, "o"), /格式/);
  await assert.rejects(store.save({ "atria.x": 1 }, "o"), /格式/);
  await writeFile(join(root, "ui-preferences.json"), "{broken");
  const damaged = createUiPreferenceStore(root);
  await damaged.load();
  assert.equal(damaged.snapshot().persisted, false);
  const kept = (await readdir(root)).find((name) => name.startsWith("ui-preferences.json.invalid-"));
  assert.equal(await readFile(join(root, kept), "utf8"), "{broken");
});
