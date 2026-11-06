import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { textHash } = await import("../dist/src/applications/types.js");

const user = { type: "user", id: "local" };
const agent = { type: "agent", id: "main" };

async function fixture(t, initialContent = "第一行\n第二行\n") {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-resource-store-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const service = new ApplicationService(workspaceRoot);
  const taskId = "task-1";
  const created = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "doc.md",
    initialContent,
    actor: user
  });
  return {
    workspaceRoot,
    service,
    taskId,
    resourceId: created.resource.resourceId,
    instance: created.appInstance
  };
}

/** A resource's metadata, log and selection: under its application. */
function resourcePath(workspaceRoot, resourceId, file, appType = "text-editor") {
  return join(workspaceRoot, "applications", appType, "resources", resourceId, file);
}

/**
 * An interrupted write's record: workspace-wide, keyed by resource.
 *
 * It was per-Task while resources were, and moved with them — the transaction
 * describes a resource, and a resource is no longer a Task's.
 */
function transactionsDir(workspaceRoot) {
  return join(workspaceRoot, ".runtime", "applications", "transactions");
}

/**
 * Where a resource's file lives: under its application, not under a Task.
 *
 * A resource belongs to no conversation — conversations reference it, several
 * at once. The previous layout nested the file under `<taskId>/resources/`,
 * which is what forced "bind from elsewhere" to be a destructive move. The
 * assertions using this are unchanged in intent: a resource is still a real
 * file that the user and Main both see.
 */
function workspaceFile(workspaceRoot, relativePath, appType = "text-editor") {
  return join(workspaceRoot, "applications", appType, "files", relativePath);
}

test("the same operationId retried returns the first result without a new revision", async (t) => {
  const { service, taskId, resourceId, workspaceRoot } = await fixture(t);
  const first = await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-stable",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "标题\n" },
    actor: user
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.resource.revision, 1);

  const retry = await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-stable",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "标题\n" },
    actor: user
  });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.resource.revision, 1);
  assert.equal(retry.event.eventId, first.event.eventId);

  const log = await readFile(resourcePath(workspaceRoot, resourceId, "operations.jsonl"), "utf8");
  assert.equal(log.split("\n").filter(Boolean).length, 1, "a retry must not append a second log line");
});

test("concurrent writes on one baseline: exactly one wins and the other gets 409 with the current revision", async (t) => {
  const { service, taskId, resourceId } = await fixture(t);
  const settled = await Promise.allSettled([
    service.applyOperation({
      taskId,
      resourceId,
      operationId: "op-a",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "A" },
      actor: user
    }),
    service.applyOperation({
      taskId,
      resourceId,
      operationId: "op-b",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "B" },
      actor: agent
    })
  ]);
  const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
  const rejected = settled.filter((entry) => entry.status === "rejected");
  assert.equal(fulfilled.length, 1, "last-write-wins is forbidden");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "revision_conflict");
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(rejected[0].reason.details.currentRevision, 1);

  const read = await service.readResource(taskId, resourceId);
  assert.equal(read.resource.revision, 1);
  assert.equal(read.operations.length, 1);
});

test("a correct revision with a stale content precondition is still refused", async (t) => {
  const { service, taskId, resourceId } = await fixture(t, "目标用户是谁\n");
  // Revision 0 is current, but the text this patch believed it was replacing is
  // not what the document holds. Revision alone cannot catch that.
  await assert.rejects(
    () =>
      service.applyOperation({
        taskId,
        resourceId,
        operationId: "op-stale",
        appType: "text-editor",
        operationType: "text.replace",
        baseRevision: 0,
        payload: { from: 0, to: 4, text: "新的用户", replacedTextHash: textHash("完全不同") },
        actor: agent
      }),
    (error) => error.code === "operation_precondition_failed" && error.status === 409
  );
  assert.equal((await service.readResource(taskId, resourceId)).resource.revision, 0);

  const correct = await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-good",
    appType: "text-editor",
    operationType: "text.replace",
    baseRevision: 0,
    payload: { from: 0, to: 4, text: "新的用户", replacedTextHash: textHash("目标用户") },
    actor: agent
  });
  assert.equal(correct.snapshot.content, "新的用户是谁\n");
});

test("an interrupted transaction that already reached the target revision has its log line repaired", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "开始\n");
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 3, text: "继续\n" },
    actor: user
  });
  const metadata = JSON.parse(
    await readFile(resourcePath(workspaceRoot, resourceId, "metadata.json"), "utf8")
  );
  const body = await readFile(workspaceFile(workspaceRoot, metadata.path), "utf8");
  const event = JSON.parse(
    (await readFile(resourcePath(workspaceRoot, resourceId, "operations.jsonl"), "utf8")).trim()
  );

  // Simulate a crash between the metadata write and the log append: the
  // durable state is at the target revision, the log line never landed.
  await writeFile(resourcePath(workspaceRoot, resourceId, "operations.jsonl"), "");
  await mkdir(transactionsDir(workspaceRoot), { recursive: true });
  await writeFile(
    join(transactionsDir(workspaceRoot), `${resourceId}.json`),
    JSON.stringify({ version: 1, resourceId, targetRevision: 1, event, resource: metadata, body }, null, 2)
  );

  const recovered = new ApplicationService(workspaceRoot);
  const read = await recovered.readResource(taskId, resourceId);
  assert.equal(read.resource.revision, 1);
  assert.equal(read.resource.status, "ready");
  assert.equal(read.operations.length, 1, "the missing log line must be restored");
  assert.equal(read.operations[0].operationId, "op-1");
  assert.deepEqual(await readdir(transactionsDir(workspaceRoot)), []);
});

test("an interrupted transaction that never landed is replayed in full", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "基线\n");
  const metadata = JSON.parse(
    await readFile(resourcePath(workspaceRoot, resourceId, "metadata.json"), "utf8")
  );
  const { contentVersion } = await import("../dist/src/applications/types.js");
  const body = "补上\n基线\n";
  const target = {
    version: 1,
    resourceId,
    targetRevision: 1,
    event: {
      eventId: "evt_replay",
      operationId: "op-replay",
      taskId,
      resourceId,
      appType: "text-editor",
      actor: user,
      operationType: "text.insert",
      baseRevision: 0,
      revision: 1,
      payload: { at: 0, text: "补上\n" },
      summary: "插入补上",
      occurredAt: new Date().toISOString()
    },
    resource: { ...metadata, revision: 1, operationCount: 1, contentVersion: contentVersion(body) },
    body
  };
  await mkdir(transactionsDir(workspaceRoot), { recursive: true });
  await writeFile(
    join(transactionsDir(workspaceRoot), `${resourceId}.json`),
    JSON.stringify(target, null, 2)
  );

  const recovered = new ApplicationService(workspaceRoot);
  const read = await recovered.readResource(taskId, resourceId);
  assert.equal(read.resource.revision, 1);
  assert.equal(read.snapshot.content, "补上\n基线\n");
  assert.equal(read.operations.length, 1);
  assert.deepEqual(await readdir(transactionsDir(workspaceRoot)), []);
});

test("an undecidable interruption is marked read-only rather than guessed at", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "内容\n");
  const metadata = JSON.parse(
    await readFile(resourcePath(workspaceRoot, resourceId, "metadata.json"), "utf8")
  );
  // The metadata revision is far past the target and the file matches neither:
  // no rule can say what the user's document should contain.
  await writeFile(
    resourcePath(workspaceRoot, resourceId, "metadata.json"),
    JSON.stringify({ ...metadata, revision: 7 }, null, 2)
  );
  await mkdir(transactionsDir(workspaceRoot), { recursive: true });
  await writeFile(
    join(transactionsDir(workspaceRoot), `${resourceId}.json`),
    JSON.stringify(
      {
        version: 1,
        resourceId,
        targetRevision: 3,
        event: { operationId: "op-lost", revision: 3 },
        resource: { ...metadata, revision: 3, contentVersion: "sha256:never-written" },
        body: "从未落盘的内容\n"
      },
      null,
      2
    )
  );

  const recovered = new ApplicationService(workspaceRoot);
  const read = await recovered.readResource(taskId, resourceId);
  assert.equal(read.resource.status, "recovery_required");
  await assert.rejects(
    () =>
      recovered.applyOperation({
        taskId,
        resourceId,
        operationId: "op-after",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 7,
        payload: { at: 0, text: "x" },
        actor: user
      }),
    (error) => error.code === "resource_recovery_required" && error.status === 503
  );
  // A damaged resource must not take the whole Task with it.
  const summary = await recovered.taskSummary(taskId);
  assert.equal(summary.resources.length, 1);
});

test("revisions survive a process restart and stay monotonic", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "");
  for (let index = 0; index < 5; index += 1) {
    await service.applyOperation({
      taskId,
      resourceId,
      operationId: `op-${index}`,
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: index,
      payload: { at: index, text: String(index) },
      actor: index % 2 ? agent : user
    });
  }
  const reopened = new ApplicationService(workspaceRoot);
  const read = await reopened.readResource(taskId, resourceId, { afterRevision: 0 });
  assert.equal(read.resource.revision, 5);
  assert.equal(read.snapshot.content, "01234");
  assert.deepEqual(
    read.operations.map((event) => event.revision),
    [1, 2, 3, 4, 5]
  );
  assert.equal(new Set(read.operations.map((event) => event.revision)).size, 5);
});

test("undo appends a new revision instead of rewriting history", async (t) => {
  const { service, taskId, resourceId } = await fixture(t, "保留这句\n");
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-1",
    appType: "text-editor",
    operationType: "text.delete",
    baseRevision: 0,
    payload: { from: 0, to: 4 },
    actor: user
  });
  assert.equal((await service.readResource(taskId, resourceId)).snapshot.content, "\n");

  const undone = await service.undo({ taskId, resourceId, actor: user });
  assert.equal(undone.resource.revision, 2);
  const read = await service.readResource(taskId, resourceId);
  assert.equal(read.snapshot.content, "保留这句\n");
  assert.deepEqual(
    read.operations.map((event) => event.revision),
    [1, 2]
  );
});

test("history pages from the newest end and reports that older entries remain", async (t) => {
  const { service, taskId, resourceId } = await fixture(t, "");
  for (let index = 0; index < 12; index += 1) {
    await service.applyOperation({
      taskId,
      resourceId,
      operationId: `op-${index}`,
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: index,
      payload: { at: index, text: "x" },
      actor: user
    });
  }
  const page = await service.readResource(taskId, resourceId, { limit: 5 });
  assert.equal(page.operations.length, 5);
  assert.deepEqual(
    page.operations.map((event) => event.revision),
    [8, 9, 10, 11, 12]
  );
  assert.equal(page.hasMore, true);
  const since = await service.readResource(taskId, resourceId, { afterRevision: 10 });
  assert.deepEqual(
    since.operations.map((event) => event.revision),
    [11, 12]
  );
  assert.equal(since.hasMore, false);
});

test("selection is a projection, not a revision", async (t) => {
  const { service, taskId, resourceId } = await fixture(t, "目标用户是产品经理\n");
  const before = await service.readResource(taskId, resourceId);
  const selection = await service.saveSelection({
    taskId,
    resourceId,
    schema: "text.range/v1",
    data: { anchor: 0, head: 4 },
    actor: user
  });
  assert.match(selection.summary, /目标用户/);
  const after = await service.readResource(taskId, resourceId);
  assert.equal(after.resource.revision, before.resource.revision);
  assert.equal(after.operations.length, 0);
  assert.equal(after.selection.summary, selection.summary);
});

test("oversized content and oversized operations are refused with a size error", async (t) => {
  const { service, taskId } = await fixture(t);
  await assert.rejects(
    () =>
      service.createResource({
        taskId,
        kind: "text/markdown",
        title: "huge.md",
        initialContent: "永".repeat(1_200_000),
        actor: user
      }),
    (error) => error.code === "resource_too_large" && error.status === 413
  );
  const small = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "small.md",
    initialContent: "",
    actor: user
  });
  await assert.rejects(
    () =>
      service.applyOperation({
        taskId,
        resourceId: small.resource.resourceId,
        operationId: "op-big",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "字".repeat(200_000) },
        actor: agent
      }),
    (error) => error.code === "resource_too_large"
  );
});

test("a symlinked resource file is refused rather than followed", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t);
  const secret = join(workspaceRoot, "outside.json");
  await writeFile(secret, JSON.stringify({ resourceId, revision: 99, content: "leaked" }));
  const resource = JSON.parse(
    await readFile(resourcePath(workspaceRoot, resourceId, "metadata.json"), "utf8")
  );
  const file = workspaceFile(workspaceRoot, resource.path);
  await rm(file);
  await symlink(secret, file);
  await assert.rejects(
    () => service.readResource(taskId, resourceId),
    (error) => error.code === "unsafe_path"
  );
});

test("a resource is a deliverable the moment it exists, with no publish step", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "# 方案\n初稿\n");
  // Nothing was published, yet the resource is already something the Task can
  // hand over: saving is saving, and the outputs view is assembled, not a
  // directory listing.
  const deliverables = await service.deliverables(taskId, []);
  assert.equal(deliverables.length, 1);
  assert.equal(deliverables[0].kind, "resource");
  assert.equal(deliverables[0].resourceId, resourceId);
  assert.equal(deliverables[0].revision, 0);
  assert.equal(deliverables[0].editable, true);

  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-1",
    appType: "text-editor",
    operationType: "text.replace",
    baseRevision: 0,
    payload: { from: 5, to: 7, text: "终稿" },
    actor: user
  });
  const updated = await service.deliverables(taskId, []);
  assert.equal(updated[0].revision, 1, "the deliverable tracks the live revision");
  assert.equal(
    (await readFile(workspaceFile(workspaceRoot, updated[0].name.replace(/[^.]*$/, "md")), "utf8").catch(
      () => null
    )) ?? (await readFile(workspaceFile(workspaceRoot, "doc.md"), "utf8")),
    "# 方案\n终稿\n"
  );
});

test("the deliverables view maps resources and published files into one list", async (t) => {
  const { service, taskId, resourceId } = await fixture(t, "内容\n");
  const rows = await service.deliverables(taskId, [
    { relativePath: "报告.pdf", displayName: "报告.pdf", mimeType: "application/pdf", size: 1024 },
    { relativePath: "说明.md", displayName: "说明.md", mimeType: "text/markdown", size: 12 }
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["resource", "file", "file"]
  );
  assert.equal(rows[0].resourceId, resourceId);
  assert.equal(rows[0].editable, true, "a resource opens in its application");
  // A PDF has no adapter, so it is a download; a markdown file can be adopted.
  assert.equal(rows.find((row) => row.relativePath === "报告.pdf").editable, false);
  assert.equal(rows.find((row) => row.relativePath === "说明.md").editable, true);
});

test("artifact imports refuse a source that changes after its identity was resolved", async (t) => {
  const { workspaceRoot, service, taskId } = await fixture(t);
  const artifacts = join(workspaceRoot, taskId, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "racing.md"), "original");
  const originalList = service.listResources.bind(service);
  service.listResources = async (task) => {
    const listed = await originalList(task);
    await writeFile(join(artifacts, "racing.md"), "changed after resolve");
    return listed;
  };
  await assert.rejects(
    service.importArtifact({ taskId, relativePath: "racing.md", actor: user }),
    (error) => error.code === "source_file_conflict"
  );
  assert.equal((await originalList(taskId)).length, 1, "a failed import leaves existing resources intact");
});

test("artifact imports keep storage-root identity after reopening a shared document", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-artifact-origin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = join(root, "documents");
  const storageA = join(root, "storage-a");
  const storageB = join(root, "storage-b");
  const taskId = "same-task";
  for (const storage of [storageA, storageB]) {
    const artifacts = join(storage, taskId, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "same.md"), "identical source bytes");
  }
  const serviceA = new ApplicationService(documents, undefined, storageA);
  const first = await serviceA.importArtifact({ taskId, relativePath: "same.md", actor: user });
  const serviceB = new ApplicationService(documents, undefined, storageB);
  await serviceB.mapping.add(taskId, first.resource);
  const second = await serviceB.importArtifact({ taskId, relativePath: "same.md", actor: user });
  assert.notEqual(second.resource.resourceId, first.resource.resourceId);
  const reopened = new ApplicationService(documents, undefined, storageA);
  const again = await reopened.importArtifact({ taskId, relativePath: "same.md", actor: user });
  assert.equal(again.resource.resourceId, first.resource.resourceId);
  assert.equal(again.reused, true);
});

test("a malicious title cannot become a path", async (t) => {
  const { workspaceRoot, service, taskId } = await fixture(t);
  const created = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "../../etc/passwd",
    initialContent: "x",
    actor: agent
  });
  assert.equal(created.resource.path.includes(".."), false);
  assert.equal(created.resource.path.includes("/"), false);
  const files = await readdir(join(workspaceRoot, "applications", "text-editor", "files"));
  assert.equal(
    files.every((name) => !name.includes("..")),
    true
  );
  // The file really is inside the application's directory, not somewhere a
  // traversal reached.
  assert.equal(await readFile(workspaceFile(workspaceRoot, created.resource.path), "utf8"), "x");
});

test("application state lives beside the resource and never touches artifacts", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t);
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "x" },
    actor: user
  });
  const files = await readdir(join(workspaceRoot, "applications", "text-editor", "resources", resourceId));
  assert.deepEqual(
    files.sort(),
    ["metadata.json", "operations.jsonl"],
    "history lives beside the file, not a copy of it"
  );
  // The document itself is an ordinary workspace file the user can see.
  const resource = await service.readResource(taskId, resourceId);
  assert.equal(
    await readFile(workspaceFile(workspaceRoot, resource.resource.path), "utf8"),
    resource.snapshot.content
  );
  // Live editing state must never be mistaken for a published deliverable.
  assert.deepEqual(await readdir(join(workspaceRoot, taskId, "artifacts")).catch(() => []), []);
});

test("a resource is a workspace file the user and Main both see", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "# 方案\n");
  const resource = (await service.readResource(taskId, resourceId)).resource;
  // The filename comes from the title, with the adapter's extension.
  assert.equal(resource.path, "doc.md");
  const file = workspaceFile(workspaceRoot, resource.path);
  assert.equal(await readFile(file, "utf8"), "# 方案\n");

  // Saving through the protocol writes that same file — there is no separate
  // publish step that makes the content real.
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 5, text: "\n正文\n" },
    actor: user
  });
  assert.equal(await readFile(file, "utf8"), "# 方案\n\n正文\n");
});

test("an edit made outside the protocol is noticed instead of being overwritten", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "原始内容\n");
  const resource = (await service.readResource(taskId, resourceId)).resource;
  const file = workspaceFile(workspaceRoot, resource.path);

  // Main wrote the file with its ordinary tools, or a person used vim. The file
  // being real is what makes it useful and also what allows this.
  await writeFile(file, "别的进程写的内容\n");

  const read = await service.readResource(taskId, resourceId);
  assert.equal(read.snapshot.content, "别的进程写的内容\n", "the file is the source of truth");
  assert.equal(read.resource.revision, 1, "the revision advances so stale clients must re-read");
  assert.ok(
    read.resource.externalChangeAt,
    "the change is recorded as external, not attributed to a user edit"
  );
  assert.equal(read.resource.updatedBy.type, "system");
  const external = read.operations.find((event) => event.operationType === "workspace.external_change");
  assert.ok(external, "history says the file was changed outside the protocol");

  // An editor still holding revision 0 cannot clobber that work.
  await assert.rejects(
    () =>
      service.applyOperation({
        taskId,
        resourceId,
        operationId: "op-stale",
        appType: "text-editor",
        operationType: "text.replace",
        baseRevision: 0,
        payload: { from: 0, to: 4, text: "覆盖" },
        actor: user
      }),
    (error) => error.code === "revision_conflict" && error.details.currentRevision === 1
  );
  assert.equal(await readFile(file, "utf8"), "别的进程写的内容\n");

  // Re-reading and writing against the new revision succeeds.
  const recovered = await service.applyOperation({
    taskId,
    resourceId,
    operationId: "op-fresh",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 1,
    payload: { at: 0, text: "接着改：" },
    actor: user
  });
  assert.equal(recovered.snapshot.content, "接着改：别的进程写的内容\n");
  assert.equal(recovered.resource.externalChangeAt, undefined, "the write reconciles the external change");
});

test("renaming moves the workspace file so both views agree on what this is", async (t) => {
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "内容\n");
  const renamed = await service.renameResource({ taskId, resourceId, title: "产品方案.md" });
  assert.equal(renamed.title, "产品方案.md");
  assert.equal(renamed.path, "产品方案.md");
  assert.equal(await readFile(workspaceFile(workspaceRoot, "产品方案.md"), "utf8"), "内容\n");
  await assert.rejects(() => readFile(workspaceFile(workspaceRoot, "doc.md"), "utf8"), /ENOENT/);
  // A rename is not an edit.
  assert.equal(renamed.revision, 0);
});

test("two resources with the same title get distinct files", async (t) => {
  const { workspaceRoot, service, taskId } = await fixture(t);
  const first = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "报告.md",
    initialContent: "第一份",
    actor: user
  });
  const second = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "报告.md",
    initialContent: "第二份",
    actor: user
  });
  assert.notEqual(first.resource.path, second.resource.path);
  assert.equal(await readFile(workspaceFile(workspaceRoot, first.resource.path), "utf8"), "第一份");
  assert.equal(await readFile(workspaceFile(workspaceRoot, second.resource.path), "utf8"), "第二份");
});

test("a workspace file Main already wrote can be adopted without losing it", async (t) => {
  const { workspaceRoot, service, taskId } = await fixture(t);
  const { mkdir: makeDir } = await import("node:fs/promises");
  await makeDir(join(workspaceRoot, taskId, "resources"), { recursive: true });
  await writeFile(workspaceFile(workspaceRoot, "main-wrote-this.md"), "# Main 写的\n不能被清空\n");

  const adopted = await service.resources.createResource({
    taskId,
    appType: "text-editor",
    kind: "text/markdown",
    title: "main-wrote-this.md",
    actor: user,
    adoptPath: "main-wrote-this.md"
  });
  assert.equal(
    adopted.snapshot.content,
    "# Main 写的\n不能被清空\n",
    "adoption reads the file rather than overwriting it"
  );
  assert.equal(
    await readFile(workspaceFile(workspaceRoot, "main-wrote-this.md"), "utf8"),
    "# Main 写的\n不能被清空\n"
  );
});

test("a resource path cannot escape the Task workspace", async (t) => {
  const { service, taskId } = await fixture(t);
  for (const adoptPath of ["../escape.md", "../../etc/passwd", "/absolute.md", "a/../../b.md"]) {
    await assert.rejects(
      () =>
        service.resources.createResource({
          taskId,
          appType: "text-editor",
          kind: "text/markdown",
          title: "x",
          actor: user,
          adoptPath
        }),
      (error) => error.code === "unsafe_path",
      `${adoptPath} must be refused`
    );
  }
});

test("two concurrent creates with the same title get distinct files, not one overwriting the other", async (t) => {
  // Creation was the one write path with no lock. Picking a filename is a
  // read-then-write, so both calls saw the name as free and the second
  // overwrote the first — whose metadata then described content that was gone.
  const { workspaceRoot, service, taskId } = await fixture(t);
  const settled = await Promise.all([
    service.createResource({
      taskId,
      kind: "text/markdown",
      title: "报告",
      initialContent: "第一份内容",
      actor: user
    }),
    service.createResource({
      taskId,
      kind: "text/markdown",
      title: "报告",
      initialContent: "第二份内容",
      actor: user
    })
  ]);
  const paths = settled.map((entry) => entry.resource.path);
  assert.equal(new Set(paths).size, 2, `both creates must get their own file, got ${JSON.stringify(paths)}`);
  for (const created of settled) {
    const read = await service.readResource(taskId, created.resource.resourceId);
    assert.equal(
      read.snapshot.content,
      created.snapshot.content,
      "each document must still hold what it was created with"
    );
    assert.equal(read.resource.revision, 0, "neither may be reported as externally changed");
    assert.equal(read.resource.externalChangeAt, undefined);
  }
});

test("undo walks back through history instead of toggling the last change", async (t) => {
  // An undo is itself invertible, so "the last event with an inverse" made undo
  // a two-state flip: the second press redid the first and the user could never
  // reach an earlier state.
  const { service, taskId, resourceId } = await fixture(t, "");
  for (const [index, text] of ["AAA", "BBB", "CCC"].entries()) {
    await service.applyOperation({
      taskId,
      resourceId,
      operationId: `op-${index}`,
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: index,
      payload: { at: index * 3, text },
      actor: user
    });
  }
  assert.equal((await service.readResource(taskId, resourceId)).snapshot.content, "AAABBBCCC");

  assert.equal((await service.undo({ taskId, resourceId, actor: user })).snapshot.content, "AAABBB");
  assert.equal((await service.undo({ taskId, resourceId, actor: user })).snapshot.content, "AAA");
  assert.equal((await service.undo({ taskId, resourceId, actor: user })).snapshot.content, "");
  // History is append-only throughout: six revisions, nothing rewritten.
  const read = await service.readResource(taskId, resourceId, { limit: 50 });
  assert.equal(read.resource.revision, 6);
  await assert.rejects(
    () => service.undo({ taskId, resourceId, actor: user }),
    (error) => error.code === "invalid_operation",
    "with everything undone there is nothing left to undo"
  );
});

test("the deliverables view never hides an artifact that merely shares a resource's filename", async (t) => {
  // resource.path is relative to resources/, artifact.relativePath to
  // artifacts/, so equal names are different files. De-duplicating on the name
  // could only ever make a real deliverable disappear.
  const { service, taskId } = await fixture(t);
  const resource = (await service.readResource(taskId, (await service.listResources(taskId))[0].resourceId))
    .resource;
  const rows = await service.deliverables(taskId, [
    { relativePath: resource.path, displayName: resource.path, mimeType: "text/markdown", size: 99 },
    { relativePath: "报告.pdf", displayName: "报告.pdf", mimeType: "application/pdf", size: 1024 }
  ]);
  assert.equal(rows.length, 3, "both artifacts stay listed alongside the resource");
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["resource", "file", "file"]
  );
  assert.ok(rows.some((row) => row.kind === "file" && row.relativePath === resource.path));
});

test("renaming drains an interrupted write instead of letting recovery undo it", async (t) => {
  // rename moved the file without recovering first, so a later recover()
  // re-committed against the pending transaction's old path — recreating the
  // file under its former name and reverting the rename.
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "内容\n");
  const metadata = JSON.parse(
    await readFile(resourcePath(workspaceRoot, resourceId, "metadata.json"), "utf8")
  );
  const { contentVersion } = await import("../dist/src/applications/types.js");
  const body = "被中断的写入\n";
  await mkdir(transactionsDir(workspaceRoot), { recursive: true });
  await writeFile(
    join(transactionsDir(workspaceRoot), `${resourceId}.json`),
    JSON.stringify(
      {
        version: 1,
        resourceId,
        targetRevision: 1,
        event: {
          eventId: "evt_pending",
          operationId: "op-pending",
          taskId,
          resourceId,
          appType: "text-editor",
          actor: user,
          operationType: "text.insert",
          baseRevision: 0,
          revision: 1,
          payload: { at: 0, text: "被中断的写入\n" },
          summary: "插入",
          occurredAt: new Date().toISOString()
        },
        resource: { ...metadata, revision: 1, operationCount: 1, contentVersion: contentVersion(body) },
        body
      },
      null,
      2
    )
  );

  const renamed = await service.renameResource({ taskId, resourceId, title: "新名字.md" });
  assert.equal(renamed.path, "新名字.md");

  // A later read must not resurrect the old filename or revert the rename.
  const reopened = new ApplicationService(workspaceRoot);
  const read = await reopened.readResource(taskId, resourceId);
  assert.equal(read.resource.path, "新名字.md", "the rename must survive recovery");
  assert.equal(read.resource.title, "新名字.md");
  const files = await readdir(join(workspaceRoot, "applications", "text-editor", "files"));
  assert.deepEqual(files, ["新名字.md"], "the document must not exist twice on disk");
  assert.equal(read.snapshot.content, "被中断的写入\n", "the interrupted write still lands");
});

test("recovery abandons an interrupted write rather than overwriting an external edit", async (t) => {
  // The file being real is what lets someone fix it after a crash. Replaying
  // the pre-crash bytes over that edit would destroy the very work the user
  // did to recover, so the external change wins and is recorded as one.
  const { workspaceRoot, service, taskId, resourceId } = await fixture(t, "崩溃前的内容\n");
  const metadata = JSON.parse(
    await readFile(resourcePath(workspaceRoot, resourceId, "metadata.json"), "utf8")
  );
  const { contentVersion } = await import("../dist/src/applications/types.js");
  const interrupted = "这次写入没有完成\n";
  await mkdir(transactionsDir(workspaceRoot), { recursive: true });
  await writeFile(
    join(transactionsDir(workspaceRoot), `${resourceId}.json`),
    JSON.stringify(
      {
        version: 1,
        resourceId,
        targetRevision: 1,
        event: {
          eventId: "evt_lost",
          operationId: "op-lost",
          taskId,
          resourceId,
          appType: "text-editor",
          actor: user,
          operationType: "text.insert",
          baseRevision: 0,
          revision: 1,
          payload: { at: 0, text: interrupted },
          summary: "插入",
          occurredAt: new Date().toISOString()
        },
        resource: {
          ...metadata,
          revision: 1,
          operationCount: 1,
          contentVersion: contentVersion(interrupted)
        },
        body: interrupted
      },
      null,
      2
    )
  );
  // The user opened the file and rewrote it after the crash.
  await writeFile(workspaceFile(workspaceRoot, metadata.path), "我自己改好的内容\n");

  const recovered = new ApplicationService(workspaceRoot);
  const read = await recovered.readResource(taskId, resourceId, { limit: 50 });
  assert.equal(read.snapshot.content, "我自己改好的内容\n", "the user's repair must survive recovery");
  assert.ok(read.resource.externalChangeAt, "and be recorded as an external change");
  assert.ok(read.operations.some((event) => event.operationType === "workspace.external_change"));
  assert.equal(
    read.operations.some((event) => event.operationId === "op-lost"),
    false,
    "the abandoned write is not logged as applied"
  );
  assert.deepEqual(await readdir(transactionsDir(workspaceRoot)), []);
});

test("rekeying two rows onto one document merges them, keeping the earlier slot", async (t) => {
  // This is the collapse that makes one file one tab. Two conversations each
  // had their own window on a shared document, so a legacy strip has two rows
  // for it; rekeying both onto the document's own id has to leave one — at the
  // position the first of them held, so the strip does not reshuffle — and the
  // focus has to follow whichever of the two was in front.
  const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
  const root = await mkdtemp(join(tmpdir(), "atria-rekey-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "tabs.json");
  await writeFile(
    path,
    `${JSON.stringify({
      version: 2,
      tabs: [
        { tabId: "conversation:a", kind: "conversation", taskId: "a", openedAt: "2026-01-01T00:00:00.000Z" },
        {
          tabId: "window:app_1",
          kind: "application",
          taskId: "a",
          appInstanceId: "app_1",
          openedAt: "2026-01-01T00:00:01.000Z"
        },
        { tabId: "conversation:b", kind: "conversation", taskId: "b", openedAt: "2026-01-01T00:00:02.000Z" },
        {
          tabId: "window:app_2",
          kind: "application",
          taskId: "b",
          appInstanceId: "app_2",
          openedAt: "2026-01-01T00:00:03.000Z"
        }
      ],
      activeTabId: "window:app_2",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })}\n`,
    "utf8"
  );

  const store = new WorkbenchTabStore(path);
  await store.rekey("window:app_1", { kind: "application", resourceId: "res_1" });
  const after = await store.rekey("window:app_2", { kind: "application", resourceId: "res_1" });

  assert.deepEqual(
    after.tabs.map((tab) => tab.tabId),
    ["conversation:a", "resource:res_1", "conversation:b"],
    "one row for the document, where the first of the two sat"
  );
  assert.equal(after.activeTabId, "resource:res_1", "focus follows the identity, not the row that vanished");
  assert.equal(
    after.tabs.find((tab) => tab.tabId === "resource:res_1").taskId,
    undefined,
    "and the merged row names no conversation"
  );
});

test("giving a document to an editor brings it up, even with nothing in front", async (t) => {
  // The bug this pins, reported four times as 「新建后没打开」 and finally
  // caught by a console trace from the real browser: the document was created
  // (HTTP 201) and its tab existed, but `activeTabId` was undefined, so the
  // page had nothing to show and the draft conversation stayed in front.
  //
  // The sequence is specific to the draft state. Opening the editor makes the
  // draft reassert itself and PATCH `tabId: null` — "the person stepped away
  // from every application", which is true and worth recording. A moment later
  // a document is created into that window, and `rekey` preserved focus only
  // when the row it replaced had been in front. Nothing was, so the new
  // document became a tab nobody was looking at.
  const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
  const root = await mkdtemp(join(tmpdir(), "atria-rekey-focus-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WorkbenchTabStore(join(root, "tabs.json"));

  await store.open({ kind: "application", taskId: "workspace", appInstanceId: "app_1" });
  // The draft steps away from it: recorded, so the next poll does not put the
  // editor back over the composer.
  const detached = await store.clearActive();
  assert.equal(detached.activeTabId, undefined, "nothing is in front");
  assert.equal(detached.detached, true);

  // Now the person creates a document into that same window.
  const after = await store.rekey("window:app_1", { kind: "application", resourceId: "res_1" });
  assert.deepEqual(
    after.tabs.map((tab) => tab.tabId),
    ["resource:res_1"],
    "the window became the document"
  );
  assert.equal(after.activeTabId, "resource:res_1", "and it is what the person is looking at");
  assert.equal(after.detached, false, "stepping away ended when they asked for this");

  // It survives a re-read: the page polls, and a stale `detached` would take
  // the document straight back off the screen.
  const reread = await store.read();
  assert.equal(reread.activeTabId, "resource:res_1");
});

test("a rekey does not steal focus from a tab the person chose", async (t) => {
  // The other half. Claiming focus whenever nothing held it must not extend to
  // pulling the person off a document they are actually reading.
  const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
  const root = await mkdtemp(join(tmpdir(), "atria-rekey-keep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WorkbenchTabStore(join(root, "tabs.json"));

  await store.open({ kind: "application", taskId: "t", appInstanceId: "app_1" });
  await store.open({ kind: "application", resourceId: "res_reading" });
  assert.equal((await store.read()).activeTabId, "resource:res_reading");

  // A document lands in the other, still-empty window.
  const after = await store.rekey("window:app_1", { kind: "application", resourceId: "res_new" });
  assert.equal(after.activeTabId, "resource:res_reading", "the person keeps the document they were on");
  assert.ok(
    after.tabs.some((tab) => tab.tabId === "resource:res_new"),
    "though the new one is in the strip"
  );
});

test("non-activating tab opens preserve concurrent navigation and detached focus", async (t) => {
  const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
  const root = await mkdtemp(join(tmpdir(), "atria-tab-focus-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WorkbenchTabStore(join(root, "tabs.json"));
  await store.open({ kind: "conversation", taskId: "task-a" });
  await store.open({ kind: "application", resourceId: "cad" });
  await store.activate("conversation:task-a");
  await Promise.all([
    store.open({ kind: "application", resourceId: "cad" }, { activate: false }),
    store.activate("resource:cad")
  ]);
  assert.equal((await store.read()).activeTabId, "resource:cad");
  await store.clearActive();
  await store.open({ kind: "application", resourceId: "txt" }, { activate: false });
  assert.equal((await store.read()).activeTabId, undefined);
  assert.equal((await store.read()).detached, true);
});

test("review compares a saved edit and refuses to undo a revision that changed meanwhile", async (t) => {
  const { service, taskId, resourceId } = await fixture(t, "人工修改\n");
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "reviewed-edit",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "模型新增\n" },
    actor: agent
  });
  const review = await service.reviewResource(taskId, resourceId);
  assert.equal(review.available, true);
  assert.equal(review.before, "人工修改\n");
  assert.equal(review.after, "模型新增\n人工修改\n");
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "later-edit",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 1,
    payload: { at: 0, text: "后续人工\n" },
    actor: user
  });
  await assert.rejects(
    service.undo({ taskId, resourceId, actor: user, baseRevision: review.revision, eventId: review.eventId }),
    (error) => error.code === "revision_conflict"
  );
  const current = await service.reviewResource(taskId, resourceId);
  const restored = await service.undo({
    taskId,
    resourceId,
    actor: user,
    baseRevision: current.revision,
    eventId: current.eventId
  });
  assert.equal(restored.snapshot.content, review.after);
  assert.equal(restored.resource.revision, 3);
  assert.equal((await service.reviewResource(taskId, resourceId)).before, "后续人工\n模型新增\n人工修改\n");
  await assert.rejects(
    service.reviewResource("unrelated", resourceId),
    (error) => error.code === "resource_not_found"
  );
});
