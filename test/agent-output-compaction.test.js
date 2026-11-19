import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactAgentOutputLine } from "../dist/src/runtime/agent-output-compaction.js";
import { readAgentTrajectory } from "../dist/src/runtime/agent-trajectory.js";

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  stopReason: "stop",
  timestamp: 1_800_000_000_000,
  usage: { input: 10, output: 2 }
};
const events = [
  { type: "session", id: "s1" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { ...assistant, content: [] } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "do" } },
  { type: "message_update", assistantMessageEvent: { type: "text_end", content: "done" } },
  { type: "message_end", message: assistant },
  { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
  { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: "a".repeat(5000) } },
  {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "a b" }] },
    isError: false
  },
  { type: "turn_end", message: assistant, toolResults: [{ role: "toolResult", content: "a b" }] },
  { type: "agent_end", messages: [assistant, assistant] }
];

test("a delegated agent's log keeps settled events and the timing of the boundaries", () => {
  const kept = events
    .map((event) => compactAgentOutputLine(JSON.stringify(event)))
    .filter((line) => line !== undefined)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    kept.map((event) => event.type),
    [
      "session",
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "agent_end"
    ]
  );
  assert.deepEqual(kept[3].message, { role: "assistant", timestamp: assistant.timestamp, stopReason: "stop" });
  assert.deepEqual(kept[4].message, assistant);
  assert.deepEqual(kept[7], {
    type: "turn_end",
    message: { role: "assistant", timestamp: assistant.timestamp, stopReason: "stop" }
  });
  assert.deepEqual(kept[8], { type: "agent_end" });
  // Pi's own diagnostics and a cut line are not events and stay as they are.
  assert.equal(compactAgentOutputLine("Extension loaded"), "Extension loaded");
  assert.equal(compactAgentOutputLine('{"type":"message_upd'), '{"type":"message_upd');
});

test("the launcher writes the child's events to its log through the compaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-agent-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = join(root, "child.mjs");
  // Lines split across writes, and a last line the child never finished.
  const text = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(
    child,
    `const text=${JSON.stringify(text)};const half=Math.floor(text.length/2);` +
      `process.stdout.write(text.slice(0,half));setTimeout(()=>process.stdout.write(text.slice(half)+"\\n{\\"type\\":\\"mess"),20);`
  );
  const driver = join(root, "driver.mjs");
  await writeFile(
    driver,
    `import { runCliProcess } from ${JSON.stringify(new URL("../scripts/cli-runtime-host.mjs", import.meta.url).href)};` +
      `import { compactAgentOutputLine } from ${JSON.stringify(new URL("../dist/src/runtime/agent-output-compaction.js", import.meta.url).href)};` +
      `process.exitCode = await runCliProcess({ executable: ${JSON.stringify(child)}, args: [], env: {}, projectDirectory: ${JSON.stringify(root)}, compactStdoutLine: compactAgentOutputLine });`
  );
  const logPath = join(root, "agent-output.log");
  const log = await open(logPath, "a");
  const process_ = spawn(process.execPath, [driver], { stdio: ["ignore", log.fd, "inherit"] });
  await log.close();
  const [code] = await once(process_, "close");
  assert.equal(code, 0);
  const written = await readFile(logPath, "utf8");
  assert.doesNotMatch(written, /message_update|tool_execution_update/);
  assert.ok(written.endsWith('{"type":"mess'));
  const trajectory = await readAgentTrajectory(logPath);
  assert.deepEqual(
    trajectory.entries.map((entry) => [entry.kind, entry.status]),
    [
      ["state", "completed"],
      ["message", "completed"],
      ["tool", "completed"],
      ["state", "completed"]
    ]
  );
});
