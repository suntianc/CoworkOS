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
  "real Main edits a project-owned document while Task history stays central, then restores and unloads it",
  { timeout: 90_000 },
  async (t) => {
    // Node's runner isolates test files in separate processes. Drop inherited
    // provider/path overrides in this process before the shared launcher copies them.
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

    const taskId = "project-document";
    const title = "独立项目文档.txt";
    const initialContent = "项目中的中文原稿 😀\n";
    const editedContent = `${initialContent}Main 通过文档工具追加的内容。\n`;
    const failures = [];
    const seen = { edit: [], restored: [], unloaded: [] };
    let phase = "edit";
    let resourceId;
    const model = await modelProtocolFixture("openai-completions", (request) => {
      const requests = seen[phase];
      const step = requests.length;
      requests.push(request);
      try {
        const names = request.tools.map((tool) => tool.function.name);
        if (phase === "unloaded") {
          for (const name of ["read_document", "outline_document", "patch_document", "write_document"])
            assert.equal(names.includes(name), false, `${name} must disappear after unloading`);
          return { text: "已确认卸载应用后的普通对话。" };
        }
        assert.ok(names.includes("read_document"), "the first real provider request discovers the bound TXT");
        assert.ok(names.includes("write_document"), "the bound TXT exposes its actual edit tool");
        assert.equal(names.includes("cad_read_model"), false);
        if (step === 0) {
          const context = JSON.stringify(request.messages);
          assert.ok(context.includes(title), "bound context carries the Chinese document identity");
          assert.ok(context.includes(resourceId), "bound context names the actual project resource");
          return { name: "read_document", arguments: {} };
        }
        const toolMessage = request.messages.findLast((message) => message.role === "tool");
        assert.ok(toolMessage, "the model receives a real Pi/MCP tool result");
        const result = JSON.parse(toolMessage.content);
        assert.notEqual(result.ok, false, JSON.stringify(result));
        assert.ok(!result.error, JSON.stringify(result));
        if (phase === "restored") {
          assert.equal(step, 1);
          assert.equal(result.result.content, editedContent);
          return { text: "重启后读取到同一份已修改文档。" };
        }
        if (step === 1) {
          assert.equal(result.result.content, initialContent);
          return { name: "write_document", arguments: { content: editedContent } };
        }
        if (step === 2) return { name: "read_document", arguments: {} };
        assert.equal(step, 3);
        assert.equal(result.result.content, editedContent);
        return { text: "已通过真实文档工具修改并读回核对。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "项目文档回归失败。" };
      }
    });
    t.after(() => model.close());
    const dashboard = await startDashboard({
      modelEndpoint: model.baseUrl,
      model: "protocol-fixture",
      defaultProject: false
    });
    t.after(() => dashboard.stop());
    const projectDirectory = join(dashboard.root, "project");
    await mkdir(projectDirectory);
    assert.notEqual(projectDirectory, dashboard.workspaceRoot);
    const api = async (path, body, expectedStatus = 200) => {
      const response = await fetch(`${dashboard.base}${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            }),
        signal: AbortSignal.timeout(5_000)
      });
      const payload = await response.json();
      assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(payload)}`);
      return payload;
    };
    const settle = async () => {
      const until = Date.now() + 30_000;
      let detail;
      while (Date.now() < until) {
        detail = await api(`/api/tasks/${taskId}`);
        if (!detail.runtime.active && ["completed", "failed", "cancelled"].includes(detail.task.status)) {
          assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
          assert.deepEqual(failures, []);
          return detail;
        }
        await delay(40);
      }
      assert.fail(`Main did not settle: ${JSON.stringify(detail?.task)}`);
    };

    const { project } = await api("/api/projects", { projectName: "独立文档项目", projectDirectory }, 201);
    const task = await api(
      "/api/tasks",
      { taskId, goal: "读取并编辑独立项目文档", projectId: project.projectId },
      201
    );
    assert.equal(task.projectDirectory, projectDirectory);
    assert.equal(task.storageRoot, dashboard.workspaceRoot);
    const opened = await api(
      "/api/workbench/open-application",
      { appType: "text-editor", workspaceRoot: projectDirectory },
      201
    );
    const appInstanceId = opened.appInstance.appInstanceId;
    const created = await api(
      `/api/workbench/instances/${encodeURIComponent(appInstanceId)}/resources`,
      { kind: "text/plain", title, initialContent },
      201
    );
    resourceId = created.resource.resourceId;
    const documentPath = new ResourceFiles(projectDirectory).absolutePath(created.resource);
    assert.equal(await readFile(documentPath, "utf8"), initialContent);
    await assert.rejects(access(new ResourceFiles(dashboard.workspaceRoot).absolutePath(created.resource)), {
      code: "ENOENT"
    });
    await api("/api/workbench/load-instance", { taskId, appInstanceId });
    const context = await api(`/api/tasks/${taskId}/active-app-context`);
    assert.equal(context.context.resource.resourceId, resourceId);
    assert.equal(context.context.resource.title, title);
    const manifestPath = join(dashboard.workspaceRoot, taskId, "applications", "manifest.json");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).workspaceRoot, projectDirectory);
    await assert.rejects(access(join(projectDirectory, taskId, "task.json")), { code: "ENOENT" });

    const firstRun = await api(
      `/api/tasks/${taskId}/run`,
      { prompt: "读取文档，追加内容，再读回核对。" },
      202
    );
    const completed = await settle();
    assert.equal(seen.edit.length, 4);
    assert.equal(completed.projectDirectory, projectDirectory);
    assert.equal(completed.storageRoot, dashboard.workspaceRoot);
    assert.equal(await readFile(documentPath, "utf8"), editedContent);
    const read = await api(`/api/tasks/${taskId}/resources/${resourceId}`);
    assert.equal(read.snapshot.content, editedContent);
    assert.equal(read.resource.revision, 1);
    const executions = completed.runtimeEvents
      .map((event) => event.payload)
      .filter((event) => event.type === "tool_execution_end");
    assert.deepEqual(
      executions.map((event) => event.toolName),
      ["read_document", "write_document", "read_document"]
    );
    assert.ok(executions.every((event) => event.isError === false));
    await access(join(dashboard.workspaceRoot, taskId, "runs", firstRun.runId, "run_events.jsonl"));
    assert.equal(
      JSON.parse(await readFile(join(dashboard.workspaceRoot, taskId, "task.json"), "utf8")).status,
      "completed"
    );
    await assert.rejects(access(join(projectDirectory, taskId, "runs")), { code: "ENOENT" });

    await dashboard.restart({ newPort: true });
    const restored = await api(`/api/tasks/${taskId}/active-app-context`);
    assert.equal(restored.context.resource.resourceId, resourceId);
    assert.equal(restored.context.resource.revision, 1);
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).workspaceRoot, projectDirectory);
    phase = "restored";
    const continued = await api(
      `/api/tasks/${taskId}/run`,
      { prompt: "重启后继续，只读取已保存的文档。" },
      202
    );
    assert.notEqual(continued.runId, firstRun.runId);
    await settle();
    assert.equal(seen.restored.length, 2);
    assert.equal(await readFile(documentPath, "utf8"), editedContent);

    await api(`/api/tasks/${taskId}/app-instances/unbind`, {});
    assert.equal((await api(`/api/tasks/${taskId}/active-app-context`)).context, null);
    phase = "unloaded";
    await api(`/api/tasks/${taskId}/run`, { prompt: "应用已卸载，请回复普通对话确认。" }, 202);
    await settle();
    assert.equal(seen.unloaded.length, 1);
    assert.deepEqual(failures, []);
    assert.equal(await readFile(documentPath, "utf8"), editedContent);
  }
);
