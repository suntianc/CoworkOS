import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startProjectDataDashboard } from "./p3-storage-fixture.mjs";
import { backendPaths, readBackendInstance } from "../dist/src/dashboard/backend-instance.js";
import { createProjectLedgerTool } from "../dist/src/runtime/project-ledger-tool.js";

/**
 * The board keeps serving its HTTP surface and the Main tool that reads it.
 *
 * Observation replaced the board dialog, so this keeps the backend contract it
 * read: an external publish is a board entry, an internal ledger need is not,
 * a user claim is recorded as such, and the Main tool claims through its own
 * Task binding.
 */
test("the production board publishes, claims and lists through the real HTTP backend", async (t) => {
  const dashboard = await startProjectDataDashboard(t, "sqlite");
  const directory = join(dashboard.root, "board-project");
  await mkdir(directory, { recursive: true });
  const created = await dashboard.request("/api/projects", {
    projectName: "看板项目",
    projectDirectory: directory
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const projectId = created.body.project.projectId;
  const external = await dashboard.request(`/api/projects/${encodeURIComponent(projectId)}/board`, {
    action: "publish",
    requestId: "publish-production",
    title: "生产看板需求",
    content: "通过真实 HTTP 发布。",
    source: { kind: "external", reference: "控制入口" }
  });
  assert.equal(external.status, 201, JSON.stringify(external.body));
  const internal = await dashboard.request(`/api/projects/${encodeURIComponent(projectId)}/ledger`, {
    action: "create",
    title: "内部需求",
    content: "内部需求只进台账。",
    source: { kind: "internal" }
  });
  assert.equal(internal.status, 201, JSON.stringify(internal.body));

  const listed = await dashboard.request(
    `/api/projects/${encodeURIComponent(projectId)}/board`,
    undefined,
    "GET"
  );
  assert.equal(listed.body.entries.length, 1, "the internal need stayed out of the board");
  assert.equal(listed.body.entries[0].title, "生产看板需求");
  assert.equal(listed.body.entries[0].assignment, undefined, "an unclaimed need names no owner");

  const claimed = await dashboard.request(`/api/projects/${encodeURIComponent(projectId)}/board`, {
    action: "claim",
    boardId: external.body.entry.boardId,
    expectedRevision: 1,
    requestId: "claim-production"
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.entry.state, "claimed");
  assert.equal(claimed.body.entry.assignment.kind, "user");
  const after = await dashboard.request(
    `/api/projects/${encodeURIComponent(projectId)}/board`,
    undefined,
    "GET"
  );
  const persisted = after.body.entries.find((item) => item.title === "生产看板需求");
  assert.equal(persisted.state, "claimed");

  // The Main tool reads the same board and claims through its Task binding.
  const instance = await readBackendInstance(backendPaths(join(dashboard.root, "home")));
  assert.ok(instance.value?.token);
  const task = await dashboard.request("/api/tasks", {
    taskId: "task-board-main",
    goal: "处理看板需求",
    projectId
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const second = await dashboard.request(`/api/projects/${encodeURIComponent(projectId)}/board`, {
    action: "publish",
    requestId: "publish-main",
    title: "Main 认领的需求",
    content: "由当前会话的处理 Main 认领。",
    source: { kind: "external", reference: "控制入口" }
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const tool = createProjectLedgerTool({
    dashboardUrl: dashboard.base,
    taskId: "task-board-main",
    token: instance.value.token
  });
  const board = await tool.execute({ action: "board" });
  assert.equal(board.entries.length, 2);
  const mainClaim = await tool.execute({
    action: "claim_board",
    boardId: second.body.entry.boardId,
    expectedRevision: 1
  });
  assert.equal(mainClaim.entry.state, "claimed");
  assert.equal(mainClaim.entry.assignment.kind, "main");
  assert.deepEqual(mainClaim.entry.assignment.handler, {
    backendId: instance.value.backendId,
    projectId,
    taskId: "task-board-main"
  });
});
