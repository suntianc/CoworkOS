import { applicationFixtureNodeOptions } from "./application-fixture.mjs";
import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
const { ResourceFiles } = await import("../dist/src/applications/resource-files.js");

test(
  "real Pi creates and reads a first text document in the conversation project, then restores its tools after restart",
  { timeout: 90_000 },
  async (t) => {
    for (const name of Object.keys(process.env))
      if (
        /^(?:ATRIA_|COWORK_|PI_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|CEREBRAS_|OPENROUTER_|TOGETHER_|DEEPSEEK_|SERPER_)/.test(
          name
        ) ||
        /_API_KEY$/.test(name) ||
        name === "NODE_OPTIONS"
      )
        delete process.env[name];
    process.env.NODE_OPTIONS = applicationFixtureNodeOptions;
    const failures = [],
      seen = { create: [], restore: [] };
    let phase = "create",
      resourceId;
    const model = await modelProtocolFixture("openai-completions", (request) => {
      const step = seen[phase].length;
      seen[phase].push(request);
      try {
        const names = request.tools.map((tool) => tool.function.name);
        if (phase === "restore") {
          assert.ok(names.includes("read_document"));
          assert.ok(JSON.stringify(request.messages).includes(resourceId));
          return step === 0 ? { name: "read_document", arguments: {} } : { text: "恢复后读取到同一 文本。" };
        }
        if (step === 0) return { name: "enable_tools", arguments: { groups: ["applications"] } };
        if (step === 1) {
          assert.ok(names.includes("create_resource"));
          return {
            name: "create_resource",
            arguments: { kind: "text/markdown", title: "项目中的自我介绍" }
          };
        }
        const result = JSON.parse(request.messages.findLast((message) => message.role === "tool").content);
        assert.notEqual(result.ok, false, JSON.stringify(result));
        assert.ok(!result.error, JSON.stringify(result));
        assert.ok(names.includes("read_document"));
        if (step === 2) {
          assert.equal(result.bound, true);
          resourceId = result.resource.resourceId;
          assert.ok(result.resource.project?.projectId);
          return { name: "read_document", arguments: {} };
        }
        assert.equal(step, 3);
        return { text: "已创建并通过应用工具读回 文本。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "项目上下文回归失败。" };
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
        signal: AbortSignal.timeout(5_000)
      });
      const result = await response.json();
      assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
      return result;
    };
    const directory = join(d.root, "project");
    await mkdir(directory);
    const { project } = await api("/api/projects", {
      projectName: "自我介绍项目",
      projectDirectory: directory
    });
    await api("/api/tasks", { taskId: "text-chat", goal: "制作自我介绍 文本", projectId: project.projectId });
    const settle = async () => {
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        const detail = await api("/api/tasks/text-chat");
        if (!detail.runtime.active && ["completed", "failed", "cancelled"].includes(detail.task.status)) {
          assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
          assert.deepEqual(failures, []);
          return detail;
        }
        await delay(40);
      }
      assert.fail("real Pi did not settle");
    };
    await api("/api/tasks/text-chat/run", { prompt: "新建一份自我介绍 文本，并用应用工具读取确认。" });
    await settle();
    assert.equal(seen.create.length, 4);
    const read = await api(`/api/tasks/text-chat/resources/${resourceId}`);
    assert.equal(read.resource.project.projectId, project.projectId);
    const file = new ResourceFiles(directory).absolutePath(read.resource);
    const original = await readFile(file, "utf8");
    await assert.rejects(access(new ResourceFiles(d.workspaceRoot).absolutePath(read.resource)), {
      code: "ENOENT"
    });
    const tab = (await api("/api/workbench/tabs")).tabs.find((entry) => entry.resourceId === resourceId);
    assert.equal(tab.project.projectName, project.projectName);
    assert.equal(tab.workspaceRoot, directory);
    await d.restart({ newPort: true });
    phase = "restore";
    await api("/api/tasks/text-chat/run", { prompt: "继续读取现有 文本，确认重启恢复。" });
    await settle();
    assert.equal(seen.restore.length, 2);
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(
      (await api("/api/tasks/text-chat/active-app-context")).context.resource.resourceId,
      resourceId
    );
  }
);
