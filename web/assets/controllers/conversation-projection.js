import { buildConversationExchanges } from "../conversation.js";

/** Reuse settled grouping while the current exchange receives append-only deltas. */
export function createConversationProjection(normalize = (messages) => messages) {
  let source,
    count = 0,
    tail,
    signature,
    exchanges,
    seenMessages,
    seenLocal,
    seenVersion;
  return (messages, localMessages, events, version) => {
    // The page replaces both lists rather than editing them, and a change
    // made elsewhere arrives with a new conversation version, so the same
    // lists need no second serialization on each streamed frame.
    const nextSignature =
      messages === seenMessages && localMessages === seenLocal && version === seenVersion
        ? signature
        : JSON.stringify([messages, localMessages]);
    seenMessages = messages;
    seenLocal = localMessages;
    seenVersion = version;
    const current = exchanges?.at(-1);
    const appended =
      source === events &&
      count > 0 &&
      events.length >= count &&
      events[count - 1] === tail &&
      nextSignature === signature &&
      current?.events.at(-1) === tail &&
      !current.awaitingDelivery &&
      !current.continued;
    if (appended) {
      const suffix = events.slice(count);
      // Delivery, replay boundaries and assistant starts can change ownership.
      const boundary = suffix.some((record) => {
        const event = record?.type === "runtime_event" ? record.payload : record;
        return ["message_start", "message_end"].includes(event?.type);
      });
      if (!boundary) {
        current.events.push(...suffix);
        count = events.length;
        tail = events.at(-1);
        return exchanges;
      }
    }
    exchanges = buildConversationExchanges([...normalize(messages), ...localMessages], events);
    source = events;
    count = events.length;
    tail = events.at(-1);
    signature = nextSignature;
    return exchanges;
  };
}
