import { ui } from "./ui/language.js";
import { agentDisplayName } from "./agent-names.js";

const liveStates = new Set(["running", "leased", "queued", "waiting"]);
const roleLabels = { executor: "Executor", reviewer: "Reviewer" };
const terminalStates = new Set(["completed", "succeeded", "failed", "cancelled", "timed_out"]);

export function agentName(agent = {}) {
  if (agent.__main || agent.agentId === "main") return "CoworkOS";
  if (/^subagent[_-]\d+$/.test(agent.agentId || "")) return agentDisplayName(agent.agentId);
  return agent.name || (agent.agentId ? agentDisplayName(agent.agentId) : ui("协作成员"));
}

/** Role, model and working site of one work item, as display parts. */
export function agentIdentity(agent = {}) {
  return {
    role: roleLabels[agent.role] || "",
    model: agent.model || "",
    workspace: agent.workspace || ""
  };
}

export function teamMembers(detail = {}) {
  const members = new Map();
  for (const agent of [...(detail.coordination?.calls || []), ...(detail.progress?.agents || [])]) {
    const key = agent.callId || agent.agentId;
    if (key) members.set(key, { ...members.get(key), ...agent });
  }
  return [
    {
      agentId: "main",
      __main: true,
      status: detail.humanRequests?.some((request) => request.status === "pending")
        ? "waiting"
        : detail.runtime?.active === true
          ? "running"
          : detail.monitoring?.sleep
            ? "waiting"
            : terminalStates.has(detail.task?.status)
              ? detail.task.status
              : "idle",
      task: detail.task?.goal || ui("等待新任务")
    },
    ...members.values()
  ].map((member, index) => ({ ...member, index }));
}

// Finished stars stay visible. A stale live snapshot on a closed task must
// not make a member appear to keep working or claim a successful result.
export function galaxyMembers(detail = {}, members = teamMembers(detail)) {
  return members.map((member) =>
    !member.__main && terminalStates.has(detail.task?.status) && liveStates.has(member.status)
      ? { ...member, status: "interrupted" }
      : member
  );
}

// Slots belong to member identities for the lifetime of the displayed task.
// Polling, selection and newly arriving members never move an existing orbit.
export function createOrbitLayout() {
  const slots = new Map();
  return (members) => {
    const satellites = members.filter((member) => !member.__main && member.agentId !== "main");
    const keyFor = (member) => member.callId || member.agentId;
    for (const member of [...satellites].sort((a, b) =>
      String(a.agentId).localeCompare(String(b.agentId), "en", { numeric: true })
    )) {
      if (!slots.has(keyFor(member))) slots.set(keyFor(member), slots.size);
    }
    return satellites.map((member) => {
      const slot = slots.get(keyFor(member));
      const period = 48 + slot * 17;
      const phase = ([0.63, 0.96, 0.28, 0.77, 0.43, 0.12][slot % 6] + Math.floor(slot / 6) * 0.037) % 1;
      return {
        member,
        slot,
        width: slot < 3 ? [52, 73, 94][slot] : 94 + 4 * (1 - 1 / (slot - 1)),
        tilt: [-22, -16, -25, -12][slot % 4],
        period,
        delay: -period * phase
      };
    });
  };
}

export const isWorking = (agent) => agent?.status === "running" || agent?.status === "leased";
