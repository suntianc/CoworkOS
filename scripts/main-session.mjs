import { queuedUserTurn } from "../dist/src/runtime/queued-user-turn.js";
import { resolve } from "node:path";
import { realpath, readFile, rename, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mainInputDelivered, readMainInput } from "../dist/src/runtime/main-continuation.js";

/** Resume the same Task in its project's new folder without rewriting its source transcript. */
export async function alignSelectedTaskSession(sessionPath, sessionDirectory, projectDirectory) {
  const target = await realpath(resolve(projectDirectory));
  const session = SessionManager.open(sessionPath, resolve(sessionDirectory));
  if (resolve(session.getHeader().cwd) === target) return sessionPath;
  return SessionManager.forkFrom(sessionPath, target, resolve(sessionDirectory)).getSessionFile();
}

/** Pi defers its first session file until an assistant response. A cancelled
 * first request still has CoworkOS's durable context snapshot; restore it once. */
export async function restoreUnflushedTaskSession(sessionDirectory, projectDirectory, snapshotPath) {
  const sessions = await SessionManager.listAll(resolve(sessionDirectory));
  if (sessions.some((session) => session.messageCount > 0)) return;
  let entries;
  try {
    entries = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("会话上下文无法恢复，原始记录已保留");
  }
  if (
    !Array.isArray(entries) ||
    !entries.some((entry) => entry?.type === "message" && entry.message?.role === "user")
  )
    return;
  const target = await realpath(resolve(projectDirectory));
  const session = SessionManager.create(target, resolve(sessionDirectory));
  await writeFile(
    session.getSessionFile(),
    [session.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { mode: 0o600, flag: "wx" }
  );
}

/** Recover an accepted input that a crashed process never saved, without replaying delivered input. */
export async function restorePendingTaskInput(
  sessionDirectory,
  projectDirectory,
  inputPath,
  selectedSessionPath
) {
  const input = await readMainInput(inputPath);
  if (!input) throw new Error("这次继续缺少已保存的输入记录，无法恢复；会话与记录仍保留。");
  const directory = resolve(sessionDirectory);
  const [latest] = selectedSessionPath
    ? [{ path: selectedSessionPath }]
    : await SessionManager.listAll(directory);
  const session = latest
    ? SessionManager.open(latest.path, directory)
    : SessionManager.create(await realpath(resolve(projectDirectory)), directory);
  if (mainInputDelivered(session.getBranch(), input)) return;
  const content =
    input.source === "composer" && input.taskId && input.runId && input.messageId
      ? queuedUserTurn({
          taskId: input.taskId,
          runId: input.runId,
          messageId: input.messageId,
          text: input.prompt
        })
      : input.prompt;
  session.appendMessage({ role: "user", content, timestamp: input.submittedAt });
  // Pi defers files without assistant output; flush the restored input before
  // its child discovers the session, including a first-turn startup failure.
  const path = session.getSessionFile();
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    [session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { mode: 0o600 }
  );
  await rename(temporary, path);
}
