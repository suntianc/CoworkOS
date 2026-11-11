import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  link,
  stat,
  chmod
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { projectAtriaSystemMessage } from "../dist/src/domain/agent-identity.js";
import { createSessionExport } from "../dist/src/storage/session-export.js";
import { exportCliSession } from "../scripts/cli-session-export.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
const exec = promisify(execFile);
const entry = resolve(process.env.ATRIA_TEST_CLI_ENTRY || "scripts/atria.mjs");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
const { registerCliCommands } = await jiti.import(resolve(".pi/runtime/cli-commands.ts"));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-contract-"));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project"),
    user = join(root, "user"),
    profile = join(user, "pi");
  const workspace = join(user, "workspace"),
    sessionDirectory = join(profile, "sessions", "--project--");
  await mkdir(project, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  const sessionId = "11111111-2222-3333-4444-555555555555",
    taskId = "pi-legacy-task";
  const sessionPath = join(sessionDirectory, "fixture.jsonl");
  const apiKey = "isolated-contract-provider-key",
    searchKey = "isolated-contract-search-key";
  const previousKey = "isolated-contract-config-provider-key",
    previousSearchKey = "isolated-contract-config-search-key";
  const secrets = [apiKey, searchKey, previousKey, previousSearchKey];
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ apiKey: previousKey, serperApiKey: previousSearchKey }));
  const records = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
    {
      type: "custom",
      id: "bind",
      parentId: null,
      timestamp,
      customType: "atria-cli-task",
      data: {
        version: 1,
        sessionId,
        taskId,
        workspaceRoot: workspace,
        projectDirectory: project,
        sessionFile: sessionPath
      }
    },
    {
      type: "message",
      id: "user",
      parentId: "bind",
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: `Preserve task and tool evidence ${secrets.join(" ")}` }],
        timestamp: Date.now()
      }
    },
    {
      type: "message",
      id: "call",
      parentId: "user",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "source.md" } }],
        stopReason: "toolUse",
        responseId: "response-1",
        timestamp: Date.now()
      }
    },
    {
      type: "message",
      id: "result-a",
      parentId: "call",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "historical result" }],
        details: { revision: 1 },
        isError: true,
        timestamp: Date.now()
      }
    },
    {
      type: "message",
      id: "result-b",
      parentId: "call",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "current result" }],
        details: { revision: 2 },
        isError: false,
        timestamp: Date.now()
      }
    },
    {
      type: "message",
      id: "bash",
      parentId: "result-b",
      timestamp,
      message: {
        role: "bashExecution",
        command: "pwd",
        output: "bash audit output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: Date.now()
      }
    },
    {
      type: "custom_message",
      id: "notice",
      parentId: "bash",
      timestamp,
      customType: "fixture-notice",
      content: "<script>unsafe()</script>",
      display: true,
      details: { reason: "fixture" }
    }
  ];
  await writeFile(sessionPath, records.map(JSON.stringify).join("\n") + "\n");
  const store = new LocalWorkspaceStore(workspace);
  await store.createTask(taskId, { projectDirectory: project });
  await store.createRun(taskId, "legacy-run");
  await store.publishArtifact({
    taskId,
    runId: "legacy-run",
    producerAgentId: "main",
    relativePath: "artifacts/report.txt",
    content: "verified artifact"
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name)
    )
  );
  Object.assign(env, {
    ATRIA_HOME: user,
    COWORK_CONFIG: config,
    COWORK_API_KEY: apiKey,
    COWORK_SERPER_API_KEY: searchKey,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  const run = (args, options = {}) => {
    const pending = exec(process.execPath, [entry, ...args], {
      cwd: project,
      env,
      timeout: 15000,
      ...options
    });
    pending.child.stdin.end();
    return pending;
  };
  return {
    root,
    project,
    user,
    profile,
    workspace,
    sessionId,
    taskId,
    sessionPath,
    secrets,
    run,
    apiKey,
    searchKey,
    env,
    cleanup
  };
}

test("offline CoworkOS exports resolve nested session IDs, preserve branches, metadata and source bytes", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.sessionPath),
    taskBefore = await readFile(join(f.workspace, f.taskId, "task.json"));
  const result = JSON.parse((await f.run(["session", "export", f.sessionId])).stdout);
  assert.match(result.outputPath, /coworkos-session-.*\.json$/);
  const raw = await readFile(result.outputPath, "utf8"),
    data = JSON.parse(raw);
  assert.equal(data.format, "atria.session");
  assert.equal(data.producer.name, "CoworkOS");
  assert.equal(data.session.taskId, f.taskId);
  assert.equal(data.session.runId, "legacy-run");
  assert.equal(data.artifacts.length, 1);
  assert.equal(data.artifacts[0].relativePath, "artifacts/report.txt");
  assert.equal(data.toolCalls[0].resultMessageId, "result-b");
  assert.deepEqual(data.toolCalls[0].resultMessageIds, ["result-a", "result-b"]);
  assert.equal(data.messages.find((m) => m.messageId === "result-a").inCurrentBranch, false);
  assert.equal(data.messages.find((m) => m.messageId === "result-b").metadata.details.revision, 2);
  assert.equal(data.messages.find((m) => m.messageId === "call").metadata.responseId, "response-1");
  assert.equal(data.messages.find((m) => m.role === "bashExecution").metadata.output, "bash audit output");
  assert.equal(data.messages.find((m) => m.role === "notice").metadata.customType, "fixture-notice");
  assert.ok(!raw.includes(f.apiKey));
  assert.ok(!raw.includes(f.searchKey));
  for (const key of f.secrets) assert.ok(!raw.includes(key));
  assert.deepEqual(await readFile(f.sessionPath), before);
  assert.deepEqual(await readFile(join(f.workspace, f.taskId, "task.json")), taskBefore);
  await assert.rejects(f.run(["session", "export", f.sessionId]), /导出文件已存在/);
  await f.run(["session", "export", f.sessionId.slice(0, 8), "--force"]);
  const htmlResult = JSON.parse((await f.run(["start", "--export", f.sessionPath])).stdout);
  const html = await readFile(htmlResult.outputPath, "utf8");
  assert.ok(html.includes("· CoworkOS"));
  assert.ok(html.includes("current result"));
  assert.ok(!html.includes("<script>unsafe()"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("pi.dev"));
  assert.ok(!html.includes(f.apiKey));
  assert.equal((await stat(result.outputPath)).mode & 0o777, 0o600);
});

test("legacy/BOM exports are read-only, bind symlink workspaces and never overwrite their source", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.sessionPath, "utf8");
  await writeFile(f.sessionPath, "\uFEFF" + original);
  const alias = join(f.root, "workspace-alias");
  await symlink(f.workspace, alias, "dir");
  const output = await exportCliSession({
    source: f.sessionPath,
    agentDir: f.profile,
    workspaceRoot: alias,
    directory: f.project
  });
  assert.equal(JSON.parse(await readFile(output.outputPath, "utf8")).session.taskId, f.taskId);
  assert.equal(await readFile(f.sessionPath, "utf8"), "\uFEFF" + original);
  await assert.rejects(
    exportCliSession({
      source: f.sessionPath,
      agentDir: f.profile,
      workspaceRoot: alias,
      directory: f.project,
      outputPath: f.sessionPath,
      force: true
    }),
    /不能覆盖原始/
  );
  const hardlink = join(f.project, "hardlink.jsonl");
  await link(f.sessionPath, hardlink);
  await assert.rejects(
    exportCliSession({
      source: f.sessionPath,
      agentDir: f.profile,
      workspaceRoot: alias,
      directory: f.project,
      outputPath: hardlink,
      force: true
    }),
    /不能覆盖原始/
  );
  const broken = join(f.project, "broken.jsonl");
  await writeFile(broken, '{"id":"private-header-secret');
  await assert.rejects(f.run(["session", "export", broken]), (error) => {
    assert.match(error.stderr, /无效的会话文件头/);
    assert.ok(!error.stderr.includes("private-header-secret"));
    return true;
  });
  const legacy = join(f.project, "legacy.jsonl");
  await writeFile(legacy, original.replace('"version":3', '"version":2'));
  const legacyBefore = await readFile(legacy);
  await f.run(["session", "export", legacy, "--output", "legacy-export.json"]);
  assert.deepEqual(await readFile(legacy), legacyBefore);
  const v1 = join(f.project, "v1.jsonl");
  const v1Raw =
    [
      { type: "session", id: f.sessionId, cwd: f.project, timestamp: new Date().toISOString() },
      {
        type: "message",
        message: { role: "user", content: "Early transcript without version", timestamp: Date.now() }
      }
    ]
      .map(JSON.stringify)
      .join("\n") + "\n";
  await writeFile(v1, v1Raw);
  const v1Export = JSON.parse((await f.run(["session", "export", v1, "--output", "v1-export.json"])).stdout);
  assert.equal(
    JSON.parse(await readFile(v1Export.outputPath, "utf8")).messages[0].content,
    "Early transcript without version"
  );
  const v1Message = JSON.parse(await readFile(v1Export.outputPath, "utf8")).messages[0];
  assert.ok(v1Message.messageId);
  assert.equal(v1Message.parentEntryId, null);
  assert.equal(v1Message.inCurrentBranch, true);
  assert.equal(await readFile(v1, "utf8"), v1Raw);
});

test("offline exports reject malformed records and cyclic branches without touching source or output", async (t) => {
  const f = await fixture(t);
  const header = JSON.parse((await readFile(f.sessionPath, "utf8")).split("\n")[0]);
  const message = (id, parentId) => ({
    type: "message",
    id,
    parentId,
    message: { role: "user", content: "private-record-marker" }
  });
  const cases = [
    ["self-cycle", [message("x", "x")]],
    ["two-node-cycle", [message("x", "y"), message("y", "x")]],
    ["inactive-branch-cycle", [message("x", "y"), message("y", "x"), message("leaf", null)]],
    ["missing-id", [message(undefined, null)]],
    ["empty-id", [message("", null)]],
    ["duplicate-id", [message("x", null), message("x", null)]],
    ["missing-parent", [{ ...message("x", null), parentId: undefined }]],
    ["invalid-parent", [message("x", 42)]],
    ["dangling-parent", [message("x", "absent")]],
    ["missing-message", [{ type: "message", id: "x", parentId: null }]],
    ["missing-role", [{ ...message("x", null), message: { content: "private-record-marker" } }]],
    ["null-entry", [null]],
    ["array-entry", [[]]],
    ["embedded-header", [header]]
  ];
  for (const [name, entries] of cases)
    await t.test(name, async () => {
      const source = join(f.project, `${name}.jsonl`),
        output = join(f.project, `${name}.html`);
      const original = [header, ...entries].map(JSON.stringify).join("\n") + "\n";
      await writeFile(source, original);
      await writeFile(output, "previous export");
      await assert.rejects(
        f.run(["session", "export", source, "--format", "html", "--output", output, "--force"], {
          env: { ...f.env, NODE_OPTIONS: "--max-old-space-size=64", TMPDIR: f.root },
          timeout: 5000
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /会话记录/);
          assert.ok(!error.stderr.includes("private-record-marker"));
          assert.equal(error.stdout, "");
          return true;
        }
      );
      assert.equal(await readFile(source, "utf8"), original);
      assert.equal(await readFile(output, "utf8"), "previous export");
    });
});

test("forced JSON and HTML exports become private and preserve source/link protections", async (t) => {
  const f = await fixture(t),
    original = await readFile(f.sessionPath);
  for (const format of ["json", "html"]) {
    const output = join(f.project, `public-${format}.${format}`);
    await writeFile(output, "previous export");
    await chmod(output, 0o644);
    await assert.rejects(
      f.run(["session", "export", f.sessionPath, "--format", format, "--output", output]),
      /导出文件已存在/
    );
    assert.equal(await readFile(output, "utf8"), "previous export");
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o644);
    await f.run(["session", "export", f.sessionPath, "--format", format, "--output", output, "--force"]);
    assert.match(await readFile(output, "utf8"), /atria.session/);
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
  }
  const links = [
    f.sessionPath,
    join(f.project, "source-hardlink.jsonl"),
    join(f.project, "source-symlink.jsonl")
  ];
  await link(f.sessionPath, links[1]);
  await symlink(f.sessionPath, links[2]);
  const mode = (await stat(f.sessionPath)).mode;
  for (const output of links) {
    await assert.rejects(
      f.run(["session", "export", f.sessionPath, "--output", output, "--force"]),
      /不能覆盖原始/
    );
    assert.deepEqual(await readFile(f.sessionPath), original);
    assert.equal((await stat(f.sessionPath)).mode, mode);
  }
});

test("shared audit serialization validates inactive branches and handles deep valid parent chains", async () => {
  const input = { sessionId: "fixture", projectDirectory: "/fixture", branchEntryIds: ["leaf"] };
  const entries = [
    { type: "custom", id: "x", parentId: "y" },
    { type: "custom", id: "y", parentId: "x" },
    { type: "custom", id: "leaf", parentId: null }
  ];
  await assert.rejects(createSessionExport({ ...input, entries }), /会话记录.*循环/);
  assert.equal(entries[0].parentId, "y");
  await assert.rejects(
    createSessionExport({ ...input, entries: [{ type: "custom", parentId: null }] }),
    /会话记录.*ID/
  );
  const length = 16000;
  const deep = Array.from({ length }, (_, index) => ({
    type: "custom",
    id: `entry-${index}`,
    parentId: index + 1 < length ? `entry-${index + 1}` : null,
    customType: "deep-audit-event",
    data: { index }
  }));
  const exported = await createSessionExport({
    ...input,
    entries: deep,
    branchEntryIds: deep.map((entry) => entry.id)
  });
  assert.equal(exported.events.length, length);
  assert.equal(exported.events[0].parentEntryId, "entry-1");
  assert.equal(exported.events.at(-1).parentEntryId, null);
  assert.ok(exported.events.every((event) => event.inCurrentBranch));
});

test("owned slash commands intercept the submission boundary and generate only local outputs", async (t) => {
  const f = await fixture(t),
    commands = new Map(),
    notifications = [],
    submitted = [];
  const session = SessionManager.open(f.sessionPath);
  let editorText = "";
  const editor = { onSubmit: undefined, getText: () => editorText, getExpandedText: () => editorText };
  let factory, autocomplete;
  const ctx = {
    mode: "tui",
    sessionManager: session,
    ui: {
      notify: (value) => notifications.push(value),
      addAutocompleteProvider: (wrapper) => {
        autocomplete = wrapper(
          new CombinedAutocompleteProvider(
            [
              { name: "share", description: "Share session as a secret GitHub gist" },
              { name: "bug", description: "Report a bug to the Pi developers" },
              { name: "model", description: "Select a model" }
            ],
            f.project,
            null
          )
        );
      },
      getEditorComponent: () => () => editor,
      setEditorComponent: (value) => {
        factory = value;
      }
    }
  };
  const adapter = registerCliCommands(
    { registerCommand: (name, command) => commands.set(name, command) },
    {
      workspaceRoot: f.workspace,
      taskId: f.taskId,
      runId: "legacy-run",
      projectDirectory: f.project,
      secrets: f.secrets
    }
  );
  adapter.configure(ctx);
  const suggestions = await autocomplete.getSuggestions(["/sh"], 0, 3, { signal: t.signal });
  assert.equal(suggestions.items[0].description, "Save a local CoworkOS session export");
  assert.equal(
    autocomplete.applyCompletion(["/sh"], 0, 3, suggestions.items[0], suggestions.prefix).lines[0],
    "/share "
  );
  const bug = await autocomplete.getSuggestions(["/bu"], 0, 3, { signal: t.signal });
  assert.match(bug.items[0].description, /local CoworkOS feedback/);
  const model = await autocomplete.getSuggestions(["/mo"], 0, 3, { signal: t.signal });
  assert.equal(model.items[0].description, "Select a model");
  const configured = factory({}, {}, {});
  configured.onSubmit = (text) => submitted.push(text);
  configured.onSubmit("/share local-share.html");
  configured.onSubmit("/bug description");
  configured.onSubmit("/model");
  configured.onSubmit("  /share whitespace.html  ");
  configured.onSubmit("\n/bug\tdescription");
  assert.deepEqual(submitted, [
    "/coworkos-share local-share.html",
    "/coworkos-bug description",
    "/model",
    "/coworkos-share whitespace.html",
    "/coworkos-bug description"
  ]);
  editorText = " \n/share busy.html";
  assert.equal(configured.getExpandedText(), "/coworkos-share busy.html");
  assert.equal(configured.getText(), "/coworkos-share busy.html");
  editorText = "  ordinary task text  ";
  assert.equal(configured.getText(), editorText);
  await commands.get("atria-share").handler("local-share.html", ctx);
  assert.ok((await readFile(join(f.project, "local-share.html"), "utf8")).includes("current result"));
  await commands.get("atria-bug").handler(`test ${f.searchKey}`, ctx);
  const report = (await readdir(f.project)).find((name) => name.startsWith("coworkos-feedback-"));
  assert.ok(!(await readFile(join(f.project, report), "utf8")).includes(f.searchKey));
  await commands.get("atria-changelog").handler("", ctx);
  assert.ok(notifications.some((text) => text.includes("暂无云端")));
  assert.ok(notifications.some((text) => text.includes("github.com/RUC-NLPIR/CoworkOS/issues")));
  assert.ok(notifications.every((text) => !text.includes("pi.dev")));
  for (const mode of ["json", "rpc", "print"]) assert.doesNotThrow(() => adapter.configure({ mode, ui: {} }));
});

test("identity projection preserves explicit user prompts, dynamic rules, system metadata and original entries", async () => {
  const preamble =
    "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
  const { buildSystemPromptSections } = await import(
    new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
  );
  const docs = buildSystemPromptSections({ cwd: "/fixture", contextFiles: [], skills: [] }).docs;
  const input = {
    role: "system",
    sections: { preamble, docs, tools: "new tool", rules: "new rule" },
    toolsAdded: [{ name: "new-tool" }],
    toolsRemoved: ["old-tool"]
  };
  const projected = projectAtriaSystemMessage(input);
  assert.match(projected.sections.preamble, /CoworkOS Main/);
  assert.equal(projected.sections.docs, null);
  const legacy = {
    ...input,
    sections: {
      ...input.sections,
      preamble: "You are Atria Main, the agent responsible for completing the user's tasks in Atria Cowork."
    }
  };
  assert.match(projectAtriaSystemMessage(legacy).sections.preamble, /CoworkOS Main/);
  const customLegacy = {
    ...legacy,
    sections: { ...legacy.sections, preamble: legacy.sections.preamble + " User customization." }
  };
  assert.equal(projectAtriaSystemMessage(customLegacy), customLegacy);
  assert.equal(projected.sections.rules, "new rule");
  assert.equal(projected.toolsAdded, input.toolsAdded);
  assert.equal(input.sections.preamble, preamble);
  assert.equal(input.sections.docs, docs);
  const custom = {
    role: "system",
    sections: {
      preamble: "User explicitly selected this identity.",
      docs: "Read Pi SDK docs for the requested programming task."
    }
  };
  assert.equal(projectAtriaSystemMessage(custom), custom);
  const data = await createSessionExport({
    sessionId: "fixture",
    projectDirectory: "/fixture",
    entries: [{ type: "message", id: "system", parentId: null, timestamp: "fixture", message: input }],
    branchEntryIds: ["system"]
  });
  assert.deepEqual(data.messages[0].metadata.toolsAdded, input.toolsAdded);
});

test("audit tool results belong to the nearest call when providers reuse IDs across turns", async () => {
  const call = (id, parentId, path) => ({
    type: "message",
    id,
    parentId,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "reused", name: "read", arguments: { path } }]
    }
  });
  const result = (id, parentId) => ({
    type: "message",
    id,
    parentId,
    message: {
      role: "toolResult",
      toolCallId: "reused",
      toolName: "read",
      content: [{ type: "text", text: id }],
      isError: false
    }
  });
  const data = await createSessionExport({
    sessionId: "fixture",
    projectDirectory: "/fixture",
    entries: [
      call("call-a", null, "a.txt"),
      result("result-a", "call-a"),
      call("call-b", "result-a", "b.txt"),
      result("result-b", "call-b"),
      result("result-b2", "call-b")
    ],
    branchEntryIds: ["call-a", "result-a", "call-b", "result-b2"]
  });
  assert.deepEqual(data.toolCalls[0].resultMessageIds, ["result-a"]);
  assert.deepEqual(data.toolCalls[1].resultMessageIds, ["result-b", "result-b2"]);
  assert.equal(data.toolCalls[1].resultMessageId, "result-b2");
});

test("start help belongs to CoworkOS and offline export rejects unsupported formats and mixed launch flags", async (t) => {
  const f = await fixture(t);
  const help = (await f.run(["start", "--help"])).stdout;
  assert.match(help, /CoworkOS/);
  assert.match(help, /session export/);
  assert.doesNotMatch(help, /pi.dev|PI_SHARE_VIEWER_URL|update \[source\|self\|pi\]/);
  await assert.rejects(f.run(["session", "export", f.sessionId, "--format", "zip"]), /须为 json 或 html/);
  await assert.rejects(f.run(["start", "--mode", "json", "--export", f.sessionPath]), /不能与运行参数混用/);
});

async function modelFixture(f) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream("openai-completions", { text: "CoworkOS fixture result." }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  f.cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  Object.assign(f.env, {
    COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
    COWORK_MODEL: "fixture",
    COWORK_MODEL_API: "openai-completions"
  });
  return requests;
}

test(
  "real RPC exports and feedback use CoworkOS commands without model calls or non-JSON stdout",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      requests = await modelFixture(f);
    const child = spawn(process.execPath, [entry, "--mode", "rpc", "--session", f.sessionPath], {
      cwd: f.project,
      env: f.env,
      stdio: "pipe"
    });
    const closed = new Promise((done) => child.once("close", done));
    f.cleanup.push(async () => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      await closed;
      clearTimeout(force);
    });
    const rows = [];
    let pending = "",
      stderr = "",
      parseError;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try {
          rows.push(JSON.parse(line));
        } catch (error) {
          parseError = error;
        }
      }
    });
    const wait = async (predicate) => {
      const deadline = Date.now() + 12000;
      while (!rows.some(predicate)) {
        assert.equal(parseError, undefined, "RPC stdout must stay JSONL");
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`RPC response missing: ${stderr}`);
        await new Promise((done) => setTimeout(done, 20));
      }
      return rows.find(predicate);
    };
    child.stdin.write(JSON.stringify({ id: "ready", type: "get_state" }) + "\n");
    assert.equal((await wait((row) => row.id === "ready")).success, true);
    for (const [id, message] of [
      ["export", "/coworkos-export json rpc-export.json"],
      ["share", "/coworkos-share rpc-share.html"],
      ["bug", `/coworkos-bug ${f.secrets.join(" ")}`],
      ["help", "/coworkos-help"]
    ]) {
      child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
      assert.equal((await wait((row) => row.id === id && row.type === "response")).success, true);
    }
    const data = JSON.parse(await readFile(join(f.project, "rpc-export.json"), "utf8"));
    assert.equal(data.producer.name, "CoworkOS");
    assert.equal(data.session.taskId, f.taskId);
    for (const key of f.secrets) assert.ok(!JSON.stringify(data).includes(key));
    assert.ok((await readFile(join(f.project, "rpc-share.html"), "utf8")).includes("· CoworkOS"));
    const report = (await readdir(f.project)).find((name) => name.startsWith("coworkos-feedback-"));
    for (const key of f.secrets) assert.ok(!(await readFile(join(f.project, report), "utf8")).includes(key));
    assert.equal(requests.length, 0);
    assert.equal(parseError, undefined);
    assert.ok(rows.some((row) => row.type === "extension_ui_request" && row.message?.includes("暂无云端")));
  }
);

test(
  "real provider requests preserve an explicitly selected custom system prompt",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      requests = await modelFixture(f);
    const custom = join(f.project, "system.txt");
    await writeFile(custom, "User-selected fixture identity. Read Pi SDK docs for this requested task.");
    const result = await f
      .run(["--print", "--no-session", "--system-prompt", custom, "Explain this fixture."])
      .catch((error) => {
        assert.fail(
          `CLI exit ${error.code}, ${requests.length} requests: ${error.stdout.slice(-4000)} ${error.stderr.slice(-4000)}`
        );
      });
    assert.match(result.stdout, /CoworkOS fixture result/);
    assert.equal(requests.length, 1);
    const system = requests[0].messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    assert.ok(system.includes("User-selected fixture identity. Read Pi SDK docs"));
    assert.ok(!system.includes("You are CoworkOS Main"));
  }
);
