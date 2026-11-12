import assert from "node:assert/strict";
import { test } from "node:test";
// Pi 1.5 compacts Main and Subagent summaries with the coding agent's serializer.
import { serializeConversation } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js";
import {
  COMPACTION_TOOL_RESULT_MAX_CHARS,
  projectCompactionMessages
} from "../dist/src/runtime/compaction-input.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const assistant = (calls) => ({
  role: "assistant",
  content: calls,
  api: "openai-completions",
  provider: "isolated-fixture",
  model: "compaction-input-fixture",
  usage,
  stopReason: "toolUse",
  timestamp: 1
});
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, text, details = {}, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  details,
  isError,
  timestamp: 2
});
const text = (message) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

test("the real SDK serializer retains tool heads, tails and error receipts within the native limit", () => {
  const messages = [
    assistant([call("verify-1", "bash", { command: "pytest -q", cwd: "/fixture/project" })]),
    result(
      "verify-1",
      "bash",
      "OUTPUT_HEAD_ANCHOR\n" +
        "obsolete-middle-data ".repeat(500) +
        "\n4 failed, 1413 passed\nCommand exited with code 1",
      { exitCode: 1, timedOut: false },
      true
    )
  ];
  const original = structuredClone(messages);
  const projected = projectCompactionMessages(messages);
  assert.ok(text(projected[1]).length <= COMPACTION_TOOL_RESULT_MAX_CHARS);
  const serialized = serializeConversation(projected);
  for (const marker of [
    "OUTPUT_HEAD_ANCHOR",
    "4 failed, 1413 passed",
    "Command exited with code 1",
    "verify-1",
    "isError=true",
    "exitCode=1",
    "/fixture/project"
  ])
    assert.ok(serialized.includes(marker), `summary input must retain ${marker}`);
  assert.doesNotMatch(serialized, /more characters truncated/);
  assert.deepEqual(messages, original);
  assert.equal(projected[0], messages[0], "non-tool source messages need no rewrite");
  assert.equal(projected[1].details, messages[1].details, "structured receipt metadata remains intact");
});

test("short and multipart outputs keep their contents and native images", () => {
  const image = { type: "image", mimeType: "image/png", data: "isolated-image-data" };
  const receipt = result("read-1", "read", "FIRST_TEXT");
  receipt.content.push(image, { type: "text", text: "SECOND_TEXT" });
  const projected = projectCompactionMessages([receipt])[0];
  assert.match(text(projected), /FIRST_TEXT\nSECOND_TEXT/);
  assert.equal(
    projected.content.find((part) => part.type === "image"),
    image
  );
  assert.equal(projected.isError, false);
  assert.doesNotMatch(text(projected), /exitCode=0|tests? passed|verified|succeeded/i);
  assert.match(text(projected), /matching earlier call unavailable/);
});

test("duplicate IDs pair results to earlier calls of the same name and do not use future calls", () => {
  const messages = [
    result("reused", "run_command", "ORPHAN_RESULT"),
    assistant([
      call("reused", "read_file", { command: "WRONG_TOOL_COMMAND" }),
      call("reused", "run_command", { command: "FIRST_COMMAND" }),
      call("reused", "run_command", { command: "SECOND_COMMAND" })
    ]),
    result("reused", "run_command", "FIRST_RESULT"),
    result("reused", "run_command", "SECOND_RESULT"),
    result("reused", "run_command", "NO_EARLIER_MATCH"),
    assistant([call("reused", "run_command", { command: "FUTURE_COMMAND" })])
  ];
  const projected = projectCompactionMessages(messages);
  assert.match(text(projected[0]), /matching earlier call unavailable/);
  assert.doesNotMatch(text(projected[0]), /FIRST_COMMAND|FUTURE_COMMAND/);
  assert.match(text(projected[2]), /FIRST_COMMAND/);
  assert.doesNotMatch(text(projected[2]), /SECOND_COMMAND|WRONG_TOOL_COMMAND/);
  assert.match(text(projected[3]), /SECOND_COMMAND/);
  assert.doesNotMatch(text(projected[3]), /FIRST_COMMAND|FUTURE_COMMAND/);
  assert.match(text(projected[4]), /matching earlier call unavailable/);
  assert.doesNotMatch(text(projected[4]), /FUTURE_COMMAND/);
});

test("projection bounds huge locators and Unicode without changing receipt bodies or status", () => {
  const messages = [
    assistant([call("id".repeat(2000), "bash", { command: "🚀\n".repeat(2000), cwd: "📂".repeat(2000) })]),
    result("id".repeat(2000), "bash", "🚀".repeat(3000) + "TAIL_UNICODE_ANCHOR", {
      exitCode: 0,
      signal: "x".repeat(2000)
    })
  ];
  const original = structuredClone(messages);
  const projected = projectCompactionMessages(messages)[1];
  assert.ok(text(projected).length <= COMPACTION_TOOL_RESULT_MAX_CHARS);
  assert.equal(text(projected).isWellFormed(), true);
  assert.match(text(projected), /TAIL_UNICODE_ANCHOR/);
  assert.match(text(projected), /isError=false/);
  assert.match(text(projected), /exitCode=0/);
  assert.doesNotMatch(text(projected), /tests? passed|verified|succeeded/i);
  assert.deepEqual(messages, original);
});

test("tool-error status and a failed compound-command head survive a later successful tail", () => {
  const receipt = result(
    "compound",
    "run_command",
    "AssertionError: replacement not written\n" + "noise ".repeat(1000) + "\nok example/parser (cached)",
    { exitCode: 0 },
    false
  );
  const projected = projectCompactionMessages([receipt])[0];
  assert.match(text(projected), /AssertionError: replacement not written/);
  assert.match(text(projected), /ok example\/parser \(cached\)/);
  assert.match(text(projected), /isError=false/);
  assert.doesNotMatch(text(projected), /tests? passed|verified|succeeded/i);
});

test("recorded command arguments and resolved cwd survive long structured tool output", () => {
  const messages = [
    assistant([
      call("argv-call", "run_command", {
        command: "python",
        args: ["-m", "pytest", "tests/parser.py"],
        cwd: "relative-project"
      })
    ]),
    result(
      "argv-call",
      "run_command",
      "noise ".repeat(2000) + "\n1 failed",
      {
        command: "python",
        args: ["-m", "pytest", "tests/parser.py"],
        cwd: "/fixture/resolved-project",
        exitCode: 1
      },
      true
    )
  ];
  const projected = projectCompactionMessages(messages)[1];
  assert.match(text(projected), /python/);
  assert.match(text(projected), /tests\/parser\.py/);
  assert.match(text(projected), /\/fixture\/resolved-project/);
  assert.match(text(projected), /1 failed/);
  assert.ok(text(projected).length <= COMPACTION_TOOL_RESULT_MAX_CHARS);
});

test("the SDK serializer retains unmatched call identities without claiming current execution", () => {
  const messages = [
    assistant([call("pending-call-anchor", "run_command", { command: "pytest -q" })]),
    assistant([call("completed-call-anchor", "read_file", { path: "parser.js" })]),
    result("completed-call-anchor", "read_file", "READ_COMPLETE")
  ];
  const original = structuredClone(messages);
  const projected = projectCompactionMessages(messages);
  const serialized = serializeConversation(projected);
  assert.match(serialized, /pending-call-anchor/);
  assert.match(serialized, /name="run_command"/);
  assert.match(serialized, /message=1/);
  assert.match(serialized, /content block=1/);
  assert.match(serialized, /only within this summary interval/);
  assert.match(serialized, /Later retained messages or current harness state may settle/);
  assert.match(serialized, /does not establish that they are currently running/);
  assert.equal((serialized.match(/Tool call without result:/g) ?? []).length, 1);
  assert.equal(projected[1], messages[1], "matched calls need no pending-call annotation");
  assert.equal(projected[0].content[0], messages[0].content[0], "call arguments remain untouched");
  assert.deepEqual(messages, original);
});

test("unmatched duplicate calls preserve occurrence positions and orphan results cannot settle future calls", () => {
  const messages = [
    result("reused-pending-id", "run_command", "EARLY_ORPHAN_RESULT"),
    assistant([
      call("reused-pending-id", "read_file", { path: "parser.js" }),
      call("reused-pending-id", "run_command", { command: "FIRST_MATCH" }),
      call("reused-pending-id", "run_command", { command: "SECOND_WITHOUT_RESULT" })
    ]),
    result("reused-pending-id", "run_command", "SETTLES_FIRST_MATCH_ONLY"),
    assistant([call("future-only-id", "run_command", { command: "LATER_CALL" })])
  ];
  const original = structuredClone(messages);
  const projected = projectCompactionMessages(messages);
  const pending = text(projected[1]);
  assert.match(pending, /name="read_file"; message=2; content block=1/);
  assert.match(pending, /name="run_command"; message=2; content block=3/);
  assert.doesNotMatch(pending, /content block=2/);
  assert.match(text(projected[0]), /matching earlier call unavailable/);
  assert.match(text(projected[2]), /FIRST_MATCH/);
  const serialized = serializeConversation(projected);
  assert.match(serialized, /future-only-id/);
  assert.equal((serialized.match(/Tool call without result:/g) ?? []).length, 3);
  assert.deepEqual(messages, original);
});

test("unmatched call annotations have a per-message Unicode-safe budget", () => {
  const messages = [
    assistant(
      Array.from({ length: 100 }, (_, index) =>
        call(`pending-${index}-` + "🚀".repeat(1000), "tool" + "📂".repeat(1000), { index })
      )
    )
  ];
  const original = structuredClone(messages);
  const projected = projectCompactionMessages(messages);
  const pending = text(projected[0]);
  assert.ok(pending.length > 0, "calls without results need serialized identity evidence");
  assert.ok(pending.length <= 2000, "annotation budget applies to the whole assistant message");
  assert.equal(pending.isWellFormed(), true);
  assert.match(pending, /additional unmatched tool calls omitted/i);
  assert.equal(projected[0].content.length, messages[0].content.length + 1);
  assert.deepEqual(messages, original);
});
