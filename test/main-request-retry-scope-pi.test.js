import "./application-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
const { MainRequestStore, mainRequestPath } = await import("../dist/src/storage/main-request-store.js");
const modelRequestRetryPath = mainRequestPath;
const readModelRequestRetry = (path) => new MainRequestStore(path, "scope-task").read();
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { ResourceMappingStore } = await import("../dist/src/applications/mapping-store.js");

async function fixture(t, handle, api = "openai-completions", { separateResourceRoot = false } = {}) {
  const received = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") return response.end(JSON.stringify({ data: [{ id: "scope-fixture" }] }));
    const raw = await readFixtureRequestBody(request);
    received.push({ raw, body: JSON.parse(raw) });
    if (received.length === 2) {
      response.writeHead(400, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "isolated failed document request" } }));
    }
    const reply = await handle(received);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream(api, reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const dashboard = await startDashboard({
    modelEndpoint: `http://127.0.0.1:${server.address().port}`,
    model: "scope-fixture"
  });
  await writeFile(join(dashboard.root, "config.json"), JSON.stringify({ api }));
  await mkdir(join(dashboard.root, "pi"), { recursive: true });
  await writeFile(
    join(dashboard.root, "pi", "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } })
  );
  t.after(async () => {
    await dashboard.stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const call = async (path, body, expected = 200, method = "POST") => {
    const response = await fetch(
      `${dashboard.base}${path}`,
      body === undefined
        ? {}
        : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  let sourceRoot = dashboard.workspaceRoot;
  let projectId = dashboard.projectId;
  if (separateResourceRoot) {
    sourceRoot = join(dashboard.root, "source-root");
    await mkdir(sourceRoot);
    const opened = await call("/api/projects", { projectName: "source", projectDirectory: sourceRoot }, 201);
    projectId = opened.project.projectId;
  }
  await call("/api/tasks", { taskId: "scope-task", goal: "Rewrite the original document", projectId }, 201);
  const resource = async (root, content) => {
    const { appInstance } = await call(
      "/api/workbench/open-application",
      { appType: "text-editor", workspaceRoot: root },
      201
    );
    return (
      await call(
        `/api/workbench/instances/${appInstance.appInstanceId}/resources`,
        { kind: "text/plain", title: "same-title.txt", initialContent: content },
        201
      )
    ).resource;
  };
  const bind = (resourceId) => call("/api/workbench/bind-resource", { taskId: "scope-task", resourceId });
  const settle = async (status) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const detail = await call("/api/tasks/scope-task");
      if (!detail.runtime.active) {
        assert.equal(detail.task.status, status, JSON.stringify(detail.task));
        return detail;
      }
      await delay(50);
    }
    assert.fail("Main process did not settle");
  };
  const launch = async () => {
    await call(
      "/api/tasks/scope-task/run",
      { prompt: "Read this document and rewrite it. Keep the other documents intact." },
      202
    );
    const failed = await settle("failed");
    assert.equal(received.length, 2);
    assert.ok(received[1].raw.includes("A_ORIGINAL"));
    return failed;
  };
  return {
    dashboard,
    sourceRoot,
    received,
    call,
    resource,
    bind,
    settle,
    launch,
    snapshotPath: modelRequestRetryPath(dashboard.workspaceRoot, "scope-task")
  };
}

function reply(received) {
  return received.length === 1
    ? { name: "read_document", arguments: {} }
    : received.length === 3
      ? { name: "write_document", arguments: { content: "A_AFTER_RETRY" } }
      : { text: "Done" };
}

async function replaceSourceReference(f, a) {
  const other = join(f.dashboard.root, "other-root");
  await mkdir(other);
  await cp(join(f.sourceRoot, "applications"), join(other, "applications"), { recursive: true });
  const service = new ApplicationService(other, undefined, f.dashboard.workspaceRoot);
  await service.resources.applyOperation({
    taskId: "scope-task",
    resourceId: a.resourceId,
    appType: a.appType,
    operationId: "isolated-other-root",
    operationType: "text.replace",
    baseRevision: a.revision,
    payload: { from: 0, to: "A_ORIGINAL".length, text: "B_ORIGINAL" },
    actor: { type: "user", id: "fixture" }
  });
  const mapping = new ResourceMappingStore(f.dashboard.workspaceRoot, other);
  await mapping.remove("scope-task", a.resourceId);
  await mapping.add("scope-task", { resourceId: a.resourceId, appType: a.appType });
  await service.bindResource("scope-task", a.resourceId);
  return service;
}

for (const api of ["openai-completions", "openai-responses"]) {
  test(
    `${api}: changed bound identity rejects before HTTP and restored original target retries exactly`,
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, reply, api);
      const a = await f.resource(f.dashboard.workspaceRoot, "A_ORIGINAL");
      const b = await f.resource(f.dashboard.workspaceRoot, "B_ORIGINAL");
      await f.bind(a.resourceId);
      const failed = await f.launch();
      const archived = await readFile(f.snapshotPath, "utf8");
      const scope = JSON.parse(archived).executionScope;
      assert.equal(scope.application.resourceId, a.resourceId);
      assert.ok(scope.application.appInstanceId);
      assert.ok(scope.application.adapterTools.includes("write_document"));
      await f.bind(b.resourceId);
      const rejection = await f.call(
        "/api/tasks/scope-task/run",
        { resume: true, retryRequestId: failed.retryRequest.requestId },
        409
      );
      assert.match(JSON.stringify(rejection), /归属已改变|应用绑定已变化/);
      assert.equal(f.received.length, 2);
      assert.equal(await readFile(f.snapshotPath, "utf8"), archived);
      const unchanged = await f.settle("failed");
      assert.deepEqual(unchanged.messages, failed.messages);
      assert.equal(unchanged.task.activeRunId, failed.task.activeRunId);
      await f.bind(a.resourceId);
      await f.call(
        "/api/tasks/scope-task/run",
        { resume: true, retryRequestId: failed.retryRequest.requestId },
        202
      );
      const completed = await f.settle("completed");
      assert.equal(f.received[2].raw, f.received[1].raw);
      assert.equal(
        (await f.call(`/api/tasks/scope-task/resources/${a.resourceId}`)).snapshot.content,
        "A_AFTER_RETRY"
      );
      assert.equal(
        (await f.call(`/api/tasks/scope-task/resources/${b.resourceId}`)).snapshot.content,
        "B_ORIGINAL"
      );
      assert.equal(completed.messages.filter((entry) => entry.role === "user").length, 1);
      assert.equal(
        completed.runtimeEvents.filter(
          (event) => event.payload.type === "tool_execution_end" && event.payload.toolName === "read_document"
        ).length,
        1,
        "the completed read is not rerun by retry"
      );
    }
  );
}

test(
  "same resource/instance IDs in another source root cannot receive an archived request",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, reply, "openai-completions", { separateResourceRoot: true });
    const source = f.sourceRoot;
    const a = await f.resource(source, "A_ORIGINAL");
    await f.bind(a.resourceId);
    const failed = await f.launch();
    const archived = await readFile(f.snapshotPath, "utf8");
    const scope = JSON.parse(archived).executionScope;
    assert.equal(scope.taskStorageRoot, await realpath(f.dashboard.workspaceRoot));
    assert.equal(scope.application.resourceWorkspaceRoot, await realpath(source));
    assert.notEqual(scope.taskStorageRoot, scope.application.resourceWorkspaceRoot);
    const service = await replaceSourceReference(f, a);
    const rejection = await f.call(
      "/api/tasks/scope-task/run",
      { resume: true, retryRequestId: failed.retryRequest.requestId },
      409
    );
    assert.match(JSON.stringify(rejection), /归属已改变|应用绑定已变化/);
    assert.equal(f.received.length, 2);
    assert.equal(await readFile(f.snapshotPath, "utf8"), archived);
    const mcpRejected = await f.call(
      "/api/workbench/mcp/call",
      {
        taskId: "scope-task",
        resourceId: a.resourceId,
        name: "replace_section",
        params: {},
        executionTarget: scope.application
      },
      409
    );
    assert.equal(mcpRejected.error.code, "execution_scope_changed");
    await f.call(
      "/api/workbench/mcp/call",
      {
        taskId: "scope-task",
        resourceId: a.resourceId,
        name: "replace_section",
        executionTarget: { resourceId: a.resourceId }
      },
      400
    );
    assert.equal((await service.readResourceById(a.resourceId)).snapshot.content, "B_ORIGINAL");
    assert.equal(
      (await new ApplicationService(source).readResourceById(a.resourceId)).snapshot.content,
      "A_ORIGINAL"
    );
  }
);

test(
  "changed project directory and legacy unscoped archives reject without changing history or original bytes",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t, reply);
    const a = await f.resource(f.dashboard.workspaceRoot, "A_ORIGINAL");
    await f.bind(a.resourceId);
    const failed = await f.launch();
    const archived = await readFile(f.snapshotPath, "utf8");
    const other = join(f.dashboard.root, "same-basename", "workspace");
    await mkdir(other, { recursive: true });
    await f.call(`/api/projects/${f.dashboard.project.projectId}`, { projectDirectory: other }, 200, "PATCH");
    await f.call(
      "/api/tasks/scope-task/run",
      { resume: true, retryRequestId: failed.retryRequest.requestId },
      409
    );
    assert.equal(f.received.length, 2);
    assert.equal(await readFile(f.snapshotPath, "utf8"), archived);
    await f.call(
      `/api/projects/${f.dashboard.project.projectId}`,
      { projectDirectory: f.dashboard.workspaceRoot },
      200,
      "PATCH"
    );
    const legacy = JSON.parse(archived);
    delete legacy.executionScope;
    legacy.checksum = createHash("sha256")
      .update(
        JSON.stringify(Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "checksum")))
      )
      .digest("hex");
    const legacyBytes = JSON.stringify(legacy);
    await writeFile(f.snapshotPath, legacyBytes);
    assert.ok(
      await readModelRequestRetry(f.snapshotPath),
      "legacy metadata remains readable for recovery/audit"
    );
    const detail = await f.call("/api/tasks/scope-task");
    assert.equal(detail.retryRequest, undefined);
    assert.equal(detail.retryRequestUnavailable, true);
    const rejection = await f.call(
      "/api/tasks/scope-task/run",
      { resume: true, retryRequestId: failed.retryRequest.requestId },
      400
    );
    assert.match(JSON.stringify(rejection), /缺少执行归属/);
    assert.equal(await readFile(f.snapshotPath, "utf8"), legacyBytes);
    assert.equal(f.received.length, 2);
    assert.deepEqual((await f.settle("failed")).messages, failed.messages);
  }
);

test(
  "rebind after replay HTTP preserves its target, then the next model turn discovers the new binding",
  { timeout: 60_000 },
  async (t) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const f = await fixture(t, async (received) => {
      if (received.length === 3) await gate;
      return received.length === 4
        ? { name: "read_document", arguments: {} }
        : received.length === 5
          ? { name: "write_document", arguments: { content: "B_AFTER_NEW_TURN" } }
          : reply(received);
    });
    const a = await f.resource(f.dashboard.workspaceRoot, "A_ORIGINAL");
    const b = await f.resource(f.dashboard.workspaceRoot, "B_ORIGINAL");
    await f.bind(a.resourceId);
    const failed = await f.launch();
    await f.call(
      "/api/tasks/scope-task/run",
      { resume: true, retryRequestId: failed.retryRequest.requestId },
      202
    );
    for (let attempt = 0; f.received.length < 3 && attempt < 600; attempt++) await delay(50);
    assert.equal(f.received.length, 3);
    await f.bind(b.resourceId);
    release();
    const completed = await f.settle("completed");
    assert.equal(f.received[2].raw, f.received[1].raw);
    assert.ok(f.received[4].raw.includes("B_ORIGINAL"));
    assert.equal(
      (await f.call(`/api/tasks/scope-task/resources/${a.resourceId}`)).snapshot.content,
      "A_AFTER_RETRY"
    );
    assert.equal(
      (await f.call(`/api/tasks/scope-task/resources/${b.resourceId}`)).snapshot.content,
      "B_AFTER_NEW_TURN"
    );
    assert.equal(
      completed.runtimeEvents.filter(
        (event) => event.payload.type === "tool_execution_end" && event.payload.isError
      ).length,
      0
    );
  }
);

test(
  "source ownership remains enforced while the replay response executes its tools",
  { timeout: 60_000 },
  async (t) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      t,
      async (received) => {
        if (received.length === 3) await gate;
        return reply(received);
      },
      "openai-completions",
      { separateResourceRoot: true }
    );
    const a = await f.resource(f.sourceRoot, "A_ORIGINAL");
    await f.bind(a.resourceId);
    const failed = await f.launch();
    await f.call(
      "/api/tasks/scope-task/run",
      { resume: true, retryRequestId: failed.retryRequest.requestId },
      202
    );
    for (let attempt = 0; f.received.length < 3 && attempt < 600; attempt++) await delay(50);
    assert.equal(f.received.length, 3);
    const other = await replaceSourceReference(f, a);
    release();
    const completed = await f.settle("completed");
    assert.equal(f.received[2].raw, f.received[1].raw);
    const write = completed.runtimeEvents.find(
      (event) => event.payload.type === "tool_execution_end" && event.payload.toolName === "write_document"
    );
    assert.equal(write.payload.isError, true);
    assert.match(JSON.stringify(write), /execution_scope_changed/);
    assert.equal((await other.readResourceById(a.resourceId)).snapshot.content, "B_ORIGINAL");
    assert.equal(
      (await new ApplicationService(f.sourceRoot).readResourceById(a.resourceId)).snapshot.content,
      "A_ORIGINAL"
    );
  }
);
