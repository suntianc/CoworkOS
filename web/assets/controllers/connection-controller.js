import { createRevisionSchedule } from "./revision-schedule.js";
import { streamRecordKey } from "../conversation.js";
import { createVisiblePoll } from "../ui/visible-poll.js";

/** Owns the selected conversation's SSE and shared application revision refresh. */
export function createConnectionController({
  state,
  renderConversation,
  loadDetail,
  getWorkbench,
  readApplicationRevisions,
  refreshWorkbench,
  openStream
}) {
  const revisionSchedule = createRevisionSchedule();
  let streamOpened = false;
  let eventStream, eventStreamTaskId, eventStreamRunId, detailRefreshTimer;
  let streamAbort, streamTaskId, streamRunId;
  let eventStreamKeys = new Set();
  let renderFrame;
  const applicationVersions = new Map();
  let applicationRead,
    disposed = false;
  // Run SSE remains the immediate path. Revision checks also cover standalone
  // editors, idle chats and edits made by another conversation or MCP process.
  async function refreshApplications({ poll = false } = {}) {
    if (disposed || applicationRead || !readApplicationRevisions) return;
    const tabs = getWorkbench()?.openTabs?.filter((tab) => tab.kind === "application") ?? [];
    if (!tabs.length) {
      applicationVersions.clear();
      revisionSchedule.due([], undefined);
      return;
    }
    const host = getWorkbench();
    const foreground = host?.applicationVisible ? host.applicationTab?.appInstanceId : undefined;
    const due = revisionSchedule.due(tabs, foreground, !poll);
    if (!due.length) return;
    const controller = (applicationRead = new AbortController());
    try {
      const { instances = [] } = await readApplicationRevisions(controller.signal, due);
      if (disposed) return;
      const host = getWorkbench();
      const current = host?.openTabs?.filter((tab) => tab.kind === "application") ?? [];
      const openInstances = new Set(current.map((tab) => tab.appInstanceId));
      for (const id of applicationVersions.keys()) if (!openInstances.has(id)) applicationVersions.delete(id);
      let changedTabs = false;
      await Promise.all(
        instances.map(async (instance) => {
          const tab = current.find((entry) => entry.appInstanceId === instance.appInstanceId);
          if (!tab) return;
          if (tab.resourceId !== instance.resourceId || tab.title !== instance.title) changedTabs = true;
          const version = JSON.stringify([
            instance.resourceId,
            instance.revision,
            instance.contentVersion,
            instance.title
          ]);
          if (applicationVersions.get(instance.appInstanceId) === version) {
            revisionSchedule.observe(instance.appInstanceId, version);
            return;
          }
          if (
            instance.resourceId &&
            Number.isInteger(instance.revision) &&
            (await host.handleEvent({ type: "resource.operation_applied", ...instance })) === false
          )
            return;
          applicationVersions.set(instance.appInstanceId, version);
          revisionSchedule.observe(instance.appInstanceId, version);
        })
      );
      if (changedTabs) await refreshWorkbench?.();
    } catch {
      // Keep the mounted editor and its drafts; the next check retries.
    } finally {
      if (applicationRead === controller) applicationRead = undefined;
    }
  }
  const applicationPoll = readApplicationRevisions
    ? createVisiblePoll({ run: ({ resume }) => refreshApplications({ poll: !resume }), intervalMs: 500 })
    : undefined;
  const resume = () => {
    if (state.selected) connectEventStream(state.selected);
  };
  const dispose = () => {
    disposed = true;
    applicationPoll?.dispose();
    applicationRead?.abort();
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
      // A resource event belongs to one adapter. Routing it there refreshes that
      // tab alone; repainting the whole conversation for a keystroke elsewhere
      // would throw away scroll position and streamed output for no reason.
      if (typeof record.type === "string" && record.type.startsWith("resource.")) {
        const key = streamRecordKey(record);
        if (key && seenKeys.has(key)) return;
        if (key) seenKeys.add(key);
        const event = { ...record, ...(record.payload || {}) };
        revisionSchedule.invalidate(event.appInstanceId);
        getWorkbench()?.handleEvent(event);
      }
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
    refreshApplications,
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
