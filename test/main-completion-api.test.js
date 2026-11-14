import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { finalAnswerIndex } from "../web/assets/conversation.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { endAgentProcesses } from "./dashboard-fixture.mjs";

/**
 * Poll until the condition holds.
 *
 * The default budget covers an in-process turn. A check that also waits for a
 * delegated work item passes a larger one: that item is a real Pi process, and
 * its startup is not bounded by this harness.
 */
async function until(read, condition, label, timeoutMs = 10_000) {
  const untilMs = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const value = await read();
    last = value;
    if (condition(value)) return value;
    if (Date.now() >= untilMs) break;
    await delay(20);
  }
  assert.fail(
    `Timed out: ${label}${last?.task ? JSON.stringify({ task: last.task, runtime: last.runtime, humanRequests: last.humanRequests, humanResumePending: last.humanResumePending, events: last.events }) : ""}`
  );
}

/**
 * Main's runtime-state writes are fire-and-forget, so a SIGTERMed dashboard can
 * still be writing when the directory goes. Retry rather than fail teardown.
 */
async function removeAfterAsyncWrites(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  await rm(path, { recursive: true, force: true });
}

async function fixture(t, handle, maxTurns = 20, env = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-main-completion-"));
  let child;
  let output = "";
  const model = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "glm-5.3", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      const reply = ({ text, calls }) => {
        send({ role: "assistant" });
        if (text) send({ content: text });
        if (calls)
          send({
            tool_calls: calls.map(([name, args], index) => ({
              index,
              id: `tool-${Date.now()}-${index}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }))
          });
        send({}, calls?.length ? "tool_calls" : "stop");
        response.end("data: [DONE]\n\n");
      };
      await handle(body, reply);
    } catch (error) {
      output += String(error);
      response.destroy();
    }
  });
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    // A resident Main (and a delegated process) outlives the backend that
    // started it; this fixture is what finally ends them.
    await endAgentProcesses(workspaceRoot);
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
    await removeAfterAsyncWrites(root);
  });
  await writeFile(join(root, "config.json"), "{}");
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const workspaceRoot = join(root, "workspace");
  child = spawn(process.execPath, ["dist/src/cli/dashboard.js"], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      COWORK_WORKSPACE: workspaceRoot,
      COWORK_GLOBAL_INDEX: join(root, "global.json"),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_UI_PORT: String(port),
      COWORK_API_BASE: `http://127.0.0.1:${model.address().port}`,
      COWORK_API_KEY: "test-key",
      COWORK_MODEL: "glm-5.3",
      PI_CODING_AGENT_DIR: join(root, "pi-agent"),
      COWORK_DISABLE_MAIN_GUARDIAN: "1",
      COWORK_SERPER_API_KEY: "",
      SERPER_API_KEY: "",
      COWORK_WEB_TOOLS: "0",
      COWORK_MAIN_MAX_TURNS: String(maxTurns),
      ...env
    }
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const api = async (path, body) => {
    const response = await fetch(
      `http://127.0.0.1:${port}${path}`,
      body
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : undefined
    );
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  await until(
    async () => {
      try {
        return await api("/api/tasks");
      } catch {
        if (child.exitCode !== null) assert.fail(output);
        return null;
      }
    },
    Boolean,
    "dashboard listening"
  );
  await api("/api/tasks", { taskId: "task", goal: "Verify delegated evidence before final delivery" });
  return {
    root,
    workspaceRoot,
    api,
    base: `http://127.0.0.1:${port}`,
    detail: () => api("/api/tasks/task"),
    start: () => api("/api/tasks/task/run", { prompt: "Verify delegated evidence before final delivery" })
  };
}

test("askhuman waits for the answer and continues the same turn with it", { timeout: 20000 }, async (t) => {
  // askhuman is an ordinary asynchronous tool: it blocks, and the answer comes
  // back as its tool result. Before this it returned immediately and ended the
  // turn, so the answer had to re-enter as a fabricated user turn — which the
  // transcript showed as something the person had typed, and which dragged the
  // supervisor's own "Resume this task…" prompt in behind it.
  const requests = [];
  const f = await fixture(t, (body, reply) => {
    requests.push(body);
    if (requests.length === 1) {
      return reply({
        calls: [
          [
            "askhuman",
            {
              question: "报告使用哪种语言？",
              context: "这会决定报告的写作语言。",
              options: ["中文", "英文"],
              recommended: 0
            }
          ]
        ]
      });
    }
    reply({ text: "已按你的选择完成中文报告。" });
  });
  const run = await f.start();

  // The question appears while the run is still going: the tool is waiting, not
  // the process having exited.
  let detail = await until(
    f.detail,
    (value) => value.humanRequests?.some((question) => question.status === "pending"),
    "pending human question"
  );
  const question = detail.humanRequests[0];
  assert.deepEqual(question.options, ["中文", "英文"]);
  assert.equal(question.recommended, 0, "the recommended option is recorded for the UI and the timeout path");
  assert.equal(detail.runtime.active, true, "the run stays alive while the tool waits");
  assert.equal(
    (await f.detail()).humanRequests[0].requestId,
    question.requestId,
    "reload retains the same question"
  );
  assert.equal(requests.length, 1, "waiting for a human must not keep querying the model");

  const path = `/api/tasks/task/human/${question.requestId}/answer`;
  const empty = await fetch(f.base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: " " })
  });
  assert.equal(empty.status, 400);

  // A duplicate submission must not produce a second run or a second delivery.
  const answers = await Promise.all([
    f.api(path, { answer: "中文\n\n补充说明：保留英文术语" }),
    f.api(path, { answer: "中文\n\n补充说明：保留英文术语" })
  ]);
  assert.ok(answers.every((answer) => answer.request.status === "answered"));

  detail = await until(
    f.detail,
    (value) => !value.runtime.active && value.task.status === "completed",
    "completion after human reply"
  );
  assert.equal(detail.task.activeRunId, run.runId, "the same run continued; nothing was resumed");
  assert.equal(requests.length, 2, "one more model turn, carrying the tool result");

  // The answer reached the model as this tool's result, not as a user turn and
  // not as an Inbox instruction replayed on top of it.
  const second = JSON.stringify(requests[1].messages);
  assert.match(second, /保留英文术语/, "the answer reached the model");
  assert.doesNotMatch(
    second,
    /Cowork human answer received from Inbox/,
    "a delivered answer must not also arrive as an unprompted Inbox instruction"
  );
  assert.doesNotMatch(
    second,
    /Resume this task from its durable state/,
    "no supervisor wake-up prompt: the turn never ended"
  );
  assert.doesNotMatch(second, /我的回答是/, "no fabricated user turn");

  assert.equal(detail.humanResumePending, false);
  assert.equal(detail.humanRequests[0].answer, "中文\n\n补充说明：保留英文术语");
  await f.api(path, { answer: "英文" });
  await delay(100);
  assert.equal(
    requests.length,
    2,
    "a retry after completion must not reopen the task or replace the accepted answer"
  );
  assert.equal((await f.detail()).humanRequests[0].answer, "中文\n\n补充说明：保留英文术语");
});

test(
  "an unanswered question times out into the recommended option instead of stalling",
  { timeout: 20000 },
  async (t) => {
    // Nobody answers. The turn continues on the option the model said it would
    // pick, so the person is never left with a conversation that has stopped —
    // and the question stays open, so a late answer still reaches Main durably.
    const requests = [];
    const f = await fixture(
      t,
      (body, reply) => {
        requests.push(body);
        if (requests.length === 1) {
          return reply({
            calls: [["askhuman", { question: "要继续吗？", options: ["继续", "停下"], recommended: 0 }]]
          });
        }
        reply({ text: "没有收到确认，我按推荐选项继续了。" });
      },
      20,
      { COWORK_HUMAN_ANSWER_TIMEOUT_MS: "1200" }
    );

    await f.start();
    const detail = await until(
      f.detail,
      (value) => !value.runtime.active && value.task.status === "completed",
      "completion after timeout"
    );
    assert.equal(requests.length, 2, "the turn continued rather than ending at the question");
    const second = JSON.stringify(requests[1].messages);
    assert.match(second, /timeout/, "the tool result says the wait expired");
    assert.match(second, /继续/, "and names the recommended option to proceed on");
    // The question is not left pending — pending means someone is blocked on it,
    // and the completion gate would never let the turn finish. It is marked
    // unanswered, which still offers it to the person.
    assert.equal(detail.humanRequests[0].status, "unanswered");
  }
);

test(
  "two questions in one turn each wait, and a reply for another run is refused",
  { timeout: 20000 },
  async (t) => {
    // Two askhuman calls in one turn: each blocks on its own answer, and the turn
    // continues once both are in. Previously the turn ended at the first question
    // and both answers had to be replayed as user turns to get back.
    let requests = 0;
    const f = await fixture(t, (_body, reply) => {
      requests += 1;
      if (requests === 1) {
        return reply({
          calls: [
            ["askhuman", { question: "报告格式？", options: ["Markdown", "PDF"], recommended: 0 }],
            ["askhuman", { question: "报告面向谁？" }]
          ]
        });
      }
      reply({ text: "已按两项回答完成报告。" });
    });
    await f.start();
    let detail = await until(f.detail, (value) => value.humanRequests?.length === 2, "two pending questions");
    assert.equal(detail.runtime.active, true, "the run stays alive while both tools wait");
    const [first, second] = detail.humanRequests;
    assert.equal(requests, 1, "waiting for answers must not keep querying the model");

    await f.api(`/api/tasks/task/human/${first.requestId}/answer`, { answer: "Markdown" });
    await f.api(`/api/tasks/task/human/${second.requestId}/answer`, { answer: "项目开发者" });
    detail = await until(
      f.detail,
      (value) => !value.runtime.active && value.task.status === "completed",
      "completion after both questions"
    );
    assert.equal(requests, 2, "one further model turn, carrying both tool results");
    assert.ok(detail.humanRequests.every((request) => request.status === "answered"));
    const second_turn = JSON.stringify((await f.detail()).messages ?? []);
    assert.doesNotMatch(
      second_turn,
      /Resume this task from its durable state/,
      "the turn never ended, so nothing was resumed"
    );

    // A reply aimed at a run that is no longer the active one is refused.
    await new LocalWorkspaceStore(f.workspaceRoot).updateTask("task", { activeRunId: "another-run" });
    const response = await fetch(`${f.base}/api/tasks/task/human/${first.requestId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "PDF" })
    });
    assert.equal(response.status, 409);
  }
);

test("an answer given after the process stopped still resumes the run", { timeout: 20000 }, async (t) => {
  // The durable path, which askhuman blocking does not replace: a person may
  // answer long after the waiting process is gone — the timeout expired, the
  // dashboard restarted, the machine slept. The answer then arrives through the
  // Inbox and resumes the run, which is what `humanResumePending` reports.
  let requests = 0;
  const f = await fixture(
    t,
    (_body, reply) => {
      requests += 1;
      if (requests === 1)
        return reply({
          calls: [["askhuman", { question: "继续撰写？", options: ["继续", "暂停"], recommended: 0 }]]
        });
      reply({ text: "已根据回答继续并完成。" });
    },
    20,
    // A resident Main stays after its turn; the durable answer path is the one
    // a person takes once that process is gone (an idle exit, a restart, a
    // machine that slept), so the fixture lets the process idle out here.
    { COWORK_HUMAN_ANSWER_TIMEOUT_MS: "800", COWORK_MAIN_IDLE_TIMEOUT_MS: "800" }
  );
  const run = await f.start();

  // Let the wait expire and the turn settle, then let the idle process exit:
  // from here on nothing is blocked on the question and nobody is reading the
  // Inbox, exactly as after a restart.
  let detail = await until(
    f.detail,
    (value) => !value.runtime.active && !value.runtime.mainRunning && value.humanRequests?.length,
    "settled question after the Main exited"
  );
  assert.equal(detail.humanRequests[0].status, "unanswered");
  assert.equal(requests, 2, "the turn continued on the recommended option rather than stalling");

  // Now the person answers. Nothing is waiting for it, so it travels durably.
  const human = new HumanRequestStore(f.workspaceRoot);
  await human.submitAnswer("task", detail.humanRequests[0].requestId, "继续");
  const inbox = new InboxStore(
    join(f.workspaceRoot, "task", "runs", run.runId, "agents", "main", "inbox-store.json")
  );
  // A lease abandoned by a process that exited must not strand the answer.
  await inbox.lease("main", 60_000, "exited-process");
  assert.equal((await f.detail()).humanResumePending, true);

  await f.api("/api/tasks/task/human/resume", {});
  detail = await until(
    f.detail,
    (value) => !value.runtime.active && value.task.status === "completed",
    "restored answer completion"
  );
  assert.equal(detail.humanResumePending, false);
  assert.ok((await inbox.list("main")).every((message) => message.state === "consumed"));
  assert.equal((await f.detail()).humanRequests[0].answer, "继续", "a late answer is still recorded");
});

for (const mode of ["wait tool", "premature answer"]) {
  test(
    `Main consumes two delayed callbacks before final completion (${mode})`,
    { timeout: 30000 },
    async (t) => {
      const subagents = [];
      const subagentPrompts = [];
      const mainRequests = [];
      let finished = false;
      const f = await fixture(t, async (body, reply) => {
        if (!body.tools?.some((tool) => tool.function.name === "call_subagent")) {
          subagents.push(reply);
          subagentPrompts.push(
            body.messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n")
          );
          return;
        }
        mainRequests.push(body);
        if (mainRequests.length === 1)
          return reply({
            calls: [
              ["call_subagent", { task: "Inspect component A", mode: "async" }],
              ["call_subagent", { task: "Inspect component B", mode: "async" }]
            ]
          });
        if (mainRequests.length === 2 && mode === "wait tool")
          return reply({ calls: [["wait_for_subagents", { timeoutMs: 5000 }]] });
        const callbacks = body.messages.filter(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Cowork callback received from Inbox")
        );
        const evidence = JSON.stringify(body.messages);
        if (
          mode === "wait tool"
            ? !evidence.includes("Evidence A verified.") || !evidence.includes("Evidence B verified.")
            : callbacks.length < 2
        )
          return reply({ text: "PROVISIONAL: still awaiting delegated evidence." });
        if (mode === "wait tool" && !finished) {
          finished = true;
          return reply({ calls: [["finish_task", { summary: "Both delegated results verified" }]] });
        }
        reply({ text: "VERIFIED FINAL: both delegated results are accepted." });
      });
      const run = await f.start();
      await until(
        () => subagents.length === 2 && mainRequests.length >= 2,
        Boolean,
        "two running Subagents and Main wait/stop"
      );
      let detail = await f.detail();
      assert.equal(detail.runtime.active, true);
      assert.notEqual(detail.task.status, "completed");
      if (mode === "wait tool")
        await until(
          f.detail,
          (value) =>
            value.runtimeEvents.some(
              ({ payload }) =>
                payload.type === "tool_execution_start" && payload.toolName === "wait_for_subagents"
            ),
          "Main entered the wait tool"
        );
      subagents[0]({ text: "Evidence A verified." });
      await until(
        f.detail,
        (value) => value.coordination.calls.some((call) => call.status === "completed"),
        "first Subagent completion"
      );
      detail = await f.detail();
      assert.notEqual(detail.task.status, "completed");
      assert.equal(detail.runtime.active, true);
      if (mode === "wait tool") {
        // A callback that settles while Main is inside a tool must not be
        // injected into that turn: it stays in the Inbox until the tool reads
        // it. Both facts are durable, so assert them on the Inbox record and on
        // the event order rather than on how far the tool had got when the page
        // happened to be read.
        const inbox = new InboxStore(
          join(f.workspaceRoot, "task", "runs", detail.task.activeRunId, "agents", "main", "inbox-store.json")
        );
        assert.ok(
          (await inbox.list("main")).some((message) => message.kind === "callback"),
          "the settled result is durable in the Inbox while the tool runs"
        );
        const events = detail.runtimeEvents.map(({ payload }) => payload);
        const waitEnd = events.findIndex(
          (event) => event.type === "tool_execution_end" && event.toolName === "wait_for_subagents"
        );
        assert.equal(
          events.some(
            (event, index) =>
              (waitEnd < 0 || index < waitEnd) &&
              event.type === "message_end" &&
              event.message?.customType === "cowork-callback"
          ),
          false,
          "a callback settled inside a tool is not delivered into the running turn"
        );
      }
      subagents[1]({ text: "Evidence B verified." });
      detail = await until(f.detail, (value) => !value.runtime.active, "Main final completion");
      assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
      assert.equal(detail.task.completion.signal, mode === "wait tool" ? "finish_task" : "natural_stop");
      assert.deepEqual(detail.coordination.pending, []);
      assert.deepEqual(detail.coordination.callbackPending, []);
      const events = detail.runtimeEvents.map((event) => event.payload);
      assert.equal(
        events.some((event) => event.message?.customType === "cowork-completion-check"),
        false
      );
      const names = detail.coordination.calls.map((call) => call.name);
      assert.equal(new Set(names).size, 2);
      assert.ok(names.every((name) => name && !/智能体|\d/.test(name)));
      for (const agent of detail.progress.agents) {
        assert.ok(names.includes(agent.name));
        assert.ok(
          subagentPrompts.some(
            (prompt) =>
              prompt.includes(`Your team name is ${agent.name}`) &&
              prompt.includes(join(f.workspaceRoot, "task", "agents", "subagents", agent.agentId))
          )
        );
      }
      const finalIndex = events.findIndex(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "assistant" &&
          event.message.content.some(
            (part) => part.text === "VERIFIED FINAL: both delegated results are accepted."
          )
      );
      assert.ok(finalIndex >= 0);
      const callbackIndexes = events.flatMap((event, index) =>
        event.type === "message_end" && event.message?.customType === "cowork-callback" ? [index] : []
      );
      const waitResult = events.find(
        (event) => event.type === "tool_execution_end" && event.toolName === "wait_for_subagents"
      )?.result;
      const waitEvidence = JSON.stringify(waitResult ?? {});
      const deliveredEvidence = callbackIndexes.map((index) => JSON.stringify(events[index].message));
      for (const value of ["Evidence A verified.", "Evidence B verified."]) {
        assert.equal(
          Number(waitEvidence.includes(value)) +
            deliveredEvidence.filter((body) => body.includes(value)).length,
          1,
          `${value} must reach Main through wait or callback exactly once`
        );
      }
      assert.ok(
        callbackIndexes.every((index) => names.includes(events[index].message.details.name)),
        "callbacks retain the team member's name"
      );
      assert.ok(
        callbackIndexes.every((index) => index < finalIndex),
        "no callback should arrive after the final answer"
      );
      const inbox = JSON.parse(
        await readFile(
          join(f.workspaceRoot, "task", "runs", run.runId, "agents", "main", "inbox-store.json"),
          "utf8"
        )
      );
      assert.ok(inbox.every((message) => message.state === "consumed"));
    }
  );
}

for (const [name, args] of [
  ["bash", { command: "pwd" }],
  ["write", { path: "note.txt", content: "Verified fixture result" }]
]) {
  test(
    `Main naturally ends after ${name} and a final answer without an injected continuation`,
    { timeout: 15000 },
    async (t) => {
      const requests = [];
      const f = await fixture(t, (body, reply) => {
        requests.push(body);
        if (requests.length === 1) return reply({ calls: [[name, args]] });
        reply({ text: "Complete interpretation. No further work is required." });
      });
      // Persisted conversations may still carry the old policy value.
      await new LocalWorkspaceStore(f.workspaceRoot).updateTask("task", {
        completion: { policy: "explicit" }
      });
      await f.start();
      const detail = await until(
        f.detail,
        (value) => !value.runtime.active,
        "natural completion after tool use"
      );
      assert.equal(requests.length, 2, "a complete answer must not start another model request");
      assert.equal(detail.task.status, "completed");
      assert.equal(detail.task.completion.signal, "natural_stop");
      assert.equal(
        detail.runtimeEvents.some(({ payload }) => payload.message?.customType === "cowork-completion-check"),
        false
      );
      assert.equal(finalAnswerIndex(detail.messages, detail), detail.messages.length - 1);
    }
  );
}

test(
  "A natural final answer at the turn limit completes even with legacy explicit metadata",
  { timeout: 15000 },
  async (t) => {
    let requests = 0;
    const f = await fixture(
      t,
      (_body, reply) => {
        requests += 1;
        reply({ text: "Complete interpretation." });
      },
      1
    );
    await new LocalWorkspaceStore(f.workspaceRoot).updateTask("task", { completion: { policy: "explicit" } });
    await f.start();
    const detail = await until(f.detail, (value) => !value.runtime.active, "final answer at budget limit");
    assert.equal(requests, 1);
    assert.equal(detail.task.status, "completed");
    assert.equal(detail.task.completion.signal, "natural_stop");
  }
);

test(
  "A turn budget stop on a tool never promotes an incomplete response to a final answer",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_body, reply) => reply({ calls: [["bash", { command: "pwd" }]] }), 1);
    await new LocalWorkspaceStore(f.workspaceRoot).updateTask("task", { completion: { policy: "explicit" } });
    await f.start();
    const detail = await until(f.detail, (value) => !value.runtime.active, "budget-limited Main exit");
    assert.ok(["waiting", "failed"].includes(detail.task.status), JSON.stringify(detail.task));
    assert.notEqual(detail.task.completion.signal, "finish_task");
    assert.equal(finalAnswerIndex(detail.messages, detail), -1);
    assert.equal(
      detail.runtimeEvents.some(({ payload }) => payload.message?.customType === "cowork-completion-check"),
      false
    );
    assert.equal(
      detail.events.some((event) => event.type === "main.run_completed"),
      false
    );
  }
);

test(
  "Main's completion wait re-drives a queued Subagent retry without abandoning its callback",
  { timeout: 15000 },
  async (t) => {
    let subagentRequests = 0;
    let mainRequests = 0;
    let finishing = false;
    const f = await fixture(
      t,
      (body, reply) => {
        if (!body.tools?.some((tool) => tool.function.name === "call_subagent")) {
          subagentRequests += 1;
          return reply({ text: subagentRequests === 1 ? "" : "Recovered, verified evidence." });
        }
        mainRequests += 1;
        if (mainRequests === 1)
          return reply({ calls: [["call_subagent", { task: "Verify retry recovery", mode: "async" }]] });
        const hasCallback = body.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Cowork callback received from Inbox")
        );
        if (!hasCallback) return reply({ text: "Waiting for verification." });
        if (!finishing) {
          finishing = true;
          return reply({ calls: [["finish_task", { summary: "Recovered result verified" }]] });
        }
        reply({ text: "Verified after retry." });
        // Retries are off by default, since an expensive job should surface a
        // failure rather than silently repeat it. This exercises the machinery
        // that is still there for callers that do want it.
      },
      20,
      { COWORK_MAX_ATTEMPTS: "3" }
    );
    await f.start();
    const detail = await until(f.detail, (value) => !value.runtime.active, "retried task completion");
    assert.equal(subagentRequests, 2);
    assert.equal(detail.task.status, "completed");
    assert.equal(detail.task.completion.signal, "finish_task");
    assert.deepEqual(detail.coordination.callbackPending, []);
    assert.ok(detail.events.some((event) => event.type === "run.retry_scheduled"));
  }
);

test(
  "A blocked Subagent question reaches Main, gates completion, and is answered end to end",
  { timeout: 30000 },
  async (t) => {
    let mainRequests = 0;
    let subagentRequests = 0;
    let answeredOnce = false;
    let questionId;
    let callId;
    const f = await fixture(t, (body, reply) => {
      if (!body.tools?.some((tool) => tool.function.name === "call_subagent")) {
        subagentRequests += 1;
        // The Subagent asks once, then reports what it was told.
        if (subagentRequests === 1)
          return reply({
            calls: [["ask_main", { question: "哪个评测脚本是权威的？", assumption: "用 scripts/eval.py" }]]
          });
        const answers = body.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content)
          .join(" ");
        return reply({ text: `按 Main 的回答完成：${answers}` });
      }
      mainRequests += 1;
      if (mainRequests === 1)
        return reply({ calls: [["call_subagent", { task: "核对评测脚本", mode: "async" }]] });
      // The question stays in Main's transcript after it is answered, so a real
      // Main answers it once and then gets on with the work.
      const question = answeredOnce
        ? undefined
        : body.messages.find(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("Cowork subagent question received from Inbox")
          );
      if (question) {
        const raw =
          typeof question.content === "string"
            ? question.content
            : (question.content ?? [])
                .map((part) => (part && part.type === "text" ? part.text : ""))
                .join("");
        const payload = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
        questionId = payload.questionId;
        callId = payload.callId;
        answeredOnce = true;
        return reply({
          calls: [["send_subagent_message", { callId, questionId, message: "configs/eval.py 才是权威的" }]]
        });
      }
      const callback = body.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("Cowork callback received from Inbox")
      );
      reply({ text: callback ? "协作者已按澄清完成核对。" : "等待协作者。" });
    });
    await f.start();
    const detail = await until(
      f.detail,
      (value) => !value.runtime.active && value.task.status === "completed",
      "question answered and task completed"
    );

    assert.ok(questionId, "Main must actually receive the question through its Inbox");
    assert.equal(subagentRequests, 2, "the Subagent must take another turn once it has the answer");
    assert.equal(detail.task.status, "completed");
    assert.deepEqual(detail.coordination.callbackPending, []);
    // The question travelled as its own kind and was consumed, not left dangling.
    assert.ok(detail.events.some((event) => event.type === "question.raised"));
    assert.ok(detail.events.some((event) => event.type === "question.answered"));
    const inboxPath = join(
      f.workspaceRoot,
      "task",
      "runs",
      detail.task.activeRunId,
      "agents",
      "main",
      "inbox-store.json"
    );
    const inbox = JSON.parse(await readFile(inboxPath, "utf8"));
    assert.ok(
      inbox.every((message) => message.state === "consumed"),
      "every delivered message must be acknowledged"
    );
    const question = inbox.find((message) => message.kind === "subagent_question");
    assert.ok(question, "the question must be its own Inbox kind");
    const callback = inbox.find((message) => message.kind === "callback");
    assert.ok(question.priority > callback.priority, "a blocked collaborator must outrank a queued callback");
    // The answer actually reached the Subagent rather than its assumption.
    const answered = JSON.parse(
      await readFile(join(f.workspaceRoot, "task", "subagent-questions", `${questionId}.json`), "utf8")
    );
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "configs/eval.py 才是权威的");
  }
);

test(
  "A pending Subagent question blocks the dashboard complete action until it is resolved",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(
      t,
      (body, reply) => {
        if (!body.tools?.some((tool) => tool.function.name === "call_subagent")) {
          // Ask and stay blocked for the rest of the test.
          return reply({ calls: [["ask_main", { question: "要继续吗？", assumption: "继续" }]] });
        }
        if (
          !body.messages.some(
            (message) =>
              message.role === "assistant" && JSON.stringify(message.content).includes("call_subagent")
          )
        ) {
          return reply({ calls: [["call_subagent", { task: "等待澄清", mode: "async" }]] });
        }
        reply({ text: "等待协作者的问题被回答。" });
      },
      20,
      { COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "600000" }
    );
    await f.start();
    const questionDir = join(f.workspaceRoot, "task", "subagent-questions");
    await until(
      async () => {
        const files = await readdir(questionDir).catch(() => []);
        return files.length ? files : null;
      },
      Boolean,
      "a raised question on disk",
      60_000
    );

    // The user clicking "complete" must not close a Task somebody is blocked on.
    const response = await fetch(`${f.base}/api/tasks/task/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "complete" })
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.match(body.error, /等待回答/);
    assert.notEqual((await f.detail()).task.status, "completed");
  }
);

test(
  "the person can speak while Main is working, and it reaches the running turn",
  { timeout: 30000 },
  async (t) => {
    // Making the person wait for a run to finish before they could say anything
    // had the model backwards: a colleague who is mid-task can be told something,
    // and what the person says may be exactly what changes the work. The message
    // steers the turn in progress rather than queueing behind it — the same path
    // a Subagent callback takes.
    const turns = [];
    const f = await fixture(
      t,
      async (body, reply) => {
        turns.push(JSON.stringify(body.messages));
        if (turns.length === 1) {
          // Long enough to interject into.
          for (let step = 0; step < 12; step += 1) await delay(60);
          return reply({ text: "第一轮结束。" });
        }
        reply({ text: "已按你的补充调整。" });
      },
      20,
      // A resident Main serves the conversation between turns; this test also
      // covers the case where that process has idled out.
      { COWORK_MAIN_IDLE_TIMEOUT_MS: "4000" }
    );
    await f.start();

    await until(f.detail, (value) => value.runtime?.active === true, "a running turn");
    const delivered = await f.api("/api/tasks/task/interject", { message: "等一下，改成用中文写" });
    assert.equal(delivered.delivered, true);

    const detail = await until(
      f.detail,
      (value) => !value.runtime.active && value.task.status === "completed",
      "completion"
    );
    // It reached the model, as the person talking rather than as a system notice.
    const everything = turns.join("\n");
    assert.match(everything, /改成用中文写/, "the message reached the model");
    assert.match(everything, /用户在你工作期间补充了一句话/, "delivered as the person speaking");
    assert.doesNotMatch(
      everything,
      /received from Inbox:[\s\S]*human\.message/,
      "not wrapped in the machinery's envelope"
    );
    // Recorded, so the transcript can show it where the person said it.
    assert.ok((detail.events ?? []).some((event) => event.type === "user.interjected"));

    // The resident Main is still the conversation: an insertion between turns
    // opens the next one instead of being refused, and it reaches the model.
    const betweenTurns = turns.length;
    const inserted = await fetch(`${f.base}/api/tasks/task/interject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "空闲时再补一句" })
    });
    assert.equal(inserted.status, 202, await inserted.text());
    await until(
      f.detail,
      (value) => !value.runtime.active && value.task.status === "completed" && turns.length > betweenTurns,
      "the inserted message to open the next turn"
    );
    assert.match(turns.at(-1), /空闲时再补一句/);

    // Once the process has idled out there is nothing to steer, and the caller
    // is told to send an ordinary message instead of the request silently
    // doing nothing.
    await until(f.detail, (value) => !value.runtime?.mainRunning, "the idle Main to exit");
    const response = await fetch(`${f.base}/api/tasks/task/interject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "现在没有在跑" })
    });
    assert.equal(response.status, 409);
  }
);
