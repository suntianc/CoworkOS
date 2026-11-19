import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SubagentQuestionStore } from "../dist/src/runtime/subagent-questions.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-question-hold-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const questions = new SubagentQuestionStore(root);
  const humans = new HumanRequestStore(root);
  const ask = (questionId, runId = "run-1") =>
    questions.create({
      questionId,
      taskId: "task-1",
      runId,
      callId: "call-1",
      agentId: "subagent_1",
      agentName: "Nova",
      question: "May I write test/?",
      assumption: "Leave test/ alone"
    });
  const askUser = (runId = "run-1") => humans.create({ taskId: "task-1", runId, question: "Allow test/?" });
  return { questions, humans, ask, askUser };
}

test("a Subagent's wait does not run out while Main is waiting for the user", async (t) => {
  const f = await fixture(t);
  await f.ask("question-1");
  const startedAt = Date.now();
  const waiting = f.questions.waitForAnswer("task-1", "question-1", { timeoutMs: 400 });
  // Main turns to the user before the Subagent's wait runs out.
  await delay(150);
  const request = await f.askUser();
  await delay(700);
  assert.equal((await f.questions.read("task-1", "question-1")).status, "pending", "held past its deadline");
  // The user answers; Main gets the full wait again to answer the Subagent.
  await f.humans.answer("task-1", request.requestId, "yes");
  const answeredAt = Date.now();
  await delay(200);
  await f.questions.answer("task-1", "question-1", "Yes, write the tests.");
  const settled = await waiting;
  assert.equal(settled.status, "answered");
  assert.ok(answeredAt - startedAt > 400);
});

test("after the user answers, an unanswered question expires a full wait later", async (t) => {
  const f = await fixture(t);
  const request = await f.askUser();
  // Asked while Main is already waiting for the user: it is held from the start.
  await f.ask("question-2");
  const waiting = f.questions.waitForAnswer("task-1", "question-2", { timeoutMs: 300 });
  await delay(500);
  await f.humans.markUnanswered("task-1", request.requestId);
  const freedAt = Date.now();
  const settled = await waiting;
  assert.equal(settled.status, "expired");
  assert.ok(Date.now() - freedAt >= 250, "the full wait restarts when Main is free again");
});

test("another Run's question for the user does not hold this wait", async (t) => {
  const f = await fixture(t);
  await f.askUser("run-0");
  await f.ask("question-3");
  const started = Date.now();
  const settled = await f.questions.waitForAnswer("task-1", "question-3", { timeoutMs: 200 });
  assert.equal(settled.status, "expired");
  assert.ok(Date.now() - started < 1_500);
});
