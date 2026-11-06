import { applicationFixtureNodeOptions } from "./application-fixture.mjs";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
const { ResourceFiles } = await import("../dist/src/applications/resource-files.js");

test(
  "real Main reads a projectless attachment and temporary document, edits by CAS and restores its original roots after restart",
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
    let phase = "edit",
      step = 0,
      resourceId,
      uploadId;
    const failures = [];
    const model = await modelProtocolFixture("openai-completions", (request) => {
      try {
        const names = request.tools.map((tool) => tool.function.name);
        assert.ok(names.includes("read_document"));
        assert.ok(names.includes("write_document"));
        if (step++ === 0) {
          assert.ok(JSON.stringify(request.messages).includes(resourceId));
          if (phase === "edit") {
            assert.ok(names.includes("read_attachment"));
            assert.ok(JSON.stringify(request.messages).includes("input.txt"));
            return { name: "read_attachment", arguments: { id: uploadId } };
          }
          return { name: "read_document", arguments: {} };
        }
        const result = JSON.parse(request.messages.findLast((message) => message.role === "tool").content);
        assert.notEqual(result.ok, false, JSON.stringify(result));
        if (phase === "restored") {
          assert.equal(result.result.content, "Edited temporary copy\n");
          return { text: "Restored document verified." };
        }
        if (step === 2) {
          assert.ok(JSON.stringify(result).includes("Retained upload"));
          return { name: "read_document", arguments: {} };
        }
        if (step === 3) {
          assert.equal(result.result.content, "Temporary original\n");
          return { name: "write_document", arguments: { content: "Edited temporary copy\n" } };
        }
        if (step === 4) return { name: "read_document", arguments: {} };
        assert.equal(result.result.content, "Edited temporary copy\n");
        return { text: "Temporary attachment and document verified." };
      } catch (error) {
        failures.push(error.stack);
        return { text: "Fixture assertion failed." };
      }
    });
    t.after(() => model.close());
    const d = await startDashboard({
      modelEndpoint: model.baseUrl,
      model: "protocol-fixture",
      defaultProject: false
    });
    t.after(() => d.stop());
    const api = async (path, body, status = body === undefined ? 200 : 201) => {
      const response = await fetch(d.base + path, {
        ...(body === undefined
          ? {}
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8_000)
      });
      const result = await response.json();
      assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
      return result;
    };
    const opened = await api("/api/workbench/open-application", { appType: "text-editor" });
    const root = opened.tabs.find(
      (tab) => tab.appInstanceId === opened.appInstance.appInstanceId
    ).workspaceRoot;
    const created = await api(`/api/workbench/instances/${opened.appInstance.appInstanceId}/resources`, {
      kind: "text/plain",
      title: "Temporary.txt",
      initialContent: "Temporary original\n"
    });
    resourceId = created.resource.resourceId;
    const task = await api("/api/tasks", {
      taskId: "temporary-main",
      goal: "Read attachment and edit",
      projectId: null,
      temporaryWorkspaceRoot: root
    });
    assert.equal(task.projectId, null);
    await api(
      "/api/workbench/load-instance",
      { taskId: task.taskId, appInstanceId: opened.appInstance.appInstanceId },
      200
    );
    const uploadResponse = await fetch(d.base + "/api/uploads?name=input.txt", {
      method: "POST",
      body: "Retained upload\n",
      headers: { "content-type": "application/octet-stream" }
    });
    assert.equal(uploadResponse.status, 201);
    uploadId = (await uploadResponse.json()).uploadId;
    const settle = async () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const detail = await api(`/api/tasks/${task.taskId}`);
        if (!detail.runtime.active && ["completed", "failed", "cancelled"].includes(detail.task.status)) {
          assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
          assert.deepEqual(failures, []);
          return detail;
        }
        await delay(60);
      }
      assert.fail("Main did not settle");
    };
    await api(
      `/api/tasks/${task.taskId}/run`,
      { prompt: "Read attachment and document, then edit and verify.", attachmentIds: [uploadId] },
      202
    );
    const completed = await settle();
    assert.equal(step, 5);
    assert.equal(completed.storageRoot, d.workspaceRoot);
    assert.equal(completed.projectDirectory, root);
    const documentPath = new ResourceFiles(root).absolutePath(created.resource);
    assert.equal(await readFile(documentPath, "utf8"), "Edited temporary copy\n");
    await access(join(d.workspaceRoot, task.taskId, "task.json"));
    await assert.rejects(access(join(root, task.taskId, "task.json")), { code: "ENOENT" });
    const input = join(d.workspaceRoot, task.taskId, "inputs", uploadId, "original.txt");
    assert.equal(await readFile(input, "utf8"), "Retained upload\n");
    assert.deepEqual((await api("/api/tasks")).projects, []);
    await d.restart({ newPort: true });
    phase = "restored";
    step = 0;
    const restored = await api(`/api/tasks/${task.taskId}/active-app-context`);
    assert.equal(restored.context.resource.resourceId, resourceId);
    assert.equal(restored.context.resource.revision, 1);
    await api(`/api/tasks/${task.taskId}/run`, { prompt: "Read the restored document." }, 202);
    await settle();
    assert.equal(step, 2);
    assert.equal(await readFile(input, "utf8"), "Retained upload\n");
    assert.deepEqual((await api("/api/tasks")).projects, []);
  }
);
