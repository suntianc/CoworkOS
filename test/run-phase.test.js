import assert from "node:assert/strict";
import { test } from "node:test";
import { runPhase } from "../web/assets/run-phase.js";

const task = (status = "running", extra = {}) => ({ taskId: "t", status, ...extra });
const detail = (active, runtimeEvents = [], extra = {}) => ({
  task: { taskId: "t" },
  runtime: { active },
  runtimeEvents,
  ...extra
});
const agent = (state) => ({ role: "subagent", state });
const kind = (input) => runPhase(input)?.kind;

test("the composer names one coarse state per round", () => {
  assert.equal(kind({ task: task(), detail: detail(true) }), "working");
  assert.equal(kind({ task: task("completed"), detail: detail(false) }), undefined);
  assert.equal(kind({ task: task("paused"), detail: detail(false) }), "paused");
  assert.equal(kind({ task: task("running", { pause: {} }), detail: detail(true) }), "pausing");
  assert.equal(
    kind({ task: task(), detail: detail(true, [{ type: "auto_retry_start", attempt: 1 }]) }),
    "retrying"
  );
  assert.equal(
    kind({ task: task("waiting"), detail: detail(false, [], { humanRequests: [{ status: "pending" }] }) }),
    "asking"
  );
});

test("Main waiting on its Subagents is waiting, not working", () => {
  const waitTool = [{ type: "tool_execution_start", toolCallId: "w", toolName: "wait_for_subagents" }];
  const agents = [agent("running"), agent("queued"), agent("completed")];
  assert.deepEqual(runPhase({ task: task(), detail: detail(true, waitTool), agents }), {
    kind: "waiting",
    agents: 2
  });
  // Parked after dispatching async work: no turn, Subagents still working.
  assert.equal(kind({ task: task("waiting"), detail: detail(false), agents }), "waiting");
  // Main doing its own step while Subagents work is Main working.
  const ownStep = [
    ...waitTool,
    { type: "tool_execution_end", toolCallId: "w" },
    { type: "tool_execution_start", toolCallId: "r", toolName: "read" }
  ];
  assert.equal(kind({ task: task(), detail: detail(true, ownStep), agents }), "working");
  // Finished Subagents are nothing to wait for.
  assert.equal(
    kind({ task: task("waiting"), detail: detail(false), agents: [agent("completed")] }),
    undefined
  );
});

test("Main sitting in a wait reads as waiting before the sampled Subagent count arrives", () => {
  const waitTool = [{ type: "tool_execution_start", toolCallId: "w", toolName: "wait_for_subagents" }];
  // The catalog sample has no Subagents yet, and the conversation's progress has none either.
  assert.deepEqual(runPhase({ task: task(), detail: detail(true, waitTool), agents: [] }), {
    kind: "waiting",
    agents: 0
  });
  // The conversation's own progress counts the Subagents the sample has not seen.
  const progressed = detail(true, waitTool, {
    progress: { agents: [{ status: "running" }, { status: "queued" }, { status: "succeeded" }] }
  });
  assert.deepEqual(runPhase({ task: task(), detail: progressed, agents: [] }), { kind: "waiting", agents: 2 });
});
