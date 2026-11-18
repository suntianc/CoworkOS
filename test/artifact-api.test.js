import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { GlobalProjectCatalog } from "../dist/src/workspace/project-catalog.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

test(
  "Dashboard discovers final files and preserves binary downloads, ranges and bounded Unicode previews",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atria-artifact-api-"));
    let child;
    try {
      const workspaceRoot = join(root, "workspace");
      const projectDirectory = join(root, "project");
      await mkdir(projectDirectory);
      const catalog = new GlobalProjectCatalog(join(root, "projects.json"));
      const project = await catalog.create({ projectName: "Artifact API", projectDirectory });
      const store = new LocalWorkspaceStore(workspaceRoot);
      await store.createTask("task", {
        goal: "artifact API regression",
        projectId: project.projectId,
        projectCatalogPath: catalog.filePath,
        projectDirectory
      });
      const artifacts = join(workspaceRoot, "task", "artifacts");
      const candidate = join(workspaceRoot, "task", "agents", "main", "deliverables");
      await mkdir(candidate, { recursive: true });
      await writeFile(join(candidate, "candidate.md"), "not a final file");
      await writeFile(join(artifacts, "报告 说明.md"), "# 已验收\n");
      await writeFile(join(artifacts, "long.txt"), "中".repeat(100000));
      await writeFile(join(artifacts, "result.json"), '{"purpose":"user requested JSON"}');
      const binary = Buffer.from([80, 75, 3, 4, 255, 0, 128, 33]);
      await writeFile(join(artifacts, "演示 文稿.pptx"), binary);
      await writeFile(join(artifacts, "preview.pdf"), Buffer.from("%PDF-1.7\nfixture"));
      await writeFile(join(artifacts, "preview.png"), Buffer.from([137, 80, 78, 71, 0, 255]));
      await writeFile(join(root, "secret.txt"), "outside");
      await symlink(join(root, "secret.txt"), join(artifacts, "escape.txt"));
      const config = join(root, "config.json");
      await writeFile(config, "{}");
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = probe.address().port;
      await new Promise((done) => probe.close(done));
      child = spawn(process.execPath, ["dist/src/cli/dashboard.js"], {
        cwd: resolve("."),
        stdio: "ignore",
        env: {
          ...process.env,
          COWORK_WORKSPACE: workspaceRoot,
          ATRIA_HOME: join(root, "home"),
          COWORK_GLOBAL_INDEX: join(root, "global.json"),
          COWORK_CONFIG: config,
          COWORK_UI_PORT: String(port),
          COWORK_API_BASE: "",
          COWORK_API_KEY: ""
        }
      });
      const base = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          if ((await fetch(`${base}/api/tasks`)).ok) break;
        } catch {
          /* wait for listener */
        }
        if (child.exitCode !== null) throw new Error("dashboard exited before listening");
        await delay(20);
      }
      const fileUrl = (name, extra = "") =>
        `${base}/api/tasks/task/artifact?path=${encodeURIComponent(name)}${extra}`;
      let detail = await (await fetch(`${base}/api/tasks/task`)).json();
      assert.equal(detail.artifacts.length, 6);
      assert.equal(
        detail.artifacts.some((entry) => /candidate|escape/.test(entry.relativePath)),
        false
      );
      assert.ok(
        detail.artifacts.some((entry) => entry.relativePath === "result.json"),
        "final JSON files must not be filtered as logs"
      );
      let preview = await (await fetch(fileUrl("报告 说明.md"))).json();
      assert.equal(preview.previewKind, "text");
      assert.equal(preview.content, "# 已验收\n");
      const oldVersion = preview.version;
      await writeFile(join(artifacts, "报告 说明.md"), "# 新版\n");
      detail = await (await fetch(`${base}/api/tasks/task`)).json();
      preview = await (await fetch(fileUrl("报告 说明.md"))).json();
      assert.notEqual(preview.version, oldVersion);
      assert.equal(preview.content, "# 新版\n");
      const long = await (await fetch(fileUrl("long.txt"))).json();
      assert.equal(long.truncated, true);
      assert.ok(Buffer.byteLength(long.content) <= 256 * 1024);
      assert.equal(long.content.includes("\uFFFD"), false);
      const binaryPreview = await (await fetch(fileUrl("演示 文稿.pptx"))).json();
      assert.equal(binaryPreview.previewKind, "download");
      assert.equal(binaryPreview.content, undefined);
      const download = await fetch(fileUrl("演示 文稿.pptx", "&download=1"));
      assert.match(download.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), binary);
      assert.equal((await (await fetch(fileUrl("preview.pdf"))).json()).previewKind, "pdf");
      assert.equal((await (await fetch(fileUrl("preview.png"))).json()).previewKind, "image");
      const range = await fetch(fileUrl("演示 文稿.pptx", "&raw=1"), { headers: { range: "bytes=2-5" } });
      assert.equal(range.status, 206);
      assert.equal(range.headers.get("content-range"), "bytes 2-5/8");
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), binary.subarray(2, 6));
      const changedRange = await fetch(fileUrl("演示 文稿.pptx", "&raw=1"), {
        headers: { range: "bytes=2-5", "if-range": '"old-revision"' }
      });
      assert.equal(changedRange.status, 200);
      assert.deepEqual(Buffer.from(await changedRange.arrayBuffer()), binary);
      const invalidRange = await fetch(fileUrl("preview.pdf", "&raw=1"), {
        headers: { range: "bytes=999-" }
      });
      assert.equal(invalidRange.status, 416);
      for (const path of [
        "../secret.txt",
        "escape.txt",
        "/etc/passwd",
        "agents/main/deliverables/candidate.md"
      ]) {
        assert.equal((await fetch(fileUrl(path))).status, 400);
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);
