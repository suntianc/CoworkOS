import { ui } from "./ui/language.js";
const START = "main.run_spawned";
const STOPS = new Set(["main.run_completed", "main.run_failed", "main.run_paused", "main.run_waiting"]);

function ledgerTime(value) {
  // Ledger timestamps carry a timezone. Do not let Date.parse turn a budget,
  // numeric string or local calendar date into an apparent execution time.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Sum closed execution intervals for the runs explicitly present in an exchange.
 * Missing or ambiguous ledger boundaries mean unknown, never an estimated time.
 */
export function executionElapsedMs(runtimeEvents, lifecycleEvents) {
  if (!Array.isArray(runtimeEvents) || !Array.isArray(lifecycleEvents)) return null;
  const runs = new Map();
  for (const record of runtimeEvents) {
    if (typeof record?.runId === "string" && record.runId.trim()) runs.set(record.runId, []);
  }
  if (!runs.size) return null;

  for (const event of lifecycleEvents) {
    if (!runs.has(event?.runId) || (event.type !== START && !STOPS.has(event.type))) continue;
    const time = ledgerTime(event.occurredAt);
    if (time === null) return null;
    runs.get(event.runId).push({ time, start: event.type === START });
  }

  let elapsed = 0;
  for (const events of runs.values()) {
    if (!events.length) return null;
    // Polling and SSE replay may repeat a boundary or return ledger files in a
    // different order. A repeated finalizer does not open another interval.
    events.sort((a, b) => a.time - b.time || Number(b.start) - Number(a.start));
    const seen = new Set();
    let started = null;
    let closed = false;
    for (const event of events) {
      const key = `${event.start}:${event.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (event.start) {
        if (started !== null) return null;
        started = event.time;
      } else if (started !== null) {
        elapsed += event.time - started;
        started = null;
        closed = true;
      } else if (!closed) {
        return null;
      }
    }
    if (started !== null || !closed) return null;
  }
  return Number.isFinite(elapsed) ? elapsed : null;
}

/** Whole seconds, without implying precision the display does not provide. */
export function formatExecutionDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return ui`${seconds}秒`;
  return ui`${minutes}分钟${seconds ? ui`${seconds}秒` : ""}`;
}
