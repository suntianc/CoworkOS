import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { historyService, documentAdapter } from "./document-history-fixture.mjs";
import { contentVersion } from "../dist/src/applications/types.js";

const execFileAsync = promisify(execFile);

const actor = { type: "user", id: "local" };
const taskId = "history-task";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-history-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = historyService(root);
  // Incompressible embedded media distinguishes sharing bytes from merely
  // compressing another complete copy of the same image on every save.
  const media = `data:image/png;base64,${randomBytes(3 * 1024 * 1024).toString("base64")}`;
  const created = await service.createResource({
    taskId,
    kind: "test/history+json",
    title: "media deck",
    initialContent: {
      pages: [
        {
          id: "one",
          elements: [
            {
              id: "image",
              type: "image",
              left: 0,
              top: 0,
              width: 100,
              height: 100,
              rotate: 0,
              src: media
            }
          ]
        }
      ]
    },
    actor
  });
  const resourceId = created.resource.resourceId;
  const directory = join(root, "applications", "history-document", "resources", resourceId);
  const document = created.snapshot.content;
  const save = (revision) => {
    const next = structuredClone(document);
    next.pages[0].elements[0].left = revision + 1;
    return service.applyOperation({
      taskId,
      resourceId,
      operationId: `save-${revision}`,
      appType: "history-document",
      operationType: "document.replace",
      baseRevision: revision,
      payload: { document: next },
      actor
    });
  };
  return { root, directory, service, resourceId, document, media, save };
}

async function storedBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await storedBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

test("repeated structured document saves share embedded media and reopen with bounded complete history", async (t) => {
  const { root, directory, service, resourceId, media, save } = await fixture(t);
  const first = await save(0);
  for (let revision = 1; revision < 7; revision++) await save(revision);
  assert.ok(
    (await storedBytes(directory)) < Buffer.byteLength(media) * 2,
    "editing geometry must not duplicate both media snapshots for every history entry"
  );
  assert.ok((await stat(join(directory, "operations.jsonl"))).size < 64 * 1024);

  const reopened = historyService(root);
  const read = await reopened.readResource(taskId, resourceId, { limit: 100 });
  assert.equal(read.snapshot.content.pages[0].elements[0].left, 7);
  assert.equal(read.operations.length, 1, "a complete large event gets its own byte-bounded page");
  assert.equal(read.hasMore, true);
  assert.equal(read.operations[0].payload.document.pages[0].elements[0].src, media);
  assert.equal(read.operations[0].inverse.payload.document.pages[0].elements[0].left, 6);

  const retry = await reopened.applyOperation({
    taskId,
    resourceId,
    operationId: "save-0",
    appType: "history-document",
    operationType: "document.replace",
    baseRevision: 0,
    payload: first.event.payload,
    actor
  });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.resource.revision, 7);
  assert.deepEqual(
    retry.event,
    JSON.parse(JSON.stringify(first.event)),
    "old receipts retain the original full payload and inverse"
  );
  await reopened.undo({ taskId, resourceId, actor });
  const secondUndo = await reopened.undo({ taskId, resourceId, actor });
  assert.equal(secondUndo.snapshot.content.pages[0].elements[0].left, 5);
  const review = await service.reviewResource(taskId, resourceId);
  assert.equal(review.available, true);
});

test("legacy inline large history remains readable, retryable and undoable", async (t) => {
  const { root, directory, resourceId, media, save } = await fixture(t);
  const events = [];
  for (let revision = 0; revision < 3; revision++) events.push((await save(revision)).event);
  await writeFile(
    join(directory, "operations.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n"
  );
  const reopened = historyService(root);
  const read = await reopened.readResource(taskId, resourceId);
  assert.equal(read.operations.length, 1, "legacy pages obey the same byte bound");
  assert.equal(read.hasMore, true);
  assert.equal(read.operations[0].payload.document.pages[0].elements[0].src, media);
  const since = await reopened.readResource(taskId, resourceId, { afterRevision: 2 });
  assert.equal(since.hasMore, false);
  assert.equal(since.operations[0].revision, 3);
  const undone = await reopened.undo({ taskId, resourceId, actor });
  assert.equal(undone.snapshot.content.pages[0].elements[0].left, 2);
});

test(
  "a 128 MiB heap can read, retry and undo a 192 MiB legacy inline history",
  { timeout: 120_000 },
  async (t) => {
    const { root, directory, resourceId, document, save } = await fixture(t);
    const first = await save(0);
    const log = join(directory, "operations.jsonl");
    await writeFile(log, "");
    const revisions = 24;
    let current = structuredClone(document);
    // Seed actual, consistent old-format events rather than retaining them all
    // in the fixture. Each event is ~8 MiB; the whole log exceeds the child heap.
    for (let index = 0; index < revisions; index++) {
      const next = structuredClone(document);
      next.pages[0].elements[0].left = index + 1;
      await appendFile(
        log,
        JSON.stringify({
          ...first.event,
          eventId: `evt_seed_${index}`,
          operationId: `seed-${index}`,
          baseRevision: index,
          revision: index + 1,
          payload: { document: next },
          inverse: { operationType: "document.replace", payload: { document: current } }
        }) + "\n"
      );
      current = next;
    }
    const metadataPath = join(directory, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const body = documentAdapter.serialize(current);
    await writeFile(join(root, "applications", "history-document", "files", metadata.path), body);
    await writeFile(
      metadataPath,
      JSON.stringify({
        ...metadata,
        revision: revisions,
        operationCount: revisions,
        contentVersion: contentVersion(body)
      })
    );
    const bytes = (await stat(log)).size;
    assert.ok(bytes > 192 * 1024 * 1024 && bytes < 250 * 1024 * 1024);
    const moduleUrl = new URL("./document-history-fixture.mjs", import.meta.url).href;
    const code = `
    import assert from "node:assert/strict";
    import { historyService } from ${JSON.stringify(moduleUrl)};
    const service = historyService(process.argv[1]);
    const resourceId = process.argv[2];
    const taskId = "history-task";
    const actor = { type: "user", id: "local" };
    const read = await service.readResource(taskId, resourceId);
    assert.equal(read.resource.revision, 24);
    assert.equal(read.operations.length, 1);
    assert.equal(read.hasMore, true);
    assert.equal(read.snapshot.content.pages[0].elements[0].left, 24);
    const receipt = await service.applyOperation({
      taskId, resourceId, operationId: "seed-0", appType: "history-document",
      operationType: "document.replace", baseRevision: 0,
      payload: { document: read.snapshot.content }, actor
    });
    assert.equal(receipt.deduplicated, true);
    assert.equal(receipt.event.revision, 1);
    assert.equal(receipt.event.payload.document.pages[0].elements[0].left, 1);
    assert.equal(receipt.resource.revision, 24);
    const undone = await service.undo({ taskId, resourceId, actor });
    assert.equal(undone.resource.revision, 25);
    assert.equal(undone.snapshot.content.pages[0].elements[0].left, 23);
    process.stdout.write("bounded legacy history passed");
  `;
    const result = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=128", "--input-type=module", "--eval", code, root, resourceId],
      { timeout: 90_000, maxBuffer: 128 * 1024 }
    );
    assert.equal(result.stdout, "bounded legacy history passed");
  }
);

test("external history strings preserve UTF-16 units and do not expose marker-shaped user fields", async (t) => {
  const { root, service, resourceId, document } = await fixture(t);
  const extra = "a".repeat(64 * 1024) + "\ud800";
  const next = structuredClone(document);
  next.theme.extra = extra;
  next.theme.reference = { digest: "a".repeat(64), path: ["payload", "document"] };
  await service.applyOperation({
    taskId,
    resourceId,
    appType: "history-document",
    operationId: "utf16",
    operationType: "document.replace",
    baseRevision: 0,
    payload: { document: next },
    actor
  });
  const read = await historyService(root).readResource(taskId, resourceId);
  assert.equal(read.operations[0].payload.document.theme.extra, extra);
  assert.deepEqual(read.operations[0].payload.document.theme.reference, next.theme.reference);
});

test("large pending transactions repair torn history without losing the retry receipt", async (t) => {
  const { root, directory, resourceId, save } = await fixture(t);
  const outcome = await save(0);
  const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
  const body = await readFile(join(root, "applications", "history-document", "files", metadata.path), "utf8");
  const transactions = join(root, ".runtime", "applications", "transactions");
  await mkdir(transactions, { recursive: true });
  await writeFile(
    join(transactions, `${resourceId}.json`),
    JSON.stringify({
      version: 1,
      resourceId,
      targetRevision: 1,
      event: outcome.event,
      resource: metadata,
      body
    })
  );
  await writeFile(join(directory, "operations.jsonl"), '{"eventId":"torn');
  const reopened = historyService(root);
  const read = await reopened.readResource(taskId, resourceId);
  assert.equal(read.operations.length, 1);
  assert.equal(read.operations[0].operationId, "save-0");
  assert.equal(read.operations[0].inverse.payload.document.pages[0].elements[0].left, 0);
  assert.deepEqual(await readdir(transactions), []);
  const retry = await reopened.applyOperation({
    taskId,
    resourceId,
    appType: "history-document",
    operationId: "save-0",
    operationType: "document.replace",
    baseRevision: 0,
    payload: outcome.event.payload,
    actor
  });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.resource.revision, 1);
});

test("missing, corrupted or redirected history payloads report a locatable recovery error", async (t) => {
  const { directory, service, resourceId, save } = await fixture(t);
  await save(0);
  const record = JSON.parse((await readFile(join(directory, "operations.jsonl"), "utf8")).trim());
  const path = join(directory, "history-blobs", `${record.details}.gz`);
  const original = await readFile(path);
  const expectRecovery = () =>
    assert.rejects(
      () => service.readResource(taskId, resourceId),
      (error) => error.code === "resource_recovery_required" && error.details.path === path
    );
  await rm(path);
  await expectRecovery();
  await writeFile(path, Buffer.from("not gzip"));
  await expectRecovery();
  await writeFile(path, gzipSync('{"version":1,"event":{},"strings":[]}'));
  await expectRecovery();
  const outside = join(directory, "outside.gz");
  await writeFile(outside, original);
  await rm(path);
  await symlink(outside, path);
  await expectRecovery();
});
