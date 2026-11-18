import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { readJsonLines, streamRunEvents } from "../dist/src/dashboard/event-stream.js";
import { readTaskRuntimeEvents } from "../dist/src/runtime/conversation-history.js";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "atria-stream-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = join(root, "task", "runs", "run");
  await fs.mkdir(run, { recursive: true });
  return { root, run, ledger: join(run, "run_events.jsonl"), runtime: join(run, "runtime-output.log") };
}

async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < until, "the isolated stream must settle");
    await delay(10);
  }
}

function stream(t, root, options) {
  const request = new EventEmitter();
  const response = new EventEmitter();
  const records = [],
    afterClose = [];
  let closed = false;
  response.writeHead = () => {};
  response.write = (chunk) => {
    const data = String(chunk)
      .split("\n")
      .find((part) => part.startsWith("data: "));
    if (data) {
      const record = JSON.parse(data.slice(6));
      records.push(record);
      if (closed) afterClose.push(record);
    }
    return true;
  };
  response.end = () => response.emit("close");
  const close = () => {
    closed = true;
    request.emit("close");
    response.emit("close");
  };
  t.after(close);
  streamRunEvents(request, response, "task", "run", root, options);
  return { records, afterClose, close };
}

function observeReads(path) {
  const originalReadFile = fs.readFile;
  const originalOpen = fs.open;
  const observed = { bytes: 0, ranges: [] };
  fs.readFile = async (file, ...args) => {
    const result = await originalReadFile(file, ...args);
    if (String(file) === path) observed.bytes += Buffer.byteLength(result);
    return result;
  };
  fs.open = async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (String(file) === path) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        observed.bytes += result.bytesRead;
        observed.ranges.push({ start: readArgs[3], length: result.bytesRead });
        return result;
      };
      const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (options) => {
        observed.ranges.push({ start: options.start, end: options.end });
        // FileHandle streams use the same read method instrumented above.
        return createReadStream(options);
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  return {
    observed,
    restore() {
      fs.readFile = originalReadFile;
      fs.open = originalOpen;
      syncBuiltinESMExports();
    }
  };
}

const ledgerValue = (index) => ({
  eventId: `ledger-${index}`,
  type: "changed",
  payload: { index, text: "中文😀" }
});
const jsonl = (value) => JSON.stringify(value) + "\n";

test("a long ledger's first SSE replay reads only its final range and keeps the newest 500 identities", async (t) => {
  const f = await fixture(t);
  const values = Array.from({ length: 10000 }, (_, index) => ledgerValue(index));
  const lines = values.map(jsonl);
  const body = lines.join("");
  await fs.writeFile(f.ledger, body);
  const probe = observeReads(f.ledger);
  const opened = stream(t, f.root);
  try {
    await waitFor(() => opened.records.length === 500);
    assert.deepEqual(opened.records, values.slice(-500));
    const blockSize = 65536;
    const allowedBytes = Math.ceil(Buffer.byteLength(lines.slice(-501).join("")) / blockSize) * blockSize;
    assert.ok(probe.observed.bytes <= allowedBytes, JSON.stringify(probe.observed));
    assert.ok(
      probe.observed.bytes < Buffer.byteLength(body) / 4,
      "first replay must avoid the historical prefix"
    );
    assert.ok(probe.observed.ranges.every((range) => range.start >= Buffer.byteLength(body) - allowedBytes));
    console.log(
      JSON.stringify({ firstReplayBytes: probe.observed.bytes, ledgerBytes: Buffer.byteLength(body) })
    );
  } finally {
    opened.close();
    probe.restore();
  }
});

test("a bounded initial ledger tail preserves half a UTF-8 character and JSON line until its append completes", async (t) => {
  const f = await fixture(t);
  const values = Array.from({ length: 2000 }, (_, index) => ledgerValue(index));
  const pending = { eventId: "ledger-pending", type: "changed", payload: { text: "未完成中文😀" } };
  const encoded = Buffer.from(jsonl(pending));
  const cut = encoded.indexOf(Buffer.from("😀")) + 2;
  await fs.writeFile(
    f.ledger,
    Buffer.concat([Buffer.from(values.map(jsonl).join("")), encoded.subarray(0, cut)])
  );
  const probe = observeReads(f.ledger);
  const opened = stream(t, f.root);
  try {
    await waitFor(() => opened.records.length === 500);
    assert.deepEqual(opened.records, values.slice(-500));
    const initialBytes = probe.observed.bytes;
    assert.ok(initialBytes <= 65536, "the incomplete tail must not force a full historical scan");
    await delay(350);
    assert.equal(opened.records.length, 500, "partial UTF-8/JSON stays buffered during idle polls");
    assert.equal(probe.observed.bytes, initialBytes, "an idle partial line does not reread its body");
    const next = ledgerValue(2000);
    const appended = Buffer.concat([encoded.subarray(cut), Buffer.from(jsonl(next))]);
    await fs.appendFile(f.ledger, appended);
    await waitFor(() => opened.records.length === 502);
    assert.deepEqual(opened.records.slice(-2), [pending, next]);
    assert.equal(
      probe.observed.bytes - initialBytes,
      appended.length,
      "the next poll reads only appended bytes"
    );
    assert.equal(JSON.stringify(opened.records).includes("\uFFFD"), false);
  } finally {
    opened.close();
    probe.restore();
  }
});

for (const state of ["empty", "missing"]) {
  test(`an initially ${state} ledger delivers every event from its first appended 600-event burst`, async (t) => {
    const f = await fixture(t);
    if (state === "empty") await fs.writeFile(f.ledger, "");
    await fs.writeFile(f.runtime, '{"type":"turn_start"}\n');
    const opened = stream(t, f.root);
    try {
      // Runtime follows the ledger read in one emit, so this confirms the
      // connection completed its initial empty/missing ledger observation.
      await waitFor(() => opened.records.some((record) => record.type === "runtime_event"));
      const values = Array.from({ length: 600 }, (_, index) => ledgerValue(index));
      await fs.appendFile(f.ledger, values.map(jsonl).join(""));
      await waitFor(() => opened.records.filter((record) => record.type === "changed").length >= 500);
      assert.deepEqual(
        opened.records.filter((record) => record.type === "changed").map((record) => record.eventId),
        values.map((record) => record.eventId)
      );
    } finally {
      opened.close();
    }
  });
}

test("bounded ledger tails retry legal short reads instead of dropping the newest bytes", async (t) => {
  const f = await fixture(t);
  const values = Array.from({ length: 1000 }, (_, index) => ({ index, text: "中文😀".repeat(30) }));
  await fs.writeFile(f.ledger, values.map((value) => JSON.stringify(value)).join("\n"));
  const originalOpen = fs.open;
  fs.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) === f.ledger) {
      const originalRead = handle.read.bind(handle);
      handle.read = (buffer, offset, length, position) =>
        originalRead(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const actual = await readJsonLines(f.ledger, 30);
    assert.deepEqual(
      actual.map((value) => value.index),
      values.slice(-30).map((value) => value.index)
    );
    assert.deepEqual(actual, values.slice(-30));
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("closing while the ledger is opening prevents late writes and further runtime reads", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.ledger, '{"eventId":"ledger-event","type":"changed"}\n');
  await fs.writeFile(f.runtime, '{"type":"turn_start"}\n');
  const originalOpen = fs.open;
  let release,
    started = false,
    runtimeReads = 0;
  fs.open = async (path, ...args) => {
    if (String(path) === f.ledger) {
      started = true;
      await new Promise((resolve) => (release = resolve));
    }
    if (String(path) === f.runtime) runtimeReads++;
    return originalOpen(path, ...args);
  };
  syncBuiltinESMExports();
  const opened = stream(t, f.root);
  try {
    await waitFor(() => started);
    opened.close();
    release();
    await delay(150);
    assert.deepEqual(opened.afterClose, [], "a closed response must not receive an in-flight range");
    assert.equal(runtimeReads, 0, "closing must stop subsequent log-body work");
  } finally {
    release?.();
    fs.open = originalOpen;
    syncBuiltinESMExports();
    opened.close();
  }
});

test("closing during a tail's short read cancels further body reads and closes its handle", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    f.ledger,
    Array.from({ length: 2000 }, (_, index) => ({
      ...ledgerValue(index),
      payload: { index, text: "中😀".repeat(15) }
    }))
      .map(jsonl)
      .join("")
  );
  const originalOpen = fs.open;
  let reads = 0,
    release,
    started = false,
    handleClosed = false;
  fs.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) === f.ledger) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        reads++;
        const result = await originalRead(buffer, offset, Math.min(length, 8192), position);
        if (reads === 1) {
          started = true;
          await new Promise((resolve) => (release = resolve));
        }
        return result;
      };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        try {
          await close();
        } finally {
          handleClosed = true;
        }
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const opened = stream(t, f.root);
  try {
    await waitFor(() => started);
    opened.close();
    const readsAtClose = reads;
    release();
    await waitFor(() => handleClosed);
    assert.equal(reads, readsAtClose, "a closed SSE must not fill or prepend another tail range");
    assert.deepEqual(opened.afterClose, []);
  } finally {
    release?.();
    fs.open = originalOpen;
    syncBuiltinESMExports();
    opened.close();
  }
});

test("atomic runtime replacement between metadata and open keeps live and persisted event identities aligned", async (t) => {
  const f = await fixture(t);
  const record = (text) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text }
  });
  const encode = (value) => JSON.stringify(value) + "\n";
  await fs.writeFile(f.runtime, encode(record("old0")));
  const replacement = `${f.runtime}.replacement`;
  await fs.writeFile(replacement, encode(record("new1")) + encode(record("new2")));
  const originalOpen = fs.open;
  let replaced = false;
  fs.open = async (path, ...args) => {
    if (String(path) === f.runtime && !replaced) {
      replaced = true;
      await fs.rename(replacement, f.runtime);
    }
    return originalOpen(path, ...args);
  };
  syncBuiltinESMExports();
  const opened = stream(t, f.root);
  try {
    await waitFor(() => opened.records.at(-1)?.payload?.assistantMessageEvent?.delta === "new2");
    assert.deepEqual(opened.records, await readTaskRuntimeEvents(f.root, "task"));
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    opened.close();
  }
});

test("runtime replacement preserving a pending UTF-8 prefix delivers only appended deltas with stable identities", async (t) => {
  const f = await fixture(t);
  const delta = (text) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text }
  });
  const delivered = delta("已经交付中文😀");
  const pending = delta("继续追加中文😀");
  const last = delta("替换后末尾追加");
  const pendingBytes = Buffer.from(jsonl(pending));
  const cut = pendingBytes.indexOf(Buffer.from("😀")) + 2;
  const prefix = Buffer.concat([Buffer.from(jsonl(delivered)), pendingBytes.subarray(0, cut)]);
  await fs.writeFile(f.runtime, prefix);
  const opened = stream(t, f.root);
  try {
    await waitFor(() => opened.records.length === 1);
    assert.deepEqual(opened.records[0].payload, delivered);
    const replacement = `${f.runtime}.replacement`;
    await fs.writeFile(
      replacement,
      Buffer.concat([prefix, pendingBytes.subarray(cut), Buffer.from(jsonl(last))])
    );
    await fs.rename(replacement, f.runtime);
    await waitFor(
      () => opened.records.at(-1)?.payload?.assistantMessageEvent?.delta === last.assistantMessageEvent.delta
    );
    assert.deepEqual(
      opened.records.map((record) => record.payload),
      [delivered, pending, last]
    );
    assert.deepEqual(opened.records, await readTaskRuntimeEvents(f.root, "task"));
    assert.equal(JSON.stringify(opened.records).includes("\uFFFD"), false);
  } finally {
    opened.close();
  }
});

test("a stream opened after a saved history continues from its last runtime event", async (t) => {
  const f = await fixture(t);
  const delta = (text) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text }
  });
  await fs.writeFile(f.runtime, jsonl(delta("a")) + jsonl(delta("b")) + jsonl(delta("c")));
  const opened = stream(t, f.root, { runtimeAfter: 2 });
  await fs.appendFile(f.runtime, jsonl(delta("d")));
  await waitFor(() => opened.records.at(-1)?.payload?.assistantMessageEvent?.delta === "d");
  const runtime = opened.records.filter((record) => record.type === "runtime_event");
  assert.deepEqual(
    runtime.map((record) => [record.eventId, record.payload.assistantMessageEvent.delta]),
    [
      ["runtime-run-2", "c"],
      ["runtime-run-3", "d"]
    ]
  );
  opened.close();
});
