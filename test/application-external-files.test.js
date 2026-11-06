import "./application-fixture.mjs";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { contentVersion } = await import("../dist/src/applications/types.js");

const actor = { type: "user", id: "local" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "outside.txt");
  await writeFile(original, "原文 😀\n");
  const workspaceRoot = join(root, "workspace");
  const service = new ApplicationService(workspaceRoot);
  const created = await service.createResource({
    taskId: "task",
    kind: "text/plain",
    title: "outside.txt",
    externalPath: original,
    actor
  });
  const resource = created.resource;
  const externalPath = await realpath(original);
  const edit = (baseRevision, text = "修改后\n") =>
    service.applyOperation({
      taskId: "task",
      resourceId: resource.resourceId,
      operationId: `edit-${baseRevision}`,
      appType: "text-editor",
      operationType: "text.rewrite",
      baseRevision,
      payload: { content: text },
      actor
    });
  return { root, workspaceRoot, service, resource, externalPath, edit };
}

test("an external TXT uses the original file for reads, edits, selections, export and undo", async (t) => {
  const { service, resource, externalPath, edit } = await fixture(t);
  assert.equal((await service.readResource("task", resource.resourceId)).snapshot.content, "原文 😀\n");
  await chmod(externalPath, 0o640);
  const changed = await edit(0);
  assert.equal(changed.resource.revision, 1);
  assert.equal(await readFile(externalPath, "utf8"), "修改后\n");
  assert.equal((await stat(externalPath)).mode & 0o777, 0o640, "saving preserves user file permissions");
  const selection = await service.resources.saveSelection({
    resourceId: resource.resourceId,
    schema: "text.range/v1",
    data: { anchor: 0, head: 2 },
    actor
  });
  assert.match(selection.summary, /修改/);
  const exported = await service.renderForDownload({
    taskId: "task",
    resourceId: resource.resourceId,
    format: "text"
  });
  assert.equal(exported.body, "修改后\n");
  await service.resources.undo({ resourceId: resource.resourceId, actor });
  assert.equal(await readFile(externalPath, "utf8"), "原文 😀\n");
  assert.equal(
    await stat(join(service.resources.resourceFileDirectory("text-editor"), resource.path)).catch(() => null),
    null,
    "editing never creates a shadow copy inside the application"
  );
});

test("an external edit advances the same revision and rejects stale writes", async (t) => {
  const { service, resource, externalPath, edit } = await fixture(t);
  await writeFile(externalPath, "来自其他软件\n");
  const read = await service.readResource("task", resource.resourceId);
  assert.equal(read.resource.revision, 1);
  assert.equal(read.snapshot.content, "来自其他软件\n");
  await assert.rejects(edit(0), { code: "revision_conflict" });
  assert.equal(await readFile(externalPath, "utf8"), "来自其他软件\n");
});

test("concurrent protocol reads return content and metadata from the same revision", async (t) => {
  const { workspaceRoot, service } = await fixture(t);
  const { resource } = await service.createResource({
    taskId: "task",
    kind: "text/plain",
    title: "concurrent.txt",
    initialContent: "revision 0",
    actor
  });
  const other = new ApplicationService(workspaceRoot);
  const writer = async () => {
    for (let revision = 0; revision < 12; revision++)
      await other.applyOperation({
        taskId: "task",
        resourceId: resource.resourceId,
        appType: "text-editor",
        actor,
        operationId: `concurrent-${revision}`,
        operationType: "text.rewrite",
        baseRevision: revision,
        payload: { content: `revision ${revision + 1}` }
      });
  };
  const reader = async () => {
    for (let i = 0; i < 16; i++) {
      const {
        resource: current,
        snapshot,
        operations
      } = await service.readResource("task", resource.resourceId);
      assert.equal(snapshot.content, `revision ${current.revision}`);
      assert.equal(current.contentVersion, contentVersion(snapshot.content));
      if (operations.length) assert.equal(operations.at(-1).revision, current.revision);
    }
  };
  await Promise.all([writer(), reader(), reader()]);
});

test("renaming an external resource stays in its directory and refuses an existing file", async (t) => {
  const { root, service, resource, externalPath, edit } = await fixture(t);
  await writeFile(join(root, "occupied.txt"), "别人的文件");
  await assert.rejects(service.resources.rename("text-editor", resource.resourceId, "occupied.txt"), {
    code: "invalid_operation"
  });
  assert.equal(await readFile(join(root, "occupied.txt"), "utf8"), "别人的文件");
  const renamed = await service.resources.rename("text-editor", resource.resourceId, "新名称.txt");
  assert.equal(renamed.externalPath, await realpath(join(root, "新名称.txt")));
  assert.equal(await stat(externalPath).catch(() => null), null);
  await edit(0);
  assert.equal(await readFile(renamed.externalPath, "utf8"), "修改后\n");
});

async function interrupt({ workspaceRoot, resource }) {
  const body = "中断后要提交的内容\n";
  const directory = join(workspaceRoot, ".runtime", "applications", "transactions");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${resource.resourceId}.json`),
    JSON.stringify({
      version: 1,
      resourceId: resource.resourceId,
      targetRevision: 1,
      resource: { ...resource, revision: 1, operationCount: 1, contentVersion: contentVersion(body) },
      body,
      event: {
        eventId: "evt-interrupted",
        operationId: "op-interrupted",
        resourceId: resource.resourceId,
        appType: resource.appType,
        actor,
        operationType: "text.rewrite",
        baseRevision: 0,
        revision: 1,
        payload: { content: body },
        summary: "中断写入",
        occurredAt: new Date().toISOString()
      }
    })
  );
  return directory;
}

test("recovery completes an external transaction at the original path", async (t) => {
  const data = await fixture(t);
  const directory = await interrupt(data);
  const restarted = new ApplicationService(data.workspaceRoot);
  const read = await restarted.readResource("task", data.resource.resourceId);
  assert.equal(read.snapshot.content, "中断后要提交的内容\n");
  assert.equal(await readFile(data.externalPath, "utf8"), read.snapshot.content);
  assert.equal(read.operations.length, 1);
  assert.deepEqual(await readdir(directory), []);
});

test("recovery preserves an external edit and never recreates a deleted user file", async (t) => {
  const data = await fixture(t);
  await interrupt(data);
  await writeFile(data.externalPath, "用户在中断期间修改了文件\n");
  assert.equal(
    (await data.service.readResource("task", data.resource.resourceId)).snapshot.content,
    "用户在中断期间修改了文件\n"
  );
  const second = await fixture(t);
  await interrupt(second);
  await rm(second.externalPath);
  await assert.rejects(second.service.readResource("task", second.resource.resourceId), {
    code: "resource_not_found"
  });
  assert.equal(await stat(second.externalPath).catch(() => null), null);
});

test("adoption rejects missing files and symlinks instead of silently creating empty content", async (t) => {
  const { root, service, externalPath } = await fixture(t);
  for (const path of [join(root, "missing.txt"), join(root, "link.txt")]) {
    if (path.endsWith("link.txt")) await symlink(externalPath, path);
    await assert.rejects(
      service.createResource({
        taskId: "task",
        kind: "text/plain",
        title: "bad.txt",
        externalPath: path,
        actor
      }),
      { code: path.endsWith("link.txt") ? "unsafe_path" : "resource_not_found" }
    );
  }
});

test("an intermediate workspace symlink cannot redirect reads or recovery writes", async (t) => {
  const { root, service, resource } = await fixture(t);
  const internal = await service.createResource({
    taskId: "task",
    kind: "text/plain",
    title: "inside.txt",
    initialContent: "内部文件",
    actor
  });
  const files = service.resources.resourceFileDirectory("text-editor");
  await rm(files, { recursive: true });
  await symlink(root, files);
  await assert.rejects(service.readResource("task", internal.resource.resourceId), { code: "unsafe_path" });
  assert.equal(resource.title, "outside.txt");
});
