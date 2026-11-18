import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-file.js";

/**
 * The hold a paused Main puts on its Run's Subagents.
 *
 * Pausing goes to Main: at the step boundary where Main pauses, its runtime
 * writes this record before it marks the Task paused, and every Subagent of
 * the Run reads it at the end of each of its own steps and stays there until
 * the record is gone. Main removes it when its next turn starts, so on resume
 * Main goes first and its Subagents follow. Nothing here is the model's
 * decision: both sides check it at fixed boundaries.
 *
 * A Subagent finishing its current step after the pause keeps that step; its
 * result, if it was the last one, waits in Main's Inbox like any other.
 */
export interface SubagentPause {
  pausedAt: string;
}

export function subagentPausePath(workspaceRoot: string, taskId: string, runId: string): string {
  return join(workspaceRoot, taskId, "runs", runId, "subagents-paused.json");
}

export async function pauseSubagents(workspaceRoot: string, taskId: string, runId: string): Promise<void> {
  const record: SubagentPause = { pausedAt: new Date().toISOString() };
  await atomicWrite(subagentPausePath(workspaceRoot, taskId, runId), `${JSON.stringify(record)}\n`);
}

export async function resumeSubagents(workspaceRoot: string, taskId: string, runId: string): Promise<void> {
  await rm(subagentPausePath(workspaceRoot, taskId, runId), { force: true });
}

export async function readSubagentPause(
  workspaceRoot: string,
  taskId: string,
  runId: string
): Promise<SubagentPause | undefined> {
  try {
    return JSON.parse(
      await readFile(subagentPausePath(workspaceRoot, taskId, runId), "utf8")
    ) as SubagentPause;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
