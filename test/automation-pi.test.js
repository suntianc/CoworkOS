import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

test(
  "real Pi reads, edits and publishes files without an editor and resumes after restart",
  { timeout: 90000 },
  async (t) => {
    const failures = [];
    let step = 0,
      phase = "create",
      directory;
    const resultText = "# 自动生成报告\n\n输入已核对。\n";
    const model = await modelProtocolFixture("openai-completions", (request) => {
      try {
        const names = request.tools.map((tool) => tool.function.name);
        for (const removed of ["read_document", "write_document", "patch_document", "outline_document"])
          assert.ok(!names.includes(removed), removed);
        assert.ok(names.includes("call_subagent"));
        const last = request.messages.findLast((message) => message.role === "tool");
        if (phase === "resume") {
          if (step++ === 0) return { name: "read", arguments: { path: join(directory, "report.md") } };
          assert.match(JSON.stringify(last.content), /输入已核对/);
          return { text: "重启后报告仍可读取。" };
        }
        switch (step++) {
          case 0:
            assert.ok(names.includes("read") && names.includes("write"));
            return { name: "read", arguments: { path: join(directory, "input.txt") } };
          case 1:
            assert.match(JSON.stringify(last.content), /自动化输入/);
            return { name: "write", arguments: { path: join(directory, "report.md"), content: resultText } };
          case 2:
            return { name: "enable_tools", arguments: { groups: ["delivery"] } };
          case 3:
            return { name: "publish_artifact", arguments: { sourcePath: join(directory, "report.md") } };
          default:
            assert.ok(JSON.stringify(last.content).includes("report.md"));
            return { text: "报告已生成并交付。" };
        }
      } catch (error) {
        failures.push(error.message);
        return { text: "自动化回归失败。" };
      }
    });
    t.after(() => model.close());
    const d = await startDashboard({
      defaultProject: false,
      modelEndpoint: model.baseUrl,
      model: "protocol-fixture"
    });
    t.after(() => d.stop());
    const api = async (path, body) => {
      const response = await fetch(d.base + path, {
        ...(body === undefined
          ? {}
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000)
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    };
    assert.deepEqual((await api("/api/applications")).applications, []);
    directory = join(d.root, "project");
    await mkdir(directory);
    await writeFile(join(directory, "input.txt"), "自动化输入");
    const { project } = await api("/api/projects", {
      projectName: "自动化项目",
      projectDirectory: directory
    });
    await api("/api/tasks", {
      taskId: "automation",
      goal: "整理输入并交付报告",
      projectId: project.projectId
    });
    const settle = async () => {
      for (let i = 0; i < 600; i++) {
        const detail = await api("/api/tasks/automation");
        if (!detail.runtime.active && ["completed", "failed", "cancelled"].includes(detail.task.status)) {
          assert.equal(detail.task.status, "completed");
          assert.deepEqual(failures, []);
          return detail;
        }
        await delay(50);
      }
      assert.fail("Pi did not settle");
    };
    await api("/api/tasks/automation/run", { prompt: "读取 input.txt，生成 report.md 并发布为产物。" });
    const detail = await settle();
    assert.equal(step, 5);
    assert.equal(await readFile(join(directory, "report.md"), "utf8"), resultText);
    assert.ok(detail.artifacts.some((item) => item.relativePath === "report.md"));
    const download = await fetch(d.base + "/api/tasks/automation/artifact?path=report.md&download=1");
    assert.equal(download.status, 200);
    assert.equal(await download.text(), resultText);
    await d.restart({ newPort: true });
    phase = "resume";
    step = 0;
    await api("/api/tasks/automation/run", { prompt: "读取刚生成的 report.md，确认内容。" });
    await settle();
    assert.equal(step, 2);
    assert.deepEqual((await api("/api/applications")).applications, []);
  }
);
