import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { streamRunEvents, readJsonFile } from "../dist/src/dashboard/event-stream.js";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { readTaskRuntimeEvents } from "../dist/src/runtime/conversation-history.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";

const delta = (text) => ({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: text }
});
const line = (value) => `${JSON.stringify(value)}\n`;
async function waitFor(check) {
  const until = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < until, "the local runtime output did not settle");
    await delay(10);
  }
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-stream-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, "task", "runs", "run");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "run.json"), JSON.stringify({ createdAt: "2026-01-01" }));
  const output = join(run, "runtime-output.log");
  await writeFile(output, "");
  return { root, run, output };
}
function startStream(t, root) {
  const request = new EventEmitter();
  const response = new EventEmitter();
  const records = [];
  response.writeHead = () => {};
  response.write = (chunk) => {
    const data = String(chunk)
      .split("\n")
      .find((value) => value.startsWith("data: "));
    if (data) records.push(JSON.parse(data.slice(6)));
    return true;
  };
  response.end = () => response.emit("close");
  streamRunEvents(request, response, "task", "run", root);
  t.after(() => request.emit("close"));
  return records;
}

test("spaced reasoning deltas arrive individually instead of accumulating in quarter-second batches", async (t) => {
  const { root, output } = await workspace(t);
  const records = startStream(t, root);
  await appendFile(output, line({ type: "turn_start" }));
  await waitFor(() => records.length === 1);
  const arrivals = [];
  for (const text of ["正在", "读取", "文件", "并检查", "约束😀"]) {
    const started = performance.now();
    await appendFile(output, line(delta(text)));
    await waitFor(() => records.at(-1)?.payload?.assistantMessageEvent?.delta === text);
    arrivals.push(performance.now() - started);
  }
  assert.equal(records.length, 6);
  assert.ok(arrivals.reduce((sum, ms) => sum + ms, 0) / arrivals.length < 150, JSON.stringify(arrivals));
});

test("real delayed byte writes preserve Chinese and Emoji in SSE and persisted history", async (t) => {
  const { root, output } = await workspace(t);
  const text = "中😀";
  const value = Buffer.from(line(delta(text)));
  const firstByte = value.indexOf(Buffer.from(text));
  // A complete marker before the partial character proves the first range was
  // consumed before the remaining bytes are appended.
  await writeFile(
    output,
    Buffer.concat([Buffer.from(line({ type: "turn_start" })), value.subarray(0, firstByte + 1)])
  );
  const records = startStream(t, root);
  await waitFor(() => records.length === 1);
  const unicodeLength = Buffer.byteLength(text);
  for (let offset = firstByte + 1; offset < firstByte + unicodeLength; offset += 1) {
    await appendFile(output, value.subarray(offset, offset + 1));
    await delay(300);
    assert.equal(records.length, 1, "an incomplete JSON line must stay buffered");
  }
  await appendFile(output, value.subarray(firstByte + unicodeLength));
  await waitFor(() => records.length === 2);
  assert.equal(
    records[1].payload.assistantMessageEvent.delta === text,
    true,
    "the thinking delta must retain every UTF-8 code point"
  );
  const history = await readTaskRuntimeEvents(root, "task");
  assert.deepEqual(records, history, "live and persisted event identities and contents must agree");
});

test("truncation clears incomplete UTF-8 and JSON state, and later valid events recover", async (t) => {
  const { root, output } = await workspace(t);
  const partial = Buffer.from(line(delta("😀")));
  const firstByte = partial.indexOf(Buffer.from("😀"));
  await writeFile(
    output,
    Buffer.concat([Buffer.from(line({ type: "turn_start" })), partial.subarray(0, firstByte + 1)])
  );
  const records = startStream(t, root);
  await waitFor(() => records.length === 1);
  await writeFile(output, "");
  await delay(350);
  const restored = delta("恢复😀");
  await appendFile(output, line(restored));
  await waitFor(() => records.length === 2);
  assert.deepEqual(records[1].payload, restored);
  await appendFile(output, '{"incomplete":');
  await delay(350);
  assert.equal(records.length, 2);
  const later = delta("后续中文😀");
  await appendFile(output, `\n${line(later)}`);
  await waitFor(() => records.length === 3);
  assert.deepEqual(records[2].payload, later);
  assert.deepEqual(
    (await readTaskRuntimeEvents(root, "task")).map((record) => record.payload),
    [restored, later]
  );
});

test("a real child's stderr cannot split stdout JSON events and remains available as diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-child-output-"));
  const workspaceRoot = join(root, "workspace");
  const store = new LocalWorkspaceStore(workspaceRoot);
  await store.createTask("task", { goal: "synthetic stream integrity" });
  await mkdir(join(root, "scripts"));
  const event = delta("合成思考😀");
  const encoded = line(event);
  const cut = encoded.indexOf("thinking_delta") + 4;
  const first = encoded.slice(0, cut);
  const last = encoded.slice(cut);
  const diagnostic = "synthetic stderr diagnostic 中文😀\n";
  const finalDiagnostic = "synthetic stderr before exit 中文😀\n";
  await writeFile(
    join(root, "scripts", "start-pi.mjs"),
    `
    import { access } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const wait = async (path) => { for (;;) { try { await access(path); return; } catch { await delay(10); } } };
    const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
    await write(process.stdout, ${JSON.stringify(first)});
    await wait(${JSON.stringify(join(root, "allow-stderr"))});
    await write(process.stderr, ${JSON.stringify(diagnostic)});
    await wait(${JSON.stringify(join(root, "allow-tail"))});
    await write(process.stdout, ${JSON.stringify(last + line({ type: "turn_end" }))});
    await write(process.stderr, ${JSON.stringify(finalDiagnostic)});
    process.exitCode = 1;
  `
  );
  const service = createDashboardRunService({
    projectRoot: root,
    tabStorePath: join(root, "tabs.json"),
    dashboardUrl: "http://127.0.0.1:1",
    coordinator: {},
    locateTask: async () => ({ workspaceRoot, store, task: await store.readTask("task") }),
    resolveMainModel: singleConnectionMainModel({ apiKey: "synthetic-only", model: "synthetic" }),
    normalizeModel: (value) => value,
    appendRunEvent: async () => {},
    readJsonFile
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  await service.startMainRun("task", "synthetic-only", "run");
  const output = join(workspaceRoot, "task", "runs", "run", "runtime-output.log");
  const errors = join(workspaceRoot, "task", "runs", "run", "runtime-stderr.log");
  await waitFor(async () => (await readFile(output, "utf8").catch(() => "")) === first);
  const streamed = startStream(t, workspaceRoot);
  await writeFile(join(root, "allow-stderr"), "");
  await waitFor(
    async () =>
      (await readFile(output, "utf8").catch(() => "")).includes(diagnostic) ||
      (await readFile(errors, "utf8").catch(() => "")).includes(diagnostic)
  );
  await writeFile(join(root, "allow-tail"), "");
  await waitFor(() => service.activeRuns.size === 0);
  assert.equal((await store.readTask("task")).status, "failed");
  assert.equal(await readFile(output, "utf8"), encoded + line({ type: "turn_end" }));
  const history = await readTaskRuntimeEvents(workspaceRoot, "task");
  assert.equal(history.length, 2, "a diagnostic between stdout fragments must not drop the thinking event");
  assert.deepEqual(history[0].payload, event);
  await waitFor(() => streamed.length === 2);
  assert.deepEqual(streamed, history);
  assert.equal(
    await readFile(errors, "utf8"),
    diagnostic + finalDiagnostic,
    "stderr diagnostics must retain their original bytes"
  );
});
