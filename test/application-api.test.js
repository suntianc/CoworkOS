import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

async function dashboard(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-application-api-"));
  const workspaceRoot = join(root, "workspace");
  const store = new LocalWorkspaceStore(workspaceRoot);
  await store.createTask("task", { goal: "application API regression" });
  const config = join(root, "config.json");
  await writeFile(config, "{}");
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/cli/dashboard.js"], {
    cwd: resolve("."),
    stdio: "ignore",
    env: {
      ...process.env,
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      // Named so a test can write a legacy strip and watch it migrate.
      COWORK_TABS_INDEX: join(root, "tabs.json"),
      COWORK_CONFIG: config,
      COWORK_UI_PORT: String(port),
      COWORK_API_BASE: "",
      COWORK_API_KEY: ""
    }
  });
  t.after(async () => {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/tasks`)).ok) break;
    } catch {
      /* wait for listener */
    }
    if (child.exitCode !== null) throw new Error("dashboard exited before listening");
    await delay(20);
  }
  return { base, workspaceRoot, store, stripPath: join(root, "tabs.json") };
}

async function json(base, path, options) {
  const response = await fetch(`${base}${path}`, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function post(body) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

test(
  "the full resource lifecycle works over HTTP with revision CAS and a typed error shape",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);

    const applications = await json(base, "/api/applications");
    assert.equal(applications.status, 200);
    const editor = applications.body.applications.find((entry) => entry.appType === "text-editor");
    assert.deepEqual(editor.resourceKinds, ["text/plain", "text/markdown"]);
    assert.ok(editor.capabilities.includes("agent-commands"));

    const created = await json(
      base,
      "/api/tasks/task/resources",
      post({
        appType: "text-editor",
        kind: "text/markdown",
        title: "proposal.md",
        initialContent: "# 方案\n目标用户\n"
      })
    );
    assert.equal(created.status, 201);
    const resourceId = created.body.resource.resourceId;
    assert.equal(created.body.resource.revision, 0);
    assert.equal(created.body.snapshot.content, "# 方案\n目标用户\n");
    assert.ok(created.body.appInstance.appInstanceId.startsWith("app_"));

    const applied = await json(
      base,
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "op-1",
        appType: "text-editor",
        operationType: "text.replace",
        baseRevision: 0,
        payload: { from: 5, to: 9, text: "产品经理" }
      })
    );
    assert.equal(applied.status, 200);
    assert.equal(applied.body.resource.revision, 1);
    assert.equal(applied.body.snapshot.content, "# 方案\n产品经理\n");

    // A stale baseline gets 409 carrying the current revision, never a silent overwrite.
    const stale = await json(
      base,
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "op-2",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "旧版本" }
      })
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "revision_conflict");
    assert.equal(stale.body.error.retryable, true);
    assert.equal(stale.body.error.details.currentRevision, 1);

    const selection = await json(base, `/api/tasks/task/resources/${resourceId}/selection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "text.range/v1", data: { anchor: 5, head: 9 }, summary: "ignored" })
    });
    assert.equal(selection.status, 200);
    assert.match(selection.body.selection.summary, /产品经理/);

    // Binding is explicit: creating the resource opened a tab, nothing more.
    assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);
    await json(base, `/api/tasks/task/app-instances/${created.body.appInstance.appInstanceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true, status: "open" })
    });
    const context = await json(base, "/api/tasks/task/active-app-context");
    assert.equal(context.body.context.resource.resourceId, resourceId);
    assert.match(context.body.rendered, /<active_application/);
    assert.equal(
      context.body.rendered.includes("# 方案\n产品经理"),
      false,
      "full content must not be injected"
    );

    const undone = await json(base, `/api/tasks/task/resources/${resourceId}/undo`, post({}));
    assert.equal(undone.status, 200);
    assert.equal(undone.body.snapshot.content, "# 方案\n目标用户\n");
    assert.equal(undone.body.resource.revision, 2, "undo appends a revision rather than rewriting history");

    // No publish step: the resource is already one of the Task's deliverables.
    const detail = await json(base, "/api/tasks/task");
    const deliverable = detail.body.applications.deliverables.find((row) => row.resourceId === resourceId);
    assert.ok(deliverable, "a resource appears in the outputs view without being published");
    assert.equal(deliverable.kind, "resource");
    assert.equal(deliverable.editable, true);
    assert.equal(detail.body.applications.resources.length, 1);
    assert.equal(detail.body.applications.instances.length, 1);
    // Task detail carries an index, never document text.
    assert.equal(JSON.stringify(detail.body.applications).includes("目标用户\n"), false);
  }
);

test("error codes and statuses match the documented contract", { timeout: 30000 }, async (t) => {
  const { base, workspaceRoot } = await dashboard(t);
  const created = await json(
    base,
    "/api/tasks/task/resources",
    post({ kind: "text/markdown", title: "a.md", initialContent: "x" })
  );
  const resourceId = created.body.resource.resourceId;

  const cases = [
    ["/api/tasks/task/resources/res_missing", undefined, 404, "resource_not_found"],
    [
      "/api/tasks/task/resources",
      post({ appType: "text-editor", kind: "model/cad+json", title: "x" }),
      422,
      "unsupported_resource_kind"
    ],
    [
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "op",
        appType: "text-editor",
        operationType: "text.rotate",
        baseRevision: 0,
        payload: {}
      }),
      422,
      "invalid_operation"
    ],
    [
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "op",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 9,
        payload: { at: 0, text: "x" }
      }),
      409,
      "revision_conflict"
    ],
    [
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "op",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "字".repeat(300_000) }
      }),
      413,
      "resource_too_large"
    ],
    ["/api/tasks/task/resources/..%2F..%2Fetc", undefined, 400, "unsafe_path"],
    [
      "/api/tasks/task/app-instances/app_missing",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
      404,
      "instance_not_found"
    ]
  ];
  for (const [path, options, status, code] of cases) {
    const result = await json(base, path, options);
    assert.equal(result.status, status, `${path} should be ${status}, got ${result.status}`);
    assert.equal(result.body.error.code, code, `${path} should report ${code}`);
    assert.equal(typeof result.body.error.message, "string");
    assert.equal(typeof result.body.error.retryable, "boolean");
  }
});

test(
  "a retried operation is idempotent over HTTP and does not create a second revision",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);
    const created = await json(
      base,
      "/api/tasks/task/resources",
      post({ kind: "text/markdown", title: "a.md", initialContent: "" })
    );
    const resourceId = created.body.resource.resourceId;
    const body = post({
      operationId: "op-retry",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "只应出现一次" }
    });

    const first = await json(base, `/api/tasks/task/resources/${resourceId}/operations`, body);
    const retry = await json(
      base,
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "op-retry",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "只应出现一次" }
      })
    );
    assert.equal(first.body.resource.revision, 1);
    assert.equal(retry.body.resource.revision, 1);
    assert.equal(retry.body.deduplicated, true);
    assert.equal(retry.body.event.eventId, first.body.event.eventId);
    assert.equal(
      (await json(base, `/api/tasks/task/resources/${resourceId}`)).body.snapshot.content,
      "只应出现一次"
    );
  }
);

test("resource changes reach the client on the existing Task SSE stream", { timeout: 30000 }, async (t) => {
  const { base, store } = await dashboard(t);
  // The stream is bound to an active run, as it already is for conversation events.
  await store.createRun("task", "main-1");
  const created = await json(
    base,
    "/api/tasks/task/resources",
    post({ kind: "text/markdown", title: "live.md", initialContent: "a" })
  );
  const resourceId = created.body.resource.resourceId;

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/api/tasks/task/stream`, { signal: controller.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const collected = [];
  const readUntil = async (predicate, budgetMs = 8_000) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const chunk of buffer.split("\n\n")) {
        const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        try {
          collected.push(JSON.parse(line.slice(6)));
        } catch {
          /* partial frame */
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      if (collected.some(predicate)) return true;
    }
    return false;
  };

  await json(
    base,
    `/api/tasks/task/resources/${resourceId}/operations`,
    post({
      operationId: "op-live",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 1, text: "b" }
    })
  );
  const seen = await readUntil((event) => event.type === "resource.operation_applied");
  assert.equal(seen, true, "an applied operation must reach the stream");
  const event = collected.find((entry) => entry.type === "resource.operation_applied");
  assert.equal(event.payload.resourceId, resourceId);
  assert.equal(event.payload.revision, 1);
  assert.equal(event.payload.appType, "text-editor");
  // The envelope is generic: the core stream never interprets the operation.
  assert.equal(event.payload.summary.length > 0, true);
});

test(
  "task detail carries the application index, and everything the UI already relied on",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);

    const detail = await json(base, "/api/tasks/task");
    assert.equal(detail.status, 200);
    // An index, never content: this payload is polled every few seconds and must
    // not grow with a document.
    assert.ok("applications" in detail.body, "task detail carries the application index");
    assert.equal(
      JSON.stringify(detail.body.applications ?? {}).includes('"content"'),
      false,
      "the index must never carry resource content"
    );
    // Everything the UI already relies on is still present.
    for (const field of [
      "task",
      "coordination",
      "events",
      "artifacts",
      "messages",
      "statistics",
      "humanRequests",
      "runtime"
    ]) {
      assert.ok(field in detail.body, `${field} must still be returned`);
    }
  }
);

test(
  "an artifact opens as a copy: the published file is never adopted or modified",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const artifacts = join(workspaceRoot, "task", "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "交付报告.md"), "# 交付报告\n这是已发布的版本。\n");

    const opened = await json(base, "/api/tasks/task/resources", post({ fromArtifact: "交付报告.md" }));
    assert.equal(opened.status, 201);
    assert.equal(opened.body.resource.title, "交付报告.md");
    assert.equal(
      opened.body.snapshot.content,
      "# 交付报告\n这是已发布的版本。\n",
      "content comes from the file, not the caller"
    );
    assert.ok(opened.body.appInstance.appInstanceId, "opening an artifact must open a tab");
    const resourceId = opened.body.resource.resourceId;
    // The copy has its own identity and starts at revision 0.
    assert.equal(opened.body.resource.revision, 0);
    assert.equal(opened.body.resource.publishedRevision, undefined);

    await json(
      base,
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "edit-copy",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "草稿改动\n" }
      })
    );
    // Editing the copy leaves the original artifact byte-identical: opening an
    // artifact for editing must not silently take over the published file.
    assert.equal(await readFile(join(artifacts, "交付报告.md"), "utf8"), "# 交付报告\n这是已发布的版本。\n");
  }
);

test("opening an artifact refuses traversal, binaries and oversized files", { timeout: 30000 }, async (t) => {
  const { base, workspaceRoot } = await dashboard(t);
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const artifacts = join(workspaceRoot, "task", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(workspaceRoot, "outside.md"), "# 工作空间之外\n");
  await symlink(join(workspaceRoot, "outside.md"), join(artifacts, "escape.md"));
  // A .md extension is not proof of text: publishing a mangled round trip
  // would destroy the user's bytes.
  await writeFile(join(artifacts, "binary.md"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]));
  await writeFile(join(artifacts, "huge.md"), "永".repeat(1_200_000));
  await writeFile(join(artifacts, "报告.pdf"), Buffer.from("%PDF-1.7\n"));

  // Traversal, symlinks and missing files are path-level refusals.
  for (const path of ["../../../etc/passwd", "escape.md", "missing.md"]) {
    const result = await json(base, "/api/tasks/task/resources", post({ fromArtifact: path }));
    assert.equal(
      result.status,
      400,
      `${path} must be refused, got ${result.status}: ${JSON.stringify(result.body)}`
    );
    assert.ok(result.body.error?.code, `${path} must report a code`);
  }
  // Content-level refusals carry their own codes and statuses.
  for (const [path, status, code] of [
    ["binary.md", 422, "unsupported_resource_kind"],
    ["报告.pdf", 422, "unsupported_resource_kind"],
    ["huge.md", 413, "resource_too_large"]
  ]) {
    const result = await json(base, "/api/tasks/task/resources", post({ fromArtifact: path }));
    assert.equal(
      result.status,
      status,
      `${path} should be ${status}, got ${result.status}: ${JSON.stringify(result.body)}`
    );
    assert.equal(result.body.error.code, code);
  }
  // Nothing was created by any refused attempt.
  assert.equal((await json(base, "/api/tasks/task/resources")).body.resources.length, 0);
});

test("renaming changes the tab and the file without touching any revision", { timeout: 30000 }, async (t) => {
  const { base, workspaceRoot } = await dashboard(t);
  const created = await json(
    base,
    "/api/tasks/task/resources",
    post({ kind: "text/markdown", title: "未命名.md", initialContent: "# 草稿\n" })
  );
  const resourceId = created.body.resource.resourceId;
  await json(
    base,
    `/api/tasks/task/resources/${resourceId}/operations`,
    post({
      operationId: "op-1",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "改动\n" }
    })
  );

  const renamed = await json(base, `/api/tasks/task/resources/${resourceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "产品方案.md" })
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.resource.title, "产品方案.md");
  // The title is not the identity, so renaming is not an edit.
  assert.equal(renamed.body.resource.revision, 1, "a rename must not create a revision");
  const history = (await json(base, `/api/tasks/task/resources/${resourceId}/operations?afterRevision=0`))
    .body;
  assert.equal(history.operations.length, 1, "a rename must not appear in the operation log");

  // Every tab showing it follows the new name.
  const summary = await json(base, "/api/tasks/task/app-instances");
  assert.equal(summary.body.instances[0].title, "产品方案.md");

  // The file on disk follows the new name, so both views agree what this is.
  const { readdir } = await import("node:fs/promises");
  assert.ok(
    (await readdir(join(workspaceRoot, "applications", "text-editor", "files"))).includes("产品方案.md")
  );

  const empty = await json(base, `/api/tasks/task/resources/${resourceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   " })
  });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, "invalid_operation");
});

test(
  "download returns a file to save without publishing it as a deliverable",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);
    const created = await json(
      base,
      "/api/tasks/task/resources",
      post({ kind: "text/markdown", title: "报告 中文.md", initialContent: "# 报告\n正文\n" })
    );
    const resourceId = created.body.resource.resourceId;

    const response = await fetch(`${base}/api/tasks/task/resources/${resourceId}/download?format=markdown`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/markdown/);
    // An attachment with a UTF-8 filename, so the browser's own save dialog runs.
    assert.match(response.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''/);
    assert.match(decodeURIComponent(response.headers.get("content-disposition")), /报告 中文\.md/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "# 报告\n正文\n");

    // Saving a copy is not publishing: artifacts/ stays empty and the resource
    // is not marked as published.
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(workspaceRoot, "task", "artifacts")).catch(() => []), []);
    assert.equal(
      (await json(base, `/api/tasks/task/resources/${resourceId}`)).body.resource.publishedRevision,
      undefined
    );
  }
);

test("a conversation is bound only when the user binds it", { timeout: 30000 }, async (t) => {
  const { base, workspaceRoot } = await dashboard(t);
  const first = await json(
    base,
    "/api/tasks/task/resources",
    post({ kind: "text/markdown", title: "a.md", initialContent: "a" })
  );
  const second = await json(
    base,
    "/api/tasks/task/resources",
    post({ kind: "text/markdown", title: "b.md", initialContent: "b" })
  );

  // Two applications are open and neither is bound: a new conversation must
  // not have an application attached to it by default.
  let summary = await json(base, "/api/tasks/task/app-instances");
  assert.equal(summary.body.instances.length, 2);
  assert.equal(summary.body.activeInstanceId, undefined);
  assert.equal(summary.body.unbound, true);
  assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);

  // Selecting one binds it.
  await json(base, `/api/tasks/task/app-instances/${second.body.appInstance.appInstanceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: true, status: "open" })
  });
  assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context.resource.title, "b.md");

  // Selecting the other one moves the binding.
  await json(base, `/api/tasks/task/app-instances/${first.body.appInstance.appInstanceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: true, status: "open" })
  });
  assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context.resource.title, "a.md");

  // Detaching is a real state: no context at all, even though tabs are open.
  const unbound = await json(base, "/api/tasks/task/app-instances/unbind", post({}));
  assert.equal(unbound.status, 200);
  assert.equal(unbound.body.unbound, true);
  assert.equal(unbound.body.activeInstanceId, undefined);
  assert.equal(unbound.body.instances.length, 2, "detaching does not close anything");
  assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);

  // Opening a third application does not re-bind on its own.
  await json(
    base,
    "/api/tasks/task/resources",
    post({ kind: "text/markdown", title: "c.md", initialContent: "c" })
  );
  assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);

  // Binding again restores it.
  await json(base, `/api/tasks/task/app-instances/${first.body.appInstance.appInstanceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: true, status: "open" })
  });
  summary = await json(base, "/api/tasks/task/app-instances");
  assert.equal(summary.body.unbound, false);
  assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context.resource.title, "a.md");
});

test(
  "explicit loading binds the conversation, and navigation cannot undo unloading",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);
    const created = await json(
      base,
      "/api/tasks/task/resources",
      post({ kind: "text/markdown", title: "a.md", initialContent: "a" })
    );
    const resourceId = created.body.resource.resourceId;

    // Creating the resource alone does not bind: the strip has not moved yet.
    assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);

    // Opening the tab is what binds it. This is the path the Agent takes after
    // create_resource, and without it the Agent gets a NULL context for the
    // document it just created and loses the application's own tools with it.
    //
    // The tab is keyed by the document and `bindTo` names the conversation: a
    // document tab belongs to no conversation, so the two are separate inputs
    // rather than one implied by the other.
    const opened = await json(
      base,
      "/api/workbench/tabs",
      post({ kind: "application", resourceId, bindTo: "task" })
    );
    assert.equal(opened.status, 200);
    assert.equal(opened.body.activeTabId, `window:${created.body.appInstance.appInstanceId}`);
    const bound = await json(base, "/api/tasks/task/active-app-context");
    assert.equal(bound.body.context.resource.title, "a.md");
    assert.match(bound.body.rendered, /<active_application/);

    // Detaching is still honoured: nothing re-binds behind the user's back, and
    // re-reading the strip does not undo the decision.
    await json(base, "/api/tasks/task/app-instances/unbind", post({}));
    assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);
    await json(base, "/api/workbench/tabs");
    assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);

    // A second document does not steal the binding until its tab is opened.
    const second = await json(
      base,
      "/api/tasks/task/resources",
      post({ kind: "text/markdown", title: "b.md", initialContent: "b" })
    );
    assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);
    await json(
      base,
      "/api/workbench/tabs",
      post({ kind: "application", resourceId: second.body.resource.resourceId, bindTo: "task" })
    );
    assert.equal(
      (await json(base, "/api/tasks/task/active-app-context")).body.context.resource.title,
      "b.md"
    );
  }
);

test(
  "an application opens with no document, and a document can be created into it",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);

    // Opening the application is not creating a file: the window comes first.
    const opened = await json(
      base,
      "/api/tasks/task/app-instances/open",
      post({ appType: "text-editor", workspaceRoot })
    );
    assert.equal(opened.status, 201);
    const appInstanceId = opened.body.appInstance.appInstanceId;
    assert.deepEqual(opened.body.appInstance.resourceIds, [], "an empty window holds no resource");
    assert.equal(
      (await json(base, "/api/tasks/task/resources")).body.resources.length,
      0,
      "nothing was written"
    );

    // Loading is explicit; only this loaded empty instance may be reused.
    await json(base, "/api/workbench/load-instance", post({ taskId: "task", appInstanceId }));
    const again = await json(
      base,
      "/api/tasks/task/app-instances/open",
      post({ appType: "text-editor", workspaceRoot })
    );
    assert.equal(again.body.appInstance.appInstanceId, appInstanceId);
    assert.equal((await json(base, "/api/tasks/task/app-instances")).body.instances.length, 1);

    // An empty window binds to nothing, so there is no context to inject.
    await json(base, `/api/tasks/task/app-instances/${appInstanceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true, status: "open" })
    });
    assert.equal((await json(base, "/api/tasks/task/active-app-context")).body.context, null);

    // Creating fills that same window instead of opening a second one.
    const created = await json(
      base,
      `/api/tasks/task/app-instances/${appInstanceId}/resources`,
      post({
        kind: "text/markdown",
        title: "方案.md",
        initialContent: "# 方案\n"
      })
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.appInstance.appInstanceId, appInstanceId, "the document appears in place");
    assert.deepEqual(created.body.appInstance.resourceIds, [created.body.resource.resourceId]);
    assert.equal(created.body.appInstance.title, "方案.md", "the tab takes the document's name");
    assert.equal((await json(base, "/api/tasks/task/app-instances")).body.instances.length, 1);

    const { readFile } = await import("node:fs/promises");
    assert.equal(
      await readFile(
        join(workspaceRoot, "applications", "text-editor", "files", created.body.resource.path),
        "utf8"
      ),
      "# 方案\n"
    );

    // Now that the window holds a document, the binding has something to inject.
    const context = await json(base, "/api/tasks/task/active-app-context");
    assert.equal(context.body.context.resource.title, "方案.md");

    const unknown = await json(base, "/api/tasks/task/app-instances/open", post({ appType: "nope" }));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "application_not_found");
  }
);

test(
  "a text file that is not UTF-8 is refused rather than imported as mojibake",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const artifacts = join(workspaceRoot, "task", "artifacts");
    await mkdir(artifacts, { recursive: true });
    // GBK-encoded Chinese: no NUL bytes, so the old check passed it and
    // toString("utf8") replaced every character with U+FFFD.
    await writeFile(
      join(artifacts, "性能报告.md"),
      Buffer.from([0xd0, 0xd4, 0xc4, 0xdc, 0xb1, 0xa8, 0xb8, 0xe6])
    );
    await writeFile(join(artifacts, "正常.md"), "# 正常的 UTF-8\n");

    const refused = await json(base, "/api/tasks/task/resources", post({ fromArtifact: "性能报告.md" }));
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, "unsupported_resource_kind");
    assert.match(refused.body.error.message, /UTF-8/);
    assert.equal(
      (await json(base, "/api/tasks/task/resources")).body.resources.length,
      0,
      "nothing was created"
    );

    // A real UTF-8 file still opens, including its Chinese content.
    const opened = await json(base, "/api/tasks/task/resources", post({ fromArtifact: "正常.md" }));
    assert.equal(opened.status, 201);
    assert.equal(opened.body.snapshot.content, "# 正常的 UTF-8\n");
  }
);

test(
  "an application opens with no conversation at all, and its document can be bound later",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);

    // Requiring a conversation first had it backwards: an editor is something a
    // person opens on its own, and deciding what it is for comes later.
    const opened = await json(
      base,
      "/api/workbench/open-application",
      post({ appType: "text-editor", workspaceRoot })
    );
    assert.equal(opened.status, 201);
    const standalone = opened.body.taskId;
    const appInstanceId = opened.body.appInstance.appInstanceId;
    assert.ok(standalone, "the document lands in a shared workspace");
    assert.ok(
      opened.body.tabs.some((tab) => tab.appInstanceId === appInstanceId),
      "and appears in the strip"
    );

    // That workspace is not a conversation and must not be offered as one.
    const tasks = await json(base, "/api/tasks");
    assert.equal(
      tasks.body.tasks.some((task) => task.taskId === standalone),
      false,
      "a workspace is not a conversation"
    );

    const created = await json(
      base,
      `/api/tasks/${standalone}/app-instances/${appInstanceId}/resources`,
      post({
        kind: "text/markdown",
        title: "随手记.md",
        initialContent: "# 随手记\n先写下来，再决定归属。\n"
      })
    );
    assert.equal(created.status, 201);
    const resourceId = created.body.resource.resourceId;
    await json(
      base,
      `/api/tasks/${standalone}/resources/${resourceId}/operations`,
      post({
        operationId: "op-1",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "补一句\n" }
      })
    );

    // Now bind it to a real conversation.
    const bound = await json(
      base,
      "/api/workbench/bind-resource",
      post({
        fromTaskId: standalone,
        fromAppInstanceId: appInstanceId,
        resourceId,
        taskId: "task"
      })
    );
    assert.equal(bound.status, 200);
    // The resource names no conversation: it is referenced, not owned.
    assert.equal(bound.body.resource.taskId, undefined);
    assert.equal(bound.body.appInstance.taskId, undefined);

    // One document, referenced from both places. It used to *move* here, which is
    // what made a document unreachable from anywhere but its latest owner.
    const owned = await json(base, "/api/tasks/task/resources");
    assert.deepEqual(
      owned.body.resources.map((entry) => entry.resourceId),
      [resourceId]
    );
    // The holding area hands it over rather than keeping a reference: leaving one
    // put the same file in the strip twice, which reads as two documents. This is
    // specific to the shared workspace — referencing from another *conversation*
    // is sharing, and leaves that conversation's reference alone.
    const stillThere = await json(base, `/api/tasks/${standalone}/resources`);
    assert.deepEqual(
      stillThere.body.resources.map((entry) => entry.resourceId),
      [resourceId],
      "editor access remains independent of conversations"
    );
    const { readFile } = await import("node:fs/promises");
    // And there is exactly one file, under the application rather than a Task.
    assert.match(
      await readFile(
        join(workspaceRoot, "applications", "text-editor", "files", bound.body.resource.path),
        "utf8"
      ),
      /^补一句/
    );

    // Its history travelled with it, so "what changed since I last looked" still
    // answers over the document's whole life.
    const read = await json(base, `/api/tasks/task/resources/${resourceId}?afterRevision=0`);
    assert.equal(read.body.resource.revision, 1);
    assert.equal(read.body.operations.length, 1);
    // Provenance, not ownership: that edit was made while the document was
    // unattached, and the record says so rather than being rewritten to match
    // whoever references it now.
    assert.equal(read.body.operations[0].taskId, standalone);

    // And it is now bindable as this conversation's active application.
    assert.equal(
      (await json(base, "/api/tasks/task/active-app-context")).body.context.resource.resourceId,
      resourceId
    );
    // One tab, and it now lists this conversation as a referencer. There is no
    // second tab to check for: the document had one before it was bound and has
    // the same one after, which is the whole point — binding is about which
    // conversation the next message is for, not about opening another view.
    const strip = (await json(base, "/api/workbench/tabs")).body.tabs;
    const documentTabs = strip.filter((tab) => tab.resourceId === resourceId);
    assert.equal(documentTabs.length, 1, "one document, one tab");
    assert.ok(documentTabs[0].conversations.some((entry) => entry.taskId === "task"));
  }
);

test("referencing a document the conversation already has is idempotent", { timeout: 30000 }, async (t) => {
  // This was refused when binding *moved* the resource: moving it to where it
  // already was had no meaning. A reference is a set membership, so asking
  // twice is the same as asking once — and two agents deciding to work on the
  // same document is the normal case, not a mistake to report.
  const { base, workspaceRoot } = await dashboard(t);
  const created = await json(
    base,
    "/api/tasks/task/resources",
    post({ kind: "text/markdown", title: "a.md", initialContent: "x" })
  );
  const again = await json(
    base,
    "/api/workbench/bind-resource",
    post({
      fromTaskId: "task",
      fromAppInstanceId: created.body.appInstance.appInstanceId,
      resourceId: created.body.resource.resourceId,
      taskId: "task"
    })
  );
  assert.equal(again.status, 200);
  assert.equal(again.body.resource.resourceId, created.body.resource.resourceId);
  // Still referenced exactly once, and still one window on it rather than two.
  const listed = await json(base, "/api/tasks/task/resources");
  assert.equal(listed.body.resources.length, 1);
  const summary = await json(base, "/api/tasks/task/app-instances");
  assert.equal(summary.body.instances.filter((entry) => entry.status !== "closed").length, 1);
});

test("loading an empty window retains its identity", { timeout: 30000 }, async (t) => {
  const { base, workspaceRoot } = await dashboard(t);
  // Binding an editor the user has not typed in yet is a reasonable thing to
  // want; there is simply nothing to move.
  const opened = await json(
    base,
    "/api/workbench/open-application",
    post({ appType: "text-editor", workspaceRoot })
  );
  const appInstanceId = opened.body.appInstance.appInstanceId;
  const bound = await json(
    base,
    "/api/workbench/bind-resource",
    post({
      fromTaskId: opened.body.taskId,
      fromAppInstanceId: appInstanceId,
      taskId: "task"
    })
  );
  assert.equal(bound.status, 200);
  assert.equal(bound.body.appInstance.taskId, undefined);
  assert.deepEqual(bound.body.appInstance.resourceIds, []);
  // The window moved rather than being duplicated.
  const strip = bound.body.tabs.filter((tab) => tab.appType === "text-editor");
  assert.deepEqual(
    strip.map((tab) => tab.appInstanceId),
    [appInstanceId]
  );
  assert.equal(strip[0].taskId, undefined);

  // A window that does hold a document must travel with it, not alone.
  const created = await json(
    base,
    `/api/tasks/task/app-instances/${bound.body.appInstance.appInstanceId}/resources`,
    post({
      kind: "text/markdown",
      title: "有内容.md",
      initialContent: "x"
    })
  );
  const refused = await json(
    base,
    "/api/workbench/bind-resource",
    post({
      fromTaskId: "task",
      fromAppInstanceId: created.body.appInstance.appInstanceId,
      taskId: "task"
    })
  );
  assert.equal(refused.status, 200);
  assert.equal(refused.body.appInstance.appInstanceId, appInstanceId);
});

test(
  "two conversations reference one document and each agent keeps its own view",
  { timeout: 30000 },
  async (t) => {
    // The capability the reference model exists for, over HTTP: several
    // conversations, each with its own agent, working on one document. Binding
    // used to move the resource, so selecting it in a second conversation took it
    // away from the first — which made this impossible to express at all.
    const { base, store } = await dashboard(t);
    await store.createTask("other", { goal: "第二个对话" });

    const created = await json(
      base,
      "/api/tasks/task/resources",
      post({
        kind: "text/markdown",
        title: "shared.md",
        initialContent: "# 共享\n\n## 甲\n待补充。\n"
      })
    );
    const resourceId = created.body.resource.resourceId;
    // The resource names no conversation; that is what makes it shareable.
    assert.equal(created.body.resource.taskId, undefined);

    // A conversation that has not referenced it cannot read it: the reference is
    // the access check now, where it used to be the directory layout.
    const refused = await json(base, `/api/tasks/other/resources/${resourceId}`);
    assert.equal(refused.status, 404);
    assert.equal(refused.body.error.code, "resource_not_found");

    const shared = await json(
      base,
      "/api/workbench/bind-resource",
      post({
        fromTaskId: "task",
        fromAppInstanceId: created.body.appInstance.appInstanceId,
        resourceId,
        taskId: "other"
      })
    );
    assert.equal(shared.status, 200);

    // Both reference it, and the first did not lose it.
    for (const taskId of ["task", "other"]) {
      const listed = await json(base, `/api/tasks/${taskId}/resources`);
      assert.deepEqual(
        listed.body.resources.map((entry) => entry.resourceId),
        [resourceId],
        `${taskId} references it`
      );
    }

    // Each conversation binds its own window over the same document.
    const summary = await json(base, "/api/tasks/other/app-instances");
    const otherWindow = summary.body.instances.find((entry) => entry.resourceIds.includes(resourceId));
    assert.ok(otherWindow, "the second conversation has its own window on it");
    await json(base, `/api/tasks/task/app-instances/${created.body.appInstance.appInstanceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true, status: "open" })
    });
    await json(base, `/api/tasks/other/app-instances/${otherWindow.appInstanceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true, status: "open" })
    });
    for (const taskId of ["task", "other"]) {
      const context = await json(base, `/api/tasks/${taskId}/active-app-context?agentId=${taskId}-agent`);
      assert.equal(
        context.body.context.resource.resourceId,
        resourceId,
        `${taskId}'s agent sees the document`
      );
    }

    // One conversation writes; the other's agent is told, and the writer is not.
    const read = await json(base, `/api/tasks/task/resources/${resourceId}`);
    const applied = await json(
      base,
      `/api/tasks/task/resources/${resourceId}/operations`,
      post({
        operationId: "op-shared",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: read.body.resource.revision,
        payload: { at: read.body.snapshot.content.length, text: "第一个对话写的\n" }
      })
    );
    assert.equal(applied.status, 200);
    // Read back from the *other* conversation: one document, one revision chain.
    const fromOther = await json(base, `/api/tasks/other/resources/${resourceId}`);
    assert.equal(fromOther.body.resource.revision, applied.body.resource.revision);
    assert.match(fromOther.body.snapshot.content, /第一个对话写的/);

    // A stale write is still refused rather than merged: CAS is unchanged, and
    // sharing must not have turned concurrent writes into last-write-wins.
    const stale = await json(
      base,
      `/api/tasks/other/resources/${resourceId}/operations`,
      post({
        operationId: "op-stale",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: read.body.resource.revision,
        payload: { at: 0, text: "X" }
      })
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "revision_conflict");
  }
);

test(
  "relating a document out of the shared workspace leaves one tab, not two",
  { timeout: 30000 },
  async (t) => {
    // The bug this pins: with references replacing moves, the window the document
    // was sitting in stayed open — so the same file appeared in the strip twice
    // and read as two documents. The shared workspace is a holding area for
    // documents that belong to no conversation, not a conversation of its own, so
    // relating a document out of it hands the window over.
    const { base, workspaceRoot } = await dashboard(t);
    const opened = await json(
      base,
      "/api/workbench/open-application",
      post({ appType: "text-editor", workspaceRoot })
    );
    const loose = opened.body.taskId;
    const looseWindow = opened.body.appInstance.appInstanceId;
    const created = await json(
      base,
      `/api/tasks/${loose}/app-instances/${looseWindow}/resources`,
      post({
        kind: "text/markdown",
        title: "笔记.txt",
        initialContent: "# 笔记\n"
      })
    );
    const resourceId = created.body.resource.resourceId;

    const related = await json(
      base,
      "/api/workbench/bind-resource",
      post({
        fromTaskId: loose,
        fromAppInstanceId: looseWindow,
        resourceId,
        taskId: "task"
      })
    );
    assert.equal(related.status, 200);

    // Exactly one tab on this document across the whole strip — which is now
    // true by construction rather than by cleaning up after a second one.
    const documentTabs = related.body.tabs.filter(
      (tab) => tab.kind === "application" && tab.resourceId === resourceId
    );
    assert.equal(documentTabs.length, 1, "one document, one tab");
    // It belongs to no conversation; it lists the ones referencing it, which now
    // includes this one. The holding area is not among them: relating a document
    // out of it drops its reference, because the area holds what nobody claims.
    assert.equal(documentTabs[0].taskId, undefined, "a document tab names no conversation");
    assert.ok(documentTabs[0].conversations.some((entry) => entry.taskId === "task"));
    assert.equal(
      documentTabs[0].conversations.some((entry) => entry.taskId === loose),
      false,
      "the holding area no longer claims it"
    );

    // The document itself is untouched and reachable from the conversation.
    const read = await json(base, `/api/tasks/task/resources/${resourceId}`);
    assert.equal(read.body.snapshot.content, "# 笔记\n");
  }
);

test(
  "a legacy strip migrates once, and two tabs on one document collapse into one",
  { timeout: 30000 },
  async (t) => {
    // The bug, executing its own fix. A version 1 strip keyed document tabs by
    // conversation and window, so a document referenced by two conversations had
    // two rows — which is what read as two files. Rekeying both onto the
    // document's own id merges them, and the merge keeps the earlier position.
    const { base, store, stripPath } = await dashboard(t);
    await store.createTask("task-b", { goal: "第二个对话" });
    const { readFile, writeFile } = await import("node:fs/promises");

    // One document, referenced by two conversations, each with its own window —
    // exactly the state the old model produced.
    const created = await json(
      base,
      "/api/tasks/task/resources",
      post({ kind: "text/markdown", title: "共享.md", initialContent: "x" })
    );
    const resourceId = created.body.resource.resourceId;
    const windowA = created.body.appInstance.appInstanceId;
    const second = await json(
      base,
      "/api/workbench/bind-resource",
      post({
        fromTaskId: "task",
        fromAppInstanceId: windowA,
        resourceId,
        taskId: "task-b"
      })
    );
    assert.equal(second.status, 200);

    // Hand-write the v1 strip those windows would have produced.
    await writeFile(
      stripPath,
      `${JSON.stringify(
        {
          version: 1,
          tabs: [
            {
              tabId: "conversation:task",
              kind: "conversation",
              taskId: "task",
              openedAt: "2026-01-01T00:00:00.000Z"
            },
            {
              tabId: `application:task:${windowA}`,
              kind: "application",
              taskId: "task",
              appInstanceId: windowA,
              openedAt: "2026-01-01T00:00:01.000Z"
            },
            {
              tabId: `application:task-b:${windowA}`,
              kind: "application",
              taskId: "task-b",
              appInstanceId: windowA,
              openedAt: "2026-01-01T00:00:02.000Z"
            }
          ],
          activeTabId: `application:task:${windowA}`,
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    // Reading the strip is what converts it.
    const first = await json(base, "/api/workbench/tabs");
    assert.equal(first.status, 200);
    const documents = first.body.tabs.filter((tab) => tab.resourceId === resourceId);
    assert.equal(documents.length, 1, "two legacy tabs on one document become one");
    assert.equal(documents[0].tabId, `window:${windowA}`);
    assert.equal(first.body.activeTabId, `window:${windowA}`, "focus follows the surviving instance");

    // And it is recorded, so it runs once rather than on every poll.
    const onDisk = JSON.parse(await readFile(stripPath, "utf8"));
    assert.equal(onDisk.version, 2);
    assert.equal(
      onDisk.tabs.some((tab) => tab.tabId.startsWith("application:")),
      false,
      "no legacy ids survive"
    );
    const again = await json(base, "/api/workbench/tabs");
    assert.deepEqual(
      again.body.tabs.map((tab) => tab.tabId),
      first.body.tabs.map((tab) => tab.tabId),
      "a second read changes nothing"
    );
  }
);

test(
  "independent launches create fresh windows and collaboration only loads the chosen document",
  { timeout: 30000 },
  async (t) => {
    const { base, workspaceRoot } = await dashboard(t);
    const first = await json(
      base,
      "/api/workbench/open-application",
      post({ appType: "text-editor", workspaceRoot })
    );
    const second = await json(
      base,
      "/api/workbench/open-application",
      post({ appType: "text-editor", workspaceRoot })
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.appInstance.appInstanceId, second.body.appInstance.appInstanceId);
    const workspace = first.body.taskId;
    const documents = [];
    for (const [index, opened] of [first, second].entries()) {
      const created = await json(
        base,
        `/api/tasks/${workspace}/app-instances/${opened.body.appInstance.appInstanceId}/resources`,
        post({
          kind: "text/markdown",
          title: `独立实例${index}.md`,
          initialContent: `内容${index}`
        })
      );
      assert.equal(created.status, 201);
      documents.push(created.body.resource.resourceId);
    }
    const related = await json(
      base,
      "/api/workbench/bind-resource",
      post({
        fromTaskId: workspace,
        fromAppInstanceId: first.body.appInstance.appInstanceId,
        resourceId: documents[0],
        taskId: "task"
      })
    );
    assert.equal(related.status, 200);
    assert.deepEqual(
      (await json(base, "/api/tasks/task/resources")).body.resources.map((r) => r.resourceId),
      [documents[0]]
    );
    assert.deepEqual(
      (await json(base, `/api/tasks/${workspace}/resources`)).body.resources.map((r) => r.resourceId).sort(),
      [...documents].sort()
    );
    const independent = related.body.tabs.find((tab) => tab.resourceId === documents[1]);
    assert.equal(independent.standalone, true);
    const instances = (await json(base, `/api/tasks/${workspace}/app-instances`)).body.instances;
    assert.equal(
      instances.find((instance) => instance.appInstanceId === second.body.appInstance.appInstanceId).status,
      "open"
    );
  }
);

test("opening exported artifacts reuses the source identity while unrelated same-title files remain separate", async (t) => {
  const { base, workspaceRoot, store } = await dashboard(t);
  const created = await json(
    base,
    "/api/tasks/task/resources",
    post({
      appType: "text-editor",
      kind: "text/plain",
      title: "报告.txt",
      initialContent: "original"
    })
  );
  const id = created.body.resource.resourceId;
  const instanceId = created.body.appInstance.appInstanceId;
  for (const [path, provenance] of [
    ["报告.txt", { sourceResourceId: id }],
    [`exports/${id}/abcd1234-报告.txt`, {}]
  ]) {
    await store.publishArtifact({
      taskId: "task",
      runId: "run",
      producerAgentId: "main",
      relativePath: path,
      displayName: "报告.txt",
      content: "original",
      ...provenance
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const opened = await json(base, "/api/tasks/task/resources", post({ fromArtifact: path }));
      assert.equal(opened.status, 201);
      assert.equal(opened.body.reused, true);
      assert.equal(opened.body.resource.resourceId, id);
      assert.equal(opened.body.appInstance.appInstanceId, instanceId);
    }
  }
  const summary = await json(base, "/api/tasks/task");
  const files = summary.body.applications.deliverables.filter((row) => row.kind === "file");
  assert.equal(files.length, 0);
  assert.equal(summary.body.applications.deliverables.length, 1);
  assert.deepEqual(
    summary.body.applications.deliverables[0].files.map((file) => file.relativePath).sort(),
    ["报告.txt", `exports/${id}/abcd1234-报告.txt`].sort()
  );
  assert.equal(summary.body.applications.resources.length, 1);
  // The source may evolve after export: opening must return today's live document.
  await json(
    base,
    `/api/tasks/task/resources/${id}/operations`,
    post({
      appType: "text-editor",
      operationType: "text.replace",
      operationId: "changed",
      baseRevision: 0,
      payload: { from: 0, to: 8, text: "new live content" }
    })
  );
  const reopened = await json(base, "/api/tasks/task/resources", post({ fromArtifact: "报告.txt" }));
  assert.equal(reopened.body.snapshot.content, "new live content");
  // Modified exports cease to point at the source. Never ignore those independent edits.
  await writeFile(join(workspaceRoot, "task", "artifacts", "报告.txt"), "external changes");
  const imported = await json(base, "/api/tasks/task/resources", post({ fromArtifact: "报告.txt" }));
  assert.equal(imported.status, 201);
  assert.notEqual(imported.body.resource.resourceId, id);
  assert.equal(imported.body.snapshot.content, "external changes");
  const after = await json(base, "/api/tasks/task/resources");
  assert.equal(after.body.resources.length, 2);
});

test("reopening an imported artifact preserves its edited resource and one deliverable", async (t) => {
  const { base, workspaceRoot, store } = await dashboard(t);
  await store.publishArtifact({
    taskId: "task",
    runId: "run",
    producerAgentId: "main",
    relativePath: "report.md",
    content: "original"
  });
  const first = await json(base, "/api/tasks/task/resources", post({ fromArtifact: "report.md" }));
  assert.equal(first.status, 201);
  const resourceId = first.body.resource.resourceId;
  await json(
    base,
    `/api/tasks/task/resources/${resourceId}/operations`,
    post({
      operationId: "edit-import",
      appType: "text-editor",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "edited " }
    })
  );
  const reopened = await Promise.all(
    Array.from({ length: 3 }, () =>
      json(base, "/api/tasks/task/resources", post({ fromArtifact: "report.md" }))
    )
  );
  for (const result of reopened) {
    assert.equal(result.body.resource.resourceId, resourceId);
    assert.equal(result.body.snapshot.content, "edited original");
    assert.equal(result.body.reused, true);
  }
  const summary = (await json(base, "/api/tasks/task")).body;
  assert.equal(summary.applications.resources.length, 1);
  assert.equal(summary.applications.deliverables.length, 1);
  assert.equal(summary.applications.deliverables[0].resourceId, resourceId);
  assert.equal(summary.artifacts.length, 1, "the original file remains available for download");
  assert.equal(await readFile(join(workspaceRoot, "task", "artifacts", "report.md"), "utf8"), "original");
});

test("the text editor rejects unsupported binary conversion without changing the artifact", async (t) => {
  const { base, workspaceRoot, store } = await dashboard(t);
  const artifact = await store.publishArtifact({
    taskId: "task",
    runId: "run",
    producerAgentId: "main",
    relativePath: "source.bin",
    content: Buffer.from("original bytes")
  });
  const result = await json(
    base,
    "/api/tasks/task/resources",
    post({
      fromArtifact: artifact.relativePath,
      appType: "text-editor",
      kind: "text/plain",
      title: "source",
      initialContent: "converted",
      artifactSha256: artifact.sha256
    })
  );
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "unsupported_resource_kind");
  assert.equal(
    await readFile(join(workspaceRoot, "task", "artifacts", "source.bin"), "utf8"),
    "original bytes"
  );
});
