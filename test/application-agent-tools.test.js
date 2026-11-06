import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
const { ApplicationService } = await import("../dist/src/applications/application-service.js");

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  // Activation is tracked for real, not stubbed away. Pi has no unregister, so
  // visibility is controlled entirely through this set — a double that ignored
  // it could not tell "tool retired" from "tool still live", which is how a
  // stale application's tools once stayed visible after rebinding.
  const active = new Set();
  return {
    tools,
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
      // Pi activates a newly registered name by default.
      active.add(tool.name);
    },
    registerProvider() {},
    registerCommand() {},
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names) {
      active.clear();
      for (const name of names) active.add(name);
    },
    sendMessage: async () => {}
  };
}

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

/** Run one extension instance against a fresh workspace. */
async function harness(t, { tabs = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-app-tools-"));
  const taskId = "app-task";
  const runId = "main-app";
  const previous = { ...process.env };
  process.env.COWORK_API_BASE = "https://example.test";
  process.env.COWORK_API_KEY = "test-key";
  process.env.COWORK_CONFIG = join(root, "config.json");
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  process.env.COWORK_WORKSPACE = root;
  process.env.COWORK_TASK_ID = taskId;
  process.env.COWORK_RUN_ID = runId;
  // The Dashboard tells the Agent where the global strip is; a document the
  // Agent creates has to land in it.
  if (tabs) process.env.COWORK_TABS_INDEX = join(root, "tabs.json");
  else delete process.env.COWORK_TABS_INDEX;
  t.after(async () => {
    for (const key of [
      "COWORK_API_BASE",
      "COWORK_API_KEY",
      "COWORK_CONFIG",
      "COWORK_WORKSPACE",
      "COWORK_TASK_ID",
      "COWORK_RUN_ID",
      "COWORK_TABS_INDEX"
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  const store = new LocalWorkspaceStore(root);
  await store.createTask(taskId, { goal: "workbench tools" });
  await store.createRun(taskId, runId);
  const pi = fakePi();
  (await loadExtension())(pi);
  /** Bind the conversation to this document. */
  const bind = async (resourceId) => {
    await new ApplicationService(root).bindResource(taskId, resourceId);
  };
  const call = async (name, params = {}) => {
    const tool = pi.tools.get(name);
    assert.ok(tool, `extension must register ${name}`);
    const result = await tool.execute("call-1", params, undefined, undefined, {
      ui: { notify() {}, setStatus() {} }
    });
    return { details: result.details, isError: Boolean(result.isError) };
  };
  /**
   * Run the hook that rebuilds the bound application's context and tools.
   *
   * Binding alone changes nothing the model can see: the application's own
   * tools are registered per turn, so a test that binds and then calls one
   * has to let a turn happen in between.
   */
  const turn = async () => {
    await pi.handlers.get("context")(
      { messages: [] },
      {
        ui: { notify() {}, setStatus() {} },
        sessionManager: SessionManager.inMemory()
      }
    );
  };
  return {
    root,
    taskId,
    pi,
    call,
    bind,
    turn,
    tabsPath: join(root, "tabs.json"),
    service: new ApplicationService(root)
  };
}

test("the generic resource tools are always registered, and reading content is not one of them", async (t) => {
  const { pi } = await harness(t);
  for (const name of [
    "list_applications",
    "list_resources",
    "list_resource_changes",
    "create_resource",
    "apply_resource_operation"
  ]) {
    assert.equal(pi.tools.has(name), true, `${name} must be registered`);
  }
  // Reading content is the application's job. A generic read could only ever
  // hand over the whole document, and making that useful for text had grown it
  // `contentLength`/`endOffset` — the platform doing offset arithmetic on an
  // adapter's model, which is the one thing this abstraction forbids.
  assert.equal(pi.tools.has("get_resource"), false, "get_resource must not come back");
  // Everything Main already had is untouched.
  for (const name of ["call_subagent", "browse_workspace", "askhuman", "finish_task"]) {
    assert.equal(pi.tools.has(name), true, `${name} must still be registered`);
  }
});

test("Main creates a resource, opens its tab, and reads it back through the application's own tool", async (t) => {
  const { call, bind, turn, service, taskId } = await harness(t);

  const applications = await call("list_applications");
  const editor = applications.details.applications.find((entry) => entry.appType === "text-editor");
  assert.ok(
    editor.operationSchemas["text.replace"],
    "the tool layer reports schemas from the adapter, not a hard-coded list"
  );

  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "proposal.md",
    initialContent: "# 方案\n目标用户\n"
  });
  assert.ok(created.details.resource.resourceId.startsWith("res_"));

  const listed = await call("list_resources");
  assert.equal(listed.details.resources.length, 1);
  // The index carries no document text.
  assert.equal(JSON.stringify(listed.details).includes("目标用户"), false);

  // Reading is the application's, not the platform's. It appears once the
  // conversation is bound and a turn has rebuilt the tool set.
  await bind(created.details.resource.resourceId);
  await turn();
  const read = await call("read_document", {});
  assert.equal(read.details.result.content, "# 方案\n目标用户\n");
  assert.equal(read.details.result.revision, 0, "and it reports the revision a write will need");

  // The tab really exists in the durable store the UI reads.
  const summary = await service.taskSummary(taskId);
  assert.equal(summary.instances.length, 1);
  assert.equal(summary.instances[0].title, "proposal.md");
});

test("a document the Agent creates lands in the strip and is what the next turn sees", async (t) => {
  const { call, service, taskId, tabsPath } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "proposal.md",
    initialContent: "# 方案\n"
  });
  const resourceId = created.details.resource.resourceId;

  // The tool's description promises the tab is open, and the strip is the only
  // thing the browser reads to draw it. This used to be a claim about nothing:
  // the Agent never wrote to the strip at all. The tab is keyed by the
  // document, so this is also the assertion that one file is one tab.
  const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
  const strip = await new WorkbenchTabStore(tabsPath).read();
  assert.deepEqual(
    strip.tabs.map((tab) => tab.tabId),
    [`resource:${resourceId}`]
  );
  assert.equal(strip.activeTabId, `resource:${resourceId}`);

  // And because the window is in front, the conversation is bound to it: the
  // Agent's next turn sees the document it just made instead of a NULL context.
  const context = await service.activeContext({ taskId, agentId: "main" });
  assert.equal(context.resource.resourceId, created.details.resource.resourceId);

  // The Agent's own creation is not replayed to it as an unread user change.
  assert.deepEqual(context.changesSinceAgentRevision, []);
});

test("a tool result the session cannot record is reduced rather than losing the turn", async (t) => {
  // The failure this pins came from a real run: the whole turn ended with
  // "function at() { [native code] } could not be cloned." A tool result is
  // cloned into the session record, so one unclonable value cost the run — the
  // adapter no longer echoes values back, and this is the backstop for anything
  // else that ever does.
  const { call, bind, turn, service, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "doc.md",
    initialContent: "# 标题\n正文\n"
  });
  const resourceId = created.details.resource.resourceId;

  // Exactly what the model sent: `at` as a native function.
  const rejected = await call("apply_resource_operation", {
    resourceId,
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: [].at, text: "追加" }
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.details.code, "invalid_operation");
  assert.doesNotThrow(() => structuredClone(rejected.details), "the result must survive the session record");
  assert.match(JSON.stringify(rejected.details), /at/, "and still say which field was wrong");

  // The document is untouched, so a retry against the same revision works.
  assert.equal((await service.readResource(taskId, resourceId)).resource.revision, 0);

  // And the way to append is to name the text to append after, not to compute
  // where the end is. `endOffset` used to be handed over here for exactly this
  // — the platform measuring an adapter's model so the model need not — which
  // is the arithmetic that produced the bad `at` in the first place.
  await bind(resourceId);
  await turn();
  const appended = await call("patch_document", { oldText: "正文\n", newText: "正文\n追加的一段\n" });
  assert.equal(appended.isError, false);
  assert.match((await service.readResource(taskId, resourceId)).snapshot.content, /正文\n追加的一段\n/);
});

test("a stale Agent write is refused with a code it can recover from, and the user's text survives", async (t) => {
  const { call, bind, turn, service, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "doc.md",
    initialContent: "原始内容\n"
  });
  const resourceId = created.details.resource.resourceId;

  // The user edits between the Agent's read and its write.
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "user-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "用户加的一句\n" },
    actor: { type: "user", id: "local" }
  });

  const stale = await call("apply_resource_operation", {
    resourceId,
    operationType: "text.replace",
    baseRevision: 0,
    payload: { from: 0, to: 4, text: "Agent 改的" }
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.details.code, "revision_conflict");
  assert.equal(stale.details.details.currentRevision, 1);
  // The user's sentence is untouched: no last-write-wins.
  assert.match((await service.readResource(taskId, resourceId)).snapshot.content, /^用户加的一句\n/);

  // Recovery is two steps and they are deliberately different tools. What
  // changed is the platform's own version log; what the document now says is
  // the application's to report.
  const changes = await call("list_resource_changes", { resourceId, afterRevision: 0 });
  assert.equal(changes.details.operations.length, 1);
  assert.equal(changes.details.operations[0].actor.type, "user");
  assert.equal("content" in changes.details, false, "the version log must never carry content");

  await bind(resourceId);
  await turn();
  const reread = await call("read_document", {});
  assert.match(reread.details.result.content, /用户加的一句/);
  const retried = await call("patch_document", {
    oldText: "原始内容\n",
    newText: "原始内容\nCoworkOS 补充的一句\n"
  });
  assert.equal(retried.isError, false);
  const final = (await service.readResource(taskId, resourceId)).snapshot.content;
  assert.match(final, /用户加的一句/, "the Agent must not erase the user's edit");
  assert.match(final, /CoworkOS 补充的一句/);
});

test("the Agent's own edits do not come back to it as unread user changes", async (t) => {
  const { call, bind, service, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "doc.md",
    initialContent: "起点\n"
  });
  const resourceId = created.details.resource.resourceId;
  await bind(resourceId);
  await call("apply_resource_operation", {
    resourceId,
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "Agent 写的\n" }
  });

  const context = await service.activeContext({ taskId, agentId: "main" });
  assert.equal(context.changesSinceAgentRevision.length, 0, "an Agent must not be told about its own writes");

  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "user-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 1,
    payload: { at: 0, text: "用户写的\n" },
    actor: { type: "user", id: "local" }
  });
  const next = await service.activeContext({ taskId, agentId: "main" });
  assert.equal(next.changesSinceAgentRevision.length, 1);
  assert.equal(next.changesSinceAgentRevision[0].actor.type, "user");
});

test("a repeated operationId from a retried tool call does not double-apply", async (t) => {
  const { call, service, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "doc.md",
    initialContent: ""
  });
  const resourceId = created.details.resource.resourceId;
  const params = {
    resourceId,
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "只出现一次" },
    operationId: "op_fixed"
  };
  const first = await call("apply_resource_operation", params);
  const second = await call("apply_resource_operation", params);
  assert.equal(first.details.revision, 1);
  assert.equal(second.details.revision, 1);
  assert.equal(second.details.deduplicated, true);
  assert.equal((await service.readResource(taskId, resourceId)).snapshot.content, "只出现一次");
});

test("tool errors carry a code rather than only prose, including unknown resources and operations", async (t) => {
  const { call } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "doc.md",
    initialContent: "x"
  });
  const resourceId = created.details.resource.resourceId;

  const missing = await call("list_resource_changes", { resourceId: "res_nope" });
  assert.equal(missing.isError, true);
  assert.equal(missing.details.code, "resource_not_found");

  const unsupported = await call("create_resource", { kind: "model/cad+json", title: "part" });
  assert.equal(unsupported.details.code, "unsupported_resource_kind");

  const badOperation = await call("apply_resource_operation", {
    resourceId,
    operationType: "text.rotate",
    baseRevision: 0,
    payload: {}
  });
  assert.equal(badOperation.details.code, "invalid_operation");

  const badPath = await call("list_resource_changes", { resourceId: "../../escape" });
  assert.equal(badPath.details.code, "unsafe_path");
});

test("the active application context reaches the system prompt, without the document body", async (t) => {
  const { call, bind, service, pi, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "proposal.md",
    initialContent: "# 方案\n非常具体的正文内容\n"
  });
  const resourceId = created.details.resource.resourceId;
  await bind(resourceId);
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "user-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "用户新增的一行\n" },
    actor: { type: "user", id: "local" }
  });
  await service.saveSelection({
    taskId,
    resourceId,
    schema: "text.range/v1",
    data: { anchor: 0, head: 7 },
    actor: { type: "user", id: "local" }
  });

  // The context hook prepares the section; the prompt hook stays synchronous.
  await pi.handlers.get("context")(
    { messages: [{ role: "user", content: "把这一段写得更具体" }] },
    {
      sessionManager: SessionManager.inMemory(),
      ui: { notify() {} }
    }
  );
  const injected = await pi.handlers.get("before_agent_start")({ systemPrompt: "Original system rules" });

  assert.ok(
    injected.systemPrompt.startsWith("Original system rules"),
    "existing prompt rules must stay first"
  );
  assert.ok(
    injected.systemPrompt.includes("用户选择的项目目录"),
    "the existing workspace section must survive"
  );
  assert.match(injected.systemPrompt, /<active_application/);
  assert.match(injected.systemPrompt, new RegExp(`resource_id="${resourceId}"`));
  assert.match(injected.systemPrompt, /用户新增的一行/, "the user's change must be summarized");
  assert.match(injected.systemPrompt, /<selection/);
  // The full document is never injected; the Agent calls the application's
  // own read tool for it.
  assert.equal(injected.systemPrompt.includes("非常具体的正文内容\n"), false);
  assert.ok(
    Buffer.byteLength(
      injected.systemPrompt.slice(injected.systemPrompt.indexOf("<active_application")),
      "utf8"
    ) <=
      8 * 1024
  );
});

test("an unbound conversation gets no application context at all", async (t) => {
  // This is the whole of the off state. There is no feature flag any more —
  // binding is the only thing that decides whether an application reaches the
  // model — so a resource merely existing in the workspace must contribute
  // nothing to a turn.
  const { pi, root, taskId } = await harness(t);
  await new ApplicationService(root).createResource({
    taskId,
    kind: "text/markdown",
    title: "left-over.md",
    initialContent: "x",
    actor: { type: "user", id: "local" }
  });
  await pi.handlers.get("context")(
    { messages: [{ role: "user", content: "继续" }] },
    {
      sessionManager: SessionManager.inMemory(),
      ui: { notify() {} }
    }
  );
  const injected = await pi.handlers.get("before_agent_start")({ systemPrompt: "Original system rules" });
  assert.equal(injected.systemPrompt.includes("<active_application"), false);
  assert.equal(injected.systemPrompt.includes("<bound_application"), false);
  assert.equal(injected.systemPrompt.includes("left-over.md"), false);
  // And no application tool is visible while nothing is bound.
  assert.equal(pi.getActiveTools().includes("read_document"), false);
  assert.equal(pi.getActiveTools().includes("patch_document"), false);
});

test("the cursor advances only after the turn carrying the context settles", async (t) => {
  const { call, bind, service, pi, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "doc.md",
    initialContent: "基线\n"
  });
  const resourceId = created.details.resource.resourceId;
  await bind(resourceId);
  await service.applyOperation({
    taskId,
    resourceId,
    operationId: "user-1",
    appType: "text-editor",
    operationType: "text.insert",
    baseRevision: 0,
    payload: { at: 0, text: "用户改的\n" },
    actor: { type: "user", id: "local" }
  });

  const runContext = { sessionManager: SessionManager.inMemory(), ui: { notify() {} } };
  await pi.handlers.get("context")({ messages: [{ role: "user", content: "继续" }] }, runContext);
  await pi.handlers.get("before_agent_start")({ systemPrompt: "rules" });

  // The model never got to run. The same change must still be pending.
  assert.equal(
    (await service.activeContext({ taskId, agentId: "main" })).changesSinceAgentRevision.length,
    1
  );

  await pi.handlers.get("context")({ messages: [{ role: "user", content: "继续" }] }, runContext);
  await pi.handlers.get("before_agent_start")({ systemPrompt: "rules" });
  await pi.handlers.get("agent_settled")({}, runContext);
  assert.equal(
    (await service.activeContext({ taskId, agentId: "main" })).changesSinceAgentRevision.length,
    0
  );
});

test("a resource created by a tool is immediately one of the Task's deliverables", async (t) => {
  const { call, root, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "报告.md",
    initialContent: "# 报告\n结论\n"
  });
  // There is no publish tool: saving is saving, and the outputs view maps the
  // resource in on its own.
  assert.equal(call.publish, undefined);
  const rows = await new ApplicationService(root).deliverables(taskId, []);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.name]),
    [["resource", "报告.md"]]
  );
  const { readFile } = await import("node:fs/promises");
  assert.equal(
    await readFile(join(root, "applications", "text-editor", "files", created.details.resource.path), "utf8"),
    "# 报告\n结论\n"
  );
});

test("binding an application also gives the Agent its skills, tools and working directory", async (t) => {
  const { root, taskId } = await harness(t);
  const { ApplicationRegistry } = await import("../dist/src/applications/registry.js");
  const { textRuntimeAdapter } =
    await import("../dist/test/fixtures/application-contract/text-runtime-adapter.js");

  // A second application that brings domain knowledge and one specialized
  // tool. Generic tools say *how* to change a resource; this says how to work
  // in the domain — which is what the tool list alone cannot carry.
  const measured = [];
  const cad = {
    definition: {
      appType: "cad",
      displayName: "CAD",
      version: "1",
      resourceKinds: ["model/cad+json"],
      capabilities: ["view", "edit", "agent-commands"],
      fileExtensions: { "model/cad+json": ".cad.json" },
      operationSchemas: { "cad.set_parameter": { description: "设置参数", required: ["name", "value"] } },
      exportFormats: ["json"],
      skillRoots: [".pi/skills"]
    },
    createContent: () => ({ parameters: {} }),
    serialize: (content) => `${JSON.stringify(content ?? {}, null, 2)}\n`,
    parse: (raw) => JSON.parse(raw || "{}"),
    applyOperation({ payload, content }) {
      const next = { parameters: { ...(content?.parameters ?? {}), [payload.name]: payload.value } };
      return {
        content: next,
        summary: `把 ${payload.name} 设为 ${payload.value}`,
        inverse: {
          operationType: "cad.set_parameter",
          payload: { name: payload.name, value: content?.parameters?.[payload.name] ?? null }
        }
      };
    },
    summarizeSelection: () => "选中一个实体",
    summarizeContext: () => ({ shape: "一个参数化模型" }),
    exportResource: ({ content }) => ({
      fileName: "model.json",
      mimeType: "application/json",
      body: JSON.stringify(content)
    }),
    agentTools: () => [
      {
        name: "cad_measure_distance",
        description: "测量两个实体之间的距离。",
        parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
        async execute({ params, content }) {
          measured.push(params);
          // An adapter tool returns operations rather than writing, so the write
          // still goes through revision CAS.
          return {
            result: { distance: 42, parameters: content?.parameters ?? {} },
            operations: [{ operationType: "cad.set_parameter", payload: { name: "lastMeasured", value: 42 } }]
          };
        }
      }
    ]
  };

  const registry = new ApplicationRegistry().register(textRuntimeAdapter).register(cad);
  const service = new ApplicationService(root, registry);
  const created = await service.createResource({
    taskId,
    appType: "cad",
    kind: "model/cad+json",
    title: "支架",
    actor: { type: "user", id: "local" }
  });
  // Binding is the user's act; creating the resource only opened a tab.
  await service.bindResource(taskId, created.resource.resourceId);

  const bound = await service.boundCapabilities({ taskId, agentId: "main" });
  assert.equal(bound.appType, "cad");
  assert.equal(bound.displayName, "CAD");
  // The Agent is told where the resource lives and where to work.
  assert.match(bound.resourcePath, /支架\.cad\.json$/);
  // Under the application, not the Task: the resource belongs to the
  // application and is referenced by however many conversations want it.
  assert.equal(bound.workspaceDirectory, join(root, "applications", "cad", "files"));
  assert.deepEqual(bound.skillRoots, [".pi/skills"], "the application's own skills travel with the binding");
  assert.deepEqual(
    bound.tools.map((tool) => tool.name),
    ["cad_measure_distance"]
  );

  // The specialized tool's write goes through the ordinary protocol.
  const read = await service.readResource(taskId, created.resource.resourceId, { limit: 1 });
  const outcome = await bound.tools[0].execute({
    params: { from: "a", to: "b" },
    content: read.snapshot.content,
    resource: read.resource
  });
  assert.deepEqual(measured, [{ from: "a", to: "b" }]);
  assert.equal(outcome.result.distance, 42);
  assert.deepEqual(outcome.operations, [
    { operationType: "cad.set_parameter", payload: { name: "lastMeasured", value: 42 } }
  ]);

  // Unbinding takes all of it away: no context, no capabilities.
  await service.bindResource(taskId, undefined);
  assert.equal(await service.boundCapabilities({ taskId, agentId: "main" }), undefined);
});

test("an application contributes its own tools but no skill it does not need", async (t) => {
  const { call, bind, root, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "普通文档.md",
    initialContent: "x"
  });
  await bind(created.details.resource.resourceId);
  const bound = await new ApplicationService(root).boundCapabilities({ taskId, agentId: "main" });
  assert.equal(bound.appType, "text-editor");
  assert.deepEqual(bound.skillRoots, [], "the text editor needs no domain skill");
  // It does declare its own tools, for reading as well as writing. Editing
  // text is its domain, and the generic protocol is the wrong shape for a
  // model — offsets it cannot compute; reading is its domain too, now that
  // there is no generic read to fall back on. A CAD adapter will declare quite
  // different ones, which is the point.
  assert.deepEqual(bound.tools.map((tool) => tool.name).sort(), [
    "outline_document",
    "patch_document",
    "read_document",
    "write_document"
  ]);
  // It still says where work happens.
  assert.equal(bound.workspaceDirectory, join(root, "applications", "text-editor", "files"));
  assert.match(bound.resourcePath, /普通文档\.md$/);
});

test("the bound application is named in the prompt along with where to work", async (t) => {
  const { call, bind, pi } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 方案\n"
  });
  await bind(created.details.resource.resourceId);
  await pi.handlers.get("context")(
    { messages: [{ role: "user", content: "继续" }] },
    {
      sessionManager: SessionManager.inMemory(),
      ui: { notify() {} }
    }
  );
  const injected = await pi.handlers.get("before_agent_start")({ systemPrompt: "Original system rules" });
  assert.match(injected.systemPrompt, /<bound_application>/);
  assert.match(injected.systemPrompt, /文本编辑器/);
  assert.match(injected.systemPrompt, /方案\.md/);
  assert.match(injected.systemPrompt, /workspace/);
  // The warning that matters: ordinary writes bypass the version protocol. It
  // is stated here and nowhere else — `<active_application>` used to repeat it
  // without being able to name the tools that replace write/edit.
  assert.match(injected.systemPrompt, /write\/edit/);
  assert.match(injected.systemPrompt, /绕过版本协议/);
  // And the offset hazard now lives with the tool it is about, so it only
  // reaches the prompt while that tool is active.
  const fallback = pi.tools.get("apply_resource_operation");
  assert.match(fallback.promptGuidelines.join("\n"), /line number/i, "the offset hazard belongs to the tool");
  assert.equal(
    /UTF-16/.test(injected.systemPrompt.match(/<bound_application>[\s\S]*?<\/bound_application>/)[0]),
    false,
    "and is not restated in the bound block"
  );
  assert.ok(injected.systemPrompt.startsWith("Original system rules"), "existing prompt rules stay first");
});

test("a resource whose filename differs from its title is named as one document", async (t) => {
  // The failure this pins cost a real run four minutes. A document titled
  // 「算法.md」 was stored as `算法 2.md`, because the store sidesteps a name
  // collision. The prompt opened with the path and the next line named the
  // title, so it read as two different files — and the model did the
  // reasonable thing: four `bash` calls hunting a directory that also held
  // 算法大全.md and 算法合集.md, before it finally trusted the binding.
  const { call, bind, turn, pi } = await harness(t);
  const first = await call("create_resource", {
    kind: "text/markdown",
    title: "算法.md",
    initialContent: "# 一\n"
  });
  const second = await call("create_resource", {
    kind: "text/markdown",
    title: "算法.md",
    initialContent: "# 二\n"
  });
  // Same title, so the store had to pick a different filename for the second.
  assert.equal(second.details.resource.title, "算法.md");
  assert.notEqual(second.details.resource.path, first.details.resource.path);

  await bind(second.details.resource.resourceId);
  await turn();
  const prompt = (await pi.handlers.get("before_agent_start")({ systemPrompt: "BASE" })).systemPrompt;
  const section = prompt.slice(prompt.indexOf("<bound_application>"));

  // The title leads, because that is what the user calls it.
  assert.match(section, /正在编辑《算法\.md》/);
  // And the mismatch is stated as ordinary rather than left to be discovered.
  assert.match(
    section,
    new RegExp(`磁盘上的文件名是 ${second.details.resource.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(section, /指的是同一份文档/);
  // Going to the disk to work out which file is meant is exactly what must
  // not happen, so the prompt says not to and names the tool that replaces it.
  assert.match(section, /不需要用 bash\/find\/ls/);
  assert.match(section, /用 这个应用的读取工具 读到的就是它/);
});

test("a resource whose filename matches its title says so plainly", async (t) => {
  // The reconciliation above is only worth its words when there is something
  // to reconcile. With no collision the prompt must not manufacture doubt.
  const { call, bind, turn, pi } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "唯一方案.md",
    initialContent: "# 方案\n"
  });
  assert.equal(created.details.resource.path, "唯一方案.md", "no collision, so the filename is the title");

  await bind(created.details.resource.resourceId);
  await turn();
  const prompt = (await pi.handlers.get("before_agent_start")({ systemPrompt: "BASE" })).systemPrompt;
  const section = prompt.slice(prompt.indexOf("<bound_application>"));

  assert.match(section, /正在编辑《唯一方案\.md》/);
  assert.equal(
    /标题和文件名不一致/.test(section),
    false,
    "nothing to reconcile, so nothing is said about it"
  );
  assert.match(section, /它的文件是/);
});

test("the prompt says that the user's own words refer to the bound document", async (t) => {
  // The bug this pins: everything in the prompt described the resource, but
  // nothing said that "把这一段写具体点" is *about* it. The base prompt teaches
  // at length that deliverables go in `artifacts/` and never mentions shared
  // resources, so the model followed those rules and wrote a new file instead
  // of editing the document open in front of the person.
  const { call, bind, pi } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 方案\n"
  });
  await bind(created.details.resource.resourceId);
  await pi.handlers.get("context")(
    { messages: [{ role: "user", content: "把这一段写得更具体" }] },
    {
      sessionManager: SessionManager.inMemory(),
      ui: { notify() {} }
    }
  );
  const injected = await pi.handlers.get("before_agent_start")({
    systemPrompt: "交付文件请写入 artifacts/。"
  });
  const bound = injected.systemPrompt.match(/<bound_application>[\s\S]*?<\/bound_application>/)[0];

  // Named, so the instruction is about this document rather than "the bound one".
  assert.match(bound, /方案\.md/);
  // The deictic rule, which is what was missing when the model wrote a new file.
  assert.match(bound, /这个文件|这份文档/, "it must say the user's deictic words mean this document");
  // Ruling out `artifacts/` and new files is no longer done here by listing
  // prohibitions. The base prompt's placement ladder answers it once, with
  // binding as the top rung, so the two cannot disagree — which they did:
  // one sent 生成好的图表 to artifacts while this block claimed every 长文.
  assert.equal(
    /不要写进 artifacts/.test(bound),
    false,
    "the prohibition list moved to one ladder in the base prompt"
  );
});

test("the base prompt follows task intent and keeps application rules out of generic project work", async (t) => {
  // Every other prompt test passes a fake `systemPrompt`, so the claim that
  // the base file and the injected block agree was untestable. This one reads
  // the real file the Dashboard appends.
  const { call, bind, turn, pi } = await harness(t);
  const basePrompt = await readFile(resolve(".pi/prompts/cowork-main.md"), "utf8");
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 方案\n"
  });
  await bind(created.details.resource.resourceId);
  await turn();
  const full = (await pi.handlers.get("before_agent_start")({ systemPrompt: basePrompt })).systemPrompt;
  // Match the real tags, each on its own line. The base prompt now *mentions*
  // `<bound_application>` inside the ladder, so a loose match starts there.
  const bound = full.match(/\n<bound_application>\n[\s\S]*?\n<\/bound_application>/)[0];
  // The injected section, not the base prompt's mention of its name.
  const workspace = full.match(/\n<current_workspace>\n[\s\S]*?\n<\/current_workspace>/)[0];

  assert.equal(
    full.includes("用户会不会动手改它"),
    false,
    "editable files do not automatically become application resources"
  );
  assert.match(basePrompt, /修改项目代码或已有文件时，保留原路径/);
  assert.match(basePrompt, /无关任务继续使用对应的通用能力/);
  assert.match(basePrompt, /独立报告、图片、表格等成品放入 Task 的 artifacts\//);
  assert.match(basePrompt, /只有任务确实需要可交互编辑的应用资源时才创建资源/);

  // The layers keep to themselves. `<current_workspace>` is paths only.
  assert.equal(
    /create_resource|artifacts 目录是|判据/.test(workspace),
    false,
    `<current_workspace> must carry paths, not rules: ${workspace}`
  );
  // And the bound block does not restate the ladder. Checked on the prose,
  // not the whole block: the resource's absolute path legitimately contains
  // directory names like `work` that would otherwise read as a leak.
  const prose = bound
    .split("\n")
    .filter((line) => !line.includes("/"))
    .join("\n");
  for (const leaked of ["create_resource", "artifacts", "产出物面板"]) {
    assert.equal(
      prose.includes(leaked),
      false,
      `<bound_application> must not restate the ladder (${leaked})`
    );
  }
});

test("the bound block stays inside its budget", async (t) => {
  // The guard that makes the restructure hold. The block grew from 8 lines to
  // 14 in one session, one incident at a time, because appending was always
  // the cheapest move. Past this cap the next fix has to displace something,
  // which forces the question of which layer owns it.
  const { call, bind, turn, pi } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 方案\n"
  });
  await bind(created.details.resource.resourceId);
  await turn();
  const full = (await pi.handlers.get("before_agent_start")({ systemPrompt: "BASE" })).systemPrompt;
  const bound = full.match(/<bound_application>[\s\S]*?<\/bound_application>/)[0];
  const lines = bound.split("\n").filter((line) => line.trim());
  assert.ok(
    lines.length <= 12,
    `the bound block is ${lines.length} lines; move something out rather than adding`
  );
  assert.ok(
    Buffer.byteLength(bound, "utf8") <= 1600,
    `the bound block is ${Buffer.byteLength(bound, "utf8")} bytes; move something out rather than adding`
  );
});

test("each shared rule has exactly one owner across the whole prompt", async (t) => {
  // Three facts used to be stated two or three times each, in two languages,
  // across four files. Counting them is what keeps a well-meaning addition
  // from quietly recreating the duplication.
  const { call, bind, turn, pi } = await harness(t);
  const basePrompt = await readFile(resolve(".pi/prompts/cowork-main.md"), "utf8");
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 方案\n"
  });
  await bind(created.details.resource.resourceId);
  await turn();
  const injected = (await pi.handlers.get("before_agent_start")({ systemPrompt: basePrompt })).systemPrompt;

  // "Don't overwrite a resource with write/edit" — only `<bound_application>`,
  // because only it can name the tools that replace them.
  assert.equal((injected.match(/绕过版本协议/g) ?? []).length, 1);
  // The offset hazard belongs to the tool, not to any injected block.
  assert.equal(/UTF-16/.test(injected), false, "the offset hazard lives in the tool's own guidelines");
  assert.match(pi.tools.get("apply_resource_operation").promptGuidelines.join("\n"), /UTF-16/);
});

test("rebinding retires the previous application's tools", async (t) => {
  // The bug this pins actually shipped: removing a name from the tracking set
  // without deactivating it left the tool in `getActiveTools()` with nothing
  // able to take it away, so after rebinding the model saw a CAD tool while
  // editing a text file. Every existing test drove `boundCapabilities` or the
  // adapter's `execute` directly, so none of them went through the extension
  // path where that happens.
  process.env.COWORK_APPLICATION_DUMMY = "1";
  t.after(() => {
    delete process.env.COWORK_APPLICATION_DUMMY;
  });
  const { root, taskId, pi } = await harness(t);
  const service = new ApplicationService(root);

  const counter = await service.createResource({
    taskId,
    appType: "dummy-counter",
    kind: "model/counter+json",
    title: "计数器",
    initialContent: { counters: { opened: 1 } },
    actor: { type: "user", id: "local" }
  });
  const document = await service.createResource({
    taskId,
    appType: "text-editor",
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 方案\n",
    actor: { type: "user", id: "local" }
  });

  // Bind the counter, then run the turn hook that prepares the binding.
  await service.bindResource(taskId, counter.resource.resourceId);
  const context = pi.handlers.get("context");
  await context({ messages: [] }, { sessionManager: SessionManager.inMemory() });
  const boundToCounter = pi.getActiveTools();
  assert.ok(boundToCounter.includes("counter_reset_all"), "the bound application's tool is visible");

  // Rebinding to a different application must take the first one's tools away.
  await service.bindResource(taskId, document.resource.resourceId);
  await context({ messages: [] }, { sessionManager: SessionManager.inMemory() });
  const boundToText = pi.getActiveTools();
  // Name the tool outright. Deriving the expectation from the same list being
  // checked made the assertion vacuously true — it passed against the broken
  // code, which is the one thing a regression test must not do.
  assert.equal(
    boundToText.includes("counter_reset_all"),
    false,
    `the counter's tool must not survive the rebind, saw: ${boundToText.join(", ")}`
  );

  // The generic tools belong to the platform and stay throughout.
  for (const generic of ["list_resource_changes", "apply_resource_operation"]) {
    assert.ok(boundToText.includes(generic), `${generic} is the platform's, not an application's`);
  }
  // The text editor's own read tool arrives with the binding, and the
  // counter's goes with it: reading is an application capability now.
  assert.ok(boundToText.includes("read_document"), "the newly bound application's read tool is visible");
  assert.equal(boundToText.includes("list_counters"), false, "and the previous one's is gone");

  // Unbinding entirely leaves only the platform's own tools.
  await service.bindResource(taskId, undefined);
  await context({ messages: [] }, { sessionManager: SessionManager.inMemory() });
  const unbound = pi.getActiveTools();
  assert.ok(unbound.includes("list_resource_changes"));
  assert.equal(unbound.includes("read_document"), false, "no application tool outlives its binding");
  assert.equal(await service.boundCapabilities({ taskId, agentId: "main" }), undefined);
});

test("the text editor's own patch tool reaches the model and its write lands", async (t) => {
  // The principle this pins: each application declares the tools that fit its
  // domain, rather than the platform offering one generic surface and hoping it
  // suits. The text editor's protocol operations are offset-based because a
  // protocol must be precise — but a model sees text, and in a real run one
  // failed six times on "at 必须是非负整数" and wrote nothing. So the adapter
  // ships `patch_document`, shaped like the harness's own `apply_patch`.
  const { call, bind, pi, service, taskId } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "方案.md",
    initialContent: "# 产品方案\n\n## 目标用户\n待补充。\n"
  });
  const resourceId = created.details.resource.resourceId;
  await bind(resourceId);
  await pi.handlers.get("context")(
    { messages: [{ role: "user", content: "把目标用户写具体点" }] },
    {
      sessionManager: SessionManager.inMemory(),
      ui: { notify() {} }
    }
  );

  // Registered *and* active: registering without activating leaves a tool the
  // model cannot see, which is how a stale binding used to leak tools.
  assert.ok(pi.tools.has("patch_document"), "the application's own tool is registered while bound");
  assert.ok(pi.getActiveTools().includes("patch_document"), "and visible to the model");

  const patched = await call("patch_document", {
    oldText: "## 目标用户\n待补充。",
    newText: "## 目标用户\n研究员和产品经理。"
  });
  assert.equal(patched.isError, false, JSON.stringify(patched.details));

  // The write really landed, through the ordinary versioned path: a specialized
  // tool returns operations rather than writing, so it still gets CAS and undo.
  const read = await service.readResource(taskId, resourceId);
  assert.match(read.snapshot.content, /研究员和产品经理。/);
  assert.equal(read.resource.revision, 1, "one operation, one revision");
  const history = await service.readResource(taskId, resourceId, { afterRevision: 0 });
  assert.equal(history.operations.length, 1);
  assert.equal(history.operations[0].actor.type, "agent");
  assert.ok(history.operations[0].inverse, "and it is undoable like any other change");

  // An ambiguous anchor is refused rather than guessed at, with a code the
  // model can recover from.
  // "产品" appears in both the title and the section text after the patch.
  await call("patch_document", {
    oldText: "研究员和产品经理。",
    newText: "研究员和产品经理，以及产品负责人。"
  });
  const ambiguous = await call("patch_document", { oldText: "产品", newText: "產品" });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.details.code, "operation_precondition_failed");
  const unchanged = await service.readResource(taskId, resourceId);
  assert.equal(unchanged.resource.revision, 2, "a refused patch changes nothing");
});

test("binding says where new work goes, not only what the pronouns mean", async (t) => {
  // The failure this pins came from a real session. The document was bound and
  // every rule in the block was phrased around *modifying* it — "这个文件"、
  // "这一段"、"改一下". The user then said 「帮我写一个算法的伪代码」, which names
  // no document at all, so none of those rules matched: the model wrote the
  // pseudocode into the chat and the open document stayed at revision 1, empty
  // but for the title the user had typed themselves.
  //
  // Binding is a standing instruction about where this conversation's output
  // lands, not just a pronoun table.
  const { call, bind, turn, pi } = await harness(t);
  const created = await call("create_resource", {
    kind: "text/markdown",
    title: "排序算法.md",
    initialContent: "# 排序算法\n"
  });
  await bind(created.details.resource.resourceId);
  await turn();
  const section = (await pi.handlers.get("before_agent_start")({ systemPrompt: "BASE" })).systemPrompt;
  const bound = section.slice(section.indexOf("<bound_application>"));

  // The pronoun rule stays — it solved its own bug and is still needed.
  assert.match(bound, /“这个文件”/);
  // And the rule that was missing: produce-and-place, for a request that names
  // no target at all.
  assert.match(bound, /默认写进《排序算法\.md》/);
  assert.match(bound, /而不是把内容只贴在对话里/);
  // With the exceptions stated, so it does not overreach into "先讨论一下".
  assert.match(bound, /只想看看或先讨论/);
});

test("application exports publish real artifacts without rebinding or editing resources", async (t) => {
  const { pi, call, service, root, taskId } = await harness(t);
  const contract = pi.tools.get("export_resource").description;
  assert.match(contract, /application's declared formats and options/);
  assert.doesNotMatch(contract, /Blender|Cycles|768/);

  const text = await call("create_resource", {
    kind: "text/plain",
    title: "导出验收.txt",
    initialContent: "保留正文"
  });
  const id = text.details.resource.resourceId;
  const result = await call("export_resource", { resourceId: id, format: "text" });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.equal(result.details.ok, true);
  assert.equal(await readFile(result.details.path, "utf8"), "保留正文");
  assert.equal(result.details.artifact.displayName, "导出验收.txt");
  assert.deepEqual(result.details.artifact.sourceResource, {
    resourceId: id,
    sha256: result.details.artifact.sha256
  });
  assert.equal(result.details.width, undefined);
  assert.equal(result.details.height, undefined);
  assert.ok(result.details.path.startsWith(join(root, taskId, "artifacts")));
  assert.equal((await service.readResource(taskId, id)).resource.revision, 0);
  assert.equal((await service.boundCapabilities({ taskId, agentId: "main" })).resourceId, id);
  assert.equal((await call("export_resource", { resourceId: id, format: "step" })).isError, true);
  assert.equal((await call("export_resource", { resourceId: "not-owned", format: "text" })).isError, true);
});
