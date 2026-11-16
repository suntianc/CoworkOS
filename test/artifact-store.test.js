import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  listTaskArtifacts,
  publishTaskArtifact,
  resolveTaskArtifact
} from "../dist/src/workspace/artifact-store.js";

async function fixture(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-artifact-store-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const taskId = "task_1";
  const task = join(workspaceRoot, taskId);
  await mkdir(join(task, "artifacts"), { recursive: true });
  await writeFile(
    join(task, "task.json"),
    JSON.stringify({ taskId, layoutVersion: 2, activeRunId: "run_1" })
  );
  return { workspaceRoot, taskId, task };
}

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function hash(path) {
  const result = createHash("sha256");
  for await (const chunk of createReadStream(path)) result.update(chunk);
  return result.digest("hex");
}

test("ordinary file writes are discovered, including Unicode, spaces, JSON and log deliverables", async (t) => {
  const location = await fixture(t);
  await write(join(location.task, "artifacts", "研究报告", "最终 结论.md"), "# 结论\n经过验证。");
  await write(join(location.task, "artifacts", "数据.json"), '{"answer":42}');
  await write(join(location.task, "artifacts", "training.log"), "user-requested log export");
  await write(join(location.task, "agents", "main", "deliverables", "private.md"), "candidate");
  await write(join(location.task, "agents", "subagents", "sub_1", "logs", "trace.jsonl"), "log");
  const artifacts = await listTaskArtifacts(location);
  assert.deepEqual(
    new Set(artifacts.map((artifact) => artifact.relativePath)),
    new Set(["研究报告/最终 结论.md", "数据.json", "training.log"])
  );
  assert.equal(
    artifacts.find((artifact) => artifact.relativePath.endsWith(".md")).displayName,
    "最终 结论.md"
  );
  assert.equal(
    artifacts.find((artifact) => artifact.relativePath.endsWith(".json")).mimeType,
    "application/json"
  );
  assert.equal(
    artifacts.every((artifact) => artifact.runId === "run_1"),
    true
  );
  assert.equal(
    artifacts.every((artifact) => artifact.producerAgentId === "main"),
    true
  );
  await assert.rejects(lstat(join(location.task, "artifacts", "manifest.json")), { code: "ENOENT" });
  const cache = JSON.parse(await readFile(join(location.task, ".runtime", "artifacts.json"), "utf8"));
  assert.equal(cache.entries.length, 3);
  assert.equal(JSON.stringify(cache).includes("经过验证"), false);
});

test("updates retain identity, refresh hashes, remove deleted files and sort by modification time", async (t) => {
  const location = await fixture(t);
  const file = join(location.task, "artifacts", "report.txt");
  await write(file, "old");
  const [before] = await listTaskArtifacts(location);
  await write(file, "new");
  // Restoring mtime still changes ctime, so equal-length edits must invalidate the cache.
  await utimes(file, new Date(before.mtimeMs), new Date(before.mtimeMs));
  await write(join(location.task, "artifacts", "latest.txt"), "later");
  await utimes(join(location.task, "artifacts", "latest.txt"), new Date(), new Date(Date.now() + 1000));
  const updated = await listTaskArtifacts({ ...location, runId: "run_2" });
  const after = updated.find((artifact) => artifact.relativePath === "report.txt");
  assert.equal(after.artifactId, before.artifactId);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.runId, "run_1");
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(after.sha256, createHash("sha256").update("new").digest("hex"));
  assert.equal(updated[0].relativePath, "latest.txt");
  await unlink(file);
  assert.deepEqual(
    (await listTaskArtifacts(location)).map((artifact) => artifact.relativePath),
    ["latest.txt"]
  );
  await assert.rejects(resolveTaskArtifact({ ...location, relativePath: "report.txt" }), { code: "ENOENT" });
});

test("a file that changes while it is hashed is skipped without poisoning the index cache", async (t) => {
  const location = await fixture(t);
  await write(join(location.task, "artifacts", "stable.txt"), "stable deliverable");
  const racing = join(location.task, "artifacts", "racing.bin");
  await write(racing, Buffer.alloc(64 * 1024 * 1024));
  // Hashing a file this size takes long enough for the second stat to disagree
  // with the first: the indexing race, seen through the public list.
  let bumping = true;
  const bump = (async () => {
    for (let step = 1; bumping; step += 1) {
      const stamp = new Date(Date.now() + step * 1000);
      await utimes(racing, stamp, stamp);
    }
  })();
  let listed;
  try {
    listed = await listTaskArtifacts(location);
  } finally {
    bumping = false;
    await bump;
  }
  assert.deepEqual(
    listed.map((artifact) => artifact.relativePath),
    ["stable.txt"],
    "the racing file is skipped, the settled one is indexed"
  );
  // The skipped path leaves no cache entry: the next pass indexes it normally.
  const settled = await listTaskArtifacts(location);
  assert.deepEqual(
    settled.map((artifact) => artifact.relativePath),
    ["racing.bin", "stable.txt"]
  );
});

test("publishing uses the caller's user-facing path and safely replaces its bytes", async (t) => {
  const location = await fixture(t);
  const input = {
    ...location,
    runId: "run_1",
    producerAgentId: "main",
    relativePath: "演示/最终汇报 v2.pptx"
  };
  const artifact = await publishTaskArtifact({ ...input, content: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) });
  assert.equal(artifact.relativePath, "演示/最终汇报 v2.pptx");
  assert.equal(artifact.size, 4);
  assert.equal(
    artifact.mimeType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  const replaced = await publishTaskArtifact({ ...input, runId: "run_2", content: "replacement" });
  assert.equal(replaced.artifactId, artifact.artifactId);
  assert.equal(replaced.runId, "run_2");
  assert.equal((await listTaskArtifacts(location)).length, 1);
  const resolved = await resolveTaskArtifact({ ...location, relativePath: input.relativePath });
  assert.equal(await readFile(resolved.absolutePath, "utf8"), "replacement");
  assert.equal(resolved.stat.size, 11);
  assert.equal(resolved.artifact.artifactId, artifact.artifactId);
  assert.deepEqual(await readdir(join(location.task, ".runtime", "artifact-staging")), []);
  await assert.rejects(
    publishTaskArtifact({ ...input, content: "x", sourcePath: resolved.absolutePath }),
    /exactly one/
  );
});

test("large binary publication and discovery use streaming IO and preserve content", async (t) => {
  const location = await fixture(t);
  const source = join(location.workspaceRoot, "source.bin");
  const handle = await open(source, "w");
  const chunk = Buffer.alloc(64 * 1024, 0x92);
  const expected = createHash("sha256");
  try {
    for (let index = 0; index < 512; index += 1) {
      await handle.write(chunk);
      expected.update(chunk);
    }
  } finally {
    await handle.close();
  }
  const digest = expected.digest("hex");
  const published = await publishTaskArtifact({
    ...location,
    runId: "run_1",
    producerAgentId: "main",
    relativePath: "large.bin",
    sourcePath: source
  });
  assert.equal(published.size, 32 * 1024 * 1024);
  assert.equal(published.sha256, digest);
  assert.equal(await hash(join(location.task, "artifacts", "large.bin")), digest);
  await unlink(join(location.task, ".runtime", "artifacts.json"));
  assert.equal((await listTaskArtifacts(location))[0].sha256, digest);
});

test("path traversal and symlink files/directories cannot be read, published or indexed", async (t) => {
  const location = await fixture(t);
  const outside = join(location.workspaceRoot, "outside");
  await write(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(location.task, "artifacts", "link.txt"));
  await symlink(outside, join(location.task, "artifacts", "linked-directory"));
  for (const relativePath of [
    "../outside/secret.txt",
    "/secret.txt",
    "a/../../secret.txt",
    "a\\secret.txt",
    "C:/secret.txt",
    "a//b",
    "a/./b",
    "link.txt",
    "linked-directory/secret.txt"
  ]) {
    await assert.rejects(resolveTaskArtifact({ ...location, relativePath }), /unsafe|regular file|escapes/);
    await assert.rejects(
      publishTaskArtifact({
        ...location,
        runId: "run_1",
        producerAgentId: "main",
        relativePath,
        content: "changed"
      }),
      /unsafe|regular file|escapes/
    );
  }
  assert.deepEqual(await listTaskArtifacts(location), []);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
  await symlink(location.task, join(location.workspaceRoot, "task_link"));
  await assert.rejects(listTaskArtifacts({ ...location, taskId: "task_link" }), /unsafe/);
  await assert.rejects(listTaskArtifacts({ ...location, taskId: ".." }), /unsafe/);
  await rm(join(location.task, ".runtime"), { recursive: true, force: true });
  await symlink(outside, join(location.task, ".runtime"));
  await assert.rejects(listTaskArtifacts(location), /unsafe/);
});
