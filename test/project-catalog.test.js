import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalProjectCatalog } from "../dist/src/workspace/project-catalog.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { createWorkspaceDirectory } from "../dist/src/dashboard/workspace-directory.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-project-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, "workspace");
  const first = join(root, "first"),
    second = join(root, "second"),
    third = join(root, "third");
  await Promise.all([first, second, third].map((directory) => mkdir(directory)));
  const directory = createWorkspaceDirectory(
    storageRoot,
    join(root, "runtime", "workspaces.json"),
    () => "fixture"
  );
  return {
    root,
    storageRoot,
    first,
    second,
    third,
    directory,
    store: new LocalWorkspaceStore(storageRoot),
    catalog: directory.projectCatalog
  };
}

test("projects retain stable identities and empty records after restart, with validated folders and duplicate refusal", async (t) => {
  const f = await fixture(t);
  const project = await f.directory.createProject({
    projectName: "  Named project  ",
    projectDirectory: f.first
  });
  assert.match(project.projectId, /^project_[a-f0-9-]+$/);
  assert.equal(project.projectName, "Named project");
  assert.deepEqual(project.tasks, []);
  const reopened = createWorkspaceDirectory(
    f.storageRoot,
    join(f.root, "runtime", "workspaces.json"),
    () => "fixture"
  );
  assert.equal((await reopened.globalTaskPayload()).projects[0].projectId, project.projectId);
  assert.deepEqual(await reopened.knownWorkspaceRoots(), [f.storageRoot]);
  await assert.rejects(f.directory.createProject({ projectName: "duplicate", projectDirectory: f.first }), {
    status: 409
  });
  for (const input of [
    { projectName: "", projectDirectory: f.second },
    { projectName: "x", projectDirectory: "relative" },
    { projectName: "x", projectDirectory: join(f.root, "missing") }
  ]) {
    await assert.rejects(f.directory.createProject(input), { status: 400 });
  }
});

test("project edits inherit across conversations without moving their history or changing membership", async (t) => {
  const f = await fixture(t);
  const project = await f.directory.createProject({ projectName: "Original", projectDirectory: f.first });
  await f.directory.createProjectTask("one", project.projectId, { goal: "First conversation" });
  await f.directory.createProjectTask("two", project.projectId, { goal: "Second conversation" });
  const history = join(f.storageRoot, "one", "agents", "main", "context", "memory.md");
  await writeFile(history, "Retained training history\n");
  const grouped = await f.directory.globalTaskPayload();
  assert.equal(grouped.tasks.length, 2);
  for (const task of grouped.tasks) {
    assert.equal(task.projectId, project.projectId);
    assert.equal(task.projectDirectory, f.first);
    assert.equal(task.storageRoot, f.storageRoot);
  }
  let inspected;
  await f.directory.updateProject(
    project.projectId,
    { projectName: "Renamed", projectDirectory: f.second },
    async (taskIds, commit) => {
      inspected = taskIds.sort();
      return commit();
    }
  );
  assert.deepEqual(inspected, ["one", "two"]);
  for (const taskId of inspected) {
    const task = await f.store.readTask(taskId);
    assert.equal(task.projectId, project.projectId);
    assert.equal(task.projectDirectory, f.second);
    assert.equal(task.projectCatalogPath, f.catalog.filePath);
    assert.equal(
      JSON.parse(await readFile(join(f.storageRoot, taskId, "task.json"), "utf8")).projectDirectory,
      f.second
    );
  }
  assert.equal(await readFile(history, "utf8"), "Retained training history\n");
  assert.deepEqual(await f.directory.knownWorkspaceRoots(), [f.storageRoot]);
});

test("a failed directory preflight leaves every record untouched, while rename can proceed without it", async (t) => {
  const f = await fixture(t);
  const project = await f.directory.createProject({ projectName: "Original", projectDirectory: f.first });
  await f.directory.createProjectTask("one", project.projectId, { goal: "First" });
  await f.directory.createProjectTask("two", project.projectId, { goal: "Second" });
  const before = await Promise.all(
    [
      f.catalog.filePath,
      join(f.storageRoot, "one", "task.json"),
      join(f.storageRoot, "two", "task.json")
    ].map((file) => readFile(file, "utf8"))
  );
  await assert.rejects(
    f.directory.updateProject(project.projectId, { projectDirectory: f.second }, async () => {
      throw new Error("active background work");
    }),
    /active background work/
  );
  assert.deepEqual(
    await Promise.all(
      [
        f.catalog.filePath,
        join(f.storageRoot, "one", "task.json"),
        join(f.storageRoot, "two", "task.json")
      ].map((file) => readFile(file, "utf8"))
    ),
    before
  );
  const renamed = await f.directory.updateProject(project.projectId, { projectName: "Name changed" }, () =>
    assert.fail("rename must not inspect directory activity")
  );
  assert.equal(renamed.projectName, "Name changed");
});

test("an interrupted directory commit presents the old assignment until recovery finishes all task snapshots", async (t) => {
  const f = await fixture(t);
  const project = await f.directory.createProject({ projectName: "Original", projectDirectory: f.first });
  await f.directory.createProjectTask("one", project.projectId, { goal: "First" });
  await f.directory.createProjectTask("two", project.projectId, { goal: "Second" });
  const document = JSON.parse(await readFile(f.catalog.filePath, "utf8"));
  document.pending = {
    projectId: project.projectId,
    next: { ...project, projectDirectory: f.second },
    tasks: ["one", "two"].map((taskId) => ({ taskId, storageRoot: f.storageRoot }))
  };
  await writeFile(f.catalog.filePath, JSON.stringify(document));
  await f.store.updateTask("one", { projectDirectory: f.second });
  const staged = await readFile(join(f.storageRoot, "one", "task.json"), "utf8");
  assert.equal((await f.store.readTask("one")).projectDirectory, f.first);
  assert.equal((await f.store.readTask("two")).projectDirectory, f.first);
  await new GlobalProjectCatalog(f.catalog.filePath).recover();
  assert.equal(
    await readFile(join(f.storageRoot, "one", "task.json"), "utf8"),
    staged,
    "recovery must not increment metadata twice for an already staged task"
  );
  for (const taskId of ["one", "two"])
    assert.equal((await f.store.readTask(taskId)).projectDirectory, f.second);
  assert.equal(JSON.parse(await readFile(f.catalog.filePath, "utf8")).pending, undefined);
  const recovered = await readFile(join(f.storageRoot, "one", "task.json"), "utf8");
  await f.catalog.recover();
  assert.equal(await readFile(join(f.storageRoot, "one", "task.json"), "utf8"), recovered);
  const damaged = JSON.parse(await readFile(f.catalog.filePath, "utf8"));
  damaged.pending = {
    projectId: project.projectId,
    next: { ...project, projectDirectory: f.third },
    tasks: [{ storageRoot: f.storageRoot, taskId: "../one" }]
  };
  await writeFile(f.catalog.filePath, JSON.stringify(damaged));
  await assert.rejects(f.catalog.recover(), { status: 409 });
  assert.equal(await readFile(join(f.storageRoot, "one", "task.json"), "utf8"), recovered);
});

test("legacy adoption keeps missing-folder history and timestamps, while imported projects keep names and stable ids", async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, "removed-folder");
  await f.store.createTask("legacy", { goal: "Retained", projectDirectory: missing });
  const original = await f.store.readTask("legacy");
  const legacy = (await f.directory.globalTaskPayload()).projects[0];
  assert.equal(legacy.projectId, missing);
  const adopted = await f.store.readTask("legacy");
  assert.equal(adopted.projectId, missing);
  assert.equal(adopted.projectCatalogPath, f.catalog.filePath);
  assert.equal(adopted.updatedAt, original.updatedAt);
  const foreign = new GlobalProjectCatalog(join(f.root, "imported", "projects.json"));
  const sameFolder = await f.directory.createProject({
    projectName: "Existing local label",
    projectDirectory: f.first
  });
  const imported = await foreign.create({ projectName: "My imported label", projectDirectory: f.first });
  await f.store.createTask("imported", {
    projectId: imported.projectId,
    projectCatalogPath: foreign.filePath,
    projectDirectory: f.first
  });
  const grouped = await f.directory.globalTaskPayload();
  assert.equal(grouped.tasks.find((task) => task.taskId === "imported").projectId, imported.projectId);
  assert.equal(grouped.tasks.find((task) => task.taskId === "imported").projectName, "My imported label");
  assert.equal((await f.store.readTask("imported")).projectCatalogPath, f.catalog.filePath);
  assert.ok(grouped.projects.some((project) => project.projectId === sameFolder.projectId));
  const renamed = await f.directory.updateProject(
    imported.projectId,
    { projectName: "Recovered imported label", projectDirectory: f.first },
    () => assert.fail("same-directory rename has no activity guard")
  );
  assert.equal(renamed.projectName, "Recovered imported label");
  await assert.rejects(
    f.directory.createProject({ projectName: "New duplicate", projectDirectory: f.first }),
    { status: 409 }
  );
});

test("project creation and folder changes use the same cross-instance lock as task launches", async (t) => {
  const f = await fixture(t);
  const project = await f.directory.createProject({ projectName: "Original", projectDirectory: f.first });
  let release, entered;
  const gate = new Promise((done) => {
    release = done;
  });
  const ready = new Promise((done) => {
    entered = done;
  });
  const operation = new GlobalProjectCatalog(f.catalog.filePath).withProjectLock(
    project.projectId,
    async () => {
      entered();
      await gate;
    }
  );
  await ready;
  let created = false;
  const pending = f.directory
    .createProjectTask("new", project.projectId, { goal: "Wait for folder edit" })
    .then(() => {
      created = true;
    });
  await new Promise((done) => setTimeout(done, 40));
  assert.equal(created, false);
  release();
  await Promise.all([operation, pending]);
  await f.directory.updateProject(project.projectId, { projectDirectory: f.third }, (_tasks, action) =>
    action()
  );
  assert.equal((await f.store.readTask("new")).projectDirectory, f.third);
});

test("legacy CLI history recovers its exact bound project before adopting a task with no directory metadata", async (t) => {
  const f = await fixture(t);
  await f.store.createTask("legacy-cli", { goal: "Original CLI project" });
  const history = join(f.storageRoot, "legacy-cli", "agents", "main", "context", "messages.json");
  const entries = [
    {
      type: "custom",
      customType: "atria-cli-task",
      data: { taskId: "other-task", workspaceRoot: f.storageRoot, projectDirectory: f.second }
    },
    {
      type: "custom",
      customType: "atria-cli-task",
      data: { taskId: "legacy-cli", workspaceRoot: f.storageRoot, projectDirectory: f.first }
    }
  ];
  await writeFile(history, JSON.stringify(entries));
  const original = await readFile(history, "utf8");
  const task = (await f.directory.globalTaskPayload()).tasks.find((item) => item.taskId === "legacy-cli");
  assert.equal(task.projectDirectory, f.first);
  assert.equal(task.projectId, f.first);
  assert.equal((await f.store.readTask("legacy-cli")).projectDirectory, f.first);
  assert.equal(await readFile(history, "utf8"), original);
});

test("legacy CLI bindings match canonical storage roots reached through an alias", async (t) => {
  const f = await fixture(t);
  await f.store.createTask("alias-cli", { goal: "Original project through storage alias" });
  const alias = join(f.root, "workspace-alias");
  await symlink(f.storageRoot, alias, process.platform === "win32" ? "junction" : "dir");
  const canonicalStorage = await realpath(f.storageRoot),
    canonicalProject = await realpath(f.first);
  const history = join(f.storageRoot, "alias-cli", "agents", "main", "context", "messages.json");
  await writeFile(
    history,
    JSON.stringify([
      {
        type: "custom",
        customType: "atria-cli-task",
        data: { taskId: "alias-cli", workspaceRoot: canonicalStorage, projectDirectory: canonicalProject }
      }
    ])
  );
  const directory = createWorkspaceDirectory(
    alias,
    join(f.root, "alias-runtime", "workspaces.json"),
    () => "fixture"
  );
  const task = (await directory.globalTaskPayload()).tasks.find((item) => item.taskId === "alias-cli");
  assert.equal(task.projectDirectory, canonicalProject);
  assert.equal(task.projectId, canonicalProject);
  assert.equal(task.storageRoot, alias);
  assert.equal((await f.store.readTask("alias-cli")).projectDirectory, canonicalProject);
});

test("removing a project hides it and its conversations, and adding its folder again restores both (#33)", async (t) => {
  const f = await fixture(t);
  const project = await f.directory.createProject({ projectName: "Removable", projectDirectory: f.first });
  await f.directory.createProjectTask("kept-task", project.projectId, { goal: "kept" });
  const idle = (_ids, action) => action();
  let guarded;
  const removed = await f.directory.removeProject(project.projectId, (ids, action) => {
    guarded = ids;
    return action();
  });
  assert.deepEqual(guarded, ["kept-task"], "the idle check covers the project's conversations");
  assert.deepEqual(removed.taskIds, ["kept-task"]);
  let listed = await f.directory.globalTaskPayload();
  assert.deepEqual(listed.projects, []);
  assert.deepEqual(listed.tasks, []);
  // Nothing on disk is deleted, and the record keeps its owner.
  assert.equal((await f.store.readTask("kept-task")).projectId, project.projectId);
  await assert.rejects(f.directory.removeProject(project.projectId, idle), /找不到项目/);
  await assert.rejects(
    f.directory.updateProject(project.projectId, { projectName: "x" }, idle),
    /找不到项目/
  );

  const restored = await f.directory.createProject({ projectName: "Back", projectDirectory: f.first });
  assert.equal(restored.projectId, project.projectId);
  assert.equal(restored.projectName, "Back");
  assert.equal("removedAt" in restored, false);
  assert.deepEqual(
    restored.tasks.map((task) => task.taskId),
    ["kept-task"]
  );
  listed = await f.directory.globalTaskPayload();
  assert.deepEqual(
    listed.projects.map((entry) => entry.projectId),
    [project.projectId]
  );

  // A busy project is not removed.
  await assert.rejects(
    f.directory.removeProject(project.projectId, () => Promise.reject(new Error("busy"))),
    /busy/
  );
  assert.equal((await f.directory.globalTaskPayload()).projects.length, 1);
});
