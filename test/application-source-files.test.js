import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");

const actor = { type: "user", id: "local" };
const version = (content) => createHash("sha256").update(content).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cowork-source-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "note.md");
  await writeFile(path, "# Original");
  const service = new ApplicationService(join(root, "workspace"));
  const instance = await service.openApplication({ taskId: "chat", appType: "text-editor" });
  const input = {
    taskId: "chat",
    appInstanceId: instance.appInstanceId,
    kind: "text/markdown",
    title: "note.md",
    initialContent: "# Original",
    actor,
    sourceFile: { path, contentVersion: version("# Original") }
  };
  const made = await service.createInApplication(input);
  const resourceId = made.resource.resourceId;
  const edit = () =>
    service.applyOperation({
      taskId: "chat",
      resourceId,
      appType: "text-editor",
      operationId: "edit",
      operationType: "text.rewrite",
      baseRevision: 0,
      payload: { content: "# Updated" },
      actor
    });
  return { root, path, service, instance, input, resourceId, edit };
}
test("text originals save in their original format and survive reopening", async (t) => {
  const f = await fixture(t);
  await f.edit();
  assert.equal(await readFile(f.path, "utf8"), "# Updated");
  const reopened = new ApplicationService(join(f.root, "workspace"));
  assert.equal((await reopened.readResource("chat", f.resourceId)).snapshot.content, "# Updated");
});
test("changed-during-open originals are rejected without adding resources", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, "external change");
  const empty = await f.service.openApplication({ taskId: "chat", appType: "text-editor", fresh: true });
  await assert.rejects(f.service.createInApplication({ ...f.input, appInstanceId: empty.appInstanceId }), {
    code: "source_file_conflict"
  });
  assert.equal((await f.service.instances.readInstance(empty.appInstanceId)).resourceIds.length, 0);
});
test("external changes conflict before editing and retain the external bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, "external change");
  await assert.rejects(f.edit(), { code: "source_file_conflict" });
  assert.equal(await readFile(f.path, "utf8"), "external change");
  assert.equal((await f.service.resources.readMetadataById(f.resourceId)).revision, 0);
});
test("failed source writes remain retryable without applying the operation twice", async (t) => {
  const f = await fixture(t);
  const files = f.service.resources.files;
  const write = files.writeBytes.bind(files);
  files.writeBytes = async () => {
    throw new Error("disk unavailable");
  };
  await assert.rejects(f.edit(), { code: "source_file_write_failed" });
  assert.equal(await readFile(f.path, "utf8"), "# Original");
  files.writeBytes = write;
  const retry = await f.edit();
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.resource.revision, 1);
  assert.equal(await readFile(f.path, "utf8"), "# Updated");
});
test("restart recovers a source write interrupted before metadata acknowledgement", async (t) => {
  const f = await fixture(t);
  const files = f.service.resources.files;
  const write = files.writeBytes.bind(files);
  files.writeBytes = async (...args) => {
    await write(...args);
    throw new Error("exit after atomic write");
  };
  await assert.rejects(f.edit(), { code: "source_file_write_failed" });
  const restarted = new ApplicationService(join(f.root, "workspace"));
  const recovered = await restarted.readResource("chat", f.resourceId);
  assert.equal(recovered.resource.sourceFile.savedRevision, 1);
  assert.equal(recovered.resource.sourceFile.pending, undefined);
  assert.equal(recovered.operations.length, 1);
  assert.equal(recovered.snapshot.content, "# Updated");
});
