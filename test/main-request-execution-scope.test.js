import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { assertMainRequestExecutionScope, mainRequestExecutionScope, validMainRequestExecutionScope } =
  await import("../dist/src/runtime/main-request-execution-scope.js");

test("execution ownership compares canonical roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-retry-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "storage"),
    project = join(root, "project");
  for (const path of [storage, project]) await mkdir(path);
  const input = { taskStorageRoot: storage, projectDirectory: project };
  const scope = await mainRequestExecutionScope(input);
  assert.ok(validMainRequestExecutionScope(scope));
  assert.equal(scope.taskStorageRoot, await mainRequestExecutionScope(input).then((s) => s.taskStorageRoot));
  assert.doesNotThrow(() => assertMainRequestExecutionScope(scope, { ...scope }));
  for (const change of [{ projectDirectory: storage }, { taskStorageRoot: project }])
    assert.throws(() => assertMainRequestExecutionScope(scope, { ...scope, ...change }), /工作目录已改变/);
  assert.equal(validMainRequestExecutionScope({ ...scope, projectDirectory: "relative" }), false);
  assert.equal(validMainRequestExecutionScope({ ...scope, version: 2 }), false);
  if (process.platform !== "win32") {
    const alias = join(root, "project-alias");
    await symlink(project, alias, "dir");
    assert.deepEqual(await mainRequestExecutionScope({ ...input, projectDirectory: alias }), scope);
  }
});
