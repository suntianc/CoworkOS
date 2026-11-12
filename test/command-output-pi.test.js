import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { createLoadSkillTool } from "../dist/src/runtime/skill-registry.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const receipt = (patch = {}) => ({
  command: "node",
  args: ["verify.cjs"],
  cwd: "fixture-project",
  exitCode: 7,
  stdout: `STDOUT_HEAD\n${"stdout-diagnostic ".repeat(470)}\nSTDOUT_TAIL: 4 failed, 1413 passed`,
  stderr: `STDERR_HEAD\n${"stderr-diagnostic ".repeat(470)}\nSTDERR_TAIL: assertion failed`,
  stdoutPath: "logs/command-fixture/stdout.log",
  stderrPath: "logs/command-fixture/stderr.log",
  stdoutBytes: 128000,
  stderrBytes: 96000,
  stdoutTruncated: true,
  stderrTruncated: true,
  failed: true,
  isError: true,
  ...patch
});
const contentText = (content) =>
  typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
const toolFeedback = (result) => result.messages.find((message) => message.role === "toolResult");

async function exercise(t, { name = "run_command", value, tools, agentTools, ...options }) {
  const model = await modelProtocolFixture("openai-completions", (_body, requests) =>
    requests.length === 1
      ? { name, arguments: options.input ?? {} }
      : { text: "Checked the execution receipt." }
  );
  t.after(() => model.close());
  const result = await new PiSession({
    api: "openai-completions",
    baseUrl: model.baseUrl,
    apiKey: "isolated-command-output-fixture",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    maxErrorRetries: 0,
    tools:
      tools ??
      new Map([[name, { parameters: { type: "object", properties: {} }, execute: async () => value }]]),
    agentTools,
    ...options
  }).run("Inspect the command receipt and report the unresolved failure.");
  assert.equal(result.termination, "completed");
  assert.equal(model.requests.length, 2, "one tool call needs one continuation, without a recovery request");
  const wire = model.requests[1].body.messages.find((message) => message.role === "tool");
  assert.ok(wire, "the actual provider request contains the tool feedback");
  return { result, feedback: toolFeedback(result), text: contentText(wire.content), model };
}

for (const name of ["run_command", "run_tests"])
  test(`real Pi ${name}: default feedback budget preserves status, output ends and full-log references`, async (t) => {
    const original = receipt();
    const { feedback, text } = await exercise(t, { name, value: original });
    assert.ok(text.length <= 16000, `default model feedback was ${text.length} characters`);
    assert.match(text, /Exit code: 7/);
    assert.match(text, /failed/);
    for (const anchor of [
      "node",
      "verify.cjs",
      original.cwd,
      original.stdoutPath,
      original.stderrPath,
      "128000",
      "96000",
      "STDOUT_HEAD",
      "STDOUT_TAIL: 4 failed, 1413 passed",
      "STDERR_HEAD",
      "STDERR_TAIL: assertion failed"
    ])
      assert.ok(text.includes(anchor), `model feedback retains ${anchor}`);
    assert.match(text, /truncated/);
    assert.equal(feedback.isError, true);
    assert.deepEqual(feedback.details, original, "presentation must not rewrite diagnostic details");
    assert.equal(contentText(feedback.content), text);
  });

test("real Pi command: an explicit small feedback budget preserves interruption and log metadata before previews", async (t) => {
  const original = receipt({ exitCode: null, timedOut: true, cancelled: true, logLimitExceeded: true });
  const { feedback, text } = await exercise(t, { value: original, maxToolResponseChars: 1024 });
  assert.ok(text.length <= 1024);
  assert.match(text, /Exit code: null/);
  assert.match(text, /timed out/i);
  assert.match(text, /cancelled/i);
  assert.match(text, /log limit exceeded/i);
  for (const anchor of [
    original.stdoutPath,
    original.stderrPath,
    original.cwd,
    "STDOUT_HEAD",
    "STDOUT_TAIL",
    "STDERR_HEAD",
    "STDERR_TAIL"
  ])
    assert.ok(text.includes(anchor), `a small budget retains ${anchor}`);
  assert.deepEqual(feedback.details, original);
  assert.equal(feedback.isError, true);
});

test("real Pi: tiny command feedback prioritizes the exit and interruption status", async (t) => {
  const { text } = await exercise(t, {
    value: receipt({ exitCode: null, timedOut: true, cancelled: true, logLimitExceeded: true }),
    maxToolResponseChars: 64
  });
  assert.ok(text.length <= 64);
  assert.match(text, /(?:Exit code: |exit=)null/);
  assert.match(text, /timed out/i);
  assert.match(text, /cancelled/i);
  assert.match(text, /log limit exceeded/i);
});

test("real Pi: harness errors and agent-relative log paths remain explicit in command feedback", async (t) => {
  const original = receipt({
    exitCode: 0,
    failed: false,
    isError: true,
    error: "COMMAND_LOG_WRITE_ERROR: ENOSPC while preserving the command output",
    logPathBase: "agent",
    stdoutPath: "logs/agent-stdout.log",
    stderrPath: "logs/agent-stderr.log"
  });
  const { feedback, text } = await exercise(t, { value: original, maxToolResponseChars: 1024 });
  assert.ok(text.length <= 1024);
  assert.match(text, /failed/);
  assert.doesNotMatch(text, /completed/);
  assert.ok(text.includes(original.error));
  assert.match(text, /log \(read_file\): "logs\/agent-stdout\.log"/);
  assert.doesNotMatch(text, /browse_workspace/);
  assert.deepEqual(feedback.details, original);
  assert.equal(feedback.isError, true);
});

test("real Pi: incomplete command logs distinguish observed output from bytes saved on disk", async (t) => {
  const original = receipt({ stdoutLogBytes: 64000, stderrLogBytes: 32000, logLimitExceeded: true });
  const { feedback, text } = await exercise(t, { value: original, maxToolResponseChars: 1024 });
  assert.ok(text.length <= 1024);
  assert.match(text, /stdout: 128000 bytes observed; 64000 bytes logged; log incomplete/);
  assert.match(text, /stderr: 96000 bytes observed; 32000 bytes logged; log incomplete/);
  assert.match(text, /log limit exceeded/);
  assert.deepEqual(feedback.details, original);
});

for (const native of [false, true])
  for (const explicit of [false, true])
    test(`real Pi ${native ? "native" : "runtime"} load_skill: ${explicit ? "explicit budget remains effective" : "default feedback preserves all skill instructions"}`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "atria-tool-output-skill-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const name = "fixture-complete-workflow";
      const source = `SKILL_HEAD\n${"instruction ".repeat(1200)}\nSKILL_MIDDLE_REQUIRED_RULE: preserve the user's original verification scope.\n${"instruction ".repeat(1200)}\nSKILL_TAIL`;
      const path = join(directory, "SKILL.md");
      await writeFile(path, source);
      const loader = createLoadSkillTool([
        { name, directory, path, description: "Read the complete fixture workflow." }
      ]);
      const agentTools = native
        ? [
            {
              name: "load_skill",
              label: "load_skill",
              description: loader.description,
              parameters: Type.Unsafe(loader.parameters),
              execute: async (_callId, input) => {
                const details = await loader.execute(input);
                return { content: [{ type: "text", text: JSON.stringify(details) }], details };
              }
            }
          ]
        : undefined;
      const { feedback, text } = await exercise(t, {
        name: "load_skill",
        input: { name },
        tools: native ? new Map() : new Map([["load_skill", loader]]),
        agentTools,
        ...(explicit ? { maxToolResponseChars: 1024 } : {})
      });
      assert.equal(
        feedback.details.content,
        source,
        "the complete loaded instructions remain in diagnostic details"
      );
      if (explicit) {
        assert.ok(text.length <= 1024);
        assert.doesNotMatch(text, /SKILL_MIDDLE_REQUIRED_RULE/);
        assert.match(text, /truncated/);
      } else {
        assert.ok(text.length > 16000);
        assert.equal(JSON.parse(text).content, source);
        assert.match(text, /SKILL_MIDDLE_REQUIRED_RULE/);
      }
    });

for (const name of ["inspect_receipt", "run_command"])
  test(`real Pi: ${name === "run_command" ? "a command without log metadata" : "a custom tool with command-like data"} keeps plain-data compatibility`, async (t) => {
    const original =
      name === "run_command"
        ? { command: "printf", stdout: "small output", exitCode: 0 }
        : receipt({ stdout: "small output", stderr: "", stdoutTruncated: false, stderrTruncated: false });
    const { feedback, text } = await exercise(t, { name, value: original });
    assert.deepEqual(JSON.parse(text), original);
    assert.deepEqual(feedback.details, original);
  });

test("real Pi: ordinary custom text uses the default cap and retains its head and tail", async (t) => {
  const original = `CUSTOM_HEAD\n${"普通诊断😀 ".repeat(6000)}\nCUSTOM_TAIL`;
  const { feedback, text } = await exercise(t, { name: "inspect", value: original });
  assert.ok(text.length <= 16000);
  assert.match(text, /CUSTOM_HEAD/);
  assert.match(text, /CUSTOM_TAIL/);
  assert.equal(text.isWellFormed(), true);
  assert.equal(feedback.details, original);
});

const image = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM3sAAAAASUVORK5CYII="
};
test("real Pi: default native-result feedback retains images, errors and original details", async (t) => {
  const original = {
    content: [{ type: "text", text: `IMAGE_HEAD ${"pixel-evidence ".repeat(3000)} IMAGE_TAIL` }, image],
    details: { evidence: "complete diagnostic record" },
    isError: true
  };
  const { feedback, text, model } = await exercise(t, {
    name: "inspect_image",
    value: original,
    supportsImages: true
  });
  assert.ok(text.length <= 16000);
  assert.match(text, /IMAGE_HEAD/);
  assert.match(text, /IMAGE_TAIL/);
  assert.deepEqual(feedback.details, original.details);
  assert.deepEqual(
    feedback.content.find((block) => block.type === "image"),
    image
  );
  assert.equal(feedback.isError, true);
  assert.ok(JSON.stringify(model.requests[1].body).includes(image.data));
});

test("real Pi: additional native AgentTools share the default feedback cap", async (t) => {
  const original = {
    content: [{ type: "text", text: `AGENT_HEAD ${"agent-diagnostic ".repeat(3000)} AGENT_TAIL` }],
    details: { original: "unmodified" },
    isError: true
  };
  const { feedback, text } = await exercise(t, {
    name: "native_inspect",
    tools: new Map(),
    agentTools: [
      {
        name: "native_inspect",
        label: "native_inspect",
        description: "Inspect the native fixture.",
        parameters: Type.Object({}),
        execute: async () => original
      }
    ]
  });
  assert.ok(text.length <= 16000);
  assert.match(text, /AGENT_HEAD/);
  assert.match(text, /AGENT_TAIL/);
  assert.deepEqual(feedback.details, original.details);
  assert.equal(feedback.isError, true);
});

for (const native of [false, true])
  test(`real Pi ${native ? "native" : "runtime"}: an execute exception obeys the default feedback cap`, async (t) => {
    const name = "inspect_failure";
    const message = `EXCEPTION_HEAD\n${"failed-diagnostic ".repeat(3000)}\nEXCEPTION_TAIL`;
    const execute = async () => {
      throw new Error(message);
    };
    const { feedback, text } = await exercise(t, {
      name,
      tools: native
        ? new Map()
        : new Map([[name, { parameters: { type: "object", properties: {} }, execute }]]),
      agentTools: native
        ? [
            {
              name,
              label: name,
              description: "Inspect the failed fixture.",
              parameters: Type.Object({}),
              execute
            }
          ]
        : undefined
    });
    assert.ok(text.length <= 16000);
    assert.match(text, /EXCEPTION_HEAD/);
    assert.match(text, /EXCEPTION_TAIL/);
    assert.match(text, /truncated/);
    assert.equal(feedback.isError, true);
    assert.deepEqual(feedback.details, {}, "the SDK error envelope's diagnostic details remain unchanged");
  });

test("real Pi builtin command: feedback links to readable complete stdout and stderr logs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-command-output-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stdout = `DISK_STDOUT_HEAD\n${"disk-output ".repeat(5000)}\nDISK_STDOUT_TAIL: 4 failed, 1413 passed\n`;
  const stderr = `DISK_STDERR_HEAD\n${"disk-error ".repeat(5000)}\nDISK_STDERR_TAIL: assertion failed\n`;
  await writeFile(
    join(root, "emit.cjs"),
    `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`
  );
  const tools = createBuiltinTools({ rootDirectory: root });
  const { feedback, text } = await exercise(t, {
    tools,
    input: { command: process.execPath, args: ["emit.cjs"] }
  });
  assert.ok(text.length <= 16000);
  assert.match(text, /Exit code: 7/);
  assert.match(text, /DISK_STDOUT_HEAD/);
  assert.match(text, /DISK_STDOUT_TAIL: 4 failed, 1413 passed/);
  assert.match(text, /DISK_STDERR_TAIL: assertion failed/);
  const details = feedback.details;
  assert.equal(details.stdoutBytes, Buffer.byteLength(stdout));
  assert.equal(details.stderrBytes, Buffer.byteLength(stderr));
  for (const [path, expected] of [
    [details.stdoutPath, stdout],
    [details.stderrPath, stderr]
  ]) {
    assert.equal(typeof path, "string");
    assert.ok(text.includes(path), "the model can locate the complete log");
    assert.equal(await readFile(join(root, path), "utf8"), expected);
    const readable = await tools.get("read_file").execute({ path });
    assert.equal(readable.content, expected, "the agent's existing read tool reaches the same complete log");
  }
  assert.equal(feedback.isError, true);
});
