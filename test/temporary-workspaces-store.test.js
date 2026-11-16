import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  TemporaryWorkspaceStore,
  readTemporaryWorkspace
} from "../dist/src/workspace/temporary-workspaces.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

test("temporary allocation commits distinct validated records and restart discovery ignores incomplete staging", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "atria-temporary-storage-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new TemporaryWorkspaceStore(data);
  const spaces = await Promise.all(Array.from({ length: 12 }, () => store.create(join(data, "history"))));
  assert.equal(new Set(spaces.map((space) => space.root)).size, 12);
  assert.equal(new Set(spaces.map((space) => space.record.holdingTaskId)).size, 12);
  await mkdir(join(store.directory, ".pending-interrupted"));
  assert.deepEqual(
    (await new TemporaryWorkspaceStore(data).roots()).sort(),
    spaces.map((space) => space.root).sort()
  );
  for (const { root, record } of spaces) {
    assert.equal(record.retention, "until-explicit-discard");
    assert.equal(record.workspaceId, basename(root));
    assert.deepEqual(await readTemporaryWorkspace(root), record);
  }
  const first = spaces[0];
  await writeFile(
    join(first.root, ".atria-temporary-workspace.json"),
    JSON.stringify({ ...first.record, holdingTaskId: "workspace" })
  );
  await assert.rejects(store.roots(), /记录无效/);
  await writeFile(join(first.root, ".atria-temporary-workspace.json"), JSON.stringify(first.record));
  const fake = join(data, first.record.workspaceId);
  await symlink(first.root, fake);
  await assert.rejects(readTemporaryWorkspace(fake), /路径与记录不一致/);
  assert.deepEqual(
    JSON.parse(await readFile(join(first.root, ".atria-temporary-workspace.json"), "utf8")),
    first.record
  );
});

test("temporary Task metadata requires its own managed root and rejects unvalidated records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-temporary-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(join(root, "history"));
  await store.createTask("legacy", { goal: "legacy null project" });
  assert.equal((await store.readTask("legacy")).temporaryWorkspaceRoot, undefined);
  await assert.rejects(
    store.createTask("bad", { goal: "bad", temporaryWorkspaceRoot: "relative" }),
    /invalid temporary workspace root/
  );
  await writeFile(
    join(root, "history", "legacy", "task.json"),
    JSON.stringify({ taskId: "legacy", temporaryWorkspaceRoot: "relative" })
  );
  await assert.rejects(store.readTask("legacy"), /invalid temporary workspace root/);
  const allocated = await new TemporaryWorkspaceStore(root).create(join(root, "history"));
  await assert.rejects(
    store.createTask("marked", { goal: "marked", temporaryWorkspaceRoot: allocated.root }),
    /cannot override project assignment/
  );
  await store.createTask("valid", {
    goal: "valid",
    temporaryWorkspaceRoot: allocated.root,
    projectDirectory: allocated.root
  });
  assert.equal((await store.readTask("valid")).temporaryWorkspaceRoot, allocated.root);
  assert.equal((await store.readTask("valid")).projectId, undefined);
});
