import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { MainContextState } from "../../dist/src/runtime/main-context.js";
import { limitToolContent } from "../../dist/src/runtime/tool-output.js";

interface MainCompactionState {
  memory: string;
  runtime: MainContextState;
  experimentDigest?: string;
  goalAlreadyVisible?: boolean;
}

const MAX_MAIN_CONTEXT_CHARS = 12_000;
const CURRENT_STATE_BLOCK = /<atria_main_context>[\s\S]*?<\/atria_main_context>/g;

/** Older checkpoints may carry the previous implementation's runtime supplement. */
export function mainCompactionPreviousSummary(previousSummary: string | undefined): string | undefined {
  return (
    previousSummary
      ?.replace(/<atria_main_compaction_state>[\s\S]*?<\/atria_main_compaction_state>/g, "")
      .trim() || undefined
  );
}

/** Current machine state is refreshed separately from the historical checkpoint. */
export function mainCompactionContext(state: MainCompactionState): string {
  const runtime = state.runtime;
  const memory = state.memory.trim();
  const memoryContent = memory
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^# Main Agent Memory\s*$/gm, "")
    .replace(/^## (Goal|Completed|Next|Important information\/constraints)\s*$/gm, "")
    .replace(/^\s*- \((none yet|initialize after understanding the task)\)\s*$/gm, "")
    .trim();
  const parts = [
    "Current persisted Task context. This snapshot does not establish that work or verification completed. Later user messages and explicit execution evidence update historical records.",
    `Runtime state: phase=${runtime.runtimePhase ?? "unknown"}; pending delegations=${runtime.runtimePendingDelegations ?? 0}.`,
    ...(runtime.runtimeGoal && !state.goalAlreadyVisible
      ? ["Task goal record (may be incomplete):", excerpt(runtime.runtimeGoal, 6_000)]
      : []),
    ...(runtime.runtimeLastEvent
      ? [
          `Last runtime event: ${excerpt(runtime.runtimeLastEvent.type, 80)}${runtime.runtimeLastEvent.summary ? ` — ${excerpt(runtime.runtimeLastEvent.summary, 240)}` : ""}`
        ]
      : []),
    ...(memoryContent
      ? ["Auxiliary workspace memory (may be incomplete or stale):", excerpt(memory, 2_800)]
      : []),
    ...(state.experimentDigest
      ? [
          "Auxiliary experiment records (historical measurements, not proof of current verification):",
          excerpt(state.experimentDigest, 1_800)
        ]
      : []),
    "Full history: agents/main/context/messages.json. Retrieve only specific missing evidence when needed."
  ];
  const open = "<atria_main_context>\n";
  const close = "\n</atria_main_context>";
  return open + excerpt(parts.join("\n"), MAX_MAIN_CONTEXT_CHARS - open.length - close.length) + close;
}

/** Replace one dynamic system section; never append snapshot messages to history. */
export function withMainCompactionContext<T extends AgentMessage>(
  messages: readonly T[],
  state: MainCompactionState
): T[] {
  const lastSystem = messages.findLastIndex((message) => message.role === "system");
  if (lastSystem < 0) return [...messages];
  const effective = getCurrentSystemMessage(messages.filter((message) => message.role === "system"));
  const workspace = effective?.sections?.current_workspace?.replace(CURRENT_STATE_BLOCK, "").trim() ?? "";
  const goal = state.runtime.runtimeGoal;
  const goalAlreadyVisible = Boolean(
    goal &&
    messages.some(
      (message) =>
        message.role === "user" &&
        (typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
        ).includes(goal)
    )
  );
  const context = mainCompactionContext({ ...state, goalAlreadyVisible });
  return messages.map((message, index) => {
    if (message.role !== "system") return message;
    const current = message.sections?.current_workspace;
    if (index !== lastSystem && !current?.includes("<atria_main_context>")) return message;
    return {
      ...message,
      sections: {
        ...message.sections,
        current_workspace:
          index === lastSystem
            ? [workspace, context].filter(Boolean).join("\n\n")
            : (current?.replace(CURRENT_STATE_BLOCK, "").trim() ?? "")
      }
    };
  });
}

function excerpt(text: string, budget: number): string {
  // Keep delimiters inside user-owned memory/goal text from becoming snapshot boundaries.
  const safe = text.replace(/<\/?atria_main_context>/g, (tag) =>
    tag.replace("<", "&lt;").replace(">", "&gt;")
  );
  const [block] = limitToolContent([{ type: "text", text: safe }], budget);
  return block.type === "text" ? block.text : "";
}
