import { outstandingWork } from "./tool-lifecycle.js";

const messageText = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content || []).map((part) => part?.text || "").join("");

/**
 * The turn a supervisor wakes Main with, mirrored from the runtime.
 *
 * Pi needs a turn to start running, so a relaunch has to say something. It is
 * machinery, not a person talking, and showing it made the transcript read as
 * though the user had typed "Resume this task from its durable state…" right
 * after answering a question.
 *
 * `src/runtime/main-supervisor.ts` holds the runtime's copy and must match.
 */
export const SUPERVISOR_WAKE_TURN =
  "Resume this task from its durable state: consume the pending Inbox messages and continue.";

/**
 * Whether a turn is the harness talking to itself rather than to the person.
 *
 * These reach the model as ordinary user turns because that is the only way to
 * start one, but the transcript is a record of the conversation, and nobody
 * said this.
 */
export function isMachineTurn(message) {
  return message?.role === "user" && messageText(message).trim() === SUPERVISOR_WAKE_TURN;
}

export function finalAnswerIndex(messages, detail, isCurrent = true) {
  const task = detail?.task || {};
  const coordination = detail?.coordination || {};
  if (
    isCurrent &&
    (detail?.runtime?.active ||
      task.status !== "completed" ||
      coordination.pending?.length ||
      coordination.callbackPending?.length ||
      Object.values(outstandingWork(detail)).some((count) => count > 0))
  )
    return -1;
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const last = messages[index];
  return last &&
    !["toolUse", "error", "aborted", "length"].includes(last.stopReason) &&
    messageText(last).trim()
    ? index
    : -1;
}

/** Each request keeps its own terminal state, even after the task is resumed. */
export function exchangeExecutionState(events = []) {
  let terminal, retry;
  for (const record of events) {
    const event = record?.type === "runtime_event" ? record.payload : record;
    if (event?.type === "auto_retry_start") retry = event;
    if (event?.type === "auto_retry_end") retry = undefined;
    if (/^main\.run_(completed|failed|paused|waiting|cancelled)$/.test(event?.type || "")) {
      terminal = event.type.slice("main.run_".length);
      retry = undefined;
    }
  }
  return { terminal, retry };
}

// Split activity at user input's actual context position, including steering
// within a run. Earlier thinking/tools stay above the instruction they preceded.
export function buildConversationExchanges(messages, events) {
  const exchanges = [];
  // A supervisor wake-up is not a request, so it must not open an exchange:
  // doing so split CoworkOS's reply away from the message it was answering and
  // printed the harness's own instruction above it.
  for (const message of (messages || []).filter(
    (entry) => !isMachineTurn(entry) && !(entry.delivery === "followUp" && entry.pending)
  )) {
    if (message.role === "user" || !exchanges.length)
      exchanges.push({ user: message.role === "user" ? message : null, messages: [], events: [] });
    exchanges.at(-1).messages.push(message);
  }
  // Preserve first-unmatched fallback semantics without scanning every exchange.
  const index = (keyOf) => {
    const entries = new Map();
    for (const exchange of exchanges) {
      const key = keyOf(exchange);
      if (key === undefined || key === null) continue;
      const bucket = entries.get(key) || { entries: [], cursor: 0 };
      bucket.entries.push(exchange);
      entries.set(key, bucket);
    }
    return entries;
  };
  const byId = index((entry) => entry.user?.id);
  const byTimestamp = index((entry) => entry.user?.timestamp);
  let byText;
  const interjectedAssistants = new Map();
  for (const exchange of exchanges)
    if (exchange.user?.interjected)
      for (const message of exchange.messages)
        if (
          message.role === "assistant" &&
          message.timestamp !== undefined &&
          !interjectedAssistants.has(message.timestamp)
        )
          interjectedAssistants.set(message.timestamp, exchange);
  const groupedIds = new Set();
  const groupedTimestamps = new Set();
  const groups = [];
  let group;
  let prelude = [];
  for (const record of events || []) {
    const event = record?.type === "runtime_event" ? record.payload : record;
    const incoming = event?.message;
    const userMessage =
      incoming?.role === "custom" && incoming.customType === "cowork-user-message"
        ? {
            role: "user",
            id: incoming.details?._coworkInbox?.messageId,
            content: incoming.details?.message,
            timestamp: incoming.timestamp
          }
        : incoming;
    // Older logs can omit the delivered custom message. A persisted assistant
    // snapshot still locates the response after that instruction without
    // moving all of the preceding request's activity into the new segment.
    if (event?.type === "message_start" && incoming?.role === "assistant") {
      const owner = interjectedAssistants.get(incoming.timestamp);
      if (
        owner &&
        !(owner.user.id ? groupedIds.has(owner.user.id) : groupedTimestamps.has(owner.user.timestamp))
      ) {
        groupedIds.add(owner.user.id);
        groupedTimestamps.add(owner.user.timestamp);
        group = { user: owner.user, events: prelude };
        prelude = [];
        groups.push(group);
      }
    }
    if (userMessage?.role === "user" && ["message_start", "message_end"].includes(event.type)) {
      // A supervisor wake-up opens no exchange, so its activity belongs to the
      // exchange already in progress rather than to a group with no request.
      if (isMachineTurn(userMessage)) {
        if (group) group.events.push(record);
        else prelude.push(record);
        continue;
      }
      // Pi emits both start and end for the same user message.
      const sameUser =
        group?.user &&
        (userMessage.id && group.user.id
          ? group.user.id === userMessage.id
          : userMessage.timestamp !== undefined
            ? group.user.timestamp === userMessage.timestamp
            : messageText(group.user) === messageText(userMessage));
      if (event.type === "message_start" || !sameUser) {
        group = { user: userMessage, events: prelude };
        prelude = [];
        groups.push(group);
        groupedIds.add(userMessage.id);
        groupedTimestamps.add(userMessage.timestamp);
      }
    }
    if (group) group.events.push(record);
    else prelude.push(record);
  }
  const matched = new Set();
  const take = (lookup, key) => {
    const bucket = lookup.get(key);
    if (!bucket) return;
    while (bucket.cursor < bucket.entries.length && matched.has(bucket.entries[bucket.cursor]))
      bucket.cursor++;
    return bucket.entries[bucket.cursor];
  };
  for (const current of groups) {
    let exchange = current.user.id ? take(byId, current.user.id) : undefined;
    exchange ||= current.user.timestamp !== undefined ? take(byTimestamp, current.user.timestamp) : undefined;
    if (!exchange) {
      byText ||= index((entry) => (entry.user ? messageText(entry.user) : undefined));
      exchange = take(byText, messageText(current.user));
    }
    if (exchange) {
      exchange.events.push(...current.events);
      matched.add(exchange);
    }
  }
  // Older fixtures/logs may not include user message events. Assign those
  // events to the most recent persisted request, never a new optimistic one.
  if (!groups.length && prelude.length) {
    const exchange = exchanges.findLast((entry) => !entry.user?.taskId);
    if (exchange) exchange.events = prelude;
  }
  const awaitingDelivery = (exchange) =>
    Boolean(exchange?.user?.interjected) &&
    !matched.has(exchange) &&
    !exchange.messages.some((message) => message.role === "assistant");
  return exchanges.map((exchange, index) => ({
    ...exchange,
    awaitingDelivery: awaitingDelivery(exchange),
    continued:
      Boolean(exchanges[index + 1]?.user?.interjected) &&
      !awaitingDelivery(exchanges[index + 1]) &&
      !exchangeExecutionState(exchange.events).terminal,
    key: String(
      (exchange.user?.interjected ? exchange.user.id : undefined) ??
        exchange.user?.timestamp ??
        exchange.user?.id ??
        `position:${index}`
    ),
    events: exchange.events.length
      ? exchange.events
      : exchange.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => [
            { type: "turn_start" },
            { type: "message_start", message },
            { type: "message_end", message },
            { type: "turn_end", message }
          ])
  }));
}

export function streamRecordKey(record) {
  if (!record || typeof record !== "object") return "";
  if (record.eventId) return `${record.runId || ""}:${record.eventId}`;
  if (record.type === "runtime_event" && record.payload && typeof record.payload === "object")
    return `runtime:${JSON.stringify(record.payload)}`;
  return `runtime:${JSON.stringify(record)}`;
}

// SSE and detail polling can complete in either order. Preserve events that
// arrived after the detail request started, while accepting its saved history.
export function mergeRuntimeEvents(saved = [], streamed = []) {
  const keys = new Set(saved.map(streamRecordKey));
  return [
    ...saved,
    ...streamed.filter((record) => {
      const key = streamRecordKey(record);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    })
  ];
}
