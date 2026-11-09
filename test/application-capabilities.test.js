import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { applicationCapabilityProvider, resourceGrants, acceptResourceCandidate } =
  await import("../dist/src/applications/agent-capabilities.js");
const { LocalWorkspaceStore } = await import("../dist/src/workspace/workspace-store.js");
const { DurableScheduler } = await import("../dist/src/runtime/scheduler.js");
const { CoordinatorRuntime } = await import("../dist/src/runtime/coordinator-runtime.js");
const { capabilityProvider, addCapabilityTools } = await import("../dist/src/runtime/capability-provider.js");
const { attachmentGrants, attachmentCapabilityProvider } =
  await import("../dist/src/workspace/attachment-capabilities.js");
const { InputStore } = await import("../dist/src/workspace/input-store.js");

async function fixture(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-resource-delegation-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(workspaceRoot),
    taskId = "task",
    runId = "run";
  await store.createTask(taskId);
  await store.createRun(taskId, runId);
  const service = new ApplicationService(workspaceRoot);
  const create = async (content = "alpha beta") =>
    (
      await service.createResource({
        taskId,
        appType: "text-editor",
        kind: "text/plain",
        title: "shared.txt",
        initialContent: content,
        actor: { type: "user", id: "user" }
      })
    ).resource;
  const resource = await create();
  const provider = applicationCapabilityProvider(service, resolve("."));
  const delegate = async (
    access,
    agentId = "editor",
    resources = [{ resourceId: resource.resourceId, access }]
  ) => {
    const grants = await resourceGrants(service, taskId, resources);
    const callId = `call-${agentId}`;
    await new DurableScheduler(join(workspaceRoot, taskId, "runs", runId, "queue.json")).enqueue({
      stepId: callId,
      taskId,
      runId,
      agentId,
      importance: 1,
      payload: { capabilityGrants: grants }
    });
    const context = {
      taskId,
      runId,
      callId,
      agentId,
      workspaceRoot,
      workingDirectory: await store.prepareAgentWorkDir(taskId, runId, agentId),
      supportsImages: true
    };
    return { ...(await provider(grants, context)), context, grants };
  };
  const call = async (delegate, name, params = {}) => {
    const result = await delegate.tools.get(name).execute(params);
    if (result.isError) throw Object.assign(new Error(result.details.error), result.details);
    return result.details;
  };
  const accept = (candidatePath) =>
    acceptResourceCandidate(service, {
      workspaceRoot,
      taskId,
      candidatePath,
      actor: { type: "agent", id: "main" }
    });
  return { workspaceRoot, store, taskId, runId, service, resource, create, provider, delegate, call, accept };
}

test("read grants expose only declared readers and reject unrelated resource IDs", async (t) => {
  const f = await fixture(t),
    read = await f.delegate("read");
  assert.deepEqual([...read.tools.keys()].sort(), ["outline_document", "read_document"]);
  const other = await f.create("private");
  assert.equal(
    (await read.tools.get("read_document").execute({ resourceId: other.resourceId })).isError,
    true
  );
  assert.match((await f.call(read, "read_document")).result.content, /alpha/);
  assert.equal((await f.service.readResource(f.taskId, f.resource.resourceId)).resource.revision, 0);
  await assert.rejects(
    resourceGrants(f.service, "other-task", [{ resourceId: f.resource.resourceId, access: "candidate" }])
  );
});

test("candidate edits are private, cumulatively previewable, atomic, idempotent and undoable", async (t) => {
  const f = await fixture(t),
    edit = await f.delegate("candidate");
  assert.equal((await edit.tools.get("write_document").execute({ content: "unread" })).isError, true);
  await f.call(edit, "read_document");
  await f.call(edit, "patch_document", { oldText: "alpha", newText: "ALPHA" });
  const next = await f.call(edit, "patch_document", { oldText: "beta", newText: "BETA" });
  assert.equal(next.saved, false);
  assert.equal(next.candidate.operationCount, 2);
  assert.equal((await f.call(edit, "read_document")).result.content, "ALPHA BETA");
  assert.equal(
    (await f.service.readResource(f.taskId, f.resource.resourceId)).snapshot.content,
    "alpha beta"
  );
  const accepted = await f.accept(next.candidate.candidatePath);
  assert.equal(accepted.revision, 1, "two changes commit as one revision");
  assert.equal((await f.accept(next.candidate.candidatePath)).deduplicated, true);
  assert.equal(
    (await f.service.readResource(f.taskId, f.resource.resourceId)).snapshot.content,
    "ALPHA BETA"
  );
  const review = await f.service.reviewResource(f.taskId, f.resource.resourceId);
  assert.equal(review.before, "alpha beta");
  assert.equal(review.after, "ALPHA BETA");
  await f.service.undo({
    taskId: f.taskId,
    resourceId: f.resource.resourceId,
    actor: { type: "user", id: "user" }
  });
  assert.equal(
    (await f.service.readResource(f.taskId, f.resource.resourceId)).snapshot.content,
    "alpha beta"
  );
});

test("parallel candidates never race to save, and stale acceptance preserves the winning document", async (t) => {
  const f = await fixture(t),
    a = await f.delegate("candidate", "a"),
    b = await f.delegate("candidate", "b");
  await Promise.all([f.call(a, "read_document"), f.call(b, "read_document")]);
  const [one, two] = await Promise.all([
    f.call(a, "write_document", { content: "candidate A" }),
    f.call(b, "write_document", { content: "candidate B" })
  ]);
  assert.equal((await f.service.readResource(f.taskId, f.resource.resourceId)).resource.revision, 0);
  await f.accept(one.candidate.candidatePath);
  await assert.rejects(f.accept(two.candidate.candidatePath), (error) => error.code === "revision_conflict");
  assert.equal(
    (await f.service.readResource(f.taskId, f.resource.resourceId)).snapshot.content,
    "candidate A"
  );
  assert.equal(
    JSON.parse(await readFile(join(f.workspaceRoot, f.taskId, two.candidate.candidatePath), "utf8"))
      .baseRevision,
    0
  );
});

test("human edits invalidate candidates both before compute and before acceptance", async (t) => {
  const f = await fixture(t),
    edit = await f.delegate("candidate");
  await f.call(edit, "read_document");
  const candidate = await f.call(edit, "write_document", { content: "agent candidate" });
  await f.service.applyOperation({
    taskId: f.taskId,
    resourceId: f.resource.resourceId,
    appType: "text-editor",
    operationId: "human-edit",
    operationType: "text.insert",
    payload: { at: 0, text: "HUMAN " },
    baseRevision: 0,
    actor: { type: "user", id: "user" }
  });
  const further = await edit.tools.get("write_document").execute({ content: "overwrite" });
  assert.equal(further.details.code, "revision_conflict");
  await assert.rejects(
    f.accept(candidate.candidate.candidatePath),
    (error) => error.code === "revision_conflict"
  );
  assert.equal(
    (await f.service.readResource(f.taskId, f.resource.resourceId)).snapshot.content,
    "HUMAN alpha beta"
  );
});

test("bad operations leave an atomic batch and its revision completely unchanged", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.applyOperation({
      taskId: f.taskId,
      resourceId: f.resource.resourceId,
      appType: "text-editor",
      operationId: "invalid-batch",
      operationType: "resource.batch",
      baseRevision: 0,
      payload: {
        operations: [
          { operationType: "text.insert", payload: { at: 0, text: "partial" } },
          { operationType: "unknown", payload: {} }
        ]
      },
      actor: { type: "agent", id: "main" }
    })
  );
  const read = await f.service.readResource(f.taskId, f.resource.resourceId);
  assert.equal(read.snapshot.content, "alpha beta");
  assert.equal(read.resource.revision, 0);
  assert.equal(read.operations.length, 0);
});

test("receipt edits cannot widen the durable grant or escape the delegate deliverables", async (t) => {
  const f = await fixture(t),
    edit = await f.delegate("candidate");
  const other = await f.create("untouched");
  await f.call(edit, "read_document");
  const candidate = await f.call(edit, "write_document", { content: "candidate" });
  const path = join(f.workspaceRoot, f.taskId, candidate.candidate.candidatePath);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...receipt, resourceId: other.resourceId }));
  await assert.rejects(f.accept(candidate.candidate.candidatePath), /durable delegation grant/);
  await assert.rejects(f.accept("../../outside.json"));
  assert.equal((await f.service.readResource(f.taskId, other.resourceId)).snapshot.content, "untouched");
});

test("candidate state resumes only within its original call and grant", async (t) => {
  const f = await fixture(t),
    edit = await f.delegate("candidate");
  await f.call(edit, "read_document");
  await f.call(edit, "patch_document", { oldText: "alpha", newText: "ALPHA" });
  const resumed = await f.provider(edit.grants, edit.context);
  await f.call(resumed, "read_document");
  const result = await f.call(resumed, "patch_document", { oldText: "beta", newText: "BETA" });
  assert.equal(result.candidate.operationCount, 2);
  await f.accept(result.candidate.candidatePath);
});

test("multiple same-domain resources require explicit routing without cross-resource edits", async (t) => {
  const f = await fixture(t),
    other = await f.create("other");
  const edit = await f.delegate("candidate", "multi", [
    { resourceId: f.resource.resourceId, access: "read" },
    { resourceId: other.resourceId, access: "candidate" }
  ]);
  assert.equal((await edit.tools.get("read_document").execute({})).isError, true);
  await f.call(edit, "read_document", { resourceId: other.resourceId });
  assert.equal(
    (await edit.tools.get("write_document").execute({ resourceId: f.resource.resourceId, content: "wrong" }))
      .isError,
    true
  );
  const result = await f.call(edit, "write_document", { content: "right" });
  await f.accept(result.candidate.candidatePath);
  assert.equal((await f.service.readResource(f.taskId, other.resourceId)).snapshot.content, "right");
  assert.equal(
    (await f.service.readResource(f.taskId, f.resource.resourceId)).snapshot.content,
    "alpha beta"
  );
});

test("attachment providers use the native reader with explicit IDs and reject other uploads", async (t) => {
  const f = await fixture(t),
    inputs = new InputStore(join(f.workspaceRoot, "uploads"));
  const first = await inputs.receive("source.txt", Readable.from([Buffer.from("real source")]));
  const second = await inputs.receive("other.txt", Readable.from([Buffer.from("unshared")]));
  await inputs.attach(f.workspaceRoot, f.taskId, [first.uploadId, second.uploadId]);
  const grants = await attachmentGrants(join(f.workspaceRoot, f.taskId), [first.uploadId]);
  const delegate = await f.delegate("read");
  const provided = await attachmentCapabilityProvider(resolve("."))(grants, delegate.context);
  const read = await provided.tools.get("read_attachment").execute({ id: first.uploadId });
  assert.equal(read.details.text, "real source");
  await assert.rejects(
    provided.tools.get("read_attachment").execute({ id: second.uploadId }),
    /outside delegated scope/
  );
});

test("providers compose independently and cannot silently replace core tools", async () => {
  assert.throws(
    () => addCapabilityTools(new Map([["read_file", {}]]), new Map([["read_file", {}]])),
    /collides/
  );
  const provided = await capabilityProvider(
    new Map([
      ["a", async () => ({ tools: new Map([["one", {}]]) })],
      ["b", async () => ({ tools: new Map([["two", {}]]) })]
    ])
  )(
    [
      { provider: "a", scope: [] },
      { provider: "b", scope: [] }
    ],
    {}
  );
  assert.deepEqual([...provided.tools.keys()], ["one", "two"]);
});

async function modelFixture(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    requests.push(input);
    const toolNames = input.tools.map((tool) => tool.function.name);
    const resultCount = input.messages.filter((message) => message.role === "tool").length;
    const name = toolNames.includes("write_document") && resultCount ? "write_document" : "read_document";
    const stop = resultCount >= (toolNames.includes("write_document") ? 2 : 1);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "scope-fixture", object: "chat.completion.chunk", created: 1, model: "scope-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant" });
    if (stop) {
      send({ content: "Checked actual tool results; candidate remains for Main review." });
      send({}, "stop");
    } else {
      send({
        tool_calls: [
          {
            index: 0,
            id: `tool-${resultCount}`,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(name === "write_document" ? { content: "model candidate" } : {})
            }
          }
        ]
      });
      send({}, "tool_calls");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "fixture",
    model: "scope-fixture",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    maxTurns: 5,
    timeoutMs: 5000,
    maxErrorRetries: 0
  };
}

test(
  "real Pi delegates share domain tools headlessly and leave acceptance to Main",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      model = await modelFixture(t);
    const grants = await resourceGrants(f.service, f.taskId, [
      { resourceId: f.resource.resourceId, access: "candidate" }
    ]);
    const result = await new CoordinatorRuntime().dispatch({
      ...model,
      taskId: f.taskId,
      runId: f.runId,
      agentId: "real-editor",
      callId: "real-edit",
      workspaceRoot: f.workspaceRoot,
      task: "Edit the explicitly shared resource as a candidate.",
      mode: "sync",
      skillRoots: [],
      capabilityProvider: f.provider,
      capabilityGrants: grants
    });
    assert.equal(result.status, "succeeded", result.error);
    assert.ok(model.requests[0].tools.some((tool) => tool.function.name === "write_document"));
    assert.ok(!model.requests[0].tools.some((tool) => tool.function.name === "computer_act"));
    assert.equal((await f.service.readResource(f.taskId, f.resource.resourceId)).resource.revision, 0);
    const candidate = result.outputFiles.find((path) => /candidate-.*\.json$/.test(path));
    assert.ok(candidate, JSON.stringify(result));
    await f.accept(candidate);
    assert.equal(
      (await f.service.readResource(f.taskId, f.resource.resourceId)).snapshot.content,
      "model candidate"
    );
  }
);

test(
  "queue recovery preserves original read scope independently of a new Main binding",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      model = await modelFixture(t);
    const grants = await resourceGrants(f.service, f.taskId, [
      { resourceId: f.resource.resourceId, access: "read" }
    ]);
    const runtime = new CoordinatorRuntime();
    // dispatch owns every failure after the call record exists: the throw from
    // onQueued settles that record and the queued item stays the durable
    // identity the next recovery re-drives.
    const interrupted = await runtime.dispatch({
      ...model,
      taskId: f.taskId,
      runId: f.runId,
      agentId: "recovered",
      callId: "recover",
      workspaceRoot: f.workspaceRoot,
      task: "Read resource",
      mode: "async",
      skillRoots: [],
      capabilityProvider: f.provider,
      capabilityGrants: grants,
      onQueued() {
        throw new Error("process interruption");
      }
    });
    assert.equal(interrupted.status, "failed");
    assert.match(interrupted.error, /process interruption/);
    const other = await f.create("bound elsewhere");
    await f.service.bindResource(f.taskId, other.resourceId);
    const result = await new CoordinatorRuntime().recoverRun({
      ...model,
      taskId: f.taskId,
      runId: f.runId,
      workspaceRoot: f.workspaceRoot,
      skillRoots: [],
      capabilityProvider: f.provider
    });
    assert.equal(result[0].status, "succeeded", result[0].error);
    const names = model.requests[0].tools.map((tool) => tool.function.name);
    assert.ok(names.includes("read_document"));
    assert.ok(!names.includes("write_document"));
    assert.ok(!JSON.stringify(model.requests).includes("bound elsewhere"));
  }
);
