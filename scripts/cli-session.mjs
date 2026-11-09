import { readFile, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

export const CLI_TASK_ENTRY = "atria-cli-task";

export async function canonical(path) {
  const candidate = resolve(path);
  return realpath(candidate).catch(async (error) => {
    if (error.code === "ENOENT") return join(await canonical(dirname(candidate)), basename(candidate));
    throw error;
  });
}

function pathArg(value, cwd) {
  return resolve(
    cwd,
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
  );
}

function optionValue(args, name) {
  const index = args.lastIndexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** A copied/forked transcript is a different session, even when it contains the same custom entries. */
async function matchingBinding(session, workspaceRoot, projectDirectory) {
  const workspace = await canonical(workspaceRoot),
    project = await canonical(projectDirectory);
  const sessionId = session.getSessionId();
  const sessionFile = session.getSessionFile?.();
  const candidates = session
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === CLI_TASK_ENTRY)
    .reverse();
  for (const entry of candidates) {
    const data = entry.data;
    if (
      data?.version !== 1 ||
      data.sessionId !== sessionId ||
      !/^[a-zA-Z0-9._-]+$/.test(data.taskId ?? "") ||
      data.taskId === "." ||
      data.taskId === ".."
    )
      continue;
    if (
      typeof data.workspaceRoot !== "string" ||
      typeof data.projectDirectory !== "string" ||
      typeof data.sessionFile !== "string" ||
      !sessionFile
    )
      continue;
    if ((await canonical(data.sessionFile)) !== (await canonical(sessionFile))) continue;
    if ((await canonical(data.workspaceRoot)) !== workspace) continue;
    // eslint-disable-next-line no-restricted-syntax -- 旧绑定指向的 Task 可能已被删除，读不到时跳过这条记录而不能中断会话发现
    const task = await new LocalWorkspaceStore(workspace).readTask(data.taskId).catch(() => undefined);
    if (!task) continue;
    // A catalog project may change its working folder while retaining this
    // exact Task and transcript. Legacy bindings still require their old CWD.
    if (!task.projectId || !task.projectCatalogPath) {
      if ((await canonical(data.projectDirectory)) !== project) continue;
      if (task.projectDirectory && (await canonical(task.projectDirectory)) !== project) continue;
    }
    return data;
  }
}

/** Older releases recorded full Pi entries in each Task snapshot. Reuse only a unique exact message identity match. */
async function legacyTask(session, workspaceRoot, projectDirectory) {
  if (session.getHeader()?.parentSession) return undefined;
  const ids = session
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.id);
  if (ids.length === 0) return undefined;
  const project = await canonical(projectDirectory);
  const matches = [];
  for (const task of await new LocalWorkspaceStore(workspaceRoot).listTasks()) {
    if (task.projectDirectory && (await canonical(task.projectDirectory)) !== project) continue;
    let entries;
    try {
      entries = JSON.parse(
        await readFile(join(workspaceRoot, task.taskId, "agents/main/context/messages.json"), "utf8")
      );
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw error;
    }
    if (!Array.isArray(entries)) continue;
    const saved = entries.filter((entry) => entry?.type === "message").map((entry) => entry.id);
    if (
      saved.length === ids.length &&
      saved.every((id, index) => typeof id === "string" && id === ids[index])
    )
      matches.push(task.taskId);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export async function allProjectSessions(agentDir) {
  let dirs;
  try {
    dirs = await readdir(join(agentDir, "sessions"), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const all = await Promise.all(
    dirs
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => SessionManager.listAll(join(agentDir, "sessions", entry.name)))
  );
  return all.flat().sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function localProjectSessions(project, sessionDirectory) {
  // Pi's directory encoding can collide (same-folder and same/folder). Always
  // verify header CWD, even when Pi regards this as a default session directory.
  const sessions = await SessionManager.listAll(sessionDirectory);
  const belongs = await Promise.all(
    sessions.map(async (session) => (await canonical(session.cwd)) === project)
  );
  return sessions.filter((_session, index) => belongs[index]);
}

/** Resolve the exact file before Pi starts so its immutable Task-scoped tools and Inbox share the selected identity. */
export async function resolveCliSession({
  args,
  workspaceRoot,
  projectDirectory,
  agentDir,
  explicitTaskId,
  env = process.env
}) {
  const boundary = args.indexOf("--");
  const options = boundary < 0 ? args : args.slice(0, boundary);
  const requestedId = optionValue(options, "--session-id");
  const conflicts = options.filter((flag) =>
    ["--session", "--continue", "-c", "--resume", "-r"].includes(flag)
  );
  if (requestedId !== undefined) {
    if (conflicts.length) throw new Error(`--session-id cannot be combined with ${conflicts.join(", ")}`);
    SessionManager.inMemory(projectDirectory, { id: requestedId });
  }
  if (options.includes("--fork")) {
    const forkConflicts = [...conflicts, ...options.filter((flag) => flag === "--no-session")];
    if (forkConflicts.length) throw new Error(`--fork cannot be combined with ${forkConflicts.join(", ")}`);
  }
  if (
    options.includes("--no-session") ||
    options.includes("--help") ||
    options.includes("-h") ||
    options.includes("--list-models")
  )
    return {};
  const project = await canonical(projectDirectory);
  const explicitDirectory =
    optionValue(options, "--session-dir") ??
    env.PI_CODING_AGENT_SESSION_DIR ??
    env.ATRIA_CODING_AGENT_SESSION_DIR ??
    SettingsManager.create(project, agentDir, { projectTrusted: false }).getSessionDir();
  // Pi's documented project-local profile layout; pass it explicitly to both discovery and launch.
  const sessionDirectory = explicitDirectory
    ? pathArg(explicitDirectory, project)
    : join(agentDir, "sessions", `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const selected = optionValue(options, "--session");
  const exactId = optionValue(options, "--session-id");
  if (options.includes("--fork")) return { sessionDirectory };
  let sessionPath;
  if (!selected && (options.includes("--resume") || options.includes("-r"))) {
    const local = await localProjectSessions(project, sessionDirectory);
    const global = explicitDirectory
      ? await SessionManager.listAll(sessionDirectory)
      : await allProjectSessions(agentDir);
    const sessions = [...new Map([...local, ...global].map((session) => [session.path, session])).values()];
    const { selectCliSession } = await import("./cli-session-picker.mjs");
    sessionPath = await selectCliSession({ sessions });
    if (!sessionPath) return { cancelled: true };
  }
  if (
    !sessionPath &&
    selected &&
    (selected.includes("/") || selected.includes("\\") || selected.endsWith(".jsonl"))
  )
    sessionPath = pathArg(selected, project);
  else if (
    !sessionPath &&
    (selected || exactId || options.includes("--continue") || options.includes("-c"))
  ) {
    const local = await localProjectSessions(project, sessionDirectory);
    if (selected || exactId) {
      const id = selected ?? exactId;
      const search =
        selected && !explicitDirectory ? [...local, ...(await allProjectSessions(agentDir))] : local;
      const matches = search.filter((item) => item.id === id || (selected && item.id.startsWith(id)));
      const unique = [...new Map(matches.map((item) => [item.path, item])).values()];
      const exact = unique.filter((item) => item.id === id);
      if (exact.length === 1) sessionPath = exact[0].path;
      else if (exact.length > 1 || unique.length > 1)
        throw new Error(
          "会话 ID 不唯一，请使用完整会话文件路径。Ambiguous session ID; use its full file path."
        );
      else if (unique.length === 1) sessionPath = unique[0].path;
      else if (selected)
        throw new Error(
          "未找到所选会话，请检查 ID 或文件路径。Selected session not found; check its ID or path."
        );
    } else sessionPath = local[0]?.path;
  }
  if (!sessionPath) return { sessionDirectory };
  let header;
  try {
    header = JSON.parse((await readFile(sessionPath, "utf8")).split("\n")[0].replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "所选会话文件不存在，请检查路径。Selected session file does not exist; check its path."
      );
    if (error instanceof SyntaxError)
      throw new Error(
        "所选会话文件无效，原始文件已保留。Selected session file is invalid; the original file was preserved."
      );
    throw error;
  }
  if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
    throw new Error(
      "所选会话文件缺少有效记录头，原始文件已保留。Selected session has no valid header; the original file was preserved."
    );
  const selectedProject = await canonical(header.cwd);
  const selectedDirectory = explicitDirectory ? sessionDirectory : dirname(sessionPath);
  const session = SessionManager.open(sessionPath, selectedDirectory);
  const binding = await matchingBinding(session, workspaceRoot, selectedProject);
  if (explicitTaskId) {
    const explicitTask = await new LocalWorkspaceStore(workspaceRoot)
      .readTask(explicitTaskId)
      .catch((error) => {
        if (error.message === `unknown task: ${explicitTaskId}`) return undefined;
        throw error;
      });
    if (
      explicitTask?.projectDirectory &&
      (await canonical(explicitTask.projectDirectory)) !== selectedProject &&
      !(explicitTask.projectId && explicitTask.projectCatalogPath && binding?.taskId === explicitTaskId)
    )
      throw new Error(
        "显式任务的项目与所选会话不一致。请选择该任务的原会话，或使用另一个任务。Explicit Task project differs from the selected session; choose its original session or another Task."
      );
  }
  // Existing metadata in another workspace is never guessed into the current workspace.
  const hasBinding = session
    .getEntries()
    .some((item) => item.type === "custom" && item.customType === CLI_TASK_ENTRY);
  const taskId =
    explicitTaskId ??
    binding?.taskId ??
    (hasBinding ? undefined : await legacyTask(session, workspaceRoot, selectedProject));
  const task = taskId
    ? // eslint-disable-next-line no-restricted-syntax -- 会话绑定的 Task 快照可能已被删除，读不到就按没有任务继续解析工作目录
      await new LocalWorkspaceStore(workspaceRoot).readTask(taskId).catch(() => undefined)
    : undefined;
  return {
    taskId,
    projectDirectory: task?.projectId && task.projectCatalogPath ? task.projectDirectory : selectedProject,
    sessionPath,
    sessionId: session.getSessionId(),
    sessionDirectory: selectedDirectory
  };
}

/** Called once at session_start after Pi has selected/created its session. Custom entries never enter model context. */
export async function recordCliSessionBinding({
  sessionManager,
  workspaceRoot,
  taskId,
  projectDirectory,
  appendEntry,
  allowOverride = false
}) {
  if (!sessionManager.getSessionFile?.()) return { status: "skipped" };
  // eslint-disable-next-line no-restricted-syntax -- 记录绑定前 Task 可能已被删除，读不到时没有项目目录可比对，继续写入绑定
  const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId).catch(() => undefined);
  if (
    task?.projectDirectory &&
    (await canonical(task.projectDirectory)) !== (await canonical(projectDirectory))
  )
    return { status: "conflict" };
  const binding = await matchingBinding(sessionManager, workspaceRoot, projectDirectory);
  if (binding?.taskId === taskId) return { status: "unchanged" };
  if (binding && !allowOverride) return { status: "conflict" };
  const data = {
    version: 1,
    sessionId: sessionManager.getSessionId(),
    sessionFile: await canonical(sessionManager.getSessionFile()),
    workspaceRoot: await canonical(workspaceRoot),
    projectDirectory: await canonical(projectDirectory),
    taskId
  };
  appendEntry(CLI_TASK_ENTRY, data);
  return { status: "recorded", data };
}
