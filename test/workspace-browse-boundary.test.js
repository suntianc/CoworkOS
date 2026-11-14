import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browseWorkspace } from "../dist/src/tools/workspace-browse.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-browse-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "canary.txt"), "OUTSIDE_CANARY\n");
  await symlink(join(outside, "canary.txt"), join(workspace, "file-alias"));
  await symlink(outside, join(workspace, "directory-alias"));
  return { root, workspace };
}

for (const [mode, path] of [
  ["read", "file-alias"],
  ["search", "file-alias"],
  ["read", "directory-alias/canary.txt"],
  ["search", "directory-alias"],
  ["tree", "directory-alias"]
])
  test(`browse ${mode} rejects an outside target through ${path}`, async (t) => {
    const { workspace } = await fixture(t);
    await assert.rejects(
      browseWorkspace({ workspaceDirectory: workspace }, { mode, path, query: "OUTSIDE_CANARY" }),
      /escapes workspace/
    );
  });

test("artifact migration destinations cannot redirect a read outside the workspace", async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(join(workspace, ".runtime"));
  await writeFile(
    join(workspace, ".runtime/artifact-migration.json"),
    JSON.stringify({ paths: [{ sourcePath: "old.txt", destinationPath: "file-alias" }] })
  );
  await assert.rejects(
    browseWorkspace({ workspaceDirectory: workspace }, { mode: "read", path: "old.txt" }),
    /escapes workspace/
  );
});

test("workspace aliases resolving inside the same root keep normal browsing behavior", async (t) => {
  const { root, workspace } = await fixture(t);
  await mkdir(join(workspace, "documents"));
  await writeFile(join(workspace, "documents/local.txt"), "LOCAL_EVIDENCE\n");
  await symlink(join(workspace, "documents"), join(workspace, "local-alias"));
  const rootAlias = join(root, "workspace-alias");
  await symlink(workspace, rootAlias);
  const options = { workspaceDirectory: rootAlias };
  const read = await browseWorkspace(options, { mode: "read", path: "local-alias/local.txt" });
  assert.equal(read.content, "LOCAL_EVIDENCE\n");
  const search = await browseWorkspace(options, { mode: "search", path: "local-alias", query: "LOCAL" });
  assert.equal(search.matches.length, 1);
  const tree = await browseWorkspace(options, { mode: "tree", path: "local-alias" });
  assert.equal(tree.entries.length, 1);
});
