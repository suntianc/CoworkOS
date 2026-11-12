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
  migrateLegacyTaskArtifacts,
  publishTaskArtifact,
  resolveTaskArtifact
} from "../dist/src/workspace/artifact-store.js";
import { browseWorkspace } from "../dist/src/tools/builtin.js";

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

function legacy(taskId, runId, producerAgentId, suffix, content) {
  return {
    artifactId: `old_${producerAgentId}_${suffix}`,
    taskId,
    runId,
    producerAgentId,
    relativePath: `${runId}/${producerAgentId}/${suffix}`,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    createdAt: "2026-01-01T00:00:00.000Z"
  };
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

test("explicit legacy migration separates framework logs and agent candidates without losing conflicts", async (t) => {
  const location = await fixture(t);
  const files = [
    [legacy(location.taskId, "run_1", "sub_1", "run_1.jsonl", "trace"), "trace"],
    [legacy(location.taskId, "run_1", "sub_1", "result-run_1.json", '{"messages":[]}'), '{"messages":[]}'],
    [legacy(location.taskId, "run_1", "main", "trace-run_1.jsonl", "main trace"), "main trace"],
    [legacy(location.taskId, "run_1", "sub_1", "deliverables/report.md", "candidate old"), "candidate old"],
    [legacy(location.taskId, "run_1", "main", "deliverables/final.pdf", "main old"), "main old"],
    [legacy(location.taskId, "run_1", "sub_1", "report.json", '{"final":true}'), '{"final":true}'],
    [legacy(location.taskId, "run_1", "sub_1", "user.log", "requested log"), "requested log"]
  ];
  for (const [entry, content] of files)
    await write(join(location.task, "artifacts", entry.relativePath), content);
  const manifest = files.map(([entry]) => entry);
  await write(join(location.task, "artifacts", "manifest.json"), JSON.stringify(manifest));
  await write(join(location.task, "artifacts", "final.pdf"), "current final");
  await write(join(location.task, "agents", "main", "deliverables", "final.pdf"), "main old");
  await write(join(location.task, "agents", "main", "deliverables", "主讲稿.md"), "notes");
  await write(
    join(location.task, "agents", "subagents", "sub_1", "deliverables", "report.md"),
    "candidate current"
  );
  await write(
    join(location.task, "agents", "subagents", "sub_1", "outputs", "legacy-artifacts", "run_1", "report.md"),
    "archive existing"
  );
  const result = await migrateLegacyTaskArtifacts(location);
  assert.equal(result.migrated, true);
  assert.equal(result.moved, 5);
  assert.equal(result.imported, 1);
  assert.equal(await readFile(join(location.task, "artifacts", "final.pdf"), "utf8"), "current final");
  assert.equal(
    await readFile(join(location.task, "agents", "subagents", "sub_1", "deliverables", "report.md"), "utf8"),
    "candidate current"
  );
  assert.equal(
    await readFile(
      join(
        location.task,
        "agents",
        "subagents",
        "sub_1",
        "outputs",
        "legacy-artifacts",
        "run_1",
        "report.md"
      ),
      "utf8"
    ),
    "archive existing"
  );
  assert.equal(
    await readFile(
      join(location.task, "agents", "subagents", "sub_1", "logs", "run_1", "legacy-artifacts", "run_1.jsonl"),
      "utf8"
    ),
    "trace"
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(location.task, ".runtime", "legacy-artifacts-manifest.json"), "utf8")),
    manifest
  );
  await assert.rejects(lstat(join(location.task, "artifacts", "manifest.json")), { code: "ENOENT" });
  for (const [entry] of files) {
    const mapping = result.paths.find((path) => path.sourcePath === `artifacts/${entry.relativePath}`);
    assert.equal(
      await hash(join(location.task, mapping?.destinationPath ?? `artifacts/${entry.relativePath}`)),
      entry.sha256
    );
  }
  const artifacts = await listTaskArtifacts(location);
  assert.equal(artifacts.length, 5);
  assert.equal(
    artifacts.some((artifact) => artifact.relativePath.endsWith("result-run_1.json")),
    false
  );
  assert.equal(
    artifacts.some((artifact) => artifact.relativePath.endsWith("report.json")),
    true
  );
  assert.equal(
    artifacts.some((artifact) => artifact.relativePath.endsWith("user.log")),
    true
  );
  const journal = JSON.parse(
    await readFile(join(location.task, ".runtime", "artifact-migration.json"), "utf8")
  );
  assert.ok(journal.completedAt);
  assert.deepEqual(journal.paths, result.paths);
  const again = await migrateLegacyTaskArtifacts(location);
  assert.equal(again.migrated, false);
  assert.equal(again.moved, 0);
  assert.equal(again.imported, 0);
  assert.deepEqual(
    (await listTaskArtifacts(location)).map((artifact) => artifact.relativePath),
    artifacts.map((artifact) => artifact.relativePath)
  );
  await write(
    join(location.task, "agents", "main", "deliverables", "later-candidate.md"),
    "must stay private"
  );
  await migrateLegacyTaskArtifacts(location);
  assert.equal(
    (await listTaskArtifacts(location)).some((artifact) => artifact.relativePath === "later-candidate.md"),
    false
  );
});

test("migration leaves user manifest and unregistered log files intact", async (t) => {
  const location = await fixture(t);
  await write(join(location.task, "artifacts", "manifest.json"), '{"title":"deliverable manifest"}');
  await write(join(location.task, "artifacts", "run_1", "sub_1", "run_1.jsonl"), "user log");
  await write(join(location.task, "agents", "main", "deliverables", "candidate.md"), "candidate");
  assert.equal((await migrateLegacyTaskArtifacts(location)).migrated, false);
  assert.equal((await listTaskArtifacts(location)).length, 2);
});

test("old callback paths remain readable after migration without republishing candidates", async (t) => {
  const location = await fixture(t);
  const content = "候选证据：验收前保持私有。";
  const entry = legacy(location.taskId, "run_1", "sub_1", "deliverables/候选.md", content);
  const oldPath = `artifacts/${entry.relativePath}`;
  await write(join(location.task, oldPath), content);
  await write(join(location.task, "artifacts", "manifest.json"), JSON.stringify([entry]));
  const migration = await migrateLegacyTaskArtifacts(location);
  const mapping = migration.paths.find((item) => item.sourcePath === oldPath);
  const options = { workspaceDirectory: location.task };
  const redirected = await browseWorkspace(options, { mode: "read", path: oldPath });
  assert.equal(redirected.content, content);
  assert.equal(redirected.path, mapping.destinationPath);
  assert.equal(redirected.redirectedFrom, oldPath);
  assert.deepEqual(await listTaskArtifacts(location), []);

  await write(join(location.task, oldPath), "new file at the original path");
  const current = await browseWorkspace(options, { mode: "read", path: oldPath });
  assert.equal(current.content, "new file at the original path");
  assert.equal(current.redirectedFrom, undefined);

  await unlink(join(location.task, oldPath));
  await write(join(location.workspaceRoot, "outside.txt"), "outside task");
  await write(
    join(location.task, ".runtime", "artifact-migration.json"),
    JSON.stringify({ paths: [{ sourcePath: oldPath, destinationPath: "../outside.txt" }] })
  );
  await assert.rejects(browseWorkspace(options, { mode: "read", path: oldPath }), /escapes workspace/);
});

test("new layouts preserve user array manifests and never promote private candidates", async (t) => {
  for (const layoutVersion of [3, 4, undefined]) {
    for (const populated of [false, true]) {
      const location = await fixture(t);
      await write(
        join(location.task, "task.json"),
        JSON.stringify({ taskId: location.taskId, layoutVersion })
      );
      const entry = legacy(location.taskId, "run_1", "sub_1", "run_1.jsonl", "user log");
      const manifest = JSON.stringify(populated ? [entry] : []);
      await write(join(location.task, "artifacts", "manifest.json"), manifest);
      await write(join(location.task, "artifacts", entry.relativePath), "user log");
      await write(join(location.task, "agents", "main", "deliverables", "candidate.md"), "candidate");
      const result = await migrateLegacyTaskArtifacts(location);
      assert.equal(result.migrated, false);
      assert.equal(result.imported, 0);
      assert.equal(result.moved, 0);
      assert.equal(await readFile(join(location.task, "artifacts", "manifest.json"), "utf8"), manifest);
      assert.equal(await readFile(join(location.task, "artifacts", entry.relativePath), "utf8"), "user log");
      assert.equal(
        (await listTaskArtifacts(location)).some((artifact) => artifact.relativePath === "candidate.md"),
        false
      );
      await assert.rejects(lstat(join(location.task, ".runtime", "legacy-artifacts-manifest.json")), {
        code: "ENOENT"
      });
    }
  }
});

test("explicit layout 2 still upgrades an empty framework manifest and retains Main originals", async (t) => {
  const location = await fixture(t);
  await write(join(location.task, "artifacts", "manifest.json"), "[]");
  await write(join(location.task, "agents", "main", "deliverables", "final.md"), "finished");
  const result = await migrateLegacyTaskArtifacts(location);
  assert.equal(result.migrated, true);
  assert.equal(result.imported, 1);
  assert.equal(await readFile(join(location.task, "artifacts", "final.md"), "utf8"), "finished");
  assert.equal(
    await readFile(join(location.task, "agents", "main", "deliverables", "final.md"), "utf8"),
    "finished"
  );
  assert.equal(
    await readFile(join(location.task, ".runtime", "legacy-artifacts-manifest.json"), "utf8"),
    "[]"
  );
});
