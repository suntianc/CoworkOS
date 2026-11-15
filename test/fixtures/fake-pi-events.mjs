/**
 * The event handlers a loaded extension registered on a fake Pi.
 *
 * Real Pi keeps every handler registered for one event and runs them in
 * registration order; a Map of event name to one handler silently drops the
 * second registration, which is how a new hook could shadow an older one
 * without any test noticing. Results compose the way the Pi runner composes
 * them: `before_agent_start` hands each handler the prompt the previous one
 * produced and applies a returned `systemPrompt`, while every other event
 * returns the last value a handler returned.
 *
 * A handler that throws stops the dispatch and rejects, so a fixture can still
 * use one as its own stop point.
 */
export function fakeEventHandlers() {
  const registered = new Map();
  return {
    handlers: {
      /** The dispatcher for one event, or undefined when nothing listens to it. */
      get(name) {
        const list = registered.get(name);
        return list?.length ? (event, ctx) => emit(name, list, event, ctx) : undefined;
      },
      has(name) {
        return Boolean(registered.get(name)?.length);
      }
    },
    on(name, handler) {
      registered.set(name, [...(registered.get(name) ?? []), handler]);
    }
  };
}

async function emit(name, handlers, event, ctx) {
  if (name !== "before_agent_start") {
    let result;
    for (const handler of handlers) result = (await handler(event, ctx)) ?? result;
    return result;
  }
  let prompt = event.systemPrompt;
  const messages = [];
  for (const handler of handlers) {
    const result = await handler({ ...event, systemPrompt: prompt }, ctx);
    if (!result) continue;
    if (result.message) messages.push(result.message);
    if (result.systemPrompt !== undefined) prompt = result.systemPrompt;
  }
  return { systemPrompt: prompt, messages };
}
