import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRequestRecorder,
  parseModelRequestArchive,
  recordingHash
} from "../dist/src/storage/model-request-recorder.js";

const identity = { taskId: "task-1", runId: "run-1", agentId: "main" };
const tools = [{ name: "bash", description: "run", parameters: { type: "object" } }];
const summaryTools = [];

function payload(input, { systemPrompt = "You are Main", toolSet = tools, instructions } = {}) {
  return {
    model: { id: "m" },
    systemPrompt,
    tools: toolSet,
    systemPromptSha256: recordingHash(systemPrompt),
    toolsSha256: recordingHash(toolSet),
    request: { model: "m", stream: true, input, tools: toolSet, ...(instructions ? { instructions } : {}) }
  };
}

test("a request that extends an earlier one stores only what is new and rebuilds exactly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-request-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "requests.jsonl");
  const recorder = new ModelRequestRecorder(path, identity);
  const long = "x".repeat(20_000);
  const turn = (n) => [
    { role: "user", content: `${long}${n}` },
    { role: "assistant", content: `answer ${n}` }
  ];
  const sent = [
    payload([...turn(1)]),
    payload([...turn(1), ...turn(2)]),
    // A summary call between Main's requests has its own prompt and no tools.
    payload([...turn(1), ...turn(2), { role: "user", content: "summarize" }], {
      systemPrompt: "Summarize",
      toolSet: summaryTools
    }),
    payload([...turn(1), ...turn(2), ...turn(3)], { instructions: "changed" }),
    // Compaction rewrote the history: nothing is shared, so it is written in full.
    payload([{ role: "user", content: "checkpoint" }, ...turn(4)])
  ];
  for (const [index, request] of sent.entries()) await recorder.record("model_request", `r${index}`, request);
  await recorder.record("model_response", "r4", { message: { role: "assistant" } });

  const text = await readFile(path, "utf8");
  const stored = text.trim().split("\n").map(JSON.parse);
  assert.equal(stored[0].payload.requestBase, undefined);
  assert.deepEqual(stored[1].payload.requestBase, {
    sequence: 1,
    field: "input",
    reused: 2,
    reusedSha256: recordingHash(sent[0].request.input),
    same: ["model", "stream", "tools"]
  });
  assert.deepEqual(stored[1].payload.request, { input: turn(2) });
  assert.equal("systemPrompt" in stored[1].payload, false);
  assert.equal("tools" in stored[1].payload, false);
  // The summary extends Main's history; its own prompt and tools are new.
  assert.equal(stored[2].payload.requestBase.sequence, 2);
  assert.equal(stored[2].payload.systemPrompt, "Summarize");
  // Main's next request extends Main's last one, not the summary.
  assert.equal(stored[3].payload.requestBase.sequence, 2);
  assert.equal(stored[3].payload.request.instructions, "changed");
  assert.equal(stored[4].payload.requestBase, undefined);
  assert.ok(text.length < 4 * long.length + 10_000, `archive stays linear: ${text.length} bytes`);

  const rows = parseModelRequestArchive(text);
  assert.deepEqual(
    rows.filter((row) => row.type === "model_request").map((row) => row.payload),
    sent
  );
  assert.equal(rows.at(-1).type, "model_response");
});

test("a broken chain is refused instead of rebuilt wrongly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-request-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "requests.jsonl");
  const recorder = new ModelRequestRecorder(path, identity);
  await recorder.record("model_request", "a", payload([{ role: "user", content: "one" }]));
  await recorder.record(
    "model_request",
    "b",
    payload([
      { role: "user", content: "one" },
      { role: "user", content: "two" }
    ])
  );
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.throws(() => parseModelRequestArchive(lines[1]), /missing request/);
  const tampered = JSON.parse(lines[0]);
  tampered.payload.request.input[0].content = "edited";
  await writeFile(path, `${JSON.stringify(tampered)}\n${lines[1]}\n`);
  const edited = await readFile(path, "utf8");
  assert.throws(() => parseModelRequestArchive(edited), /does not match/);
});
