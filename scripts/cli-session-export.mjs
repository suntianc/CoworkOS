import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { allProjectSessions, canonical, CLI_TASK_ENTRY } from "./cli-session.mjs";
import {
  readSessionExportMetadata,
  validateSessionExportEntries,
  writeSessionExport
} from "../dist/src/storage/session-export.js";

/** Offline export: migrate only a temporary copy, leaving source history and Task metadata intact. */
export async function exportCliSession({
  source,
  agentDir,
  workspaceRoot,
  directory,
  format = "json",
  outputPath,
  force = false,
  secrets = []
}) {
  let path = resolve(directory, source);
  if (!source.includes("/") && !source.includes("\\") && !source.endsWith(".jsonl")) {
    const sessions = [
      ...(await allProjectSessions(agentDir)),
      ...(await SessionManager.listAll(join(agentDir, "sessions")))
    ];
    const matches = [
      ...new Map(
        sessions.filter((session) => session.id.startsWith(source)).map((session) => [session.path, session])
      ).values()
    ];
    const exact = matches.filter((session) => session.id === source);
    const selected = exact.length ? exact : matches;
    if (selected.length !== 1)
      throw new Error(
        selected.length ? "会话 ID 不唯一，请使用完整文件路径。" : "未找到会话，请检查 ID 或路径。"
      );
    path = selected[0].path;
  }
  const original = await readFile(path, "utf8");
  let records;
  try {
    records = original
      .split("\n")
      .filter((line) => line.trim())
      .map(JSON.parse);
  } catch {
    throw new Error("无效的会话文件头或记录，原文件已保留。");
  }
  const header = records[0];
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    !header.id ||
    typeof header.cwd !== "string" ||
    header.version !== 3
  )
    throw new Error("无效的会话文件头，原文件已保留。");
  validateSessionExportEntries(records.slice(1));
  const destination = resolve(
    directory,
    outputPath ?? `coworkos-session-${header.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.${format}`
  );
  const sourceStat = await stat(path);
  const destinationStat = await stat(destination).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (destinationStat?.dev === sourceStat.dev && destinationStat?.ino === sourceStat.ino)
    throw new Error("导出不能覆盖原始会话文件。");
  const temporary = await mkdtemp(join(tmpdir(), "atria-session-export-"));
  try {
    const copy = join(temporary, "session.jsonl");
    await writeFile(copy, original, { mode: 0o600 });
    const session = SessionManager.open(copy, temporary);
    if (session.getSessionId() !== header.id) throw new Error("无效的会话文件头，原文件已保留。");
    const entries = session.getEntries();
    validateSessionExportEntries(entries);
    let taskId;
    for (const entry of [...entries].reverse()) {
      const data = entry.type === "custom" && entry.customType === CLI_TASK_ENTRY ? entry.data : undefined;
      if (
        data?.version !== 1 ||
        data.sessionId !== header.id ||
        !/^[a-zA-Z0-9._-]+$/.test(data.taskId ?? "") ||
        [".", ".."].includes(data.taskId) ||
        typeof data.workspaceRoot !== "string" ||
        typeof data.sessionFile !== "string"
      )
        continue;
      if (
        (await canonical(data.workspaceRoot)) === (await canonical(workspaceRoot)) &&
        (await canonical(data.sessionFile)) === (await canonical(path))
      ) {
        taskId = data.taskId;
        break;
      }
    }
    const metadata = await readSessionExportMetadata(workspaceRoot, taskId);
    return await writeSessionExport({
      sessionId: header.id,
      name: session.getSessionName(),
      projectDirectory: header.cwd,
      taskId,
      ...metadata,
      entries,
      branchEntryIds: session.getBranch().map((entry) => entry.id),
      format,
      outputPath: destination,
      directory,
      force,
      secrets
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function parseSessionExportArgs(values) {
  const source = values[0];
  if (!source || source.startsWith("--"))
    throw new Error("用法：coworkos session export ID|PATH [--format json|html] [--output FILE] [--force]");
  const options = { source, format: "json", force: false };
  for (let index = 1; index < values.length; index++) {
    const flag = values[index];
    if (flag === "--force") options.force = true;
    else if (["--format", "--output"].includes(flag)) {
      const value = values[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      options[flag === "--format" ? "format" : "outputPath"] = value;
    } else throw new Error(`Unknown export option: ${flag}`);
  }
  if (!["json", "html"].includes(options.format)) throw new Error("导出格式须为 json 或 html。");
  return options;
}
