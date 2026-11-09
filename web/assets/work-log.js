import { agentName, teamMembers } from "./agent-room.js";
import { toolExecutionFailed } from "./tool-result.js";
import { presentToolCall } from "./tool-presentation.js";
export { friendlyToolName } from "./tool-presentation.js";

const text = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => part?.text || "").join("\n")
      : "";
const clean = (value) => text(value).split("[Coordinator]")[0].trim();
const timeValue = (value) => (typeof value === "number" ? value : Date.parse(value) || 0);

/** A compact activity feed of actual actions and results, without queue/lease noise. */
export function buildWorkLog(detail = {}, limit = 30) {
  const members = teamMembers(detail);
  const byCall = new Map(members.filter((member) => member.callId).map((member) => [member.callId, member]));
  const rows = new Map();
  const callbacks = new Map();
  const tools = new Map();
  const runId = detail.task?.activeRunId;
  const runtime = (detail.runtimeEvents || []).filter(
    (record) => !runId || !record.runId || record.runId === runId
  );
  let time = timeValue((detail.events || []).find((event) => event.type === "main.run_spawned")?.occurredAt);
  let sequence = 0;
  const add = (row) =>
    rows.set(row.id, {
      ...row,
      summary: row.summary?.length > 600 ? `${row.summary.slice(0, 600)}…` : row.summary,
      order: sequence++
    });

  for (const record of runtime) {
    const event = record.type === "runtime_event" ? record.payload : record;
    if (!event) continue;
    time = timeValue(event.message?.timestamp || record.occurredAt || event.timestamp) || time;
    if (event.type === "message_end" && event.message?.customType === "cowork-callback") {
      const callback = event.message.details || {};
      if (callback.callId) callbacks.set(callback.callId, callback);
    }
    if (["tool_execution_start", "tool_execution_end"].includes(event.type)) {
      if (event.toolName === "call_subagent") continue; // Delegation has its own named lifecycle records.
      const key = `tool:${record.runId || runId || ""}:${event.toolCallId}`;
      const before = tools.get(key) || {};
      const args = event.args || before.args || {};
      const done = event.type === "tool_execution_end";
      const eventTime = event.timestamp ?? record.occurredAt;
      const startedAt = before.startedAt ?? (done ? undefined : eventTime);
      const presentation = presentToolCall(
        {
          name: event.toolName || before.toolName,
          arguments: args,
          result: event.result,
          failed: toolExecutionFailed(event),
          completed: done,
          startedAt,
          endedAt: done ? eventTime : undefined
        },
        {
          workspaceRoot: detail.workspaceRoot,
          taskId: detail.task?.taskId,
          active: detail.runtime?.active,
          detail
        }
      );
      const row = {
        id: key,
        actor: "Formicand",
        agentKey: "main",
        title: presentation.title,
        summary: presentation.subject || presentation.summary,
        details: presentation.details,
        status: presentation.status,
        subject: presentation.subject,
        resultSummary: presentation.resultSummary,
        failureReason: presentation.failureReason,
        statusLabel: presentation.statusLabel,
        durationMs: presentation.durationMs,
        durationLabel: presentation.durationLabel,
        detailSections: presentation.detailSections,
        time,
        toolName: event.toolName || before.toolName
      };
      tools.set(key, { ...row, args, startedAt, toolName: event.toolName || before.toolName });
      add(row);
    }
    if (event.type === "message_end" && event.message?.role === "toolResult") {
      const key = `tool:${record.runId || runId || ""}:${event.message.toolCallId}`;
      const row = rows.get(key);
      if (row) row.time = time;
    }
  }

  const seen = new Set();
  const events = [...(detail.events || []), ...runtime.filter((record) => record.type !== "runtime_event")];
  for (const event of events) {
    if (!event.type || (runId && event.runId && event.runId !== runId)) continue;
    const id = event.eventId || `${event.type}:${event.callId || ""}:${event.occurredAt || ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const payload = event.payload || {};
    const member =
      byCall.get(event.callId || payload.callId) ||
      members.find(
        (entry) => entry.agentId === (payload.call?.calleeAgentId || payload.agentId || event.agentId)
      );
    const name = agentName(member || { agentId: payload.agentId || event.agentId, name: payload.name });
    const callback = callbacks.get(event.callId || payload.callId) || {};
    const task = member?.task || payload.task || "";
    const response = clean(callback.response || member?.response || member?.lastAssistantText);
    let actor = name,
      title,
      summary = task,
      status = "completed";
    switch (event.type) {
      case "main.run_spawned":
        actor = "Formicand";
        title = payload.resumed ? "继续处理你的请求" : "开始处理你的请求";
        summary = payload.prompt || detail.task?.goal;
        break;
      case "call.accepted":
        title = "接到协作任务";
        status = "recorded";
        break;
      case "run.completed":
        title = "已返回结果";
        summary = response || task;
        break;
      case "callback.consumed":
        actor = "Formicand";
        title = `已收到${name}的结果`;
        summary = response || task;
        break;
      case "run.retry_scheduled":
        title = "已安排重试";
        summary = payload.error || task;
        status = "recorded";
        break;
      case "run.failed":
        if (payload.retryScheduled) continue;
        title = payload.state === "cancelled" ? "任务已取消" : "执行遇到问题";
        summary = payload.error || task;
        status = payload.state === "cancelled" ? "cancelled" : "failed";
        break;
      case "run.cancel_requested":
        actor = "Formicand";
        title = `已取消${name}的任务`;
        summary = payload.reason || task;
        status = "cancelled";
        break;
      case "main.run_completed":
        actor = "Formicand";
        title = "本次请求已完成";
        summary = detail.task?.completion?.summary || "处理已结束，结果见左侧对话。";
        break;
      case "main.run_waiting":
        actor = "Formicand";
        title = "等待继续处理";
        summary =
          {
            pending_subagents: "还有协作任务尚未结束",
            pending_jobs: "还有后台任务尚未结束",
            pending_callbacks: "正在等待协作结果进入对话",
            explicit_finish_required: "旧版本要求额外确认完成",
            pending_human: "等待你的答复",
            incomplete_response: "执行在最终回答完成前停止",
            completion_check_failed: "完成状态检查未通过，需要继续处理"
          }[payload.reason] || "任务尚未完成，等待后续处理。";
        status = "waiting";
        break;
      case "main.run_failed":
        actor = "Formicand";
        title = "执行遇到问题";
        summary = payload.error;
        status = "failed";
        break;
      case "message.queued":
        actor = "Formicand";
        title = `已向${name}补充说明`;
        summary = payload.message || task;
        break;
      case "message.delivered":
        title = "已收到补充说明";
        break;
      case "watcher.event_received":
        actor = "Formicand";
        title = "收到新的监测信息";
        summary = payload.summary || payload.event?.type || "监测来源有新的变化";
        break;
      case "watcher.failed":
        actor = "Formicand";
        title = "监测遇到问题";
        summary = payload.error;
        status = "failed";
        break;
      default:
        continue;
    }
    add({
      id,
      actor,
      title,
      summary: clean(summary),
      details: clean(summary),
      status,
      time: timeValue(event.occurredAt),
      agentKey: actor === "Formicand" ? "main" : member?.callId || member?.agentId
    });
  }
  return [...rows.values()]
    .map((row) =>
      row.status === "running" && detail.runtime?.active === false && row.toolName !== "start_job"
        ? { ...row, status: "interrupted", statusLabel: "已停止" }
        : row
    )
    .sort((a, b) => b.time - a.time || b.order - a.order)
    .slice(0, limit);
}
