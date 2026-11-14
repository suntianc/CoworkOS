import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atriaRoleIdentity, projectAtriaSystemMessage } from "../dist/src/domain/agent-identity.js";
import { createSessionExport, sessionExportHtml } from "../dist/src/storage/session-export.js";

const { buildSystemPromptSections, buildSystemPromptState } = await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);
function snapshot() {
  return {
    role: "system",
    content: "",
    timestamp: 123,
    sections: buildSystemPromptSections({ cwd: "/fixture", contextFiles: [], skills: [] })
  };
}

test("known SDK defaults project idempotently and preserve dynamic instructions", () => {
  const input = snapshot();
  input.sections.rules += "\nKeep this extra rule.";
  input.sections.tools = "User supplied tool instructions";
  const original = structuredClone(input);
  const output = projectAtriaSystemMessage(input);
  assert.equal(output.sections.preamble, atriaRoleIdentity("Main"));
  assert.equal(output.sections.docs, null);
  assert.equal(output.sections.rules, input.sections.rules);
  assert.equal(output.sections.tools, input.sections.tools);
  assert.equal(projectAtriaSystemMessage(output), output);
  assert.deepEqual(input, original);
  const paths = snapshot();
  paths.sections.docs = paths.sections.docs
    .replace(/- Main documentation: [^\n]+/, "- Main documentation: C:\\fixture\\README.md")
    .replace(/- Additional docs: [^\n]+/, "- Additional docs: /fixture with spaces/docs")
    .replace(/- Examples: [^\n]+/, "- Examples: /fixture/examples (extensions, custom tools, SDK)");
  assert.equal(projectAtriaSystemMessage(paths).sections.docs, null);
});

test("custom and unknown docs, empty identities and opaque forced prompts remain intact", () => {
  const mixed = snapshot();
  mixed.content = "User-added Pi instructions";
  assert.equal(projectAtriaSystemMessage(mixed), mixed);
  for (const forceSystemPrompt of ["User forced Pi identity", ""]) {
    const forced = {
      role: "system",
      ...buildSystemPromptState({ forceSystemPrompt, cwd: "/fixture", skills: [], contextFiles: [] }),
      timestamp: 1
    };
    assert.equal(projectAtriaSystemMessage(forced), forced);
  }
  const customized = snapshot();
  customized.sections.docs = customized.sections.docs.replace(
    "- Additional docs:",
    "User policy: preserve this instruction.\n- Additional docs:"
  );
  const projected = projectAtriaSystemMessage(customized);
  assert.equal(projected.sections.preamble, atriaRoleIdentity("Main"));
  assert.equal(projected.sections.docs, customized.sections.docs);
  for (const preamble of ["", undefined, null, "User selected a Pi identity"]) {
    const input = snapshot();
    input.sections.preamble = preamble;
    assert.equal(projectAtriaSystemMessage(input), input);
  }
  const unknown = snapshot();
  unknown.sections.docs = "<docs>\nAn unknown historical SDK template\n</docs>";
  assert.equal(projectAtriaSystemMessage(unknown).sections.docs, unknown.sections.docs);
  for (const input of [
    null,
    "pi",
    [],
    { role: "system", content: "User explicitly chose Pi" },
    { role: "system", sections: [] },
    { role: "system", sections: { docs: snapshot().sections.docs } }
  ])
    assert.equal(projectAtriaSystemMessage(input), input);
});

test("current and historical compactions project only exported copies of their system snapshot", async () => {
  const entries = [
    {
      type: "message",
      id: "start",
      parentId: null,
      message: { role: "user", content: "Pi is my requested topic" }
    },
    {
      type: "compaction",
      id: "old",
      parentId: "start",
      systemMessage: snapshot(),
      summary: "old summary",
      tokensBefore: 100,
      customField: { engine: "pi" }
    },
    {
      type: "compaction",
      id: "current",
      parentId: "start",
      systemMessage: snapshot(),
      summary: "current summary",
      tokensBefore: 200
    },
    {
      type: "compaction",
      id: "custom",
      parentId: "current",
      systemMessage: { role: "system", content: "Keep user-selected Pi identity" },
      summary: "custom summary"
    }
  ];
  const before = structuredClone(entries);
  const data = await createSessionExport({
    sessionId: "fixture",
    projectDirectory: "/fixture",
    entries,
    branchEntryIds: ["start", "current", "custom"]
  });
  for (const event of data.events.slice(0, 2)) {
    assert.equal(event.data.systemMessage.sections.preamble, atriaRoleIdentity("Main"));
    assert.equal(event.data.systemMessage.sections.docs, null);
  }
  assert.equal(data.events[0].inCurrentBranch, false);
  assert.equal(data.events[1].inCurrentBranch, true);
  assert.equal(data.events[0].data.customField.engine, "pi");
  assert.equal(data.events[2].data.systemMessage.content, "Keep user-selected Pi identity");
  assert.equal(data.messages[0].content, "Pi is my requested topic");
  assert.deepEqual(entries, before);
  assert.match(sessionExportHtml(data), /Keep user-selected Pi identity/);
});

test("public JSON and HTML exports project real SDK compaction snapshots while preserving raw history bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-sdk-compaction-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  const manager = SessionManager.create(project, join(root, "sessions"));
  manager.appendMessage(snapshot());
  const userId = manager.appendMessage({ role: "user", content: "Pi user content", timestamp: 123 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Pi assistant content" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: 124,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  });
  const historical = manager.appendCompaction("historical summary", userId, 100);
  manager.branch(userId);
  const current = manager.appendCompaction("current summary", userId, 200);
  manager.appendMessage({ role: "system", content: "User-added Pi instructions", timestamp: 125 });
  const custom = manager.appendCompaction("custom summary", userId, 300);
  const source = manager.getSessionFile(),
    before = await readFile(source);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COWORK_|PI_|ATRIA_)/.test(k))),
    HOME: root,
    ATRIA_HOME: join(root, "home"),
    COWORK_HARNESS_ROOT: resolve(".")
  };
  for (const format of ["json", "html"])
    await promisify(execFile)(
      process.execPath,
      [
        resolve(process.env.TEST_ATRIA_CLI_ENTRY || "scripts/atria.mjs"),
        "session",
        "export",
        source,
        "--format",
        format,
        "--output",
        join(root, `export.${format}`)
      ],
      { cwd: project, env, timeout: 10000 }
    );
  assert.deepEqual(await readFile(source), before);
  const data = JSON.parse(await readFile(join(root, "export.json"), "utf8"));
  for (const entryId of [historical, current]) {
    const event = data.events.find((e) => e.eventId === entryId || e.id === entryId);
    assert.ok(event, JSON.stringify(data.events.map((e) => Object.keys(e))));
    assert.equal(event.data.systemMessage.sections.preamble, atriaRoleIdentity("Main"));
    assert.equal(event.data.systemMessage.sections.docs, null);
    assert.equal(event.inCurrentBranch, entryId === current);
  }
  const customEvent = data.events.find((e) => e.eventId === custom || e.id === custom);
  assert.deepEqual(customEvent.data.systemMessage, manager.getEntry(custom).systemMessage);
  assert.equal(customEvent.data.systemMessage.content, "User-added Pi instructions");
  const html = await readFile(join(root, "export.html"), "utf8");
  assert.match(html, /User-added Pi instructions/);
  if (process.env.TEST_ATRIA_IDENTITY_EVIDENCE_DIR) {
    await mkdir(process.env.TEST_ATRIA_IDENTITY_EVIDENCE_DIR, { recursive: true });
    for (const [name, content] of [
      ["raw-sdk-history.jsonl", before],
      ["public-compaction-export.json", JSON.stringify(data, null, 2)],
      ["public-compaction-export.html", html]
    ])
      await writeFile(join(process.env.TEST_ATRIA_IDENTITY_EVIDENCE_DIR, name), content);
  }
});
