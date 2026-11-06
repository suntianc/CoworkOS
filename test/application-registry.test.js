import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { ApplicationRegistry } = await import("../dist/src/applications/registry.js");
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { textRuntimeAdapter } =
  await import("../dist/test/fixtures/application-contract/text-runtime-adapter.js");
const { dummyCounterAdapter } = await import("../dist/src/applications/adapters/dummy-counter-adapter.js");

const user = { type: "user", id: "local" };
const agent = { type: "agent", id: "main" };

async function fixture(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-application-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const registry = new ApplicationRegistry().register(textRuntimeAdapter).register(dummyCounterAdapter);
  return { workspaceRoot, service: new ApplicationService(workspaceRoot, registry) };
}

test("catalog visibility filters discovery while retaining resource routing", () => {
  const compatibilityAdapter = {
    ...dummyCounterAdapter,
    definition: { ...dummyCounterAdapter.definition, catalogVisibility: "compatibility" }
  };
  const registry = new ApplicationRegistry().register(textRuntimeAdapter).register(compatibilityAdapter);
  assert.deepEqual(registry.catalogDefinitions(), [textRuntimeAdapter.definition]);
  assert.deepEqual(registry.definitions(), [textRuntimeAdapter.definition, compatibilityAdapter.definition]);
  assert.equal(registry.require("dummy-counter"), compatibilityAdapter);
  assert.equal(registry.forKind("model/counter+json"), compatibilityAdapter);
  assert.equal(registry.requireOperation("dummy-counter", "counter.increment"), compatibilityAdapter);

  const customRegistry = new ApplicationRegistry().register(dummyCounterAdapter);
  assert.deepEqual(customRegistry.catalogDefinitions(), [dummyCounterAdapter.definition]);
});

/**
 * The architectural acceptance condition from the MVP plan, run as a test.
 *
 * Both adapters go through the identical create/operate/select/context/export
 * path with no branch anywhere on appType. A counter has no text, no offsets
 * and no lines, so if this passes the core has not quietly specialized.
 */
const contracts = [
  {
    name: "text-editor",
    kind: "text/markdown",
    title: "proposal.md",
    initialContent: "# 方案\n目标用户是谁？\n",
    operation: { operationType: "text.replace", payload: { from: 2, to: 4, text: "产品方案" } },
    selection: { schema: "text.range/v1", data: { anchor: 0, head: 6 } },
    exportFormat: "markdown"
  },
  {
    name: "dummy-counter",
    kind: "model/counter+json",
    title: "回归计数器",
    initialContent: { counters: { opened: 1 } },
    operation: { operationType: "counter.increment", payload: { key: "opened", amount: 2 } },
    selection: { schema: "counter.key/v1", data: { key: "opened" } },
    exportFormat: "json"
  }
];

for (const contract of contracts) {
  test(`${contract.name} satisfies the adapter contract without platform changes`, async (t) => {
    const { service, workspaceRoot } = await fixture(t);
    const taskId = "task-1";

    const created = await service.createResource({
      taskId,
      kind: contract.kind,
      title: contract.title,
      initialContent: contract.initialContent,
      actor: user
    });
    assert.equal(created.resource.revision, 0);
    assert.equal(created.resource.status, "ready");
    // The registry, not the caller, decides which application owns a kind.
    assert.equal(created.resource.appType, contract.name);
    assert.ok(created.appInstance, "creating a resource must open something that can show it");
    assert.deepEqual(created.appInstance.resourceIds, [created.resource.resourceId]);

    const applied = await service.applyOperation({
      taskId,
      resourceId: created.resource.resourceId,
      operationId: "op-1",
      appType: contract.name,
      ...contract.operation,
      baseRevision: 0,
      actor: user
    });
    assert.equal(applied.revision ?? applied.resource.revision, 1);
    assert.ok(applied.event.summary.length > 0, "the adapter must produce a readable summary");
    assert.ok(applied.event.inverse, "an operation must be invertible for undo");
    assert.notEqual(applied.resource.contentVersion, created.resource.contentVersion);

    const selection = await service.saveSelection({
      taskId,
      resourceId: created.resource.resourceId,
      ...contract.selection,
      actor: user
    });
    assert.ok(selection.summary.length > 0);

    // Binding is the user's act for every adapter alike.
    await service.bindResource(taskId, created.resource.resourceId);
    const context = await service.activeContext({ taskId, agentId: "main" });
    assert.equal(context.appType, contract.name);
    assert.equal(context.resource.revision, 1);
    assert.equal(context.changesSinceAgentRevision.length, 1);
    assert.ok(context.selection.summary.length > 0);
    // What an Adapter contributes to the prompt is one line of shape. The
    // platform writes kind, size and revision around it, so the adapter's job
    // is only to say what the resource is *made of* — never where anything is.
    //
    // A count is fine: "8 行", "3 个工作表", "47 个特征" is nothing a model can
    // pass as an argument. An address is not. This line sits in the prompt
    // beside tools that locate by content, and a real run bridged the two: it
    // read "第 3 行 ## 目标用户" out of this very summary and passed `from: 4`
    // to text.replace — a valid offset in a 33-character document, so the
    // write was accepted, landed in line 1, and was reported as a success.
    assert.ok(context.shape.length > 0, `${contract.name} must say what its resource is made of`);
    assert.equal(context.shape.includes("\n"), false, "the shape is one line");
    assert.ok(context.shape.length <= 240, `the shape is bounded, got ${context.shape.length}`);
    for (const address of [
      /第\s*\d+\s*[行列页节个]/, // "第 3 行" — the one that actually happened
      /\b[A-Z]{1,3}\d+\s*:\s*[A-Z]{1,3}\d+/, // "A1:C5"
      /\b(line|row|col|column|page|offset|index)\s*[:#]?\s*\d+/i,
      /\[\s*\d+\s*,\s*\d+\s*[)\]]/ // "[12, 18)"
    ]) {
      assert.equal(
        address.test(context.shape),
        false,
        `${contract.name} put an address in its shape line: ${JSON.stringify(context.shape)} matched ${address}`
      );
    }
    // The size is the platform's, measured rather than asked for.
    assert.ok(context.sizeBytes > 0, `${contract.name} must be measured by the platform`);
    // And the tool list is derived from what will actually be registered, not
    // declared a second time by the adapter and left to drift.
    const adapter = contract.name === "text-editor" ? textRuntimeAdapter : dummyCounterAdapter;
    assert.deepEqual(
      context.availableToolNames,
      (adapter.agentTools?.() ?? []).map((tool) => tool.name)
    );
    // Every application must give a bound model some way to read its resource.
    // There is no generic read to fall back on.
    assert.ok(context.availableToolNames.length > 0, `${contract.name} declares no tools at all`);

    const rendered = service.context.render(context);
    assert.match(rendered, /<active_application/);
    assert.match(rendered, new RegExp(`app_type="${contract.name}"`));
    assert.ok(Buffer.byteLength(rendered, "utf8") <= 8 * 1024);

    // Every adapter's resource is a real file, and appears in the Task's
    // deliverables without a separate publish step.
    const { readFile } = await import("node:fs/promises");
    const body = await readFile(
      join(workspaceRoot, "applications", contract.name, "files", created.resource.path),
      "utf8"
    );
    assert.ok(body.length > 0, `${contract.name} must persist its resource as a file`);
    const deliverables = await service.deliverables(taskId, []);
    const entry = deliverables.find((row) => row.resourceId === created.resource.resourceId);
    assert.ok(entry, `${contract.name} resource must appear in the deliverables view`);
    assert.equal(entry.kind, "resource");
    assert.equal(entry.editable, true);
  });
}

test("the core carries no text-specific vocabulary", async () => {
  const core = [
    "types.js",
    "registry.js",
    "resource-store.js",
    "instance-store.js",
    "context-builder.js",
    "application-service.js"
  ];
  for (const name of core) {
    const source = await readFile(join("dist", "src", "applications", name), "utf8");
    // A reducer, a hard-coded operation name or an offset concept in the core
    // would mean the platform understands text, which is exactly what the MVP
    // is supposed to prevent.
    for (const forbidden of ["text.replace", "text.insert", "text.delete", "markdown", "paragraph"]) {
      assert.equal(source.includes(forbidden), false, `${name} must not mention ${forbidden}`);
    }
    assert.equal(/switch\s*\(\s*\w*[aA]ppType/.test(source), false, `${name} must not branch on appType`);
  }
});

test("the tool and route layers never look inside a resource's content", async () => {
  // The guard above only ever scanned six files under src/applications/, so
  // the tool layer sat outside it and a leak lived there for the whole life of
  // the feature: the generic `get_resource` did
  //
  //     typeof read.snapshot.content === "string"
  //       ? { contentLength: ..., endOffset: ... } : {}
  //
  // — the platform branching on the shape of an adapter's model and doing
  // offset arithmetic on it. §9.3 of the plan forbids exactly that: "如果平台
  // 核心需要识别'段落''字符位置'才能工作，说明抽象不合格".
  //
  // This tier is narrower than the one above on purpose. A tool description
  // naming `text/markdown` as an example kind is documentation, not knowledge;
  // the leak is *touching* the content. So these patterns are about the access,
  // not the vocabulary.
  const layers = [
    join("dist", "src", "dashboard", "application-routes.js"),
    // Scanned as source: the extension is outside tsconfig's `include` and is
    // loaded by jiti at runtime, so nothing else checks it at all.
    join(".pi", "extensions", "cowork.ts")
  ];
  const forbidden = [
    /\bsnapshot\s*\.\s*content\s*\.\s*(length|slice|indexOf|split|substring|charAt|codePointAt)\b/,
    /typeof\s+[\w.]*\bsnapshot\s*\.\s*content\s*===/,
    /\b(endOffset|contentLength)\s*[:=]/
  ];
  for (const path of layers) {
    // Comments describe the leak; only code can be one. Strip them first, or
    // this test fails on the paragraph above.
    const source = (await readFile(path, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${path} must not inspect resource content: matched ${pattern}`
      );
    }
  }
});

test("registry routes by declared kind and refuses what an application cannot open", async (t) => {
  const { service } = await fixture(t);
  assert.equal(service.registry.forKind("text/plain").definition.appType, "text-editor");
  assert.equal(service.registry.forKind("model/counter+json").definition.appType, "dummy-counter");
  assert.equal(service.registry.forKind("model/cad+json"), undefined);

  await assert.rejects(
    () =>
      service.createResource({
        taskId: "task-1",
        appType: "text-editor",
        kind: "model/counter+json",
        title: "x",
        actor: user
      }),
    (error) => error.code === "unsupported_resource_kind" && error.status === 422
  );
  await assert.rejects(
    () => service.createResource({ taskId: "task-1", kind: "model/cad+json", title: "x", actor: user }),
    (error) => error.code === "unsupported_resource_kind"
  );
  assert.throws(
    () => service.registry.require("cad"),
    (error) => error.code === "application_not_found" && error.status === 404
  );
});

test("an operation from the wrong application, or an unknown one, is refused before any write", async (t) => {
  const { service } = await fixture(t);
  const taskId = "task-1";
  const created = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "a.md",
    initialContent: "hi",
    actor: user
  });

  await assert.rejects(
    () =>
      service.applyOperation({
        taskId,
        resourceId: created.resource.resourceId,
        operationId: "op-x",
        appType: "dummy-counter",
        operationType: "counter.set",
        baseRevision: 0,
        payload: { key: "a", amount: 1 },
        actor: user
      }),
    (error) => error.code === "invalid_operation"
  );
  await assert.rejects(
    () =>
      service.applyOperation({
        taskId,
        resourceId: created.resource.resourceId,
        operationId: "op-y",
        appType: "text-editor",
        operationType: "text.rotate",
        baseRevision: 0,
        payload: {},
        actor: user
      }),
    (error) => error.code === "invalid_operation"
  );
  const read = await service.readResource(taskId, created.resource.resourceId);
  assert.equal(read.resource.revision, 0);
  assert.equal(read.operations.length, 0);
});

test("a reducer that throws leaves the resource and every other tab untouched", async (t) => {
  const { workspaceRoot } = await fixture(t);
  const exploding = {
    definition: { ...dummyCounterAdapter.definition, appType: "exploding" },
    createContent: () => ({ counters: {} }),
    serialize: (content) => JSON.stringify(content ?? {}),
    parse: (raw) => JSON.parse(raw || "{}"),
    applyOperation() {
      throw new Error("adapter crashed");
    },
    summarizeSelection: () => "",
    summarizeContext: () => ({ shape: "" }),
    exportResource: () => ({ fileName: "x.json", mimeType: "application/json", body: "{}" })
  };
  const registry = new ApplicationRegistry().register(textRuntimeAdapter).register(exploding);
  const service = new ApplicationService(workspaceRoot, registry);
  const taskId = "task-1";
  const healthy = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "ok.md",
    initialContent: "fine",
    actor: user
  });
  const broken = await service.createResource({
    taskId,
    appType: "exploding",
    kind: "model/counter+json",
    title: "boom",
    actor: user
  });

  await assert.rejects(
    () =>
      service.applyOperation({
        taskId,
        resourceId: broken.resource.resourceId,
        operationId: "op-1",
        appType: "exploding",
        operationType: "counter.set",
        baseRevision: 0,
        payload: { key: "a", amount: 1 },
        actor: user
      }),
    /adapter crashed/
  );

  assert.equal((await service.readResource(taskId, broken.resource.resourceId)).resource.revision, 0);
  // No half-written transaction may be left behind for the recovery pass to
  // find: the failure happened before anything durable was touched.
  const pending = await readdir(
    join(workspaceRoot, taskId, ".runtime", "applications", "transactions")
  ).catch(() => []);
  assert.deepEqual(pending, []);
  const stillWorks = await service.applyOperation({
    taskId,
    resourceId: healthy.resource.resourceId,
    operationId: "op-2",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 4, text: "!" },
    actor: user
  });
  assert.equal(stillWorks.resource.revision, 1);
});

test("tabs are not the source of truth: closing one preserves the resource and its history", async (t) => {
  const { service } = await fixture(t);
  const taskId = "task-1";
  const created = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "keep.md",
    initialContent: "keep",
    actor: user
  });
  await service.applyOperation({
    taskId,
    resourceId: created.resource.resourceId,
    operationId: "op-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 4, text: " me" },
    actor: user
  });
  await service.updateInstance({
    taskId,
    appInstanceId: created.appInstance.appInstanceId,
    status: "closed"
  });

  const summary = await service.taskSummary(taskId);
  assert.equal(summary.instances.length, 0);
  assert.equal(summary.resources.length, 1);
  assert.equal(summary.activeInstanceId, undefined);

  // Reopening activates a tab again; the content is exactly where it was.
  const reopened = await service.openResource({ taskId, resourceId: created.resource.resourceId });
  assert.equal(reopened.status, "open");
  const read = await service.readResource(taskId, created.resource.resourceId);
  assert.equal(read.snapshot.content, "keep me");
  assert.equal(read.resource.revision, 1);
});

test("reopening a resource activates the existing tab instead of creating a second one", async (t) => {
  const { service } = await fixture(t);
  const taskId = "task-1";
  const created = await service.createResource({
    taskId,
    kind: "text/markdown",
    title: "one.md",
    initialContent: "x",
    actor: user
  });
  const again = await service.openResource({ taskId, resourceId: created.resource.resourceId });
  assert.equal(again.appInstanceId, created.appInstance.appInstanceId);
  assert.equal((await service.taskSummary(taskId)).instances.length, 1);
});

test("two Tasks never see each other's resources, tabs or revisions", async (t) => {
  const { service } = await fixture(t);
  const a = await service.createResource({
    taskId: "task-a",
    kind: "text/markdown",
    title: "a.md",
    initialContent: "A",
    actor: user
  });
  const b = await service.createResource({
    taskId: "task-b",
    kind: "text/markdown",
    title: "b.md",
    initialContent: "B",
    actor: user
  });

  await assert.rejects(
    () => service.readResource("task-b", a.resource.resourceId),
    (error) => error.code === "resource_not_found" && error.status === 404
  );
  assert.deepEqual(
    (await service.listResources("task-a")).map((entry) => entry.resourceId),
    [a.resource.resourceId]
  );
  assert.deepEqual(
    (await service.listResources("task-b")).map((entry) => entry.resourceId),
    [b.resource.resourceId]
  );
  await service.bindResource("task-a", a.resource.resourceId);
  await service.bindResource("task-b", b.resource.resourceId);
  assert.equal((await service.activeContext({ taskId: "task-a", agentId: "main" })).resource.title, "a.md");
  assert.equal((await service.activeContext({ taskId: "task-b", agentId: "main" })).resource.title, "b.md");
});

test("resource and task ids are rejected before they can become a path", async (t) => {
  const { workspaceRoot, service } = await fixture(t);
  await writeFile(join(workspaceRoot, "outside.json"), "secret");
  for (const taskId of ["../escape", "task/../..", "/absolute", "task\u0000"]) {
    await assert.rejects(
      () => service.createResource({ taskId, kind: "text/markdown", title: "x.md", actor: user }),
      (error) => error.code === "unsafe_path" && error.status === 400,
      `taskId ${JSON.stringify(taskId)} must be refused`
    );
  }
  for (const resourceId of ["../../etc/passwd", "res/../..", ".."]) {
    await assert.rejects(
      () => service.readResource("task-1", resourceId),
      (error) => error.code === "unsafe_path"
    );
  }
});

test("a Task with no application state is normal, not an error", async (t) => {
  const { service } = await fixture(t);
  const summary = await service.taskSummary("legacy-task");
  assert.deepEqual(summary.resources, []);
  assert.deepEqual(summary.instances, []);
  assert.equal(summary.activeInstanceId, undefined);
  assert.equal(await service.activeContext({ taskId: "legacy-task", agentId: "main" }), undefined);
});

test("several conversations reference one resource, and each keeps its own view", async (t) => {
  // The capability this model exists for. Binding used to *move* the resource,
  // so selecting a document in conversation B took it away from A — which made
  // "several agents working on one document" impossible to express. A
  // reference is non-exclusive, so it is.
  const { service } = await fixture(t);
  const created = await service.createResource({
    taskId: "task-a",
    kind: "text/markdown",
    title: "shared.md",
    initialContent: "# 共享\n",
    actor: user
  });
  const resourceId = created.resource.resourceId;
  // The resource itself names no conversation: that is what makes it shareable.
  assert.equal(created.resource.taskId, undefined);

  const referenced = await service.referenceIntoTask({ resourceId, taskId: "task-b" });
  assert.equal(referenced.resource.resourceId, resourceId, "the same resource, not a copy");

  // Both conversations see it, and A did not lose it.
  assert.deepEqual(
    (await service.listResources("task-a")).map((entry) => entry.resourceId),
    [resourceId]
  );
  assert.deepEqual(
    (await service.listResources("task-b")).map((entry) => entry.resourceId),
    [resourceId]
  );

  // One document, one tab — but each conversation binds it on its own, and
  // each agent gets its own context over it.
  await service.bindResource("task-a", resourceId);
  await service.bindResource("task-b", referenced.resource.resourceId);
  const contextA = await service.activeContext({ taskId: "task-a", agentId: "alice" });
  const contextB = await service.activeContext({ taskId: "task-b", agentId: "bob" });
  assert.equal(contextA.resource.resourceId, resourceId);
  assert.equal(contextB.resource.resourceId, resourceId);

  // A writes. The unread cursor is per agent, so B is told and A is not: an
  // agent must never be handed its own edit as "something you have not seen".
  const read = await service.readResource("task-a", resourceId);
  await service.applyOperation({
    taskId: "task-a",
    resourceId,
    operationId: "op-alice",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: read.resource.revision,
    payload: { at: read.snapshot.content.length, text: "alice 写的\n" },
    actor: { type: "agent", id: "alice" }
  });
  const summaryA = await service.taskSummary("task-a", "alice");
  const summaryB = await service.taskSummary("task-b", "bob");
  assert.deepEqual(
    summaryA.unread.map((entry) => entry.unread),
    [0],
    "an agent does not see its own write as unread"
  );
  assert.deepEqual(
    summaryB.unread.map((entry) => entry.unread),
    [1],
    "the other agent is told the document moved"
  );

  // B stops referencing it. The resource, its content and A's reference all stay.
  await service.dereferenceResource("task-b", resourceId);
  assert.deepEqual(await service.listResources("task-b"), []);
  assert.deepEqual(
    (await service.listResources("task-a")).map((entry) => entry.resourceId),
    [resourceId]
  );
  assert.match((await service.readResource("task-a", resourceId)).snapshot.content, /alice 写的/);
});

test("a conversation cannot read a resource it does not reference", async (t) => {
  // Isolation used to be structural: a resource lived under one Task's
  // directory, so another Task could not name its path. Resources are shared
  // now, so nothing about the path stops a conversation from reading a document
  // it was never given — the reference is the access check, and it has to be
  // enforced rather than assumed.
  const { service } = await fixture(t);
  const a = await service.createResource({
    taskId: "task-a",
    kind: "text/markdown",
    title: "a.md",
    initialContent: "A",
    actor: user
  });
  const b = await service.createResource({
    taskId: "task-b",
    kind: "text/markdown",
    title: "b.md",
    initialContent: "B",
    actor: user
  });

  await assert.rejects(
    () => service.readResource("task-b", a.resource.resourceId),
    (error) => error.code === "resource_not_found" && error.status === 404,
    "a conversation that never referenced it must not be able to read it"
  );
  assert.deepEqual(
    (await service.listResources("task-a")).map((entry) => entry.resourceId),
    [a.resource.resourceId]
  );
  assert.deepEqual(
    (await service.listResources("task-b")).map((entry) => entry.resourceId),
    [b.resource.resourceId]
  );

  // Referencing is what grants access, and it is the only thing that does.
  await service.referenceIntoTask({ resourceId: a.resource.resourceId, taskId: "task-b" });
  assert.equal((await service.readResource("task-b", a.resource.resourceId)).snapshot.content, "A");
});

test("opening a resource establishes the reference that every later call needs", async (t) => {
  // The bug this pins, reported as "资源不存在" while binding: `openResource`
  // created the window but never added the reference, so the window opened and
  // then every read of it failed the access check. Isolation used to be
  // structural — a resource lived under one Task's directory — and adding the
  // check without covering this path left it half-applied.
  const { service } = await fixture(t);
  const created = await service.createResource({
    taskId: "task-a",
    kind: "text/markdown",
    title: "共享.md",
    initialContent: "x",
    actor: user
  });
  const resourceId = created.resource.resourceId;

  const window = await service.openResource({ taskId: "task-b", resourceId });
  assert.ok(window.appInstanceId.startsWith("app_"));
  assert.deepEqual(
    (await service.mapping.list("task-b")).map((entry) => entry.resourceId),
    [resourceId],
    "opening a resource is using it, so the conversation references it"
  );
  assert.equal((await service.readResource("task-b", resourceId)).snapshot.content, "x");
  // And the conversation that had it is unaffected: sharing is non-exclusive.
  assert.equal((await service.readResource("task-a", resourceId)).snapshot.content, "x");
});

test("every conversation-scoped call refuses a resource the conversation never referenced", async (t) => {
  // One rule, checked in one place, applied at every entry point. Sharing made
  // the path useless as a boundary, so each of these has to ask — otherwise
  // knowing an id would be enough to read, edit, rename or download someone
  // else's document.
  const { service } = await fixture(t);
  const created = await service.createResource({
    taskId: "task-a",
    kind: "text/markdown",
    title: "私有.md",
    initialContent: "机密",
    actor: user
  });
  const resourceId = created.resource.resourceId;
  const refused = (error) => error.code === "resource_not_found" && error.status === 404;

  await assert.rejects(() => service.readResource("task-b", resourceId), refused, "read");
  await assert.rejects(
    () =>
      service.applyOperation({
        taskId: "task-b",
        resourceId,
        operationId: "op-1",
        appType: "text-editor",
        operationType: "text.insert",
        baseRevision: 0,
        payload: { at: 0, text: "x" },
        actor: user
      }),
    refused,
    "write"
  );
  await assert.rejects(() => service.undo({ taskId: "task-b", resourceId, actor: user }), refused, "undo");
  await assert.rejects(
    () =>
      service.saveSelection({
        taskId: "task-b",
        resourceId,
        schema: "text.range/v1",
        data: { anchor: 0, head: 1 },
        actor: user
      }),
    refused,
    "selection"
  );
  await assert.rejects(
    () => service.renameResource({ taskId: "task-b", resourceId, title: "改名.md" }),
    refused,
    "rename"
  );
  await assert.rejects(
    () => service.renderForDownload({ taskId: "task-b", resourceId, format: "markdown" }),
    refused,
    "download"
  );

  // The document is untouched by any of those attempts.
  const read = await service.readResource("task-a", resourceId);
  assert.equal(read.snapshot.content, "机密");
  assert.equal(read.resource.revision, 0);
  assert.equal(read.resource.title, "私有.md");

  // A malformed id is reported as a path problem whoever asks, so a traversal
  // attempt is not hidden behind an ordinary "not referenced" answer.
  await assert.rejects(
    () => service.readResource("task-a", "../../etc/passwd"),
    (error) => error.code === "unsafe_path"
  );

  // Referencing is what grants access, and it grants all of it at once.
  await service.referenceIntoTask({ resourceId, taskId: "task-b" });
  assert.equal((await service.readResource("task-b", resourceId)).snapshot.content, "机密");
  const written = await service.applyOperation({
    taskId: "task-b",
    resourceId,
    operationId: "op-2",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "补充：" },
    actor: user
  });
  assert.equal(written.resource.revision, 1);
  // And the other conversation sees it, because it is one document.
  assert.match((await service.readResource("task-a", resourceId)).snapshot.content, /^补充：机密/);
});

test("an empty instance is loaded explicitly and gives the Agent creation context", async (t) => {
  const { service } = await fixture(t);
  const empty = await service.openApplication({ taskId: "task-a", appType: "text-editor" });
  assert.equal((await service.taskSummary("task-a")).unbound, true);
  await service.loadInstance("task-a", empty.appInstanceId);
  assert.equal(await service.activeContext({ taskId: "task-a", agentId: "main" }), undefined);
  assert.match(await service.emptyApplicationContext("task-a"), /create_resource/);
  const summary = await service.taskSummary("task-a");
  assert.equal(summary.loadedInstanceId, empty.appInstanceId);
  assert.equal(summary.unbound, false);
  assert.equal(summary.boundResourceId, undefined);
  assert.equal(summary.instances.length, 1);
});

test("opening an existing document preserves other empty instances and never loads a conversation", async (t) => {
  const { service } = await fixture(t);
  const empty = await service.openApplication({ taskId: "task-a", appType: "text-editor" });
  const created = await service.createResource({
    taskId: "task-b",
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "方案",
    actor: user
  });
  const opened = await service.openResource({ taskId: "task-a", resourceId: created.resource.resourceId });
  assert.equal(opened.appInstanceId, created.appInstance.appInstanceId);
  assert.deepEqual((await service.instances.readInstance(empty.appInstanceId)).resourceIds, []);
  assert.equal((await service.taskSummary("task-a")).unbound, true);
  assert.equal(await service.activeContext({ taskId: "task-a", agentId: "main" }), undefined);
});

test("two conversations share one tab, and each keeps its own binding", async (t) => {
  // The acceptance test for the whole change. A document belongs to no
  // conversation: any number reference it, each with its own agent and its own
  // read cursor. Keying its tab by conversation put the same file in the strip
  // twice and read as two documents — 「一个文件就应该是一个标签」.
  const { service } = await fixture(t);
  const created = await service.createResource({
    taskId: "task-a",
    kind: "text/markdown",
    title: "共享.md",
    initialContent: "# 共享\n",
    actor: user
  });
  const resourceId = created.resource.resourceId;
  await service.referenceIntoTask({ resourceId, taskId: "task-b", fromTaskId: "task-a" });

  // Each conversation binds on its own, and each agent is handed the document.
  await service.bindResource("task-a", resourceId);
  await service.bindResource("task-b", resourceId);
  assert.equal(
    (await service.activeContext({ taskId: "task-a", agentId: "alice" })).resource.resourceId,
    resourceId
  );
  assert.equal(
    (await service.activeContext({ taskId: "task-b", agentId: "bob" })).resource.resourceId,
    resourceId
  );

  // And unbinding one leaves the other alone. This is what "per conversation"
  // has to mean for the shared tab to be safe.
  await service.bindResource("task-a", undefined);
  assert.equal(await service.activeContext({ taskId: "task-a", agentId: "alice" }), undefined);
  assert.equal(
    (await service.activeContext({ taskId: "task-b", agentId: "bob" })).resource.resourceId,
    resourceId
  );
  assert.equal((await service.taskSummary("task-a")).unbound, true);
  assert.equal((await service.taskSummary("task-b")).unbound, false);
});

test("unread stays per conversation on a shared document", async (t) => {
  // One tab, one badge, but a cursor per conversation — so the badge has to
  // mean "changes CoworkOS has not read for the conversation you are in".
  const { service } = await fixture(t);
  const created = await service.createResource({
    taskId: "task-a",
    kind: "text/markdown",
    title: "共享.md",
    initialContent: "x",
    actor: user
  });
  const resourceId = created.resource.resourceId;
  await service.referenceIntoTask({ resourceId, taskId: "task-b", fromTaskId: "task-a" });
  await service.bindResource("task-a", resourceId);
  await service.bindResource("task-b", resourceId);

  await service.applyOperation({
    taskId: "task-a",
    resourceId,
    appType: "text-editor",
    operationId: "user-1",
    operationType: "text.rewrite",
    baseRevision: 0,
    payload: { content: "用户改过\n" },
    actor: { type: "user", id: "local" }
  });

  // A's agent reads it; B's does not.
  const contextA = await service.activeContext({ taskId: "task-a", agentId: "alice" });
  await service.context.recordAcknowledged("task-a", "alice", resourceId, contextA.resource.revision);

  const unreadA = (await service.taskSummary("task-a", "alice")).unread.find(
    (entry) => entry.resourceId === resourceId
  );
  const unreadB = (await service.taskSummary("task-b", "bob")).unread.find(
    (entry) => entry.resourceId === resourceId
  );
  assert.equal(unreadA.unread, 0, "A's agent has read it");
  assert.equal(unreadB.unread, 1, "B's has not, and one badge must not speak for both");
});

test("loading a document is explicit and opening another does not replace it", async (t) => {
  const { service } = await fixture(t);
  const one = await service.createResource({
    taskId: "task-b",
    kind: "text/markdown",
    title: "one.md",
    actor: user
  });
  const two = await service.createResource({
    taskId: "task-b",
    kind: "text/markdown",
    title: "two.md",
    actor: user
  });
  await service.loadInstance("task-a", one.appInstance.appInstanceId);
  await service.openResource({ taskId: "task-a", resourceId: two.resource.resourceId });
  assert.equal(
    (await service.activeContext({ taskId: "task-a", agentId: "main" })).resource.resourceId,
    one.resource.resourceId
  );
});
