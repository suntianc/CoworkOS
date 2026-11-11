import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentName } from "../web/assets/agent-names.js";
import { readAgentTrajectory } from "../dist/src/runtime/agent-trajectory.js";
import { agentDisplayName, reserveSubagentIdentity } from "../dist/src/runtime/agent-identity.js";
import { renderRunOverview } from "../web/assets/run-overview.js";

test("agent names remain unique through concurrent delegation, follow-ups and reordered cards", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-agent-names-"));
  try {
    const first = await reserveSubagentIdentity(root);
    const next = await Promise.all(Array.from({ length: 3 }, () => reserveSubagentIdentity(root)));
    const continued = await reserveSubagentIdentity(root);
    const agents = [first, ...next, continued];
    assert.equal(first.name, "Ara");
    assert.equal(new Set(agents.map((agent) => agent.agentId)).size, 5);
    assert.equal(new Set(agents.map((agent) => agent.name)).size, 5);
    const names = Array.from({ length: 200 }, (_, i) => agentDisplayName(`subagent_${i + 1}`));
    assert.equal(new Set(names).size, 200);
    assert.ok(names.every((name) => !/智能体|\d/.test(name)));
    assert.ok(agentDisplayName(`subagent_${"9".repeat(400)}`));
    assert.deepEqual(
      agents.toReversed().map(agentName),
      agents.toReversed().map((agent) => agent.name)
    );
    assert.equal(agentName({ agentId: "main" }), "Formicand");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("older team and usage snapshots resolve to the same constellation names as new delegations", () => {
  const legacy = [
    { agentId: "subagent_1", callId: "first", name: "青禾", status: "succeeded" },
    { agentId: "subagent_2", callId: "second", name: "知微", status: "running" },
    { agentId: "subagent_3", callId: "third", name: "明川", status: "waiting" },
    { agentId: "subagent_4", callId: "fourth", name: "星野", status: "running" }
  ];
  assert.deepEqual(legacy.map(agentName), ["Ara", "Norma", "Circinus", "Apus"]);
  assert.deepEqual(
    legacy.map(agentName),
    legacy.map((member) => agentDisplayName(member.agentId))
  );
  assert.equal(legacy[0].name, "青禾", "renaming the presentation must not rewrite historical records");
  assert.equal(agentName({ agentId: "my-monitor", name: "Paper Watcher" }), "Paper Watcher");
  const usage = { totalTokens: null, responses: 0, coverage: "unavailable" };
  const html = renderRunOverview({
    elapsedMs: 0,
    active: false,
    usage,
    agents: legacy.map((agent) => ({ ...agent, usage }))
  });
  for (const name of ["Ara", "Norma", "Circinus", "Apus"]) assert.ok(html.includes(name));
  assert.doesNotMatch(html, /青禾|知微|明川|星野/);
});

test("agent trajectories fold real tool results, isolate agents, and resume partial appended lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-trajectory-"));
  const path = join(root, "agent-a.jsonl");
  const wrap = (payload) =>
    JSON.stringify({ type: "trace.runtime", occurredAt: "2026-09-06T10:00:00Z", payload });
  try {
    await writeFile(
      path,
      wrap({
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "README.md" }
      }) +
        "\n" +
        wrap({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }) +
        "\n"
    );
    const first = await readAgentTrajectory(path);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].status, "running");
    const end = wrap({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "File contents" }] }
    });
    await appendFile(path, end.slice(0, 30));
    assert.equal((await readAgentTrajectory(path)).entries[0].status, "running");
    const emptyAssistant = wrap({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect the file." },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
          { type: "text", text: "  \n" }
        ]
      }
    });
    await appendFile(
      path,
      end.slice(30) +
        "\n" +
        emptyAssistant +
        "\n" +
        wrap({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "  Read complete.  " }] }
        }) +
        "\n"
    );
    const final = await readAgentTrajectory(path);
    assert.equal(final.entries.length, 2);
    assert.equal(final.entries[0].result, "File contents");
    assert.equal(final.entries[0].status, "completed");
    assert.equal(final.entries[1].text, "Read complete.");
    assert.equal(first.entries[0].status, "running");
    assert.deepEqual(await readAgentTrajectory(path), final);
    const other = join(root, "agent-b.jsonl");
    await writeFile(
      other,
      wrap({
        type: "tool_execution_end",
        toolCallId: "read-1",
        toolName: "read",
        isError: true,
        result: "denied"
      }) + "\n"
    );
    assert.equal((await readAgentTrajectory(other)).entries[0].status, "failed");
    assert.deepEqual(await readAgentTrajectory(path), final);
    assert.deepEqual(await readAgentTrajectory(join(root, "missing")), { entries: [], total: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
