import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

async function fixture(t) {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const directories = ["project-a", "project-b", "project-c"].map((name) => join(dashboard.root, name));
  await Promise.all(directories.map((directory) => mkdir(directory)));
  const request = async (path, body, method = "POST") => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async (name, directory) => {
    const response = await request("/api/projects", { projectName: name, projectDirectory: directory });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.project;
  };
  return {
    ...dashboard,
    directories,
    request,
    create,
    store: new LocalWorkspaceStore(dashboard.workspaceRoot)
  };
}

test("project API persists empty projects and conversation membership across restart without using project folders for logs", async (t) => {
  const f = await fixture(t);
  const [a, b, c] = f.directories;
  const first = await f.create("Named first", a),
    second = await f.create("Named empty", b);
  const initial = await f.request("/api/tasks", undefined, "GET");
  assert.equal(initial.body.projects.length, 2);
  assert.deepEqual(initial.body.projects.find((project) => project.projectId === second.projectId).tasks, []);
  for (const taskId of ["first", "followup"]) {
    const created = await f.request("/api/tasks", {
      taskId,
      goal: "Inherit the selected project",
      projectId: first.projectId
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.workspaceRoot, a);
    assert.equal(created.body.projectDirectory, a);
    assert.equal(created.body.storageRoot, f.workspaceRoot);
  }
  const memory = join(f.workspaceRoot, "first", "agents", "main", "context", "memory.md");
  await writeFile(memory, "Retained conversation history\n");
  const renamed = await f.request(
    `/api/projects/${encodeURIComponent(first.projectId)}`,
    { projectName: "Renamed", projectDirectory: c },
    "PATCH"
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.project.projectId, first.projectId);
  assert.equal(renamed.body.project.tasks.length, 2);
  for (const taskId of ["first", "followup"]) {
    const detail = await f.request(`/api/tasks/${taskId}`, undefined, "GET");
    assert.equal(detail.body.projectId, first.projectId);
    assert.equal(detail.body.projectName, "Renamed");
    assert.equal(detail.body.projectDirectory, c);
    assert.equal(detail.body.storageRoot, f.workspaceRoot);
    assert.equal(detail.body.task.projectDirectory, c);
  }
  await f.restart();
  const reopened = await f.request("/api/tasks", undefined, "GET");
  assert.equal(
    reopened.body.projects.find((project) => project.projectId === first.projectId).projectDirectory,
    c
  );
  assert.deepEqual(
    reopened.body.projects.find((project) => project.projectId === second.projectId).tasks,
    []
  );
  assert.equal(await readFile(memory, "utf8"), "Retained conversation history\n");
  assert.deepEqual(
    (await f.request("/api/workbench/workspaces", undefined, "GET")).body.workspaces.sort(),
    [f.workspaceRoot, b, c].sort()
  );
  const storageCatalog = JSON.parse(await readFile(join(f.root, "global.json"), "utf8"));
  assert.deepEqual(
    storageCatalog.workspaces.map((entry) => entry.workspaceRoot),
    [f.workspaceRoot]
  );
});

test("project API rejects conflicting paths, invalid membership and per-conversation folder edits without mutation", async (t) => {
  const f = await fixture(t);
  const [a, b] = f.directories;
  const first = await f.create("First", a),
    second = await f.create("Second", b);
  assert.equal(
    (await f.request("/api/projects", { projectName: "Duplicate", projectDirectory: a })).status,
    409
  );
  for (const body of [
    { projectName: "", projectDirectory: b },
    { projectName: "Invalid", projectDirectory: "relative" },
    { projectName: "Missing", projectDirectory: join(f.root, "missing") }
  ])
    assert.equal((await f.request("/api/projects", body)).status, 400);
  assert.equal(
    (
      await f.request(
        `/api/projects/${encodeURIComponent(first.projectId)}`,
        { projectDirectory: b },
        "PATCH"
      )
    ).status,
    409
  );
  assert.equal(
    (await f.request("/api/tasks", { taskId: "one", goal: "One", projectId: first.projectId })).status,
    201
  );
  assert.equal(
    (await f.request("/api/tasks", { taskId: "one", goal: "Conflicting", projectId: second.projectId }))
      .status,
    409
  );
  assert.equal(
    (await f.request("/api/tasks", { goal: "Unknown", projectId: "project_missing" })).status,
    404
  );
  assert.equal(
    (await f.request("/api/tasks", { goal: "Override", projectId: first.projectId, projectDirectory: b }))
      .status,
    400
  );
  const before = await readFile(join(f.workspaceRoot, "one", "task.json"), "utf8");
  assert.equal((await f.request("/api/workspace/choose", { taskId: "one", workspaceRoot: b })).status, 410);
  assert.equal(await readFile(join(f.workspaceRoot, "one", "task.json"), "utf8"), before);
});

test("project folder edits reject running, parked and detached-command tasks while permitting an active project's rename", async (t) => {
  const f = await fixture(t);
  const [a, b] = f.directories;
  const project = await f.create("Guarded", a);
  await f.request("/api/tasks", { taskId: "one", goal: "One", projectId: project.projectId });
  await f.request("/api/tasks", { taskId: "two", goal: "Two", projectId: project.projectId });
  await f.store.transitionTask("two", "running", { runId: "active" });
  const endpoint = `/api/projects/${encodeURIComponent(project.projectId)}`;
  assert.equal((await f.request(endpoint, { projectDirectory: b }, "PATCH")).status, 409);
  assert.equal((await f.store.readTask("one")).projectDirectory, a);
  assert.equal((await f.request(endpoint, { projectName: "Renamed while active" }, "PATCH")).status, 200);
  await f.store.transitionTask("two", "cancelled");
  const sleep = join(f.workspaceRoot, "one", "agents", "main", "sleep.json");
  await writeFile(
    sleep,
    JSON.stringify({
      runId: "parked",
      parkedAt: new Date().toISOString(),
      wakeAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "Wait for a retry"
    })
  );
  assert.equal((await f.request(endpoint, { projectDirectory: b }, "PATCH")).status, 409);
  await rm(sleep);
  await f.store.ensureRunDirectory("one", "background");
  const jobs = join(f.workspaceRoot, "one", "runs", "background", "agents", "main", "jobs");
  await mkdir(jobs, { recursive: true });
  const record = join(jobs, "job.json");
  await writeFile(
    record,
    JSON.stringify({
      jobId: "job",
      command: "fixture alive PID",
      cwd: a,
      logPath: join(jobs, "job.log"),
      pid: process.pid,
      startedAt: new Date().toISOString()
    })
  );
  await writeFile(join(jobs, "job.log"), "fixture\n");
  assert.equal((await f.request(endpoint, { projectDirectory: b }, "PATCH")).status, 409);
  await rm(record);
  const changed = await f.request(endpoint, { projectDirectory: b }, "PATCH");
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  for (const taskId of ["one", "two"]) assert.equal((await f.store.readTask(taskId)).projectDirectory, b);
});
