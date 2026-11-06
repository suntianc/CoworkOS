import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { assertMainRequestExecutionScope, mainRequestExecutionScope, validMainRequestExecutionScope } =
  await import("../dist/src/runtime/main-request-execution-scope.js");

test("execution ownership uses canonical roots and distinguishes app/instance, adapter and MCP tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-retry-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "storage"),
    source = join(root, "source"),
    project = join(root, "project");
  for (const path of [storage, source, project]) await mkdir(path);
  await writeFile(join(source, "same.txt"), "fixture");
  const application = {
    resourceId: "same-id",
    appType: "text-editor",
    appInstanceId: "same-instance",
    resourcePath: join(source, "same.txt"),
    tools: [{ name: "write_document" }, { name: "read_document" }]
  };
  const input = {
    taskStorageRoot: storage,
    projectDirectory: project,
    resourceWorkspaceRoot: source,
    application,
    mcpTools: [{ name: "replace_section" }]
  };
  const scope = await mainRequestExecutionScope(input);
  assert.ok(validMainRequestExecutionScope(scope));
  assert.notEqual(scope.taskStorageRoot, scope.application.resourceWorkspaceRoot);
  const reordered = JSON.parse(JSON.stringify(scope));
  reordered.application.adapterTools.reverse();
  assert.doesNotThrow(() => assertMainRequestExecutionScope(scope, reordered));
  for (const change of [
    { projectDirectory: source },
    { taskStorageRoot: source },
    { application: null },
    ...[
      { resourceId: "other-id" },
      { appType: "other-app" },
      { appInstanceId: "other-instance" },
      { resourceWorkspaceRoot: storage },
      { resourcePath: join(source, "other.txt") },
      { adapterTools: ["replace_section"] },
      { mcpTools: ["write_document"] }
    ].map((patch) => ({ application: { ...scope.application, ...patch } }))
  ])
    assert.throws(() => assertMainRequestExecutionScope(scope, { ...scope, ...change }), /归属已改变/);
  assert.throws(() => assertMainRequestExecutionScope(undefined, scope), /缺少执行归属/);
  assert.equal(
    validMainRequestExecutionScope({
      ...scope,
      application: { ...scope.application, resourceWorkspaceRoot: "relative" }
    }),
    false
  );
  if (process.platform !== "win32") {
    const alias = join(root, "source-alias");
    await symlink(source, alias, "dir");
    assert.deepEqual(
      await mainRequestExecutionScope({
        ...input,
        resourceWorkspaceRoot: alias,
        application: { ...application, resourcePath: join(alias, "same.txt") }
      }),
      scope
    );
  }
});
