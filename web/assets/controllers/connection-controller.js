import { streamRecordKey } from "../conversation.js";

/** Owns the selected conversation's SSE. */
export function createConnectionController({ state, renderConversation, loadDetail, openStream }) {
  let streamOpened = false;
  let eventStream, eventStreamTaskId, eventStreamRunId, detailRefreshTimer;
  let streamAbort, streamTaskId, streamRunId;
  let eventStreamKeys = new Set();
  let renderFrame;
  let disposed = false;
  const resume = () => {
    if (state.selected) connectEventStream(state.selected);
  };
  const dispose = () => {
    disposed = true;
    close();
    window.removeEventListener("pagehide", close);
    window.removeEventListener("pageshow", resume);
  };
  window.addEventListener("pagehide", close);
  window.addEventListener("pageshow", resume);
  function scheduleStreamRender(taskId) {
    if (renderFrame !== undefined) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = undefined;
      if (state.selected !== taskId || state.detail?.task?.taskId !== taskId) return;
      renderConversation(state.detail.messages || [], state.detail.task || {});
    });
  }

  /**
   * Follow the selected conversation's run stream.
   *
   * The transport is injected: the shared management client reads SSE through
   * `fetch` so the session credential travels in a header and the bound backend
   * may be another local origin. `EventSource` stays as the fallback for hosts
   * that only render the page's own backend.
   */
  function connectEventStream(taskId) {
    if (disposed) return;
    const task =
      state.detail?.task?.taskId === taskId
        ? state.detail.task
        : state.tasks.find((entry) => entry.taskId === taskId);
    const runId = task?.activeRunId;
    if (eventStream && eventStreamTaskId === taskId && eventStreamRunId === runId) return;
    if (streamTaskId === taskId && streamRunId === runId) return;
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
    renderFrame = undefined;
    eventStream?.close();
    streamAbort?.abort();
    streamAbort = undefined;
    streamOpened = false;
    eventStream = undefined;
    streamTaskId = undefined;
    streamRunId = undefined;
    eventStreamTaskId = undefined;
    eventStreamRunId = undefined;
    if (!taskId) return;
    // Inactive tasks are reconstructed from their persisted runtime log. A
    // replay here races the detail request and can append the same history
    // twice while returning to a task.
    if (task && !["running", "waiting"].includes(task.status)) return;
    // The stream replays the current run history on connect. Keep O(1) keys so
    // that replaying a long transcript does not scan thousands of DOM records
    // for every token-sized event.
    const seenKeys = (eventStreamKeys = new Set(
      state.detail?.task?.taskId === taskId ? (state.detail.runtimeEvents || []).map(streamRecordKey) : []
    ));
    const applyRecord = (record, isCurrent) => {
      if (
        !isCurrent() ||
        state.selected !== taskId ||
        state.detail?.task?.taskId !== taskId ||
        state.detail.task.activeRunId !== runId
      )
        return;
      const key = streamRecordKey(record);
      if (state.detail && key && !seenKeys.has(key)) {
        seenKeys.add(key);
        // Appended in place. Copying the whole array per event made this
        // quadratic over a run — by ten thousand events one token cost ~33ms of
        // copying plus the garbage it left for the collector, which is the
        // stutter that showed up as the reply streamed. Nothing holds a reference
        // to the old array: the render reads `state.detail.runtimeEvents` fresh.
        if (!Array.isArray(state.detail.runtimeEvents)) state.detail.runtimeEvents = [];
        state.detail.runtimeEvents.push(record);
        if (record.type === "runtime_event") {
          scheduleStreamRender(taskId);
        }
      }
      if (
        record.type !== "runtime_event" ||
        (record.payload?.type === "tool_execution_end" && record.payload?.toolName === "askhuman")
      ) {
        if (detailRefreshTimer) return;
        detailRefreshTimer = setTimeout(() => {
          detailRefreshTimer = undefined;
          if (state.selected === taskId) void loadDetail(taskId);
        }, 120);
      }
    };
    if (openStream) {
      const controller = (streamAbort = new AbortController());
      streamTaskId = taskId;
      streamRunId = runId;
      const isCurrent = () => streamAbort === controller;
      void openStream(`/api/tasks/${encodeURIComponent(taskId)}/stream`, {
        signal: controller.signal,
        onOpen: () => {
          if (isCurrent()) streamOpened = true;
        },
        onRecord: (record) => applyRecord(record, isCurrent)
      })
        // eslint-disable-next-line no-restricted-syntax -- a failed stream is not reported here: the finally block re-reads the detail, which reconnects or marks the backend offline
        .catch(() => undefined)
        .finally(() => {
          if (!isCurrent()) return;
          streamAbort = undefined;
          streamTaskId = undefined;
          streamRunId = undefined;
          streamOpened = false;
          // The detail read reconnects once the Task reports an active run;
          // reconnecting here would 409-loop while the list is still loading.
          if (state.selected === taskId) void loadDetail(taskId, { poll: true });
        });
      return;
    }
    if (!window.EventSource) return;
    eventStreamTaskId = taskId;
    eventStreamRunId = runId;
    const stream = (eventStream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/stream`));
    stream.onopen = () => {
      if (eventStream === stream) streamOpened = true;
    };
    stream.onmessage = (message) => {
      if (eventStream !== stream) return;
      let record;
      try {
        record = JSON.parse(message.data);
        // eslint-disable-next-line no-restricted-syntax -- a single malformed SSE frame from the backend is skipped; the stream keeps delivering later records
      } catch {
        return;
      }
      applyRecord(record, () => eventStream === stream);
    };
    stream.onerror = () => {
      stream.close();
      if (eventStream === stream) {
        streamOpened = false;
        if (state.selected === taskId) void loadDetail(taskId, { poll: true });
        eventStream = undefined;
        eventStreamTaskId = undefined;
        eventStreamRunId = undefined;
      }
    };
  }

  function close() {
    eventStream?.close();
    streamAbort?.abort();
    streamAbort = undefined;
    streamTaskId = undefined;
    streamRunId = undefined;
    streamOpened = false;
    eventStream = undefined;
    eventStreamTaskId = undefined;
    eventStreamRunId = undefined;
    clearTimeout(detailRefreshTimer);
    detailRefreshTimer = undefined;
    if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
    renderFrame = undefined;
  }
  return {
    isStreaming(taskId) {
      return streamOpened && (eventStreamTaskId === taskId || streamTaskId === taskId);
    },
    dispose,
    connect: connectEventStream,
    remember(taskId, records) {
      if (eventStreamTaskId === taskId || streamTaskId === taskId)
        for (const record of records || []) eventStreamKeys.add(streamRecordKey(record));
    },
    close
  };
}
