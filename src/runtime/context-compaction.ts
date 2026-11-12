import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateTokens, generateSummary } from "@earendil-works/pi-coding-agent";
import {
  getCurrentSystemMessage,
  type Api,
  type AssistantMessage,
  type Model,
  type Models
} from "@earendil-works/pi-ai";
import { projectCompactionMessages } from "./compaction-input.js";
import { CompactionFailureBackoff, compactionFingerprint } from "./compaction-failure-backoff.js";

export interface ContextCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface ContextCompactionState {
  summary?: string;
  summarizedMessageCount: number;
  compactionCount: number;
  lastTokensBefore?: number;
  updatedAt?: string;
}

export interface ContextCompactionResult {
  messages: AgentMessage[];
  state: ContextCompactionState;
  compacted: boolean;
}

export const DEFAULT_CONTEXT_COMPACTION: ContextCompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000
};

/**
 * Provider-neutral compaction for the low-level Pi Agent used by Subagents.
 * Pi coding-agent has its own durable compaction implementation for the Main
 * session. This helper gives Cowork's raw PiSession the same essential
 * semantics: summarize old history, keep a recent tail, and persist the summary
 * cursor so a resumed run does not need to summarize the same history again.
 */
export class ContextCompactor {
  private stateValue: ContextCompactionState;
  private inFlight?: Promise<ContextCompactionResult>;
  private readonly failureBackoff: CompactionFailureBackoff;

  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
    private readonly settings: ContextCompactionSettings = DEFAULT_CONTEXT_COMPACTION,
    initial?: Partial<ContextCompactionState>,
    private readonly onCompaction?: (state: ContextCompactionState) => Promise<void> | void,
    now: () => number = Date.now
  ) {
    this.failureBackoff = new CompactionFailureBackoff(now);
    this.stateValue = {
      summarizedMessageCount: Math.max(0, initial?.summarizedMessageCount ?? 0),
      compactionCount: Math.max(0, initial?.compactionCount ?? 0),
      summary: initial?.summary,
      lastTokensBefore: initial?.lastTokensBefore,
      updatedAt: initial?.updatedAt
    };
  }

  get state(): ContextCompactionState {
    return { ...this.stateValue };
  }

  async transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    try {
      const result = await this.compactIfNeeded(messages, signal);
      return result.messages;
      // eslint-disable-next-line no-restricted-syntax -- 摘要失败要退回已提交的检查点加原始尾部继续本次请求，否则一次摘要失败会让请求继续溢出而没有模型调用
    } catch {
      // Retain the last committed checkpoint and current raw tail. Replaying
      // an already summarized prefix could make this request overflow again.
      return this.visibleMessages(messages);
    }
  }

  async compactIfNeeded(messages: AgentMessage[], signal?: AbortSignal): Promise<ContextCompactionResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.compactInternal(messages, signal).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async compactInternal(
    messages: AgentMessage[],
    signal?: AbortSignal
  ): Promise<ContextCompactionResult> {
    const visible = this.visibleMessages(messages);
    const estimated = contextTokens(visible);
    const shouldCompact =
      this.settings.enabled && estimated > this.model.contextWindow - this.settings.reserveTokens;
    if (!shouldCompact) return { messages: visible, state: this.state, compacted: false };

    const cutIndex = findCutIndex(
      messages,
      this.settings.keepRecentTokens,
      this.stateValue.summarizedMessageCount
    );
    if (cutIndex <= this.stateValue.summarizedMessageCount || cutIndex >= messages.length) {
      return { messages: visible, state: this.state, compacted: false };
    }

    const toSummarize = messages.slice(this.stateValue.summarizedMessageCount, cutIndex);
    if (!toSummarize.some((message) => message.role !== "system"))
      return { messages: visible, state: this.state, compacted: false };
    signal?.throwIfAborted();
    const fingerprint = compactionFingerprint({
      model: {
        provider: this.model.provider,
        id: this.model.id,
        api: this.model.api,
        baseUrl: this.model.baseUrl
      },
      cursor: this.stateValue.summarizedMessageCount,
      cutIndex,
      previousSummary: this.stateValue.summary,
      messages: toSummarize
    });
    if (this.failureBackoff.shouldSkip(fingerprint))
      return { messages: visible, state: this.state, compacted: false };
    try {
      // Keep Pi's summary serialization, provider routing and retries; the SDK
      // already refuses failed or tool-calling summaries, and the empty-text
      // check below still prevents committing a blank replacement.
      const summaryStream: StreamFn = (model, context, streamOptions) =>
        this.models.streamSimple(model, context, streamOptions);
      const summary = await generateSummary(
        projectCompactionMessages(toSummarize),
        this.model,
        undefined,
        undefined,
        undefined,
        signal,
        undefined,
        this.stateValue.summary,
        "off",
        summaryStream
      );
      if (!summary.trim()) throw new Error("Context summary did not finish with a non-empty response");
      signal?.throwIfAborted();

      const nextState = {
        summary,
        summarizedMessageCount: cutIndex,
        compactionCount: this.stateValue.compactionCount + 1,
        lastTokensBefore: estimated,
        updatedAt: new Date().toISOString()
      };
      // Commit only after the cursor and summary have been persisted together.
      await this.onCompaction?.({ ...nextState });
      this.stateValue = nextState;
      this.failureBackoff.recordSuccess(fingerprint);
      return { messages: this.visibleMessages(messages), state: this.state, compacted: true };
    } catch (error) {
      const aborted =
        signal?.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" || ("code" in error && error.code === "aborted")));
      if (!aborted) this.failureBackoff.recordFailure(fingerprint);
      throw error;
    }
  }

  private visibleMessages(messages: AgentMessage[]): AgentMessage[] {
    const start = Math.min(this.stateValue.summarizedMessageCount, messages.length);
    const tail = messages.slice(start);
    if (!this.stateValue.summary) return tail;
    const summaryMessage: AgentMessage = {
      role: "user",
      content: `The conversation history before this point was compacted into the following summary. Treat it as trusted working context, not as a new user request.\n\n<summary>\n${this.stateValue.summary}\n</summary>`,
      timestamp: Date.now()
    };
    // System messages carry the current policy and tool loadout in Pi 0.87.
    // Summarize conversational history, but retain the effective system state
    // from the removed prefix so later tail deltas still apply in order.
    const system = getCurrentSystemMessage(
      messages.slice(0, start).filter((message) => message.role === "system")
    );
    return [...(system ? [system] : []), summaryMessage, ...tail];
  }
}

/**
 * Context size of a message list.
 *
 * Pi 1.5 keeps this calculation inside its coding-agent compaction module and
 * no longer exports it with the harness, so this reproduces the same value from
 * the public pieces: the last usable assistant usage covers everything up to
 * its own reply, and each later message is estimated on its own.
 */
function contextTokens(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    let trailing = 0;
    for (let later = index + 1; later < messages.length; later += 1)
      trailing += estimateTokens(messages[later]);
    return calculateContextTokens(usage) + trailing;
  }
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/** Provider usage from an assistant reply that finished with real numbers. */
function assistantUsage(message: AgentMessage): AssistantMessage["usage"] | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  return calculateContextTokens(message.usage) > 0 ? message.usage : undefined;
}

function findCutIndex(messages: AgentMessage[], keepRecentTokens: number, startIndex: number): number {
  let tokens = 0;
  let target = Math.max(startIndex, messages.length - 1);
  for (let index = messages.length - 1; index >= startIndex; index -= 1) {
    // Provider usage measures the whole prompt. A tail budget needs the
    // content of this message alone, otherwise a short reply can consume it.
    tokens += estimateTokens(messages[index]);
    if (tokens > keepRecentTokens) break;
    target = index;
  }
  // Keep short tails intact even if an earlier provider usage is still large.
  if (tokens < keepRecentTokens) return startIndex;
  const cuts = safeCutIndices(messages, startIndex);
  // A long active turn can be summarized before a recent assistant response.
  // Move past a whole tool exchange, or keep its call when no later cut exists.
  return cuts.find((index) => index >= target) ?? cuts.at(-1) ?? startIndex;
}

/** Never separate a call from its result or remove a call still awaiting a result. */
function safeCutIndices(messages: AgentMessage[], startIndex: number): number[] {
  const pending = new Map<string, { indices: number[]; next: number }>();
  const unsafeCutDeltas = new Int32Array(messages.length + 1);
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const key = JSON.stringify([block.id, block.name]);
        const queue = pending.get(key) ?? { indices: [], next: 0 };
        queue.indices.push(index);
        pending.set(key, queue);
      }
    } else if (message.role === "toolResult") {
      const key = JSON.stringify([message.toolCallId, message.toolName]);
      const queue = pending.get(key);
      if (!queue) continue;
      const callIndex = queue.indices[queue.next++];
      // Every boundary in (callIndex, resultIndex] splits this exchange.
      unsafeCutDeltas[callIndex + 1] += 1;
      unsafeCutDeltas[index + 1] -= 1;
      if (queue.next === queue.indices.length) pending.delete(key);
    }
  }
  // An unmatched earlier/duplicate result cannot settle a later reused ID.
  // Pin only unresolved calls from the not-yet-summarized raw range.
  for (const queue of pending.values()) {
    for (let index = queue.next; index < queue.indices.length; index += 1) {
      unsafeCutDeltas[queue.indices[index] + 1] += 1;
    }
  }
  const cuts: number[] = [];
  let unsafe = 0;
  for (let index = startIndex; index < messages.length; index += 1) {
    unsafe += unsafeCutDeltas[index];
    const role = messages[index].role;
    if (unsafe === 0 && (role === "user" || role === "assistant")) cuts.push(index);
  }
  return cuts;
}
