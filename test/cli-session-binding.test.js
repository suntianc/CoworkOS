import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdtemp, mkdir, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { GlobalProjectCatalog } from "../dist/src/workspace/project-catalog.js";
import { recordCliSessionBinding, resolveCliSession } from "../scripts/cli-session.mjs";
import { alignSelectedTaskSession } from "../scripts/main-session.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-session-binding-"));
  const project = join(root, "project"),
    agentDir = join(root, "pi"),
    workspaceRoot = join(root, "workspace"),
    sessions = join(root, "sessions");
  await mkdir(project);
  const session = SessionManager.create(project, sessions);
  const store = new LocalWorkspaceStore(workspaceRoot);
  await store.createTask("original", { goal: "Retain the original task", projectDirectory: project });
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = (extra = {}) =>
    recordCliSessionBinding({
      sessionManager: session,
      workspaceRoot,
      taskId: "original",
      projectDirectory: project,
      appendEntry: (type, data) => session.appendCustomEntry(type, data),
      ...extra
    });
  const choose = (extra = {}) =>
    resolveCliSession({
      args: ["--session", session.getSessionFile()],
      workspaceRoot,
      projectDirectory: project,
      agentDir,
      env: {},
      ...extra
    });
  const flush = () => {
    session.appendMessage({ role: "user", content: "A unique session prompt.", timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A retained answer." }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    });
  };
  return { root, project, agentDir, workspaceRoot, sessions, session, store, record, choose, flush };
}

test("session bindings honor explicit Task selection and never rewrite a conflicting association", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.record()).status, "recorded");
  f.flush();
  assert.equal((await f.choose()).taskId, "original");
  await f.store.createTask("replacement", { projectDirectory: f.project });
  assert.equal((await f.record({ taskId: "replacement" })).status, "conflict");
  assert.equal((await f.choose()).taskId, "original");
  assert.equal((await f.choose({ explicitTaskId: "replacement" })).taskId, "replacement");
  assert.equal((await f.record({ taskId: "replacement", allowOverride: true })).status, "recorded");
  assert.equal((await f.choose()).taskId, "replacement");
});

test("different workspaces and forked/copied transcripts do not inherit a Task binding", async (t) => {
  const f = await fixture(t);
  await f.record();
  f.flush();
  const otherWorkspace = join(f.root, "other-workspace");
  await new LocalWorkspaceStore(otherWorkspace).createTask("original", { projectDirectory: f.project });
  assert.equal((await f.choose({ workspaceRoot: otherWorkspace })).taskId, undefined);
  const fork = SessionManager.forkFrom(f.session.getSessionFile(), f.project, f.sessions);
  assert.equal((await f.choose({ args: ["--session", fork.getSessionFile()] })).taskId, undefined);
  const copied = join(f.sessions, "copied.jsonl");
  await copyFile(f.session.getSessionFile(), copied);
  assert.equal((await f.choose({ args: ["--session", copied] })).taskId, undefined);
  const noSession = SessionManager.inMemory(f.project);
  assert.equal((await f.record({ sessionManager: noSession })).status, "skipped");
  assert.deepEqual(await f.choose({ args: ["--no-session", "--continue"] }), {});
});

test("invalid and mutually exclusive session flags fail before a recovery file is opened", async (t) => {
  const f = await fixture(t);
  await f.record();
  f.flush();
  for (const args of [
    ["--session-id", f.session.getSessionId(), "--continue"],
    ["--session-id", f.session.getSessionId(), "--session", f.session.getSessionFile()],
    ["--fork", f.session.getSessionFile(), "--continue"],
    ["--fork", f.session.getSessionFile(), "--no-session"]
  ])
    await assert.rejects(f.choose({ args }), /cannot be combined/);
  await assert.rejects(f.choose({ args: ["--session-id", "../escape"] }), /session id|session ID/i);
  await assert.rejects(f.choose({ args: ["--session", join(f.root, "missing.jsonl")] }), /does not exist/);
  const invalid = join(f.root, "invalid.jsonl");
  await writeFile(invalid, "null\n");
  await assert.rejects(f.choose({ args: ["--session", invalid] }), /valid header/);
  assert.equal(await readFile(invalid, "utf8"), "null\n");
  assert.equal(
    (await f.choose({ args: ["--", "--session-id", "not-a-uuid", "--resume"] })).taskId,
    undefined
  );
});

test("project path encoding collisions never select another project's newest session", async (t) => {
  const f = await fixture(t);
  const requested = join(f.root, "same-folder"),
    foreign = join(f.root, "same", "folder");
  await Promise.all([mkdir(requested), mkdir(foreign, { recursive: true })]);
  const requestedProject = await realpath(requested),
    foreignProject = await realpath(foreign);
  const encode = (path) => `--${path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  assert.equal(encode(requestedProject), encode(foreignProject));
  const sharedDirectory = join(f.agentDir, "sessions", encode(requestedProject));
  const foreignSession = SessionManager.create(foreignProject, sharedDirectory);
  await f.store.createTask("foreign", { projectDirectory: foreignProject });
  await f.record({
    sessionManager: foreignSession,
    projectDirectory: foreignProject,
    taskId: "foreign",
    appendEntry: (type, data) => foreignSession.appendCustomEntry(type, data)
  });
  foreignSession.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Foreign project history." }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  try {
    const selected = await f.choose({ args: ["--continue"], projectDirectory: requestedProject });
    assert.equal(
      selected.sessionPath,
      undefined,
      "another project with the same encoded directory must be ignored"
    );
    assert.equal(selected.taskId, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("an explicit existing Task cannot silently move into a different session project", async (t) => {
  const f = await fixture(t);
  await f.record();
  f.flush();
  await f.store.createTask("foreign", { projectDirectory: join(f.root, "foreign") });
  const taskFile = join(f.workspaceRoot, "foreign", "task.json");
  const taskBefore = await readFile(taskFile, "utf8"),
    sessionBefore = await readFile(f.session.getSessionFile(), "utf8");
  await assert.rejects(f.choose({ explicitTaskId: "foreign" }), /project.*session|项目.*会话/);
  assert.equal(await readFile(taskFile, "utf8"), taskBefore);
  assert.equal(await readFile(f.session.getSessionFile(), "utf8"), sessionBefore);
});

test("a project folder edit retains exact CLI Task binding and forks history into the new CWD", async (t) => {
  const f = await fixture(t);
  const catalog = new GlobalProjectCatalog(join(f.root, "projects.json"));
  const project = await catalog.create({ projectName: "Research", projectDirectory: f.project });
  await f.store.updateTask("original", {
    projectId: project.projectId,
    projectCatalogPath: catalog.filePath,
    projectDirectory: f.project
  });
  await f.record();
  f.flush();
  const original = f.session.getSessionFile();
  const before = await readFile(original, "utf8");
  const moved = join(f.root, "moved");
  await mkdir(moved);
  await catalog.update(project.projectId, { projectDirectory: moved }, (_previous, _next, commit) =>
    commit([{ storageRoot: f.workspaceRoot, taskId: "original" }])
  );
  for (const explicitTaskId of [undefined, "original"]) {
    const selected = await f.choose({ explicitTaskId });
    assert.equal(selected.taskId, "original");
    assert.equal(selected.projectDirectory, moved);
  }
  const aligned = await alignSelectedTaskSession(original, f.sessions, moved);
  assert.notEqual(aligned, original);
  const restored = SessionManager.open(aligned, f.sessions);
  assert.equal(restored.getHeader().cwd, await realpath(moved));
  assert.ok(
    restored
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "A unique session prompt."
      )
  );
  await f.record({
    sessionManager: restored,
    projectDirectory: moved,
    appendEntry: (type, data) => restored.appendCustomEntry(type, data)
  });
  assert.equal((await f.choose({ args: ["--session", aligned] })).taskId, "original");
  assert.equal(await readFile(original, "utf8"), before, "the source transcript remains recoverable");
});
