import "./application-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { ApplicationService } = await import("../dist/src/applications/application-service.js");
const { WorkbenchTabStore } = await import("../dist/src/applications/tab-store.js");
const { handleApplicationRequest } = await import("../dist/src/dashboard/application-routes.js");

const actor = { type: "user", id: "read-cost-fixture" };

async function fixture(t, size = 40) {
  const root = await mkdtemp(join(tmpdir(), "atria-tab-read-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "storage");
  const documents = join(root, "documents");
  await Promise.all([mkdir(storage), mkdir(documents)]);
  const service = new ApplicationService(documents, undefined, storage);
  await new ApplicationService(storage).instances.listInstances();
  const tabStorePath = join(root, "tabs.json");
  const tabs = new WorkbenchTabStore(tabStorePath);
  const created = [];
  for (let index = 0; index < size; index++) {
    const document = await service.createResource({
      taskId: "fixture",
      kind: "text/plain",
      title: `fixture-${index}.txt`,
      initialContent: "x".repeat(1024),
      actor
    });
    created.push(document);
    await tabs.open({ kind: "application", appInstanceId: document.appInstance.appInstanceId });
  }
  let discoveries = 0;
  const context = {
    tabStorePath,
    defaultWorkspaceRoot: storage,
    locate: async () => {
      throw new Error("no conversations");
    },
    referencingTasks: async () => [],
    workspaceRoots: async () => {
      discoveries++;
      return [storage, documents];
    },
    mcp: { statuses: async () => [] }
  };
  async function request(endpoint) {
    let result;
    await handleApplicationRequest(
      { method: "GET" },
      {
        setHeader() {},
        getHeader() {},
        writeHead(status) {
          assert.equal(status, 200);
        },
        end(body) {
          result = JSON.parse(body);
        }
      },
      new URL(`http://localhost/api/workbench/${endpoint}`),
      context
    );
    return result;
  }
  async function measure(endpoint) {
    discoveries = 0;
    const counts = {
      reads: 0,
      instanceIndexes: 0,
      holdingTasks: 0,
      holdingMappings: 0,
      readBytes: 0,
      missing: 0,
      writeOpens: 0,
      renames: 0
    };
    const methods = ["readFile", "open", "lstat", "stat", "readdir", "rename", "mkdir"];
    const originals = new Map(methods.map((method) => [method, fs.promises[method]]));
    for (const method of methods) {
      fs.promises[method] = async (...args) => {
        const path = String(args[0]);
        if (method === "readFile") {
          counts.reads++;
          if (path.endsWith("/applications/instances/index.json")) counts.instanceIndexes++;
          if (path.endsWith("/workspace/task.json")) counts.holdingTasks++;
          if (path.endsWith("/workspace/applications/mapping.json")) counts.holdingMappings++;
        }
        if (method === "open" && String(args[1]).includes("w")) counts.writeOpens++;
        if (method === "rename") counts.renames++;
        try {
          const value = await originals.get(method)(...args);
          if (method === "readFile") counts.readBytes += Buffer.byteLength(value);
          return value;
        } catch (error) {
          if (error.code === "ENOENT") counts.missing++;
          throw error;
        }
      };
    }
    syncBuiltinESMExports();
    const began = performance.now();
    try {
      const result = await request(endpoint);
      return { endpoint, discoveries, ...counts, elapsedMs: +(performance.now() - began).toFixed(1), result };
    } finally {
      for (const [method, original] of originals) fs.promises[method] = original;
      syncBuiltinESMExports();
    }
  }
  return { service, storage, documents, created, request, measure };
}

test("40-window revision and tab snapshots share root discovery, instance indexes and holding context", async (t) => {
  const f = await fixture(t);
  await f.request("tabs");
  await f.request("revisions");
  const costs = [];
  for (const endpoint of ["revisions", "tabs"]) {
    const { result, ...cost } = await f.measure(endpoint);
    assert.equal((result.tabs ?? result.instances).length, 40);
    costs.push(cost);
    t.diagnostic(JSON.stringify(cost));
  }
  for (const cost of costs) {
    assert.equal(cost.discoveries, 1, `${cost.endpoint}: one root discovery per request`);
    assert.ok(
      cost.instanceIndexes <= 6,
      `${cost.endpoint}: indexes read ${cost.instanceIndexes} times for two roots`
    );
    assert.ok(cost.holdingTasks <= 4, `${cost.endpoint}: holding task read ${cost.holdingTasks} times`);
    assert.ok(
      cost.holdingMappings <= 1,
      `${cost.endpoint}: holding mapping read ${cost.holdingMappings} times`
    );
  }
});

test("request snapshots observe rename, close, external edits and unfinished transactions on the next request", async (t) => {
  const f = await fixture(t, 2);
  const first = f.created[0];
  await f.request("tabs");
  await f.service.resources.rename("text-editor", first.resource.resourceId, "renamed.txt");
  await f.service.instances.updateInstance(f.created[1].appInstance.appInstanceId, { status: "closed" });
  const renamed = await f.request("tabs");
  assert.equal(renamed.tabs.length, 1);
  assert.equal(renamed.tabs[0].title, "renamed.txt");
  const metadata = await f.service.resources.readMetadataById(first.resource.resourceId);
  await writeFile(
    join(f.documents, "applications", "text-editor", "files", metadata.path),
    "external edit\n"
  );
  await f.request("tabs");
  const feed = await f.request("revisions");
  assert.equal(feed.instances[0].revision, 1, "listing retains filesystem change detection");
  await assert.rejects(
    f.service.applyOperation({
      taskId: "fixture",
      resourceId: first.resource.resourceId,
      appType: "text-editor",
      operationId: "stale-save",
      operationType: "text.insert",
      baseRevision: 0,
      payload: { at: 0, text: "stale" },
      actor
    }),
    { code: "revision_conflict" }
  );
  const transactions = join(f.documents, ".runtime", "applications", "transactions");
  await mkdir(transactions, { recursive: true });
  const marker = join(transactions, `${first.resource.resourceId}.json`);
  await writeFile(marker, JSON.stringify({ fixture: "pending" }));
  assert.deepEqual((await f.request("revisions")).instances, []);
  await unlink(marker);
  assert.equal((await f.request("revisions")).instances[0].revision, 1);
});

test("a missing holding reference is restored without dropping other documents", async (t) => {
  const f = await fixture(t, 2);
  const resourceId = f.created[0].resource.resourceId;
  await f.service.mapping.remove(ApplicationService.STANDALONE_TASK, resourceId);
  assert.equal(await f.service.mapping.references(ApplicationService.STANDALONE_TASK, resourceId), false);
  const { tabs } = await f.request("tabs");
  assert.equal(tabs.length, 2);
  assert.deepEqual(
    new Set(
      (await f.service.mapping.list(ApplicationService.STANDALONE_TASK)).map(
        (reference) => reference.resourceId
      )
    ),
    new Set(f.created.map((document) => document.resource.resourceId))
  );
  assert.equal(
    (await f.service.readResource(tabs[0].accessTaskId, resourceId)).snapshot.content.length,
    1024
  );
});

test("revision checks scoped to due windows avoid reading background resource metadata", async (t) => {
  const f = await fixture(t);
  await f.request("tabs");
  const full = await f.measure("revisions");
  const id = f.created[0].appInstance.appInstanceId;
  const scoped = await f.measure(`revisions?appInstanceId=${encodeURIComponent(id)}`);
  assert.equal(scoped.result.instances.length, 1);
  assert.equal(scoped.result.instances[0].appInstanceId, id);
  assert.ok(scoped.reads < full.reads / 2, `${scoped.reads} scoped vs ${full.reads} full reads`);
  const unknown = await f.request("revisions?appInstanceId=not-open");
  assert.deepEqual(unknown.instances, []);
  t.diagnostic(JSON.stringify({ fullReads: full.reads, scopedReads: scoped.reads }));
});
