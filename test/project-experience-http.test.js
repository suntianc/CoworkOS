import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { ProjectExperienceStore } from "../dist/src/runtime/project-experience-store.js";
import { PROJECT_EXPERIENCE_ENABLED } from "../dist/src/domain/project-experience.js";

/** Project experience is switched off (#33); its enabled paths return with the switch or go in P9. */
const switchedOff = PROJECT_EXPERIENCE_ENABLED ? false : "项目经验已整套停用（#33），P9 清理时随代码删除";

test(
  "real Dashboard project experience is private, revision checked, independently scoped and survives a directory move",
  { timeout: 30000, skip: switchedOff },
  async (t) => {
    const dashboard = await startDashboard({ defaultProject: false });
    t.after(() => dashboard.stop());
    const request = async (path, body, method) => {
      const response = await fetch(dashboard.base + path, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const a = join(dashboard.root, "a"),
      b = join(dashboard.root, "b"),
      moved = join(dashboard.root, "moved");
    await Promise.all([a, b, moved].map((path) => mkdir(path)));
    const create = async (name, path) =>
      (await request("/api/projects", { projectName: name, projectDirectory: path })).body.project;
    const first = await create("A", a),
      second = await create("B", b);
    const path = `/api/projects/${first.projectId}/experience`;
    let snapshot = await request(path);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get("cache-control"), "no-store");
    assert.deepEqual(snapshot.body.settings, {
      enabled: false,
      learningEnabled: false,
      autoActivate: false,
      maxTokens: 2048,
      maxRequestsPerHour: 6
    });
    assert.equal(
      (await fetch(dashboard.base + path, { headers: { origin: "https://example.org" } })).status,
      403
    );
    assert.equal((await request("/api/projects/unknown/experience")).status, 404);
    const configure = {
      action: "configure",
      snapshotRevision: snapshot.body.revision,
      settings: { enabled: true, model: "" }
    };
    snapshot = await request(path, configure);
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    assert.equal((await request(path, configure)).status, 409);
    assert.equal(snapshot.body.settings.learningEnabled, false);
    const save = {
      action: "save",
      snapshotRevision: snapshot.body.revision,
      item: { kind: "experience", title: "Build", content: "Run the project checks before publishing." }
    };
    snapshot = await request(path, save);
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    assert.equal((await request(path, save)).status, 409);
    const entry = snapshot.body.items[0];
    assert.equal(entry.pinned, true);
    assert.equal("pending" in snapshot.body, false);
    assert.equal("learningRequests" in snapshot.body, false);
    assert.deepEqual((await request(`/api/projects/${second.projectId}/experience`)).body.items, []);
    assert.equal(
      (
        await request(path, {
          action: "save",
          snapshotRevision: snapshot.body.revision,
          item: { kind: "experience", title: "Invalid", content: "x".repeat(1001) }
        })
      ).status,
      400
    );
    assert.equal(
      (await request(`/api/projects/${first.projectId}`, { projectDirectory: moved }, "PATCH")).status,
      200
    );
    await dashboard.restart();
    snapshot = await request(path);
    assert.equal(snapshot.body.items[0].content, entry.content);
    assert.equal(snapshot.body.settings.enabled, true);
    snapshot = await request(path, {
      action: "set_state",
      snapshotRevision: snapshot.body.revision,
      id: entry.id,
      revision: entry.revision,
      state: "disabled"
    });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.items[0].state, "disabled");
    assert.deepEqual(await readdir(a), [], "private experience never writes into the project repository");
    assert.deepEqual(await readdir(moved), []);
  }
);

test(
  "real Main completion enqueues one durable reference without a foreground learning request",
  { timeout: 60000, skip: switchedOff },
  async (t) => {
    const provider = await modelProtocolFixture("openai-completions", () => ({ text: "完成当前任务。" }));
    const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
    t.after(async () => {
      await dashboard.stop();
      await provider.close();
    });
    const call = async (path, body) => {
      const response = await fetch(dashboard.base + path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    };
    const project = (await call("/api/tasks")).projects[0];
    const path = `/api/projects/${project.projectId}/experience`;
    const snapshot = await call(path);
    await call(path, {
      action: "configure",
      snapshotRevision: snapshot.revision,
      settings: { enabled: true, learningEnabled: true }
    });
    await call("/api/tasks", {
      taskId: "project-intake",
      goal: "完成当前任务",
      projectId: project.projectId
    });
    await call("/api/tasks/project-intake/run", { prompt: "完成当前任务" });
    let detail;
    for (let i = 0; i < 400; i++) {
      detail = await call("/api/tasks/project-intake");
      if (!detail.runtime.active) break;
      await delay(50);
    }
    assert.equal(detail.task.status, "completed");
    const identity = {
      projectId: project.projectId,
      projectDirectory: detail.projectDirectory,
      projectCatalogPath: detail.task.projectCatalogPath
    };
    const store = new ProjectExperienceStore(identity, join(dashboard.root, "home", "project-experience"));
    const document = await store.read();
    assert.equal(
      document.pending.length,
      1,
      "extension and Dashboard terminal hooks deduplicate the same Run"
    );
    const ref = JSON.parse(document.pending[0].text);
    assert.equal(ref.taskId, "project-intake");
    assert.equal(ref.runId, detail.task.activeRunId);
    assert.equal("messages" in ref, false);
    assert.equal(provider.requests.length, 1, "quiet window prevents foreground extraction/review calls");
  }
);
