import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextCompactionState } from "./context-compaction.js";

export interface PersistedAgentState {
  version: 1;
  status: "running" | "succeeded" | "failed";
  prompt: string;
  messages: AgentMessage[];
  compaction: ContextCompactionState;
}

export function emptyCompaction(): ContextCompactionState {
  return { summarizedMessageCount: 0, compactionCount: 0 };
}

export function readAgentCheckpoint(value: unknown): PersistedAgentState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<PersistedAgentState>;
  if (candidate.version !== 1 || !Array.isArray(candidate.messages) || typeof candidate.prompt !== "string")
    return undefined;
  if (candidate.status !== "running" && candidate.status !== "succeeded" && candidate.status !== "failed")
    return undefined;
  const compaction =
    candidate.compaction && typeof candidate.compaction === "object"
      ? candidate.compaction
      : emptyCompaction();
  return {
    version: 1,
    status: candidate.status,
    prompt: candidate.prompt,
    messages: candidate.messages,
    compaction
  };
}
