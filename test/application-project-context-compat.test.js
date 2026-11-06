import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { ResourceFiles } = await import("../dist/src/applications/resource-files.js");
const { applicationServiceForTask, taskApplicationWorkspace } =
  await import("../dist/src/applications/task-service.js");
const { createWorkspaceDirectory } = await import("../dist/src/dashboard/workspace-directory.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
import { applicationProjectLabel } from "../web/assets/workbench/workspace-scope.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-application-project-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "workspace"),
    projectDirectory = join(root, "documents"),
    oldDirectory = join(root, "old-fixture");
  await mkdir(projectDirectory);
  await mkdir(oldDirectory);
  const directory = createWorkspaceDirectory(storage, join(root, "global.json"), () => "fixture");
  const project = await directory.createProject({ projectName: "用户项目名称", projectDirectory });
  await directory.createProjectTask("chat", project.projectId, { goal: "项目会话" });
  return {
    root,
    storage,
    projectDirectory,
    oldDirectory,
    directory,
    project,
    store: new LocalWorkspaceStore(storage)
  };
}
const actor = { type: "user", id: "fixture" };

test("first document creation inherits the project folder while Task state stays central", async (t) => {
  const f = await fixture(t);
  assert.equal(await taskApplicationWorkspace(f.storage, "chat"), f.projectDirectory);
  const service = await applicationServiceForTask(f.storage, "chat");
  const created = await service.createResource({
    taskId: "chat",
    kind: "text/markdown",
    title: "自我介绍",
    initialContent: "# 自我介绍\n测试文档。",
    actor
  });
  const path = new ResourceFiles(f.projectDirectory).absolutePath(created.resource);
  assert.equal(await readFile(path, "utf8"), "# 自我介绍\n测试文档。");
  assert.equal((await f.store.readTask("chat")).projectId, f.project.projectId);
  assert.equal(created.resource.projectId, f.project.projectId);
  assert.equal((await service.mapping.list("chat"))[0].workspaceRoot, f.projectDirectory);
  await assert.rejects(readFile(join(f.projectDirectory, "chat/task.json")), { code: "ENOENT" });
});

test("a loaded legacy document keeps its source root when its conversation belongs to another project", async (t) => {
  const f = await fixture(t);
  const source = new ApplicationService(f.storage);
  const created = await source.createResource({
    taskId: "chat",
    kind: "text/plain",
    title: "旧文档",
    initialContent: "保留原文",
    actor
  });
  await source.loadInstance("chat", created.appInstance.appInstanceId);
  assert.equal(await taskApplicationWorkspace(f.storage, "chat"), f.storage);
  const service = await applicationServiceForTask(f.storage, "chat");
  assert.equal(
    (await service.readResource("chat", created.resource.resourceId)).snapshot.content,
    "保留原文"
  );
  await service.loadInstance("chat", undefined);
  assert.equal(await taskApplicationWorkspace(f.storage, "chat"), f.projectDirectory);
  assert.equal(
    (
      await (
        await applicationServiceForTask(f.storage, "chat")
      ).readResource("chat", created.resource.resourceId)
    ).snapshot.content,
    "保留原文"
  );
});

test("looking up an internal holding Task does not register a user project", async (t) => {
  const f = await fixture(t);
  await new ApplicationService(f.storage).ensureStandaloneWorkspace();
  await f.directory.locateTask("workspace");
  assert.deepEqual(
    (await f.directory.projectCatalog.list()).map((project) => project.projectId),
    [f.project.projectId]
  );
  assert.deepEqual(
    (await f.directory.globalTaskPayload()).projects.map((project) => project.projectId),
    [f.project.projectId]
  );
});

test("empty legacy records are hidden without deleting indexes, files or explicit empty projects", async (t) => {
  const f = await fixture(t);
  await f.directory.projectCatalog.ensureLegacy([f.oldDirectory, f.storage]);
  const before = await readFile(f.directory.projectCatalog.filePath, "utf8");
  const payload = await f.directory.globalTaskPayload();
  assert.deepEqual(
    payload.projects.map((project) => project.projectId),
    [f.project.projectId]
  );
  assert.equal(await readFile(f.directory.projectCatalog.filePath, "utf8"), before);
  const emptyDirectory = join(f.root, "explicit-empty");
  await mkdir(emptyDirectory);
  const empty = await f.directory.createProject({
    projectName: "用户创建的空项目",
    projectDirectory: emptyDirectory
  });
  assert.ok(
    (await f.directory.globalTaskPayload()).projects.some((project) => project.projectId === empty.projectId)
  );
});

test("a legacy project with a real document remains discoverable after its conversation disappears", async (t) => {
  const f = await fixture(t);
  await f.directory.projectCatalog.ensureLegacy([f.oldDirectory]);
  const service = new ApplicationService(f.oldDirectory, undefined, f.storage);
  const created = await service.createResource({
    taskId: "workspace",
    kind: "text/plain",
    title: "仍需保留",
    initialContent: "有效用户文档",
    actor
  });
  // This is an upgrade fixture: legacy documents have neither a snapshot nor
  // an explicit null. New unassigned documents must not invent a directory project.
  const metadataPath = join(
    f.oldDirectory,
    "applications",
    "text-editor",
    "resources",
    created.resource.resourceId,
    "metadata.json"
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  delete metadata.project;
  await writeFile(metadataPath, JSON.stringify(metadata));
  const project = (await f.directory.globalTaskPayload()).projects.find(
    (project) => project.projectDirectory === f.oldDirectory
  );
  assert.equal(project?.hasApplications, true);
  assert.equal(
    await readFile(new ResourceFiles(f.oldDirectory).absolutePath(created.resource), "utf8"),
    "有效用户文档"
  );
});

test("explicitly adopting an old project preserves it when its history disappears", async (t) => {
  const f = await fixture(t);
  await f.store.createTask("old-chat", { goal: "旧会话", projectDirectory: f.oldDirectory });
  const old = (await f.directory.globalTaskPayload()).projects.find(
    (project) => project.projectDirectory === f.oldDirectory
  );
  await f.directory.updateProject(old.projectId, { projectName: "用户保留的项目" }, (_taskIds, commit) =>
    commit()
  );
  await rm(join(f.storage, "old-chat"), { recursive: true, force: true });
  assert.equal(
    (await f.directory.globalTaskPayload()).projects.find((project) => project.projectId === old.projectId)
      ?.projectName,
    "用户保留的项目"
  );
});

test("application labels follow the document home rather than another loaded conversation", () => {
  const projects = [
    { projectName: "源项目名称", projectDirectory: "/source" },
    { projectName: "当前项目", projectDirectory: "/current" }
  ];
  const tab = { workspaceRoot: "/source/", loadedConversations: [{ taskId: "current-chat" }] };
  assert.equal(applicationProjectLabel(tab, projects), "项目：源项目名称");
  assert.equal(applicationProjectLabel({ workspaceRoot: "/central-storage" }, projects), "无项目归属");
  assert.equal(applicationProjectLabel({}, [{}]), "无项目归属");
});

test("persisted references keep old document roots discoverable after a project folder change", async (t) => {
  const f = await fixture(t);
  const service = await applicationServiceForTask(f.storage, "chat");
  const created = await service.createResource({
    taskId: "chat",
    kind: "text/plain",
    title: "保留原目录",
    initialContent: "原内容",
    actor
  });
  await service.loadInstance("chat", created.appInstance.appInstanceId);
  await f.directory.updateProject(
    f.project.projectId,
    { projectName: "改名后的项目", projectDirectory: f.oldDirectory },
    (_ids, commit) => commit()
  );
  assert.deepEqual(await f.directory.knownWorkspaceRoots(), [f.storage]);
  assert.ok((await f.directory.applicationWorkspaceRoots()).includes(f.projectDirectory));
  assert.ok((await f.directory.applicationWorkspaceRoots()).includes(f.oldDirectory));
  assert.equal(await taskApplicationWorkspace(f.storage, "chat"), f.projectDirectory);
  assert.equal(
    await readFile(new ResourceFiles(f.projectDirectory).absolutePath(created.resource), "utf8"),
    "原内容"
  );
  const owner = (await f.directory.globalTaskPayload()).projects.find(
    (project) => project.projectId === f.project.projectId
  );
  assert.equal(
    applicationProjectLabel({ projectId: created.resource.projectId, workspaceRoot: f.projectDirectory }, [
      owner
    ]),
    "项目：改名后的项目"
  );
  const another = await service.createResource({
    taskId: "chat",
    kind: "text/plain",
    title: "同源文档",
    actor
  });
  assert.equal(another.resource.projectId, f.project.projectId);
  await service.loadInstance("chat", undefined);
  assert.ok((await f.directory.applicationWorkspaceRoots()).includes(f.projectDirectory));
  const restarted = createWorkspaceDirectory(f.storage, join(f.root, "global.json"), () => "fixture");
  assert.ok((await restarted.applicationWorkspaceRoots()).includes(f.projectDirectory));
  const next = await (
    await applicationServiceForTask(f.storage, "chat")
  ).createResource({ taskId: "chat", kind: "text/plain", title: "新目录文档", actor });
  assert.equal(next.resource.projectId, f.project.projectId);
  assert.equal(
    (await service.mapping.list("chat")).find((ref) => ref.resourceId === next.resource.resourceId)
      .workspaceRoot,
    f.oldDirectory
  );
});

test("stable project ownership takes precedence when another project reuses the old folder", () => {
  const projects = [
    { projectId: "owner", projectName: "原项目已改名", projectDirectory: "/new-home" },
    { projectId: "other", projectName: "后来创建的项目", projectDirectory: "/old-home" }
  ];
  const tab = { projectId: "owner", workspaceRoot: "/old-home" };
  assert.equal(applicationProjectLabel(tab, projects), "项目：原项目已改名");
  assert.equal(applicationProjectLabel(tab, projects.slice(1)), "无项目归属");
});

test("explicit creation adopts a hidden legacy record once without changing its identity", async (t) => {
  const f = await fixture(t);
  await f.directory.projectCatalog.ensureLegacy([f.oldDirectory]);
  const adopted = await f.directory.createProject({
    projectName: "明确建立的项目",
    projectDirectory: f.oldDirectory
  });
  assert.equal(adopted.projectId, f.oldDirectory);
  assert.equal(adopted.legacy, false);
  await assert.rejects(
    f.directory.createProject({ projectName: "重复项目", projectDirectory: f.oldDirectory }),
    { status: 409 }
  );
  assert.equal(
    (await f.directory.projectCatalog.list()).filter((project) => project.projectDirectory === f.oldDirectory)
      .length,
    1
  );
});
