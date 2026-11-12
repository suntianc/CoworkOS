import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * System-prompt sections this product no longer produces (user memory,
 * automatic learning knowledge and project experience).
 *
 * Sessions persisted and requests archived before that capability was removed
 * still carry the section text. Every model request strips the keys here, so
 * the text can never reach a model again, and exact replay refuses an archive
 * that still has content there. Nothing in the product generates these keys.
 */
export const RETIRED_SYSTEM_SECTIONS = ["user_memory", "project_experience", "project_skills"] as const;

/** Drop the retired section keys from one system message; everything else is left alone. */
export function withoutRetiredSections(message: AgentMessage): AgentMessage {
  if (message.role !== "system" || !message.sections) return message;
  const sections = { ...message.sections };
  let removed = false;
  for (const name of RETIRED_SYSTEM_SECTIONS) {
    if (name in sections) {
      delete sections[name];
      removed = true;
    }
  }
  return removed ? { ...message, sections } : message;
}

/** Names of retired sections that still carry text in this transcript. */
export function retiredSectionsWithText(messages: readonly AgentMessage[]): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system" || !message.sections) continue;
    for (const name of RETIRED_SYSTEM_SECTIONS) {
      const text = message.sections[name];
      if (typeof text === "string" && text.trim().length > 0) found.add(name);
    }
  }
  return [...found];
}

/** User-facing refusal for an archive that still holds retired section text. */
export function retiredSectionReplayRefusal(retired: readonly string[]): string {
  return `原请求包含已移除的系统提示段落（${retired.join("、")}），不能原样重放。原请求和历史已保留，请发送新消息。`;
}
