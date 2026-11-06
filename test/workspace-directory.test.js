import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createWorkspaceDirectory } = await import("../dist/src/dashboard/workspace-directory.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

test("empty storage roots are omitted; legacy projects adopt history and project edits preserve its storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-workspace-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a");
  const b = join(root, "b");
  const index = join(root, "catalog.json");
  let directory = createWorkspaceDirectory(a, index, () => "fixture");
  await directory.register(b);
  assert.deepEqual((await directory.globalTaskPayload()).projects, []);
  const store = new LocalWorkspaceStore(a);
  await store.createTask("standalone", { kind: "workspace" });
  assert.deepEqual((await directory.globalTaskPayload()).projects, []);
  await store.createTask("session", { goal: "保留我的历史" });
  const memory = join(a, "session", "agents", "main", "context", "memory.md");
  await writeFile(memory, "不能丢失的历史");
  await store.updateTask("session", { projectDirectory: b });
  directory = createWorkspaceDirectory(a, index, () => "fixture");
  const payload = await directory.globalTaskPayload();
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0].workspaceRoot, b);
  assert.equal(payload.projects[0].tasks[0].workspaceRoot, b);
  assert.equal(payload.currentWorkspaceRoot, a);
  const location = await directory.locateTask("session");
  assert.equal(location.workspaceRoot, a);
  assert.equal(location.projectId, b);
  assert.equal(directory.taskListItem(location).workspaceRoot, b);
  assert.equal(await readFile(memory, "utf8"), "不能丢失的历史");
  await directory.updateProject(b, { projectDirectory: a }, (_taskIds, action) => action());
  assert.equal((await directory.globalTaskPayload()).projects[0].workspaceRoot, a);
});

test("stale directory indexes are hidden without deleting records, while legacy documents and explicit empty projects remain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-project-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  const { ApplicationService } = await import("../dist/src/applications/application-service.js");
  const storage = join(root, "workspace"),
    documentRoot = join(root, "retained-documents"),
    emptyRoot = join(root, "empty");
  await Promise.all([mkdir(documentRoot), mkdir(emptyRoot)]);
  const directory = createWorkspaceDirectory(storage, join(root, "global.json"), () => "fixture");
  await new LocalWorkspaceStore(storage).createTask("workspace", { kind: "workspace" });
  await directory.locateTask("workspace");
  assert.deepEqual(
    await directory.projectCatalog.list(),
    [],
    "lookup of a holding Task cannot adopt its directory"
  );
  const explicit = await directory.createProject({
    projectName: "Explicit empty",
    projectDirectory: emptyRoot
  });
  const resource = (
    await new ApplicationService(documentRoot).resources.createResource({
      appType: "text-editor",
      kind: "text/plain",
      title: "old.txt",
      initialContent: "Retain document\n",
      actor: { type: "user", id: "fixture" }
    })
  ).resource;
  const path = join(
    documentRoot,
    "applications",
    "text-editor",
    "resources",
    resource.resourceId,
    "metadata.json"
  );
  const metadata = JSON.parse(await readFile(path, "utf8"));
  delete metadata.project;
  await writeFile(path, JSON.stringify(metadata));
  const temporary = join(root, "atria-reasoning-launcher-old");
  await directory.projectCatalog.ensureLegacy([storage, temporary, documentRoot]);
  const indexBefore = await readFile(directory.projectCatalog.filePath, "utf8");
  const metadataBefore = await readFile(path, "utf8");
  const payload = await directory.globalTaskPayload();
  assert.deepEqual(
    payload.projects.map((project) => project.projectId).sort(),
    [explicit.projectId, documentRoot].sort()
  );
  assert.equal(payload.projects.find((project) => project.projectId === documentRoot).hasApplications, true);
  assert.equal(await readFile(directory.projectCatalog.filePath, "utf8"), indexBefore);
  assert.equal(await readFile(path, "utf8"), metadataBefore);
  assert.equal(
    await readFile(join(documentRoot, "applications", "text-editor", "files", resource.path), "utf8"),
    "Retain document\n"
  );
});
