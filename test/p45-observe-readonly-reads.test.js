import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";
import { handleDevelopmentRequest } from "../dist/src/dashboard/project-development-routes.js";

/**
 * Observation reads a node's records without working on it.
 *
 * The observation data port marks every read-only request, and the development
 * surface answers those from the stored records: a project whose published
 * merge still waits for its shared delivery must list developments, merges and
 * deliveries without replaying the outbox. The same read without the marker is
 * the work entry and the Main tool's behavior, so it still completes the
 * pending delivery before answering.
 */

const BACKEND = "backend_observe_reads";
const PROJECT = { projectId: "project_observe", projectName: "观测项目", projectDirectory: "" };
const RECEIPT = {
  mergeId: "merge_1",
  developmentId: "development_1",
  requirementId: "requirement_1",
  candidateCommit: "1".repeat(40),
  mergedCommit: "2".repeat(40),
  targetBranch: "main",
  mergedAt: "2026-11-10T08:00:00.000Z"
};
const PROJECT_PATH = `/api/projects/${encodeURIComponent(PROJECT.projectId)}`;
const READ_ONLY = { "x-cowork-read-only": "1" };

/**
 * The production service over an in-memory gateway: one merged operation this
 * backend published whose shared delivery has not been accepted yet. Every
 * `syncDelivery` the gateway receives is a replay the read performed.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "coworkos-observe-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const syncs = [];
  const deliveries = [];
  const development = {
    developmentId: RECEIPT.developmentId,
    requirementId: RECEIPT.requirementId,
    projectId: PROJECT.projectId,
    goal: "观测时读取开发记录",
    status: "active",
    updatedAt: RECEIPT.mergedAt
  };
  const merge = {
    mergeId: RECEIPT.mergeId,
    developmentId: RECEIPT.developmentId,
    projectId: PROJECT.projectId,
    state: "merged",
    executionBackendId: BACKEND,
    receipt: { ...RECEIPT },
    revision: 3,
    updatedAt: RECEIPT.mergedAt
  };
  const gateway = {
    mergeConfig: async () => undefined,
    queryDevelopments: async () => [development],
    getDevelopment: async () => development,
    findDevelopmentByRequirement: async () => development,
    queryMerges: async () => [merge],
    queryDeliveries: async () => [...deliveries],
    queryReviews: async () => [],
    reviewPlan: async () => undefined,
    boardEntries: async () => [],
    syncDelivery: async (_projectId, receipt) => {
      syncs.push(receipt);
      const delivery = { deliveryId: `delivery_${syncs.length}`, ...receipt, state: "synced" };
      deliveries.push(delivery);
      return delivery;
    }
  };
  const service = createProjectDevelopmentService({
    runtime: { service: async () => gateway },
    backendId: BACKEND,
    startedAt: "started-observe-reads",
    developmentRoot: join(root, "development-workspaces"),
    deliveryRoot: join(root, "delivery-sync"),
    project: async (projectId) => (projectId === PROJECT.projectId ? PROJECT : undefined),
    taskProject: async () => undefined
  });
  return { service, syncs, deliveries };
}

/** The development surface over a real listener, without the dashboard's auth layer. */
async function serve(t, service) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    handleDevelopmentRequest(request, response, url, {
      service,
      backendId: BACKEND,
      taskProject: async () => undefined
    }).then(
      (handled) => {
        if (handled || response.headersSent) return;
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
      },
      (error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(error?.status ?? 400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            ...(error?.code ? { code: error.code } : {})
          })
        );
      }
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(() => done())));
  return `http://127.0.0.1:${server.address().port}`;
}

async function read(base, path, { headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

const LISTS = [
  ["/developments", "developments"],
  ["/merges", "merges"],
  ["/deliveries", "deliveries"]
];

test("the observation entry lists developments, merges and deliveries without replaying the outbox", async (t) => {
  const { service, syncs, deliveries } = await fixture(t);
  const base = await serve(t, service);

  for (const [suffix, key] of LISTS) {
    const result = await read(base, `${PROJECT_PATH}${suffix}`, { headers: READ_ONLY });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.projectId, PROJECT.projectId);
    assert.ok(Array.isArray(result.body[key]), `${suffix} keeps its response shape`);
  }
  // One record read is the same read-only path as the lists.
  const one = await read(base, `${PROJECT_PATH}/developments/${RECEIPT.developmentId}`, {
    headers: READ_ONLY
  });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.development.developmentId, RECEIPT.developmentId);

  // The requirement detail reads the delivery view for the same requirement;
  // it is one more read of the same kind.
  const view = await read(base, `${PROJECT_PATH}/deliveries`, {
    headers: READ_ONLY,
    body: { action: "view", requirementId: RECEIPT.requirementId }
  });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.view.development.developmentId, RECEIPT.developmentId);
  assert.deepEqual(
    view.body.view.merges.map((entry) => entry.mergeId),
    [RECEIPT.mergeId]
  );

  assert.deepEqual(syncs, [], "a read-only read performs no outbox replay");
  assert.deepEqual(deliveries, [], "the shared delivery records are unchanged");
});

test("the same read without the marker still completes the pending delivery", async (t) => {
  for (const [suffix, key] of LISTS) {
    const { service, syncs, deliveries } = await fixture(t);
    const base = await serve(t, service);

    const result = await read(base, `${PROJECT_PATH}${suffix}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(syncs.length, 1, `${suffix} keeps the work entry's replay`);
    assert.deepEqual(
      deliveries.map((entry) => entry.mergeId),
      [RECEIPT.mergeId],
      "the pending delivery reached the shared record"
    );
    if (suffix === "/deliveries")
      assert.deepEqual(
        result.body.deliveries.map((entry) => entry.state),
        ["synced"],
        "the delivery list answers with the completed row"
      );
    assert.equal(result.body.projectId, PROJECT.projectId);
    assert.ok(Array.isArray(result.body[key]));
  }
});

test("an unrecognized read-only marker is refused instead of silently writing", async (t) => {
  const { service, syncs } = await fixture(t);
  const base = await serve(t, service);

  const result = await read(base, `${PROJECT_PATH}/developments`, {
    headers: { "x-cowork-read-only": "yes" }
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "invalid_read_only");
  assert.deepEqual(syncs, [], "a refused marker never reaches the read");
});
