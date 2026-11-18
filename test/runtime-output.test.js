import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { streamRunEvents } from "../dist/src/dashboard/event-stream.js";
import { readTaskRuntimeEvents } from "../dist/src/runtime/conversation-history.js";
import { RuntimeOutputRecorder, runtimeLogEvents } from "../dist/src/runtime/runtime-output.js";

const delta = (text) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text }
});
const ended = { role: "assistant", timestamp: 1, content: [{ type: "text", text: "hi there" }] };
const line = (event) => `${JSON.stringify(event)}\n`;

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "atria-runtime-output-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = join(root, "task", "runs", "run");
  await fs.mkdir(run, { recursive: true });
  return { root, path: join(run, "runtime-output.log") };
}

const ids = (records) =>
  records.filter((record) => record.type === "runtime_event").map((record) => record.eventId);

test("the log leaves out ended deltas but every event keeps its position", async (t) => {
  const { root, path } = await fixture(t);
  const recorder = new RuntimeOutputRecorder(path);
  recorder.write(Buffer.from(line({ type: "message_start", message: { role: "assistant", timestamp: 1 } })));
  // A chunk can end inside a line.
  const split = line(delta("hi "));
  recorder.write(Buffer.from(split.slice(0, 10)));
  recorder.write(Buffer.from(split.slice(10) + line(delta("there")) + "not json\n"));
  recorder.write(Buffer.from(line({ type: "message_end", message: ended })));
  await recorder.finish();

  const text = await fs.readFile(path, "utf8");
  assert.doesNotMatch(text, /text_delta/);
  assert.match(text, /not json/);
  const { events, next } = runtimeLogEvents(text);
  assert.deepEqual(
    events.map(({ index, event }) => [index, event.type]),
    [
      [0, "message_start"],
      [3, "message_end"]
    ]
  );
  assert.equal(next, 4);
  assert.deepEqual(ids(await readTaskRuntimeEvents(root, "task")), ["runtime-run-0", "runtime-run-3"]);
});

test("a reader sees the open message's deltas only after the line before them is written", async (t) => {
  const { root, path } = await fixture(t);
  const recorder = new RuntimeOutputRecorder(path);
  recorder.write(Buffer.from(line({ type: "message_start", message: { role: "assistant", timestamp: 1 } })));
  recorder.write(Buffer.from(line(delta("hi ")) + line(delta("there"))));
  // Before the first write lands, nothing the deltas follow has been read.
  assert.deepEqual(recorder.openDeltas(0), []);
  await delay(20);
  const saved = await readTaskRuntimeEvents(root, "task");
  assert.deepEqual(ids(saved), ["runtime-run-0", "runtime-run-1", "runtime-run-2"]);

  const request = new EventEmitter();
  const response = new EventEmitter();
  const records = [];
  response.writeHead = () => {};
  response.write = (chunk) => {
    const data = String(chunk)
      .split("\n")
      .find((part) => part.startsWith("data: "));
    if (data) records.push(JSON.parse(data.slice(6)));
    return true;
  };
  response.end = () => response.emit("close");
  t.after(() => {
    request.emit("close");
    response.emit("close");
  });
  streamRunEvents(request, response, "task", "run", root, { runtimeAfter: 2 });
  await delay(120);
  assert.deepEqual(ids(records), ["runtime-run-2"]);
  recorder.write(Buffer.from(line(delta("!"))));
  await delay(150);
  recorder.write(Buffer.from(line({ type: "message_end", message: ended })));
  await delay(150);
  // The ended message's deltas are left out of the log, but the stream sent
  // them while the message was written and does not send them again.
  assert.deepEqual(ids(records), ["runtime-run-2", "runtime-run-3", "runtime-run-4"]);
  await recorder.finish();
  assert.deepEqual(ids(await readTaskRuntimeEvents(root, "task")), ["runtime-run-0", "runtime-run-4"]);
});

test("a process that exits mid-message keeps its partial text, and a later process continues the positions", async (t) => {
  const { root, path } = await fixture(t);
  const first = new RuntimeOutputRecorder(path);
  first.write(Buffer.from(line({ type: "message_start", message: { role: "assistant", timestamp: 1 } })));
  first.write(
    Buffer.from(
      line(delta("par")) +
        line({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }) +
        line(delta("tial"))
    )
  );
  await first.finish();
  const restored = await readTaskRuntimeEvents(root, "task");
  assert.deepEqual(ids(restored), ["runtime-run-0", "runtime-run-1", "runtime-run-2", "runtime-run-3"]);
  assert.deepEqual(restored.map((record) => record.payload.assistantMessageEvent?.delta).filter(Boolean), [
    "par",
    "tial"
  ]);

  const second = new RuntimeOutputRecorder(path);
  second.write(Buffer.from(line({ type: "turn_start" })));
  await second.finish();
  assert.deepEqual(ids(await readTaskRuntimeEvents(root, "task")).at(-1), "runtime-run-4");
});
