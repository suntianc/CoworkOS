import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { currentMainSession } from "./main-message-edit.js";
import { mainContextPaths, persistMainContext } from "./main-context.js";

/**
 * Copy one conversation's history, up to and including one reply, into
 * another Task.
 *
 * Only the Main transcript travels: the new Task's Pi session holds the path
 * from the first entry to that reply, and its saved context mirrors it, so the
 * next Run there continues from the reply. Requirement records, runs, queued
 * messages, questions and memory stay with the source.
 *
 * Returns false when the reply is not on the source's current branch, such as
 * one an edit has since replaced.
 */
export async function copyMainConversation(
  source: { root: string; taskId: string },
  target: { root: string; taskId: string },
  messageId: string
): Promise<boolean> {
  const { session } = await currentMainSession(source.root, source.taskId);
  const reply = session
    ?.getBranch()
    .find(
      (entry) => entry.id === messageId && entry.type === "message" && entry.message.role === "assistant"
    );
  if (!session || !reply) return false;
  const directory = join(target.root, target.taskId, "sessions", "main", "pi");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fork = SessionManager.open(session.getSessionFile()!, directory);
  const sessionFile = fork.createBranchedSession(reply.id)!;
  // The SDK writes a branch lazily; flush it so the first Run there resumes it.
  const temporary = `${sessionFile}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    [fork.getHeader(), ...fork.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { mode: 0o600, flag: "wx" }
  );
  await rename(temporary, sessionFile);
  await persistMainContext(
    mainContextPaths(target.root, target.taskId),
    SessionManager.open(sessionFile, directory).getBranch()
  );
  return true;
}
