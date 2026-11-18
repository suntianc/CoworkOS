import { appendFile, readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/**
 * Main's runtime log without its token deltas.
 *
 * Pi prints every token delta as its own line, and once a message ends its
 * snapshot carries the same text again: the deltas were nearly every line and
 * most of the bytes of a long conversation, which each read then parsed only
 * to drop. The log keeps every other line. Where deltas were left out it
 * notes how many, so an event keeps the position it always had: ids, the
 * page's resume marks and the stream's `after` count the deltas as before.
 *
 * The deltas of the message still being written stay in memory, for the
 * stream and a detail read to show. A process that exits mid-message has
 * them written out, so a crash keeps the partial text it showed.
 */

/** Advances the position by `count` deltas the log left out. */
export const OMITTED_DELTAS = "cowork_deltas_omitted";
/** Deltas of a message that never ended, each at the position it had. */
export const RESTORED_DELTAS = "cowork_deltas_restored";

export interface PositionedEvent {
  index: number;
  event: Record<string, unknown>;
}

interface OpenDelta extends PositionedEvent {
  /** The position of the last line written before it. */
  after: number;
}

function isDelta(event: Record<string, unknown>): boolean {
  const update = (event.assistantMessageEvent as { type?: unknown } | undefined)?.type;
  return event.type === "message_update" && typeof update === "string" && update.endsWith("_delta");
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    // eslint-disable-next-line no-restricted-syntax -- 进程输出会夹带非 JSON 的日志或半行，这一行不是事件，不占位置
  } catch {
    return undefined;
  }
}

/**
 * Reads runtime log lines with the positions their events hold.
 *
 * `next` is the position the following line takes, so a reader that stops
 * part way continues from it. Lines that are not JSON objects hold no
 * position, as they never did.
 */
export class RuntimeLogPositions {
  next = 0;

  read(line: string): PositionedEvent[] {
    const event = parseObject(line);
    if (!event) return [];
    if (event.type === OMITTED_DELTAS) {
      const count = Number(event.count);
      if (Number.isSafeInteger(count) && count > 0) this.next += count;
      return [];
    }
    if (event.type === RESTORED_DELTAS) {
      const restored = (
        Array.isArray(event.deltas) ? (event.deltas as Array<Partial<PositionedEvent>>) : []
      ).filter(
        (entry): entry is PositionedEvent =>
          Number.isSafeInteger(entry.index) && typeof entry.event === "object"
      );
      // The last of them held the last position the ended process used.
      for (const entry of restored) this.next = Math.max(this.next, entry.index + 1);
      return restored;
    }
    return [{ index: this.next++, event }];
  }
}

/** Every event of a runtime log in position order, and the position after it. */
export function runtimeLogEvents(text: string): { events: PositionedEvent[]; next: number } {
  const positions = new RuntimeLogPositions();
  const events = text.split(/\r?\n/).flatMap((line) => positions.read(line));
  if (events.some((entry, index) => index > 0 && entry.index < events[index - 1].index))
    events.sort((a, b) => a.index - b.index);
  return { events, next: positions.next };
}

const recorders = new Map<string, RuntimeOutputRecorder>();

/** The recorder writing this log in this backend, while its process runs. */
export function liveRuntimeOutput(path: string): RuntimeOutputRecorder | undefined {
  return recorders.get(path);
}

/** Writes a Main process's output to its runtime log; see the module note. */
export class RuntimeOutputRecorder {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private started = false;
  private next = 0;
  private written = -1;
  private omitted = 0;
  private open: OpenDelta[] = [];
  private writes = Promise.resolve();

  constructor(private readonly path: string) {
    recorders.set(path, this);
  }

  write(chunk: Buffer): void {
    this.enqueue(() => {
      const lines = (this.pending + this.decoder.write(chunk)).split(/(?<=\n)/);
      this.pending = lines.at(-1)?.endsWith("\n") ? "" : (lines.pop() ?? "");
      return lines.map((line) => this.record(line)).join("");
    });
  }

  /** The deltas of the message being written that follow what a reader has read. */
  openDeltas(read: number): PositionedEvent[] {
    return this.open
      .filter((delta) => delta.after < read && delta.index >= read)
      .map(({ index, event }) => ({ index, event }));
  }

  /** Writes what is left once the process's output ends. */
  async finish(): Promise<void> {
    this.enqueue(() => {
      let out = this.record(this.pending + this.decoder.end());
      this.pending = "";
      // The deltas a note already stands for cannot take their place again;
      // they are restored at their positions for the message that never ended.
      if (this.open.length)
        out += `${JSON.stringify({
          type: RESTORED_DELTAS,
          deltas: this.open.map(({ index, event }) => ({ index, event }))
        })}\n`;
      this.open = [];
      this.omitted = 0;
      return out;
    });
    await this.writes;
    if (recorders.get(this.path) === this) recorders.delete(this.path);
  }

  private enqueue(lines: () => string): void {
    // Each chunk is written after the one before it, and positions continue
    // from a log an earlier process of the same Run left.
    this.writes = this.writes
      .then(async () => {
        if (!this.started) {
          this.started = true;
          this.next = runtimeLogEvents(
            // eslint-disable-next-line no-restricted-syntax -- 新 Run 的日志还不存在，从位置 0 开始
            await readFile(this.path, "utf8").catch(() => "")
          ).next;
          this.written = this.next - 1;
        }
        const text = lines();
        if (text) await appendFile(this.path, text);
      })
      .catch((error) =>
        console.error(
          `[cowork] output persist failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  }

  private record(line: string): string {
    if (!line) return "";
    const event = parseObject(line);
    if (!event) return line;
    const index = this.next++;
    if (isDelta(event)) {
      this.open.push({ index, event, after: this.written });
      this.omitted += 1;
      return "";
    }
    const note = this.omitted ? `${JSON.stringify({ type: OMITTED_DELTAS, count: this.omitted })}\n` : "";
    this.omitted = 0;
    this.written = index;
    // An ended message's snapshot carries what its deltas did.
    if (event.type === "message_end" || event.type === "turn_end") this.open = [];
    return note + (line.endsWith("\n") ? line : `${line}\n`);
  }
}
