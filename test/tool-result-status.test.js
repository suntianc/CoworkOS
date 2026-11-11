import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLiveActivity } from "../web/assets/activity.js";
import { toolExecutionFailed } from "../web/assets/tool-result.js";
import { readAgentTrajectory } from "../dist/src/runtime/agent-trajectory.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("rejected tools show failure in current events and older structured-result logs", () => {
  for (const failure of [
    { isError: true, result: { content: [] } },
    { isError: false, result: { isError: true, content: [] } },
    { isError: false, result: { details: { ok: false, code: "operation_precondition_failed" } } }
  ]) {
    const end = { type: "tool_execution_end", toolCallId: "edit", toolName: "cad_edit_parts", ...failure };
    assert.equal(toolExecutionFailed(end), true);
    const [turn] = buildLiveActivity([
      { type: "turn_start" },
      { type: "tool_execution_start", toolCallId: "edit", toolName: "cad_edit_parts" },
      end
    ]);
    assert.equal(turn.calls[0].statusLabel, "调用失败");
    assert.equal(turn.calls[0].failed, true);
  }
  assert.equal(toolExecutionFailed({ isError: false, result: { details: { ok: true } } }), false);
});

test("agent trajectories report failed edits from older Pi structured-result logs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-tool-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "trace.jsonl");
  await writeFile(
    file,
    JSON.stringify({
      type: "runtime_event",
      payload: {
        type: "tool_execution_end",
        toolCallId: "edit",
        toolName: "cad_edit_parts",
        isError: false,
        result: {
          details: { ok: false, code: "operation_precondition_failed" },
          content: [{ type: "text", text: "read first" }]
        }
      }
    }) + "\n"
  );
  const trace = await readAgentTrajectory(file);
  assert.equal(trace.entries.length, 1);
  assert.equal(trace.entries[0].status, "failed");
  assert.equal(trace.entries[0].result, "read first");
});
