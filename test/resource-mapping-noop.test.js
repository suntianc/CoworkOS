import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { ResourceMappingStore } = await import("../dist/src/applications/mapping-store.js");
const { withFileLock } = await import("../dist/src/storage/file-lock.js");

test("unchanged resource references preserve the durable mapping and do not wait for a writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-mapping-noop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ResourceMappingStore(root);
  const reference = { resourceId: "resource-a", appType: "text-editor" };
  await store.add("task-a", reference);
  const path = join(root, "task-a", "applications", "mapping.json");
  const before = await stat(path);
  const bytes = await readFile(path, "utf8");
  await store.add("task-a", reference);
  await store.remove("task-a", "missing");
  await store.prune("task-a", () => true);
  assert.equal((await stat(path)).ino, before.ino, "no-op mutations must not replace the file");
  assert.equal(await readFile(path, "utf8"), bytes);

  let release;
  let acquired;
  const entered = new Promise((resolve) => (acquired = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const held = withFileLock(path, async () => {
    acquired();
    await gate;
  });
  await entered;
  const repeated = store.add("task-a", reference);
  try {
    const outcome = await Promise.race([
      repeated.then(() => "read existing reference"),
      new Promise((resolve) => setTimeout(() => resolve("waited for writer"), 100))
    ]);
    assert.equal(outcome, "read existing reference");
  } finally {
    release();
    await held;
    await repeated;
  }
});

test("concurrent new references stay unique and a removed reference is restored from fresh disk state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-mapping-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new ResourceMappingStore(root);
  const second = new ResourceMappingStore(root);
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? first : second).add("task-a", {
        resourceId: `resource-${index % 3}`,
        appType: "text-editor"
      })
    )
  );
  assert.deepEqual((await first.list("task-a")).map((entry) => entry.resourceId).sort(), [
    "resource-0",
    "resource-1",
    "resource-2"
  ]);
  await second.remove("task-a", "resource-1");
  await first.add("task-a", { resourceId: "resource-1", appType: "text-editor" });
  assert.equal((await second.list("task-a")).length, 3);
});
