import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FixtureApplicationService as ApplicationService } from "./document-history-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { listTaskArtifacts } from "../dist/src/workspace/artifact-store.js";

const actor = { type: "user", id: "local" };
const kind = "test/history+json";

async function fixture(t, separated = false) {
  const root = await mkdtemp(join(tmpdir(), "atria-artifact-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, "storage");
  const projectRoot = separated ? join(root, "project") : storageRoot;
  await mkdir(projectRoot, { recursive: true });
  const store = new LocalWorkspaceStore(storageRoot);
  await store.createTask("chat", { goal: "artifact identity regression" });
  const artifact = await store.publishArtifact({
    taskId: "chat",
    runId: "run",
    producerAgentId: "main",
    relativePath: "intro.snapshot",
    content: Buffer.from("immutable source presentation")
  });
  const project = separated
    ? { projectId: "project", projectName: "Project", projectDirectory: projectRoot }
    : undefined;
  const service = () => new ApplicationService(storageRoot, undefined, storageRoot, project);
  const input = {
    taskId: "chat",
    relativePath: artifact.relativePath,
    appType: "history-document",
    kind,
    title: "Intro",
    initialContent: { pages: [{ id: "original", elements: [] }] },
    artifactSha256: artifact.sha256,
    actor
  };
  return { storageRoot, projectRoot, service, input, artifact, store };
}

test("deliverables combine editable exports by exact origin, retaining PDF, changed and unreferenced files", async (t) => {
  const f = await fixture(t);
  const source = await f.service().createResource({
    taskId: "chat",
    appType: "history-document",
    kind,
    title: "Intro",
    initialContent: f.input.initialContent,
    actor
  });
  const resourceId = source.resource.resourceId;
  for (const [relativePath, sourceResourceId] of [
    ["exports/intro.snapshot", resourceId],
    ["exports/intro.history-document.json", resourceId],
    ["exports/intro.history-document", resourceId],
    ["exports/intro.pdf", resourceId],
    ["exports/intro.png", resourceId],
    ["exports/modified.snapshot", resourceId],
    ["exports/unreferenced.snapshot", "res_unreferenced"]
  ])
    await f.store.publishArtifact({
      taskId: "chat",
      runId: "run",
      producerAgentId: "main",
      relativePath,
      sourceResourceId,
      content: "exported content"
    });
  await writeFile(
    join(f.storageRoot, "chat", "artifacts", "exports", "modified.snapshot"),
    "edited outside app"
  );
  const artifacts = await listTaskArtifacts({ workspaceRoot: f.storageRoot, taskId: "chat" });
  const deliverables = await f.service().deliverables("chat", artifacts);
  const row = deliverables.find((entry) => entry.resourceId === resourceId);
  assert.deepEqual(
    row.files.map((file) => file.relativePath).sort(),
    ["exports/intro.snapshot", "exports/intro.history-document.json", "exports/intro.history-document"].sort()
  );
  assert.deepEqual(
    deliverables
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.relativePath)
      .sort(),
    [
      "intro.snapshot",
      "exports/intro.pdf",
      "exports/intro.png",
      "exports/modified.snapshot",
      "exports/unreferenced.snapshot"
    ].sort()
  );
  assert.equal(deliverables.find((entry) => entry.relativePath === "exports/intro.pdf").editable, false);
  assert.equal(deliverables.find((entry) => entry.relativePath === "exports/intro.png").editable, false);
  assert.equal(artifacts.length, 8, "original files remain available to download");
  await f.service().dereferenceResource("chat", resourceId);
  assert.equal((await f.service().deliverables("chat", artifacts)).length, 8);
});

test("deliverables group changed versions of one imported artifact and retain edited previous resources", async (t) => {
  const f = await fixture(t);
  const old = await f.service().importArtifact(f.input);
  await f.service().applyOperation({
    taskId: "chat",
    resourceId: old.resource.resourceId,
    appType: "history-document",
    operationType: "document.replace",
    operationId: "edit-previous-source-version",
    baseRevision: 0,
    payload: { document: { pages: [{ id: "previous-edited", elements: [] }] } },
    actor
  });
  const previousExport = await f.store.publishArtifact({
    taskId: "chat",
    runId: "run-previous",
    producerAgentId: "main",
    relativePath: "exports/previous.snapshot",
    content: "an export of the edited previous version",
    sourceResourceId: old.resource.resourceId
  });
  const currentArtifact = await f.store.publishArtifact({
    taskId: "chat",
    runId: "run-next",
    producerAgentId: "main",
    relativePath: "intro.snapshot",
    content: "a newly generated source presentation"
  });
  const current = await f.service().importArtifact({
    ...f.input,
    artifactSha256: currentArtifact.sha256,
    initialContent: { pages: [{ id: "current-source", elements: [] }] }
  });
  assert.notEqual(current.resource.resourceId, old.resource.resourceId);
  const pdf = await f.store.publishArtifact({
    taskId: "chat",
    runId: "run-next",
    producerAgentId: "main",
    relativePath: "intro.pdf",
    content: "preview PDF"
  });
  const rows = await f.service().deliverables("chat", [currentArtifact, pdf, previousExport]);
  assert.equal(rows.length, 2, "one editable document and its independent PDF preview");
  const row = rows.find((entry) => entry.kind === "resource");
  assert.equal(row.resourceId, current.resource.resourceId);
  assert.deepEqual(
    row.files.map((entry) => entry.relativePath),
    ["intro.snapshot", "exports/previous.snapshot"]
  );
  assert.deepEqual(row.previousVersions, [
    {
      resourceId: old.resource.resourceId,
      name: old.resource.title,
      revision: 1,
      updatedAt: (await f.service().readResource("chat", old.resource.resourceId)).resource.updatedAt
    }
  ]);
  assert.equal(rows.find((entry) => entry.relativePath === "intro.pdf").kind, "file");
  assert.equal((await f.service().listResources("chat")).length, 2, "grouping never deletes a resource");
  assert.equal(
    (await f.service().readResource("chat", old.resource.resourceId)).snapshot.content.pages[0].id,
    "previous-edited",
    "the previous import keeps its independently edited content"
  );
  assert.equal(
    (await f.service().importArtifact({ taskId: "chat", relativePath: "intro.snapshot", actor })).resource
      .resourceId,
    current.resource.resourceId,
    "opening the source file continues to select its current imported version"
  );
  const restarted = await f.service().deliverables("chat", [currentArtifact, pdf, previousExport]);
  assert.deepEqual(restarted, rows, "the grouping is derived from persisted source identity after restart");

  for (const artifacts of [[], [{ ...currentArtifact, sha256: "1".repeat(64) }]]) {
    const visible = await f.service().deliverables("chat", artifacts);
    assert.equal(visible.filter((entry) => entry.kind === "resource").length, 2);
    assert.ok(visible.every((entry) => entry.previousVersions === undefined));
  }
});

test("import grouping preserves independent documents and requires the full origin and application identity", async (t) => {
  const f = await fixture(t);
  const old = await f.service().importArtifact(f.input);
  const currentArtifact = await f.store.publishArtifact({
    taskId: "chat",
    runId: "run-next",
    producerAgentId: "main",
    relativePath: "intro.snapshot",
    content: "replacement source"
  });
  const current = await f.service().importArtifact({ ...f.input, artifactSha256: currentArtifact.sha256 });
  const independent = await f.service().createResource({
    taskId: "chat",
    appType: "history-document",
    kind,
    title: old.resource.title,
    initialContent: f.input.initialContent,
    actor
  });
  const metadata = old.resource;
  const origin = metadata.importedArtifact;
  const unrelated = [
    { ...metadata, resourceId: "res_other_root", importedArtifact: { ...origin, storageRoot: "/other" } },
    { ...metadata, resourceId: "res_other_task", importedArtifact: { ...origin, taskId: "other" } },
    {
      ...metadata,
      resourceId: "res_other_path",
      importedArtifact: { ...origin, relativePath: "other/intro.snapshot" }
    },
    { ...metadata, resourceId: "res_other_app", appType: "different-app" },
    { ...metadata, resourceId: "res_other_kind", kind: "different-kind" }
  ];
  const known = [metadata, current.resource, independent.resource, ...unrelated];
  const rows = await f.service().deliverables("chat", [currentArtifact], known);
  assert.deepEqual(
    rows.map((entry) => entry.resourceId).sort(),
    [
      current.resource.resourceId,
      independent.resource.resourceId,
      ...unrelated.map((entry) => entry.resourceId)
    ].sort()
  );
  const currentRow = rows.find((entry) => entry.resourceId === current.resource.resourceId);
  assert.deepEqual(
    currentRow.previousVersions.map((entry) => entry.resourceId),
    [old.resource.resourceId]
  );
  assert.ok(
    rows
      .filter((entry) => entry.resourceId !== current.resource.resourceId)
      .every((entry) => !entry.previousVersions)
  );
  assert.equal(
    (await f.service().deliverables("chat", [{ ...currentArtifact, mimeType: "application/pdf" }], known))
      .length,
    known.length + 1,
    "read-only formats never group editable source resources"
  );
});

test("converted structured document origin survives project-root forwarding, edits, closing and service restart", async (t) => {
  const f = await fixture(t, true);
  const first = await f.service().importArtifact(f.input);
  const resourceId = first.resource.resourceId;
  assert.deepEqual(first.resource.importedArtifact, {
    storageRoot: await realpath(f.storageRoot),
    taskId: "chat",
    relativePath: "intro.snapshot",
    sha256: f.artifact.sha256
  });
  const updated = await f.service().applyOperation({
    taskId: "chat",
    resourceId,
    appType: "history-document",
    operationType: "document.replace",
    operationId: "edit-presentation",
    baseRevision: 0,
    payload: { document: { pages: [{ id: "edited", elements: [] }] } },
    actor
  });
  await new ApplicationService(f.projectRoot, undefined, f.storageRoot).updateInstance({
    taskId: "chat",
    appInstanceId: first.appInstance.appInstanceId,
    status: "closed"
  });
  const reopened = await Promise.all(Array.from({ length: 4 }, () => f.service().importArtifact(f.input)));
  for (const result of reopened) {
    assert.equal(result.reused, true);
    assert.equal(result.resource.resourceId, resourceId);
    assert.equal(result.resource.revision, updated.resource.revision);
    assert.equal(result.snapshot.content.pages[0].id, "edited");
  }
  assert.equal(new Set(reopened.map((result) => result.appInstance.appInstanceId)).size, 1);
  const resources = await f.service().listResources("chat");
  assert.equal(resources.length, 1);
  const artifacts = await listTaskArtifacts({ workspaceRoot: f.storageRoot, taskId: "chat" });
  assert.equal((await f.service().deliverables("chat", artifacts)).length, 1);
  assert.equal(
    (await readdir(join(f.projectRoot, "applications", "history-document", "resources"))).length,
    1
  );
  assert.equal(
    await readFile(join(f.storageRoot, "chat", "artifacts", "intro.snapshot"), "utf8"),
    "immutable source presentation"
  );
});

for (const rootField of ["storageRoot", "workspaceRoot"])
  test(`reopening a ${rootField} origin through a filesystem alias preserves its edited resource`, async (t) => {
    const f = await fixture(t, true);
    const first = await f.service().importArtifact(f.input);
    const resourceId = first.resource.resourceId;
    await f.service().applyOperation({
      taskId: "chat",
      resourceId,
      appType: "history-document",
      operationType: "document.replace",
      operationId: "edited-before-origin-upgrade",
      baseRevision: 0,
      payload: { document: { pages: [{ id: "edited-through-restart", elements: [] }] } },
      actor
    });
    const alias = join(f.storageRoot, "..", "storage-alias");
    await symlink(f.storageRoot, alias, "dir");
    const metadataPath = join(
      f.projectRoot,
      "applications",
      "history-document",
      "resources",
      resourceId,
      "metadata.json"
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.importedArtifact = {
      [rootField]: alias,
      taskId: "chat",
      relativePath: f.artifact.relativePath,
      sha256: f.artifact.sha256
    };
    await writeFile(metadataPath, JSON.stringify(metadata));
    const reopened = await new ApplicationService(f.projectRoot, undefined, alias).importArtifact({
      taskId: "chat",
      relativePath: f.artifact.relativePath,
      appType: "history-document",
      actor,
      converted: {
        sha256: f.artifact.sha256,
        kind,
        title: "Retried conversion",
        initialContent: f.input.initialContent
      }
    });
    assert.equal(reopened.reused, true);
    assert.equal(reopened.resource.resourceId, resourceId);
    assert.equal(reopened.snapshot.content.pages[0].id, "edited-through-restart");
    assert.deepEqual(reopened.resource.importedArtifact, {
      storageRoot: await realpath(f.storageRoot),
      taskId: "chat",
      relativePath: f.artifact.relativePath,
      sha256: f.artifact.sha256
    });
    assert.equal((await f.service().listResources("chat")).length, 1);
  });

for (const separated of [false, true]) {
  for (const stage of ["mapping", "content", "metadata", "legacy", "occupied"])
    test(`retry recovers the same structured document after SIGKILL before ${stage} (${separated ? "project" : "same"} root)`, async (t) => {
      const f = await fixture(t, separated);
      const serviceModule = new URL("./document-history-fixture.mjs", import.meta.url).href;
      const mappingModule = new URL("../dist/src/applications/mapping-store.js", import.meta.url).href;
      const filesModule = new URL("../dist/src/applications/resource-files.js", import.meta.url).href;
      const project = separated
        ? { projectId: "project", projectName: "Project", projectDirectory: f.projectRoot }
        : null;
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { FixtureApplicationService as ApplicationService } from ${JSON.stringify(serviceModule)};
      import { ResourceMappingStore } from ${JSON.stringify(mappingModule)};
      import { ResourceFiles } from ${JSON.stringify(filesModule)};
      const stage = ${JSON.stringify(stage)};
      if (stage !== "mapping") {
        const write = ResourceFiles.prototype.write;
        ResourceFiles.prototype.write = async function (...args) {
          process.send({ path: args[0].path });
          await new Promise((resolve) => process.once("message", resolve));
          return write.apply(this, args);
        };
      }
      const original = ResourceMappingStore.prototype.add;
      ResourceMappingStore.prototype.add = async function (taskId, reference) {
        if (stage === "mapping" && taskId === "chat") {
          process.send(reference);
          await new Promise((resolve) => process.once("message", resolve));
        }
        return original.call(this, taskId, reference);
      };
      await new ApplicationService(
        ${JSON.stringify(f.storageRoot)}, undefined, ${JSON.stringify(f.storageRoot)},
        ${JSON.stringify(project)}
      ).importArtifact(${JSON.stringify(f.input)});
    `
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] }
      );
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const exited = once(child, "exit");
      let committed;
      try {
        [committed] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      assert.ok(committed, stderr);
      if (stage !== "mapping") {
        const records = await readdir(join(f.projectRoot, "applications", "history-document", "resources"));
        assert.equal(records.length, 1);
        committed = { resourceId: records[0] };
        const metadataPath = join(
          f.projectRoot,
          "applications",
          "history-document",
          "resources",
          records[0],
          "metadata.json"
        );
        if (stage === "metadata") await rm(metadataPath);
        if (stage === "legacy") {
          for (const name of ["metadata.json", "creation.json"]) {
            const path = join(
              f.projectRoot,
              "applications",
              "history-document",
              "resources",
              records[0],
              name
            );
            const record = JSON.parse(await readFile(path, "utf8"));
            const resource = name === "creation.json" ? record.resource : record;
            const { storageRoot, ...origin } = resource.importedArtifact;
            resource.importedArtifact = { ...origin, workspaceRoot: storageRoot };
            await writeFile(path, JSON.stringify(record));
          }
        }
        if (stage === "occupied") {
          const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
          const contentPath = join(f.projectRoot, "applications", "history-document", "files", metadata.path);
          await mkdir(join(f.projectRoot, "applications", "history-document", "files"), { recursive: true });
          await writeFile(contentPath, "independent external content");
          await assert.rejects(f.service().importArtifact(f.input), { code: "resource_recovery_required" });
          assert.equal(await readFile(contentPath, "utf8"), "independent external content");
          assert.equal(records.length, 1);
          return;
        }
      }
      assert.equal((await f.service().listResources("chat")).length, 0);
      const reopened = await f.service().importArtifact(f.input);
      assert.equal(reopened.resource.resourceId, committed.resourceId);
      assert.equal(reopened.reused, true);
      assert.equal((await f.service().listResources("chat")).length, 1);
      assert.equal(
        (await readdir(join(f.projectRoot, "applications", "history-document", "resources"))).length,
        1
      );
    });
}
