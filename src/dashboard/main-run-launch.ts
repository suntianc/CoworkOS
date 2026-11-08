import type { EditTextFile } from "../runtime/main-message-edit.js";
import type { PiThinkingLevel } from "../runtime/runtime-settings.js";
import type { MainSessionService } from "./main-session-service.js";
import type { TaskLocation } from "./workspace-directory.js";
import { HttpError } from "./http.js";
import type { RunService } from "./run-service.js";

export interface MainRunLaunchRequest {
  taskId: string;
  prompt: string;
  runId?: string;
  resume?: boolean;
  model?: string;
  retryRequestId?: string;
  body?: string;
  /** Uploads this request already attached; a queued Run records the same ids. */
  attachmentIds?: string[];
  /** Explicit one-off connection; an unknown id refuses instead of falling back. */
  profileId?: string;
  thinkingLevel?: PiThinkingLevel;
  textAttachments?: EditTextFile[];
  source?: "composer" | "human" | "inbox";
  mainSessionId?: unknown;
  requirementId?: unknown;
  /** A person waiting on the page keeps the demand when the budget is full. */
  queueWhenFull?: boolean;
  /** A slot the queued demand already owns; the dispatch sets it. */
  admittedRequestId?: string;
}

export interface MainRunLauncherPorts {
  locateTask(taskId: string): Promise<TaskLocation>;
  mainSessions?: Pick<MainSessionService, "beginRun" | "hasHistory" | "settle" | "resolve">;
  startMainRun: RunService["startMainRun"];
}

/**
 * Start one Main Run with its session and Run ownership.
 *
 * One function for the page, a queued demand and any other in-process caller:
 * the Run is recorded against its session only after the RunService accepted
 * it, and a launch that fails after that settles only the Run this request
 * claimed.
 */
export function createMainRunLauncher({ locateTask, mainSessions, startMainRun }: MainRunLauncherPorts) {
  return async function launchMainRun(request: MainRunLaunchRequest) {
    const location = mainSessions ? await locateTask(request.taskId) : undefined;
    if (
      request.mainSessionId !== undefined &&
      request.mainSessionId !== null &&
      location &&
      !location.projectId
    )
      throw new HttpError(400, "临时会话不属于项目，不能选择 Main 会话");
    // A session is a continuing conversation: resume its Pi transcript whenever
    // one exists, even if the Task snapshot lost its Run id.
    const resumeSession =
      request.resume === true || (location && mainSessions ? await mainSessions.hasHistory(location) : false);
    // Only the Run this request is actually admitted to launch may be recorded
    // or settled. `onRunAccepted` runs inside the RunService's per-task
    // serialization after every refusal check, so a rejected start never
    // rewrites another process's ownership record.
    const claimed: { runId?: string; projectId?: string; sessionId?: string } = {};
    const submission = {
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.attachmentIds?.length ? { attachmentIds: request.attachmentIds } : {}),
      ...(request.profileId ? { profileId: request.profileId } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.textAttachments ? { textAttachments: request.textAttachments } : {}),
      ...(request.source ? { source: request.source } : {}),
      ...(request.queueWhenFull ? { queueWhenFull: true } : {}),
      ...(request.admittedRequestId ? { admittedRequestId: request.admittedRequestId } : {}),
      ...(request.mainSessionId === undefined || request.mainSessionId === null
        ? {}
        : { mainSessionId: request.mainSessionId }),
      ...(request.requirementId === undefined || request.requirementId === null
        ? {}
        : { requirementId: request.requirementId }),
      ...(mainSessions && location
        ? {
            onRunAccepted: async (acceptedLocation: TaskLocation, acceptedRunId: string) => {
              const binding = await mainSessions.beginRun(acceptedLocation, {
                runId: acceptedRunId,
                mainSessionId: request.mainSessionId,
                requirementId: request.requirementId
              });
              claimed.runId = acceptedRunId;
              claimed.projectId = acceptedLocation.projectId;
              claimed.sessionId = binding?.sessionId;
            }
          }
        : {})
    };
    try {
      const result = await startMainRun(
        request.taskId,
        request.prompt,
        request.runId,
        resumeSession,
        request.model,
        request.retryRequestId,
        submission
      );
      return claimed.sessionId ? { ...result, sessionId: claimed.sessionId } : result;
    } catch (error) {
      // A claimed Run that never spawned is settled here. A request that was
      // refused before acceptance claimed nothing, so it must not settle a
      // different Run; a failed compensation write keeps the launch error.
      if (claimed.runId && claimed.projectId)
        await mainSessions
          ?.settle(claimed.projectId, request.taskId, claimed.runId, "failed")
          .catch((settleError: unknown) =>
            console.error(
              `[cowork] session run settlement failed: ${
                settleError instanceof Error ? settleError.message : String(settleError)
              }`
            )
          );
      throw error;
    }
  };
}

export type MainRunLauncher = ReturnType<typeof createMainRunLauncher>;
