import type { SubagentDispatchResult } from "../runtime/coordinator-runtime.js";
import type { InboxStore } from "../runtime/scheduler.js";
import type { WatchProgramStore } from "../runtime/watch-program-store.js";

/** A CLI retry acknowledges an input only after successful analysis is durable. */
export async function runWatchEvent(input: {
  taskId: string;
  programId: string;
  monitorId: string;
  monitorRunId: string;
  messageId: string;
  eventId: string;
  watchStore: WatchProgramStore;
  inbox: InboxStore;
  dispatch: () => Promise<SubagentDispatchResult>;
}): Promise<SubagentDispatchResult> {
  const failure = async (summary: string) => {
    const state = await input.watchStore.readVirtualAgentState(
      input.taskId,
      input.programId,
      input.monitorId
    );
    await input.watchStore.updateVirtualAgentState(input.taskId, input.programId, input.monitorId, {
      status: "failed",
      lastCheckedAt: new Date().toISOString(),
      lastRunId: input.monitorRunId,
      lastSummary: summary.slice(0, 4000),
      consecutiveFailures: state.consecutiveFailures + 1
    });
  };
  let consumed = false;
  let recordingFailure = false;
  try {
    const result = await input.dispatch();
    if (result.status !== "succeeded") {
      recordingFailure = true;
      await failure(result.error || `Watch analysis ${result.status}: ${result.response}`);
      return result;
    }
    await input.watchStore.updateVirtualAgentState(input.taskId, input.programId, input.monitorId, {
      status: "active",
      lastCheckedAt: new Date().toISOString(),
      lastEventId: input.eventId,
      lastRunId: input.monitorRunId,
      lastSummary: result.response.slice(0, 4000),
      consecutiveFailures: 0
    });
    await input.inbox.consume(input.messageId);
    consumed = true;
    return result;
  } catch (error) {
    if (!recordingFailure) {
      // eslint-disable-next-line no-restricted-syntax -- 写入失败状态本身可能再次失败，此时保留并抛出原始执行错误，inbox 输入在 finally 独立释放
      await failure(error instanceof Error ? error.message : String(error)).catch(() => {
        // Preserve the execution/write error; the input is released independently.
      });
    }
    throw error;
  } finally {
    if (!consumed) await input.inbox.release(input.messageId);
  }
}
