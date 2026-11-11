import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { viewRuntimeEvent } from "../dist/src/runtime/conversation-history.js";
import { reconcileParts } from "../web/assets/ui/reconcile.js";

const runtime = (payload) => ({ eventId: "runtime-r-1", type: "runtime_event", runId: "r", payload });

test("the conversation view drops the system prompt and agent_end bodies, nothing else", () => {
  const prompt = "x".repeat(10_000);
  assert.deepEqual(
    viewRuntimeEvent(
      runtime({ type: "message_start", message: { role: "system", content: prompt, timestamp: 5 } })
    ),
    runtime({ type: "message_start", message: { role: "system", timestamp: 5 } })
  );
  assert.deepEqual(
    viewRuntimeEvent(runtime({ type: "agent_end", messages: [{ role: "system", content: prompt }] })),
    runtime({ type: "agent_end" })
  );
  for (const record of [
    runtime({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }),
    runtime({ type: "turn_end", message: { role: "assistant" } }),
    { type: "user.interjected", payload: { message: "hi" } }
  ])
    assert.equal(viewRuntimeEvent(record), record);
});

test("patching from a later part leaves the earlier children untouched", () => {
  const { document } = parseHTML("<!doctype html><html><body><div id=list></div></body></html>");
  const list = document.getElementById("list");
  const first = reconcileParts(list, ['<p data-view-key="a">a</p>', '<p data-view-key="b">b</p><p>tail</p>']);
  assert.deepEqual(first, [1, 2]);
  const kept = list.firstChild;
  kept.setAttribute("data-mark", "kept");
  const second = reconcileParts(list, ['<p data-view-key="b">b2</p>', "<p>new tail</p>"], list.childNodes[1]);
  assert.deepEqual(second, [1, 1]);
  assert.equal(list.firstChild, kept);
  assert.equal(kept.getAttribute("data-mark"), "kept");
  assert.deepEqual(
    [...list.childNodes].map((node) => node.textContent),
    ["a", "b2", "new tail"]
  );
});
