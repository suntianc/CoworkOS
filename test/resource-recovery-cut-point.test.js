import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");

const actor = { type: "user", id: "local" };

async function interruptedFixture(t, stage, external = false) {
  const root = await mkdtemp(join(tmpdir(), "atria-resource-cut-point-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  const externalPath = join(root, "original.md");
  if (external) await writeFile(externalPath, "baseline");
  const service = new ApplicationService(workspaceRoot);
  const { resource } = await service.createResource({
    taskId: "chat",
    kind: "text/markdown",
    title: "doc.md",
    initialContent: "baseline",
    ...(external ? { externalPath } : {}),
    actor
  });
  const operation = {
    taskId: "chat",
    resourceId: resource.resourceId,
    appType: "text-editor",
    operationId: "stable-insert",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "new-" },
    actor
  };
  const pendingPath = join(
    workspaceRoot,
    ".runtime",
    "applications",
    "transactions",
    `${resource.resourceId}.json`
  );
  const metadataPath = join(
    workspaceRoot,
    "applications",
    "text-editor",
    "resources",
    resource.resourceId,
    "metadata.json"
  );
  const files = service.resources.files;
  const write = files.write.bind(files);
  files.write = async (...args) => {
    await write(...args);
    if (stage === "metadata") {
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      await writeFile(metadataPath, JSON.stringify(pending.resource));
    }
    throw new Error(`simulated crash after ${stage}`);
  };
  await assert.rejects(service.applyOperation(operation), {
    message: `simulated crash after ${stage}`
  });
  const restarted = new ApplicationService(workspaceRoot);
  return {
    restarted,
    resource,
    operation,
    pendingPath,
    resourcePath: external ? externalPath : service.resources.absolutePath(resource)
  };
}

for (const external of [false, true]) {
  test(`recovery retains an operation after its ${external ? "external" : "workspace"} content landed before metadata`, async (t) => {
    const f = await interruptedFixture(t, "content", external);
    const read = await f.restarted.readResource("chat", f.resource.resourceId);
    assert.equal(read.snapshot.content, "new-baseline");
    assert.equal(read.resource.revision, 1);
    assert.equal(read.resource.operationCount, 1);
    assert.equal(read.operations.length, 1);
    assert.equal(read.operations[0].operationId, f.operation.operationId);
    assert.ok(read.operations[0].inverse, "the committed edit remains undoable");
    await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });

    const retry = await f.restarted.applyOperation(f.operation);
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.snapshot.content, "new-baseline");
    assert.equal(retry.resource.revision, 1);
    assert.equal(retry.event.eventId, read.operations[0].eventId);
    await f.restarted.undo({ taskId: "chat", resourceId: f.resource.resourceId, actor });
    assert.equal(await readFile(f.resourcePath, "utf8"), "baseline");
  });
}

test("recovery repairs the log after content and metadata landed", async (t) => {
  const f = await interruptedFixture(t, "metadata");
  const read = await f.restarted.readResource("chat", f.resource.resourceId);
  assert.equal(read.snapshot.content, "new-baseline");
  assert.equal(read.resource.operationCount, 1);
  assert.equal(read.operations.length, 1);
  assert.equal(read.operations[0].operationId, f.operation.operationId);
  assert.ok(read.operations[0].inverse);
  assert.equal((await f.restarted.applyOperation(f.operation)).deduplicated, true);
  await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });
});

test("recovery keeps a subsequent external edit instead of replaying the pending content", async (t) => {
  const f = await interruptedFixture(t, "content");
  await writeFile(f.resourcePath, "manual changes after interruption");
  const read = await f.restarted.readResource("chat", f.resource.resourceId);
  assert.equal(read.snapshot.content, "manual changes after interruption");
  assert.equal(read.resource.revision, 1);
  assert.equal(read.operations.length, 1);
  assert.equal(read.operations[0].operationType, "workspace.external_change");
  assert.notEqual(read.operations[0].operationId, f.operation.operationId);
  await assert.rejects(f.restarted.applyOperation(f.operation), { code: "revision_conflict" });
  assert.equal(await readFile(f.resourcePath, "utf8"), "manual changes after interruption");
  await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });
});

async function interruptedRename(t, stage, external = false) {
  const root = await mkdtemp(join(tmpdir(), "atria-rename-cut-point-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  const externalPath = join(root, "old.md");
  if (external) await writeFile(externalPath, "original A");
  const service = new ApplicationService(workspaceRoot);
  const { resource } = await service.createResource({
    taskId: "chat",
    kind: "text/markdown",
    title: "old.md",
    initialContent: "original A",
    ...(external ? { externalPath } : {}),
    actor
  });
  const pendingPath = join(
    workspaceRoot,
    ".runtime",
    "applications",
    "renames",
    `${resource.resourceId}.json`
  );
  const metadataPath = join(
    workspaceRoot,
    "applications",
    "text-editor",
    "resources",
    resource.resourceId,
    "metadata.json"
  );
  const files = service.resources.files;
  const rename = files.rename.bind(files);
  files.rename = async (file, desired, beforeRename) => {
    if (stage === "before-move") {
      return rename(file, desired, async (target) => {
        await beforeRename(target);
        throw new Error(`simulated rename crash after ${stage}`);
      });
    }
    await rename(file, desired, beforeRename);
    if (stage === "metadata") {
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      await writeFile(metadataPath, JSON.stringify(pending.resource));
    }
    throw new Error(`simulated rename crash after ${stage}`);
  };
  await assert.rejects(
    service.renameResource({ taskId: "chat", resourceId: resource.resourceId, title: "new.md" })
  );
  const restarted = new ApplicationService(workspaceRoot);
  return {
    restarted,
    resource,
    pendingPath,
    metadataPath,
    targetPath: external ? join(root, "new.md") : join(files.directory("text-editor"), "new.md")
  };
}

for (const external of [false, true]) {
  test(`an interrupted ${external ? "external" : "workspace"} rename restores the original document identity`, async (t) => {
    const f = await interruptedRename(t, "move", external);
    assert.equal(await readFile(f.targetPath, "utf8"), "original A");
    // The old name is now available. Reusing it must not retarget resource A.
    const oldPath = f.restarted.resources.absolutePath(f.resource);
    if (external) await writeFile(oldPath, "new B");
    const createdB = await f.restarted.createResource({
      taskId: "chat",
      kind: "text/markdown",
      title: "old.md",
      initialContent: "new B",
      ...(external ? { externalPath: oldPath } : {}),
      actor
    });
    const selection = await f.restarted.saveSelection({
      taskId: "chat",
      resourceId: f.resource.resourceId,
      schema: "text.range/v1",
      data: { anchor: 0, head: 10 },
      actor
    });
    assert.match(selection.summary, /original A/);
    const readA = await f.restarted.readResource("chat", f.resource.resourceId);
    assert.equal(readA.snapshot.content, "original A");
    assert.equal(readA.resource.path, "new.md");
    assert.equal(readA.resource.revision, 0);
    assert.notEqual(readA.resource.path, createdB.resource.path);
    await f.restarted.applyOperation({
      taskId: "chat",
      resourceId: f.resource.resourceId,
      appType: "text-editor",
      operationId: "edit-original-A",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "edited " },
      actor
    });
    assert.equal(await readFile(f.targetPath, "utf8"), "edited original A");
    assert.equal(
      (await f.restarted.readResource("chat", createdB.resource.resourceId)).snapshot.content,
      "new B"
    );
    const retry = await f.restarted.renameResource({
      taskId: "chat",
      resourceId: f.resource.resourceId,
      title: "new.md"
    });
    assert.equal(retry.path, "new.md");
    await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });
  });
}

test("rename recovery finishes an intent interrupted before moving the file", async (t) => {
  const f = await interruptedRename(t, "before-move");
  const read = await f.restarted.readResource("chat", f.resource.resourceId);
  assert.equal(read.snapshot.content, "original A");
  assert.equal(read.resource.path, "new.md");
  await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });
});

test("rename recovery cleans up an intent after the metadata commit", async (t) => {
  const f = await interruptedRename(t, "metadata");
  const read = await f.restarted.readResource("chat", f.resource.resourceId);
  assert.equal(read.snapshot.content, "original A");
  assert.equal(read.resource.path, "new.md");
  await assert.rejects(readFile(f.pendingPath), { code: "ENOENT" });
});

test("rename recovery preserves an independently changed target and the reused old filename", async (t) => {
  const f = await interruptedRename(t, "move");
  await writeFile(f.targetPath, "manual change in moved document");
  const oldPath = f.restarted.resources.absolutePath(f.resource);
  await writeFile(oldPath, "other document at old name");
  await assert.rejects(f.restarted.readResource("chat", f.resource.resourceId), {
    code: "resource_recovery_required"
  });
  assert.equal(await readFile(f.targetPath, "utf8"), "manual change in moved document");
  assert.equal(await readFile(oldPath, "utf8"), "other document at old name");
  assert.ok(await readFile(f.pendingPath), "ambiguous rename intent is retained for recovery");
});

test("rename recovery refuses an occupied target even when its bytes match the original", async (t) => {
  const f = await interruptedRename(t, "before-move");
  await writeFile(f.targetPath, "original A");
  await assert.rejects(f.restarted.readResource("chat", f.resource.resourceId), {
    code: "resource_recovery_required"
  });
  const oldPath = f.restarted.resources.absolutePath(f.resource);
  assert.equal(await readFile(oldPath, "utf8"), "original A");
  assert.equal(await readFile(f.targetPath, "utf8"), "original A");
  assert.ok(await readFile(f.pendingPath));
});

test("rename recovery rejects an intent naming a different resource", async (t) => {
  const f = await interruptedRename(t, "move");
  const pending = JSON.parse(await readFile(f.pendingPath, "utf8"));
  pending.resource.resourceId = "res_different";
  await writeFile(f.pendingPath, JSON.stringify(pending));
  await assert.rejects(f.restarted.readResource("chat", f.resource.resourceId), {
    code: "resource_recovery_required"
  });
  assert.equal(await readFile(f.targetPath, "utf8"), "original A");
  assert.ok(await readFile(f.pendingPath));
});

for (const [shape, value] of [
  ["null", null],
  ["string", "invalid journal shape"],
  ["number", 42],
  ["boolean", false],
  ["array", []]
]) {
  test(`rename recovery marks a ${shape} journal read-only and preserves the moved document`, async (t) => {
    const f = await interruptedRename(t, "move");
    const invalid = `${JSON.stringify(value)}\n`;
    await writeFile(f.pendingPath, invalid);
    await assert.rejects(f.restarted.readResource("chat", f.resource.resourceId), {
      code: "resource_recovery_required",
      status: 503
    });
    const metadata = JSON.parse(await readFile(f.metadataPath, "utf8"));
    assert.equal(metadata.status, "recovery_required");
    assert.equal(await readFile(f.targetPath, "utf8"), "original A");
    assert.equal(await readFile(f.pendingPath, "utf8"), invalid);
  });
}
