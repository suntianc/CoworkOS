import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const resultText = (result) =>
  result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

// Real launcher, extension and Pi built-ins, with only the remote model replaced.
// Project-relative and Task-relative paths deliberately refer to different files.
test(
  "Main Pi tools share project CWD, require Task paths and recover from ambiguous edits",
  { timeout: 60_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atria-main-task-paths-")));
    const project = join(root, "Selected Project");
    const workspace = join(root, "Task Workspace");
    const taskId = "path-task";
    const taskRoot = join(workspace, taskId);
    const memoryPath = join(taskRoot, "agents", "main", "context", "memory.md");
    const pythonProbe = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 5000 });
    const python = pythonProbe.status === 0;
    const executable = python ? "python3" : process.execPath;
    const scriptName = python ? "create_harness_ppt.py" : "create_harness_fixture.mjs";
    const taskRelativeScript = `agents/main/work/${scriptName}`;
    const scriptPath = join(taskRoot, taskRelativeScript);
    const artifactPath = join(taskRoot, "artifacts", "path-proof.txt");
    const scriptSource = python
      ? `from pathlib import Path\nPath(${JSON.stringify(artifactPath)}).parent.mkdir(parents=True, exist_ok=True)\nPath(${JSON.stringify(artifactPath)}).write_text('TASK_ARTIFACT', encoding='utf-8')\nprint('TASK_BEFORE_EDIT')\n`
      : `import {mkdirSync, writeFileSync} from 'node:fs';\nimport {dirname} from 'node:path';\nmkdirSync(dirname(${JSON.stringify(artifactPath)}),{recursive:true});\nwriteFileSync(${JSON.stringify(artifactPath)},'TASK_ARTIFACT');\nconsole.log('TASK_BEFORE_EDIT');\n`;
    const projectScriptSource = python ? "print('PROJECT_SCRIPT')\n" : "console.log('PROJECT_SCRIPT');\n";
    const recoveryPath = join(taskRoot, "agents", "main", "work", "edit-recovery.mjs");
    const recoverySource = `const slides = [
  { title: "First", color: "blue" },
  { title: "Second", color: "blue" },
  { title: "Third", color: "blue" }
];
const footer = "draft";
`;
    const cwdCommand = `${shellQuote(process.execPath)} -e ${shellQuote("const fs=require('node:fs');console.log(JSON.stringify({cwd:process.cwd(),note:fs.readFileSync('project-note.txt','utf8')}))")}`;
    const cases = [
      ["write", { path: "project-note.txt", content: "PROJECT_BEFORE_EDIT\n" }],
      ["read", { path: "project-note.txt" }],
      ["edit", { path: "project-note.txt", oldText: "PROJECT_BEFORE_EDIT", newText: "PROJECT_AFTER_EDIT" }],
      ["bash", { command: cwdCommand, timeout: 10 }],
      ["write", { path: scriptPath, content: scriptSource }],
      ["read", { path: scriptPath }],
      ["edit", { path: scriptPath, oldText: "TASK_BEFORE_EDIT", newText: "TASK_AFTER_EDIT" }],
      ["browse_workspace", { mode: "read", path: taskRelativeScript }],
      ["bash", { command: `${shellQuote(executable)} ${shellQuote(taskRelativeScript)}`, timeout: 10 }],
      ["bash", { command: `${shellQuote(executable)} ${shellQuote(scriptPath)}`, timeout: 10 }],
      ["write", { path: taskRelativeScript, content: projectScriptSource }],
      ["read", { path: taskRelativeScript }],
      ["edit", { path: taskRelativeScript, oldText: "PROJECT_SCRIPT", newText: "PROJECT_SCRIPT_AFTER_EDIT" }],
      ["bash", { command: `${shellQuote(executable)} ${shellQuote(taskRelativeScript)}`, timeout: 10 }]
    ];
    const recoveryStart = cases.length;
    const footerEdit = { oldText: 'const footer = "draft";', newText: 'const footer = "ready";' };
    cases.push(
      ["write", { path: recoveryPath, content: recoverySource }],
      [
        "edit",
        {
          path: recoveryPath,
          edits: [{ oldText: 'color: "blue"', newText: 'color: "green"' }, footerEdit]
        }
      ],
      ["read", { path: recoveryPath }],
      [
        "edit",
        {
          path: recoveryPath,
          edits: [
            {
              oldText: '{ title: "First", color: "blue" }',
              newText: '{ title: "First", color: "green" }'
            },
            footerEdit
          ]
        }
      ]
    );
    const requests = [];
    const results = [];
    const instructionFailures = [];
    const failures = [];
    let child;
    let output = "";
    let pendingLine = "";
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request.setEncoding("utf8")) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `paths-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "task-path-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      try {
        if (requests.length === 1) {
          const system = body.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n");
          assert.ok(system.includes(`用户选择的项目目录：${project}`));
          assert.ok(system.includes(`本次任务工作区：${taskRoot}`));
          assert.ok(system.includes("read/edit/write/bash 的相对路径从这里开始"));
          assert.ok(system.includes(scriptPath.slice(0, -scriptName.length - 1)));
          assert.equal(
            (await stat(dirname(scriptPath))).isDirectory(),
            true,
            "Main's advertised work directory must exist before its first model request"
          );
          const clear = body.tools.find((tool) => tool.function.name === "clear_context");
          if (!clear.function.description.includes(memoryPath))
            instructionFailures.push(
              "clear_context must name its Task memory by absolute path, because edit/write use project CWD"
            );
        }
        const index = requests.length - 1;
        if (index === recoveryStart + 2) {
          const feedback = body.messages.find(
            (message) => message.role === "tool" && message.tool_call_id === `path-case-${recoveryStart + 1}`
          );
          assert.match(
            String(feedback?.content),
            /Found 3 occurrences of edits\[0\].*Each oldText must be unique/
          );
          assert.equal(
            await readFile(recoveryPath, "utf8"),
            recoverySource,
            "an ambiguous edit must reject the whole batch, including the unique footer edit"
          );
        }
        if (index === recoveryStart + 3) {
          const reread = body.messages.find(
            (message) => message.role === "tool" && message.tool_call_id === `path-case-${recoveryStart + 2}`
          );
          assert.equal(
            reread?.content,
            recoverySource,
            "the model must receive the unchanged source before retrying with unique context"
          );
        }
        if (index < cases.length) {
          const [name, args] = cases[index];
          send({
            tool_calls: [
              {
                index: 0,
                id: `path-case-${index}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          });
          send({}, "tool_calls");
        } else {
          assert.equal(index, cases.length);
          send({ content: "已核对项目目录与任务目录的路径行为。" });
          send({}, "stop");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "路径契约回归失败。" });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(project, { recursive: true });
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask(taskId, { goal: "路径契约隔离验收" });
    await store.createRun(taskId, "paths-run");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-id",
        "paths-run",
        "--session-dir",
        join(root, "sessions"),
        "在所选项目和任务工作目录中验证文件读写与运行路径。"
      ],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: workspace,
          COWORK_PROJECT_DIR: project,
          COWORK_TASK_ID: taskId,
          COWORK_RUN_ID: "paths-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-path-fixture",
          COWORK_MODEL: "task-path-fixture",
          COWORK_DASHBOARD_URL: "",
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          COWORK_WEB_TOOLS: "0",
          COWORK_SERPER_API_KEY: "",
          SERPER_API_KEY: "",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-10_000);
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "tool_execution_end") results.push(event);
        } catch {
          /* startup diagnostics are not JSON events */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-10_000);
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.equal(requests.length, cases.length + 1, output);
    assert.deepEqual(
      results.map((event) => event.toolName),
      cases.map(([name]) => name)
    );
    assert.deepEqual(
      results.filter((event) => event.isError).map((event) => event.toolCallId),
      ["path-case-8", `path-case-${recoveryStart + 1}`]
    );
    assert.match(resultText(results[1].result), /PROJECT_BEFORE_EDIT/);
    assert.deepEqual(JSON.parse(resultText(results[3].result)), {
      cwd: project,
      note: "PROJECT_AFTER_EDIT\n"
    });
    assert.match(resultText(results[5].result), /TASK_BEFORE_EDIT/);
    const browsed = JSON.parse(resultText(results[7].result));
    assert.equal(browsed.path, taskRelativeScript);
    assert.match(browsed.content, /TASK_AFTER_EDIT/);
    assert.ok(
      resultText(results[8].result).includes(join(project, taskRelativeScript)),
      "failed relative command must report the project path, not a fabricated missing interpreter"
    );
    assert.match(resultText(results[9].result), /TASK_AFTER_EDIT/);
    assert.match(resultText(results[11].result), /PROJECT_SCRIPT/);
    assert.match(resultText(results[13].result), /PROJECT_SCRIPT_AFTER_EDIT/);
    assert.equal(await readFile(join(project, "project-note.txt"), "utf8"), "PROJECT_AFTER_EDIT\n");
    assert.equal(
      await readFile(scriptPath, "utf8"),
      scriptSource.replace("TASK_BEFORE_EDIT", "TASK_AFTER_EDIT")
    );
    assert.equal(
      await readFile(join(project, taskRelativeScript), "utf8"),
      projectScriptSource.replace("PROJECT_SCRIPT", "PROJECT_SCRIPT_AFTER_EDIT")
    );
    assert.equal(await readFile(artifactPath, "utf8"), "TASK_ARTIFACT");
    assert.equal(results[recoveryStart + 3].isError, false);
    assert.equal(
      await readFile(recoveryPath, "utf8"),
      recoverySource
        .replace('title: "First", color: "blue"', 'title: "First", color: "green"')
        .replace(footerEdit.oldText, footerEdit.newText)
    );
    if (process.env.ATRIA_TASK_PATHS_RECEIPT) {
      const receiptPath = resolve(process.env.ATRIA_TASK_PATHS_RECEIPT);
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(
        receiptPath,
        `${JSON.stringify({ observedAt: new Date().toISOString(), scope: "isolated production launcher/extension/Pi tools, local model fixture only; no real model, user task, config or artifact changed", projectDirectory: project, taskWorkspace: taskRoot, interpreter: executable, pythonVersion: python ? pythonProbe.stdout.trim() : null, requests: requests.length, expectedMissingRelativeTaskPrefix: { callId: "path-case-8", isError: results[8].isError, output: resultText(results[8].result) }, absoluteTaskScriptRecovered: resultText(results[9].result).trim(), projectRelativeScriptSucceeded: resultText(results[13].result).trim(), artifact: { content: await readFile(artifactPath, "utf8"), generatedPpt: false }, clearContextAbsoluteMemoryInstruction: instructionFailures.length === 0, toolResults: results.map((event) => ({ toolCallId: event.toolCallId, tool: event.toolName, isError: event.isError })) }, null, 2)}\n`
      );
    }
    assert.deepEqual(instructionFailures, []);
  }
);
