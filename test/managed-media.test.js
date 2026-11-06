import assert from "node:assert/strict";
import { test } from "node:test";
import { createManagedMedia } from "../web/assets/controllers/managed-media.js";

test("a rejected preview read is retried after authorization recovers", async () => {
  let requests = 0;
  const media = createManagedMedia({
    read: async () => {
      requests++;
      if (requests === 1) throw new Error("session revoked");
      return { blob: new Blob(["recovered"]) };
    },
    createObjectURL: () => "blob:recovered",
    revokeObjectURL() {}
  });
  await assert.rejects(media.get("/api/tasks/t/artifact"), /session revoked/);
  assert.equal(await media.get("/api/tasks/t/artifact"), "blob:recovered");
  assert.equal(requests, 2);
});

test("a late failed read from backend A cannot discard backend B's pending read", async () => {
  let failOld,
    finishNew,
    requests = 0;
  const old = new Promise((_, reject) => {
    failOld = reject;
  });
  const next = new Promise((resolve) => {
    finishNew = resolve;
  });
  const revoked = [];
  const media = createManagedMedia({
    read: () => (++requests === 1 ? old : next),
    createObjectURL: () => "blob:backend-B",
    revokeObjectURL: (url) => revoked.push(url)
  });
  const stale = media.get("/api/tasks/t/artifact");
  media.clear();
  const current = media.get("/api/tasks/t/artifact");
  failOld(new Error("backend A failed"));
  await assert.rejects(stale, /backend A failed/);
  assert.equal(media.get("/api/tasks/t/artifact"), current);
  finishNew({ blob: new Blob(["B"]) });
  assert.equal(await current, "blob:backend-B");
  assert.equal(requests, 2);
  media.clear();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(revoked, ["blob:backend-B"]);
});

test("a late successful read from backend A cannot replace backend B's pending read", async () => {
  let finishOld,
    finishNew,
    requests = 0,
    created = 0;
  const old = new Promise((resolve) => {
    finishOld = resolve;
  });
  const next = new Promise((resolve) => {
    finishNew = resolve;
  });
  const media = createManagedMedia({
    read: () => (++requests === 1 ? old : next),
    createObjectURL: () => `blob:${++created}`,
    revokeObjectURL() {}
  });
  const stale = media.get("/api/tasks/t/artifact");
  media.clear();
  const current = media.get("/api/tasks/t/artifact");
  finishOld({ blob: new Blob(["A"]) });
  await assert.rejects(stale, /切换后端/);
  assert.equal(media.get("/api/tasks/t/artifact"), current);
  finishNew({ blob: new Blob(["B"]) });
  assert.equal(await current, "blob:1");
  assert.equal(requests, 2);
  assert.equal(created, 1);
});
