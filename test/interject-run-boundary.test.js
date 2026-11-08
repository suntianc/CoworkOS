import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createDashboardHandler } from "../dist/src/dashboard/routes.js";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-interject-boundary-"));
  const workspaceRoot = join(root, "workspace");
  const store = new LocalWorkspaceStore(workspaceRoot);
  await store.createTask("task", { goal: "验证补充消息始终属于发送时的运行。" });
  await mkdir(join(root, "scripts"));
  const finalAnswer = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "隔离运行正常结束。" }],
      stopReason: "stop",
      timestamp: 1
    }
  });
  await writeFile(
    join(root, "scripts", "start-pi.mjs"),
    `
    import { access } from 'node:fs/promises';
    import { join } from 'node:path';
    console.log(${JSON.stringify(finalAnswer)});
    for (;;) {
      try { await access(join(${JSON.stringify(root)}, 'release-' + process.env.COWORK_RUN_ID)); break; }
      catch { await new Promise((done) => setTimeout(done, 10)); }
    }
  `
  );
  const locateTask = async () => ({ workspaceRoot, store, task: await store.readTask("task") });
  const events = [];
  const appendRunEvent = async (_workspace, _task, runId, type, payload) => {
    events.push({ runId, type, payload });
  };
  const service = createDashboardRunService({
    projectRoot: root,
    tabStorePath: join(root, "tabs.json"),
    dashboardUrl: "http://127.0.0.1:1",
    coordinator: { waitForSubagents: async () => ({ pending: [], callbackPending: [] }) },
    locateTask,
    resolveMainModel: singleConnectionMainModel(),
    normalizeModel: (value) => (typeof value === "string" ? value : undefined),
    appendRunEvent,
    readJsonFile
  });
  const handler = createDashboardHandler({
    dashboardUrl: "http://127.0.0.1:1",
    computer: {},
    locateTask,
    workspaceRoot: () => workspaceRoot,
    activeRuns: service.activeRuns,
    queueInterjection: service.queueInterjection,
    interjectionTarget: service.interjectionTarget,
    appendRunEvent
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  const inbox = (runId) =>
    new InboxStore(join(workspaceRoot, "task", "runs", runId, "agents", "main", "inbox-store.json"));
  async function finish(runId) {
    await writeFile(join(root, `release-${runId}`), "");
    for (let i = 0; i < 500; i += 1) {
      if (!service.activeRuns.has("task")) return store.readTask("task");
      await delay(10);
    }
    assert.fail("隔离运行未结束");
  }
  function interject() {
    const bodyEntered = deferred(),
      releaseBody = deferred();
    const request = Readable.from(
      (async function* () {
        bodyEntered.resolve();
        yield Buffer.from('{"message":');
        await releaseBody.promise;
        yield Buffer.from('"必须保留在原运行的补充消息。","delivery":"steer"}');
      })()
    );
    request.headers = { host: "127.0.0.1:1", "content-type": "application/json" };
    request.method = "POST";
    request.url = "/api/tasks/task/interject";
    const headers = new Map();
    const response = {
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      getHeader(name) {
        return headers.get(name.toLowerCase());
      },
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      }
    };
    const completed = handler(request, response).then(() => response);
    return { bodyEntered: bodyEntered.promise, releaseBody: releaseBody.resolve, completed };
  }
  return { service, store, events, inbox, finish, interject };
}

test("a delayed interjection cannot be accepted into a finished run after the next run starts", async (t) => {
  const f = await fixture(t);
  await f.service.startMainRun("task", "第一轮", "run-old");
  const request = f.interject();
  await request.bodyEntered;
  assert.equal((await f.finish("run-old")).status, "completed");
  await f.service.startMainRun("task", "第二轮", "run-new");
  request.releaseBody();
  const response = await request.completed;
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal((await f.store.readTask("task")).activeRunId, "run-new");
  assert.deepEqual(await f.inbox("run-old").list("main"), []);
  assert.deepEqual(await f.inbox("run-new").list("main"), []);
  assert.equal(
    f.events.some((event) => event.type === "user.interjected"),
    false
  );
});

test("a delayed interjection cannot be accepted after the user stops its run", async (t) => {
  const f = await fixture(t);
  await f.service.startMainRun("task", "第一轮", "run-old");
  const request = f.interject();
  await request.bodyEntered;
  await f.service.cancelTask("task");
  request.releaseBody();
  const response = await request.completed;
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal((await f.store.readTask("task")).status, "cancelled");
  assert.deepEqual(await f.inbox("run-old").list("main"), []);
  assert.equal(
    f.events.some((event) => event.type === "user.interjected"),
    false
  );
});

test("an interjection is durably accepted while its original run is still active", async (t) => {
  const f = await fixture(t);
  await f.service.startMainRun("task", "第一轮", "run-old");
  const request = f.interject();
  await request.bodyEntered;
  request.releaseBody();
  const response = await request.completed;
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(response.body.runId, "run-old");
  const messages = await f.inbox("run-old").list("main");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, response.body.messageId);
  assert.equal(messages[0].payload.message, "必须保留在原运行的补充消息。");
  assert.equal(f.events.filter((event) => event.type === "user.interjected").length, 1);
});

test("a delayed interjection cannot reach a resumed Main process that reuses the same run id", async (t) => {
  const f = await fixture(t);
  await f.service.startMainRun("task", "第一轮", "run-old");
  const request = f.interject();
  await request.bodyEntered;
  await f.service.cancelTask("task");
  await f.service.startMainRun("task", "继续同一轮", "run-old", true);
  request.releaseBody();
  const response = await request.completed;
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal((await f.store.readTask("task")).activeRunId, "run-old");
  assert.equal(f.service.activeRuns.has("task"), true);
  assert.deepEqual(await f.inbox("run-old").list("main"), []);
  assert.equal(
    f.events.some((event) => event.type === "user.interjected"),
    false
  );
});
