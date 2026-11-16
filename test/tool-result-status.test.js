import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLiveActivity } from "../web/assets/activity.js";
import { toolExecutionFailed } from "../web/assets/tool-result.js";

test("rejected tools show failure in current execution events", () => {
  const end = {
    type: "tool_execution_end",
    toolCallId: "edit",
    toolName: "cad_edit_parts",
    isError: true,
    result: { content: [] }
  };
  assert.equal(toolExecutionFailed(end), true);
  const [turn] = buildLiveActivity([
    { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "edit", toolName: "cad_edit_parts" },
    end
  ]);
  assert.equal(turn.calls[0].statusLabel, "调用失败");
  assert.equal(turn.calls[0].failed, true);
  assert.equal(toolExecutionFailed({ isError: false, result: { content: [] } }), false);
});
