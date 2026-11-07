import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createConversationView } from "../web/assets/controllers/conversation-view.js";
import { humanAnswerTurn } from "../web/assets/human-questions.js";

const textContent = (content) =>
  typeof content === "string" ? content : (content || []).map((part) => part.text || "").join("");
const user = { role: "user", content: "合成思考展示验收", timestamp: 1 };
const update = (type, contentIndex, value = {}) => ({
  type: "message_update",
  assistantMessageEvent: { type, contentIndex, ...value }
});

test("a submitted human reply uses a compact disclosure and preserves its open state on refresh", () => {
  const { document, state, render } = fixture("human-answer-disclosure", "");
  const request = {
    requestId: "city",
    status: "answered",
    question: "你想查询哪个城市？",
    answer: "上海\n\n保留完整回答"
  };
  state.detail.humanRequests = [request];
  state.detail.runtimeEvents = [];
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  const reply = { role: "user", timestamp: 3, content: humanAnswerTurn(request.question, request.answer) };
  render([user, reply]);
  const disclosure = document.querySelector(".human-answer-details");
  assert.ok(disclosure);
  assert.match(disclosure.querySelector("summary").textContent, /回答问题/);
  assert.equal(disclosure.hasAttribute("open"), false);
  assert.equal(document.querySelector(".human-answer-card"), null);
  assert.equal(disclosure.querySelector(".human-answer-question").textContent, request.question);
  assert.match(disclosure.querySelector(".human-answer-value").textContent, /上海[\s\S]*保留完整回答/);
  disclosure.open = true;
  render([user, reply]);
  assert.equal(document.querySelector(".human-answer-details"), disclosure);
  assert.equal(disclosure.open, true);
});

test("a mid-run instruction separates earlier activity from the continuing response", () => {
  const { document, state, render } = fixture("steering-order", "补充前的第六步。");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "补充前的第六步。" }));
  render();
  const before = document.querySelector(".reasoning-details");
  before.open = true;
  const instruction = {
    role: "user",
    id: "steer-one",
    content: "你现在再试试",
    timestamp: 3,
    delivery: "steer",
    interjected: true
  };
  const delivered = {
    role: "custom",
    customType: "cowork-user-message",
    content: "用户在你工作期间补充了一句话：你现在再试试",
    timestamp: 3,
    details: {
      message: instruction.content,
      delivery: "steer",
      _coworkInbox: { messageId: instruction.id }
    }
  };
  state.detail.runtimeEvents.push(
    { type: "message_start", message: delivered },
    { type: "message_end", message: delivered },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 4, content: [] } },
    update("thinking_delta", 0, { delta: "根据补充指令继续执行。" })
  );
  render([user, instruction]);
  const rows = [...document.querySelector("#conversation").children];
  assert.deepEqual(
    rows.map((row) =>
      row.textContent.includes("第六步")
        ? "before"
        : row.textContent.includes(instruction.content)
          ? "instruction"
          : row.textContent.includes("继续执行。")
            ? "after"
            : "request"
    ),
    ["request", "before", "instruction", "after"]
  );
  assert.equal(document.querySelector(".reasoning-details"), before);
  assert.equal(before.open, true);
  assert.equal(document.querySelectorAll(".workflow-progress-spinner").length, 1);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
  assert.doesNotMatch(rows[1].textContent, /整轮任务已完成|等待继续/);

  const answer = {
    role: "assistant",
    timestamp: 4,
    stopReason: "stop",
    content: [{ type: "text", text: "按补充指令完成。" }]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, instruction, answer]);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
  assert.equal(document.querySelectorAll(".workflow-progress-spinner").length, 0);
  assert.equal(document.querySelector(".reasoning-details"), before);
  assert.equal(before.open, true);
  assert.equal(document.querySelectorAll(".chat-message.user").length, 2);
});

test("an accepted instruction leaves the current tool active until Pi delivers it", () => {
  const { document, state, render } = fixture("steering-in-flight", "");
  state.detail.runtimeEvents.push({
    type: "tool_execution_start",
    toolCallId: "in-flight",
    toolName: "bash",
    args: { command: "node check.mjs" }
  });
  render();
  const tool = document.querySelector(".tool-details");
  const progress = document.querySelector(".workflow-progress-spinner");
  render([
    user,
    {
      role: "user",
      id: "pending-steer",
      content: "等当前调用返回后修改",
      timestamp: 3,
      delivery: "steer",
      interjected: true
    }
  ]);
  assert.equal(document.querySelector(".tool-details"), tool);
  assert.equal(document.querySelector(".workflow-progress-spinner"), progress);
  assert.match(document.querySelector(".tool-step").textContent, /执行中/);
  assert.equal(document.querySelectorAll('[data-answer-kind="pending"]').length, 1);
  const rows = [...document.querySelector("#conversation").children];
  assert.match(rows[1].textContent, /node check.mjs/);
  assert.match(rows[2].textContent, /等当前调用返回后修改/);
});

function fixture(taskId = "reasoning-one", thought = "先核对第一部分。", actions = {}) {
  const { document } = parseHTML('<main id="conversation"></main>');
  const state = {
    selected: taskId,
    localMessages: [],
    executionHistoryOpen: new Map(),
    detail: {
      task: { taskId, status: "running" },
      runtime: { active: true },
      runtimeEvents: [
        { type: "turn_start" },
        { type: "message_start", message: user },
        { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
        update("thinking_start", 0),
        update("thinking_delta", 0, { delta: thought })
      ]
    }
  };
  const view = createConversationView({
    state,
    $: (selector) => document.querySelector(selector),
    bindStarterPrompts() {},
    textContent,
    ...actions
  });
  const render = (messages = [user]) => view.renderConversation(messages, state.detail.task);
  render();
  return { document, state, render };
}

test("retrying keeps the original request and attachment when its timestamp matches the next position", () => {
  const { document, state, render } = fixture("retry-key-collision", "已检查输入。");
  const original = {
    ...user,
    content: "原始请求\n\nAttached files:\nsource.txt\nORIGINAL_ATTACHMENT_BODY"
  };
  render([original]);
  const row = document.querySelector(".chat-message.user");
  state.localMessages.push({ role: "user", content: "继续刚才未完成的请求。", taskId: state.selected });
  render([original]);
  render([original]);
  const rows = [...document.querySelectorAll(".chat-message.user")];
  assert.equal(rows.length, 2);
  assert.equal(rows[0], row);
  assert.match(rows[0].textContent, /原始请求/);
  assert.match(rows[1].textContent, /继续刚才/);
  assert.equal(document.querySelectorAll(".message-attachments").length, 1);
});

test("continuous thought deltas retain the disclosure, spinner and existing paragraph nodes", () => {
  const { document, state, render } = fixture("stable-thought", "先核对输入。");
  const detail = document.querySelector(".reasoning-details");
  const spinner = detail.querySelector(".thinking-spinner");
  const paragraph = detail.querySelector(".reasoning-copy p");
  detail.open = true;
  for (const delta of ["然后读取", "约束", "，继续检查。"]) {
    state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta }));
    render();
    assert.equal(document.querySelector(".reasoning-details"), detail);
    assert.equal(detail.querySelector(".thinking-spinner"), spinner);
    assert.equal(detail.querySelector(".reasoning-copy p"), paragraph);
    assert.equal(detail.open, true);
  }
  assert.match(paragraph.textContent, /然后读取约束，继续检查。/);
});

test("waiting between reasoning, returned tools and the next model response keeps a continuous progress indicator", () => {
  const { document, state, render } = fixture("model-gaps");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "先核对第一部分。" }));
  render();
  const progress = document.querySelector(".workflow-progress-spinner");
  assert.ok(progress);
  assert.match(document.querySelector(".workflow-heading").textContent, /等待模型响应/);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "attachment", name: "read_attachment", arguments: { path: "input.txt" } }
    }),
    { type: "tool_execution_start", toolCallId: "attachment", toolName: "read_attachment" }
  );
  render();
  assert.equal(document.querySelector(".workflow-progress-spinner"), progress);
  assert.match(document.querySelector(".workflow-heading").textContent, /读取附件/);
  assert.match(document.querySelector(".tool-action").textContent, /读取附件/);
  state.detail.runtimeEvents.push({
    type: "tool_execution_end",
    toolCallId: "attachment",
    toolName: "read_attachment",
    result: { content: [] }
  });
  render();
  assert.equal(document.querySelector(".workflow-progress-spinner"), progress);
  assert.match(document.querySelector(".workflow-heading").textContent, /等待模型响应/);
  state.detail.runtime.active = false;
  state.detail.task.status = "cancelled";
  render();
  assert.equal(document.querySelector(".workflow-progress-spinner"), null);
  assert.equal(document.querySelectorAll("[data-thinking-key]").length, 0);
});

test("a parked monitoring run remains waiting for a wake after its terminal waiting event", () => {
  const { document, state, render } = fixture("parked-monitor", "本轮变化已核实。");
  state.detail.runtimeEvents.push(update("thinking_end", 0, { content: "本轮变化已核实。" }), {
    type: "main.run_waiting"
  });
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  state.detail.monitoring = { sleep: { reason: "等待新变化" } };
  render();
  assert.match(document.querySelector(".workflow-heading").textContent, /等待唤醒/);
  assert.match(document.querySelector(".live-caption").textContent, /本轮已处理/);
  assert.equal(document.querySelectorAll(".workflow-progress-spinner").length, 0);
  assert.match(document.querySelector(".reasoning-copy").textContent, /本轮变化已核实/);
  state.detail.runtime.active = true;
  state.detail.task.status = "running";
  state.detail.runtimeEvents.push({ type: "turn_start" });
  render();
  assert.doesNotMatch(document.querySelector(".workflow-heading").textContent, /等待唤醒/);
  assert.equal(document.querySelectorAll(".workflow-progress-spinner").length, 1);
});

test("no first token and an automatic retry both keep a visible waiting animation", () => {
  const { document, state, render } = fixture("no-first-token", "");
  state.detail.runtimeEvents = [];
  render();
  const progress = document.querySelector(".assistant-thinking .thinking-spinner");
  assert.ok(progress);
  render();
  assert.equal(document.querySelector(".assistant-thinking .thinking-spinner"), progress);
  state.detail.runtimeEvents.push({ type: "auto_retry_start", attempt: 1, maxAttempts: 5 });
  render();
  assert.ok(document.querySelector(".assistant-thinking .thinking-spinner"));
  assert.match(document.querySelector(".assistant-thinking").textContent, /恢复模型连接/);
  state.detail.runtime.active = false;
  state.detail.task.status = "cancelled";
  render();
  assert.equal(document.querySelectorAll("[data-thinking-key]").length, 0);
});

test("unknown tool names remain identifiable and HTML in a tool name is escaped", () => {
  const { document, state, render } = fixture("named-custom-tool", "");
  state.detail.runtimeEvents.push({
    type: "tool_execution_start",
    toolCallId: "custom",
    toolName: "mcp__slides__inspect<img src=x onerror=alert(1)>"
  });
  render();
  assert.match(document.querySelector(".tool-action").textContent, /mcp__slides__inspect/);
  assert.equal(document.querySelector(".tool-action img"), null);
  assert.doesNotMatch(document.querySelector(".tool-action").textContent, /执行工具/);
});

test("Main retry progress uses bounded event fields and clears on recovery", () => {
  const { document, state, render } = fixture("retry-progress", "");
  state.detail.runtimeEvents.push({
    type: "auto_retry_start",
    attempt: 3,
    maxAttempts: 5,
    errorMessage: "Bearer sk-test-synthetic-private"
  });
  render();
  assert.match(document.querySelector(".request-retry").textContent, /第 3 \/ 5 次自动重试/);
  assert.doesNotMatch(
    document.querySelector("#conversation").textContent,
    /Bearer|sk-test-synthetic|private/
  );
  state.detail.runtimeEvents.push({ type: "auto_retry_end", attempt: 3, success: true });
  render();
  assert.equal(document.querySelector(".request-retry"), null);
});

test("an exhausted Main retry shows the observed retry count with manual recovery", () => {
  const { document, state, render } = fixture("retry-exhausted", "");
  state.detail.runtime.active = false;
  state.detail.task = { ...state.detail.task, status: "failed", lastError: "503 service unavailable" };
  state.detail.runtimeEvents.push({
    type: "auto_retry_end",
    attempt: 5,
    success: false,
    finalError: "Bearer sk-test-synthetic-private"
  });
  render();
  assert.match(document.querySelector('[role="alert"]').textContent, /已自动重试 5 次/);
  assert.equal(document.querySelectorAll("[data-retry-request]").length, 1);
  assert.doesNotMatch(
    document.querySelector("#conversation").textContent,
    /Bearer|sk-test-synthetic|private/
  );
});

test("consecutive successful file and command calls compact into an expandable group while failure stays visible", () => {
  const { document, state, render } = fixture("compact-tools", "");
  const add = (index, name, failed = false) => {
    const id = `operation-${index}`;
    state.detail.runtimeEvents.push(
      update("toolcall_end", index, {
        toolCall: { id, name, arguments: { path: `file-${index}.txt`, command: "node check.mjs" } }
      }),
      { type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [], isError: failed } }
    );
  };
  add(1, "read");
  add(2, "read");
  add(3, "edit");
  add(4, "bash");
  add(5, "bash", true);
  render();
  const group = document.querySelector(".tool-group-details");
  assert.equal(group.open === true, false);
  assert.equal(
    group.querySelector("summary").textContent,
    "读取了 2 个文件 · 编辑了 1 个文件 · 运行了 1 条命令"
  );
  assert.equal(group.querySelectorAll(".tool-step").length, 4);
  assert.equal(document.querySelectorAll(".workflow-rail > .tool-step.is-failed").length, 1);
  group.open = true;
  const firstTool = group.querySelector(".tool-details");
  firstTool.open = true;
  state.detail.runtimeEvents.push(
    update("thinking_start", 6),
    update("thinking_delta", 6, { delta: "失败需要检查。" })
  );
  render();
  assert.equal(document.querySelector(".tool-group-details"), group);
  assert.equal(group.open, true);
  assert.equal(group.querySelector(".tool-details"), firstTool);
  assert.equal(firstTool.open, true);
});

test("compaction does not hide running commands or merge calls across reasoning", () => {
  const { document, state, render } = fixture("group-boundaries", "");
  for (const index of [1, 2]) {
    state.detail.runtimeEvents.push(
      update("toolcall_end", index, {
        toolCall: { id: `read-${index}`, name: "read", arguments: { path: "input.txt" } }
      }),
      { type: "tool_execution_end", toolCallId: `read-${index}`, result: { content: [] } }
    );
  }
  state.detail.runtimeEvents.push(
    update("thinking_delta", 3, { delta: "现在运行验证。" }),
    update("toolcall_end", 4, {
      toolCall: { id: "running", name: "bash", arguments: { command: "node verify.mjs" } }
    }),
    { type: "tool_execution_start", toolCallId: "running", toolName: "bash" }
  );
  render();
  assert.equal(document.querySelectorAll(".tool-group").length, 1);
  assert.equal(document.querySelectorAll(".workflow-rail > .tool-step.is-running").length, 1);
  assert.equal(document.querySelectorAll(".reasoning-step").length, 2);
});

test("a collapsed thought shows its real first sentence and leaves the rest inside the disclosure", () => {
  const thought = "先读取项目说明，确认约束。然后检查入口与工具。";
  const { document } = fixture("preview", thought);
  const detail = document.querySelector(".reasoning-details");
  assert.match(detail.querySelector("summary").textContent, /先读取项目说明，确认约束。/);
  assert.doesNotMatch(detail.querySelector("summary").textContent, /然后检查|查看思考过程|实时更新/);
  assert.equal(detail.open === true, false);
  assert.equal(detail.querySelector(".reasoning-copy").textContent, thought);
  assert.equal(document.querySelectorAll(".reasoning-step .activity-step-head").length, 0);
});

test("tool rows show delegation purpose and avoid repeating an already visible success status", () => {
  const { document, state, render } = fixture("friendly-purpose", "");
  for (const [index, toolCall] of [
    { id: "script", name: "bash", arguments: { command: "python3 verify.py", timeout: 120 } },
    { id: "delegate", name: "call_subagent", arguments: { name: "Ara", task: "核对文稿的引用和文件链接" } }
  ].entries()) {
    state.detail.runtimeEvents.push(update("toolcall_end", index + 1, { toolCall }), {
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { content: [], isError: false }
    });
  }
  render();
  assert.equal(document.querySelectorAll(".tool-step")[0].querySelector(".tool-context"), null);
  assert.equal(document.querySelectorAll(".tool-context").length, 1);
  assert.equal(
    document.querySelectorAll(".tool-step")[1].querySelector(".tool-context").textContent,
    "核对文稿的引用和文件链接"
  );
  assert.equal(document.querySelectorAll(".activity-status")[0].textContent, "完成");
  assert.doesNotMatch(
    [...document.querySelectorAll(".tool-details > summary")].map((node) => node.textContent).join(""),
    /command=|timeout=|120/
  );
});

test("all tool diagnostic sections retain independent reading positions through updates and collapse", () => {
  const { document, state, render } = fixture("tool-reading", "先核对输出。");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "verify", name: "bash", arguments: { command: "python3 verify.py" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "verify",
      result: {
        content: [],
        details: { stdout: "output\n".repeat(80), stderr: "warning\n".repeat(80), exitCode: 0 }
      }
    }
  );
  render();
  document.querySelector(".tool-details").open = true;
  const stdout = document.querySelector('[data-reading-key="标准输出"]');
  const stderr = document.querySelector('[data-reading-key="标准错误"]');
  stdout.scrollTop = 91;
  stderr.scrollTop = 123;
  stderr.scrollLeft = 11;
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "更新过程。" }));
  render();
  assert.equal(document.querySelector('[data-reading-key="标准输出"]').scrollTop, 91);
  assert.equal(document.querySelector('[data-reading-key="标准错误"]').scrollTop, 123);
  assert.equal(document.querySelector('[data-reading-key="标准错误"]').scrollLeft, 11);
  document.querySelector(".tool-details").open = false;
  render();
  document.querySelector(".tool-details").open = true;
  document.querySelector(".tool-details").dispatchEvent(new document.defaultView.Event("toggle"));
  assert.equal(document.querySelector('[data-reading-key="标准错误"]').scrollTop, 123);
});

test("a rejected finish acknowledgement remains waiting in the visible tool row", () => {
  const { document, state, render } = fixture("waiting-finish", "");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "finish", name: "finish_task", arguments: { summary: "等待检查产物" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "finish",
      result: { content: [], details: { completed: false } }
    }
  );
  render();
  assert.equal(document.querySelector(".activity-status").textContent, "等待中");
  assert.equal(document.querySelector(".tool-step").classList.contains("is-done"), false);
  assert.equal(document.querySelectorAll(".tool-progress-spinner").length, 0);
  assert.equal(document.querySelector(".live-caption").textContent, "1/1 项调用已返回");
});

test("command exit evidence marks a failed tool while counting its returned call", () => {
  const { document, state, render } = fixture("exit-code-evidence", "");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "exit", name: "bash", arguments: { command: "python3 verify.py" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "exit",
      isError: false,
      result: { content: [], details: { exitCode: 1, stderr: "SyntaxError: invalid syntax" } }
    }
  );
  render();
  assert.equal(document.querySelector(".activity-status").textContent, "调用失败");
  assert.equal(document.querySelector(".tool-step").classList.contains("is-failed"), true);
  assert.equal(document.querySelector(".tool-context").textContent, "Python 语法错误");
  assert.match(document.querySelector(".tool-details-body").textContent, /SyntaxError: invalid syntax/);
  assert.equal(document.querySelector(".live-caption").textContent, "1/1 项调用已返回");
});

test("zero-output HTTP stream failure shows a safe recovery card instead of an empty waiting workflow", () => {
  let retries = 0;
  let settings = 0;
  const { document, state, render } = fixture("zero-error", "", {
    retry: () => retries++,
    openSettings: () => settings++
  });
  const error = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "Upstream HTTP/2 stream failed",
    content: [{ type: "text", text: "\n" }]
  };
  state.detail.runtimeEvents.push(
    update("text_delta", 0, { delta: "" }),
    { type: "message_end", message: error },
    { type: "turn_end", message: error }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "failed";
  state.detail.task.lastError = error.errorMessage;
  render([user, error]);
  const alert = document.querySelector('[role="alert"]');
  assert.match(alert.textContent, /模型连接中断/);
  assert.match(alert.textContent, /已保留|重试/);
  assert.doesNotMatch(alert.textContent, /Upstream|HTTP\/2|等待继续/);
  assert.equal(document.querySelectorAll(".live-workflow").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  assert.equal(retries, 0);
  document.querySelector("[data-retry-request]").click();
  document.querySelector("[data-error-settings]").click();
  assert.equal(retries, 1);
  assert.equal(settings, 1);
});

test("a latest stopped assistant error exposes recovery before task status polling catches up and retains partial thought", () => {
  const { document, state, render } = fixture("partial-error", "已经读取输入约束。");
  document.querySelector(".reasoning-details").open = true;
  const error = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "Upstream HTTP/2 stream failed",
    content: [{ type: "thinking", thinking: "已经读取输入约束。" }]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: error },
    { type: "turn_end", message: error }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, error]);
  assert.match(document.querySelector('[role="alert"]')?.textContent || "", /模型连接中断/);
  assert.equal(document.querySelector(".reasoning-details").open, true);
  assert.equal(document.querySelector(".reasoning-copy").textContent, "已经读取输入约束。");
  assert.match(document.querySelector(".reasoning-state").textContent, /思考已停止/);
  assert.doesNotMatch(document.querySelector(".live-workflow-head").textContent, /等待继续|已完成/);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
});

test("recovery buttons belong to their rendered task and cannot act on a newer selection", () => {
  const retries = [];
  let settings = 0;
  const { document, state, render } = fixture("recovery-owner-a", "", {
    retry: (taskId) => retries.push(taskId),
    openSettings: () => settings++
  });
  const error = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "401 Authentication failed",
    content: []
  };
  state.detail.runtime.active = false;
  state.detail.task.status = "failed";
  render([user, error]);
  const staleRetry = document.querySelector("[data-retry-request]");
  const staleSettings = document.querySelector("[data-error-settings]");
  staleRetry.click();
  assert.deepEqual(retries, ["recovery-owner-a"]);
  state.selected = "recovery-owner-b";
  state.detail = {
    task: { taskId: state.selected, status: "failed", lastError: error.errorMessage },
    runtime: { active: false },
    runtimeEvents: []
  };
  staleRetry.click();
  staleSettings.click();
  assert.deepEqual(retries, ["recovery-owner-a"]);
  assert.equal(settings, 0);
  render([user, error]);
  assert.equal(document.querySelector("[data-recovery-task]").dataset.recoveryTask, "recovery-owner-b");
  document.querySelector("[data-retry-request]").click();
  assert.deepEqual(retries, ["recovery-owner-a", "recovery-owner-b"]);
});

test("failure recovery never exposes unknown raw provider errors containing credential-like text", () => {
  const { document, state, render } = fixture("safe-error", "");
  state.detail.runtime.active = false;
  state.detail.task.status = "failed";
  state.detail.task.lastError = "Provider refused request Authorization: Bearer sk-test-synthetic-never-real";
  render();
  assert.match(document.querySelector('[role="alert"]').textContent, /任务失败/);
  assert.doesNotMatch(
    document.querySelector("#conversation").innerHTML,
    /Authorization|Bearer|sk-test-synthetic/
  );
});

test("a current Main-process failure uses its ledger layer without blaming model settings", () => {
  const { document, state, render } = fixture("process-error", "");
  state.detail.runtime.active = false;
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "current-run",
    lastError: "Main process exited with code=503 signal= private-process-detail"
  };
  state.detail.events = [
    {
      runId: "old-run",
      type: "main.run_failed",
      payload: { failure: { kind: "model_request", httpStatus: 401 } }
    },
    { runId: "current-run", type: "main.run_failed", payload: { failure: { kind: "main_process" } } }
  ];
  render();
  assert.equal(document.querySelector('[role="alert"] strong').textContent, "执行进程退出");
  assert.match(document.querySelector('[role="alert"]').textContent, /手动重试继续/);
  assert.equal(document.querySelectorAll("[data-error-settings]").length, 0);
  assert.doesNotMatch(
    document.querySelector('[role="alert"]').textContent,
    /模型|503|private-process-detail/
  );
});

test("a launch failure with no saved messages still exposes recovery after reloading", () => {
  const { document, state, render } = fixture("empty-process-error", "");
  state.detail.runtime = { active: false };
  state.detail.runtimeEvents = [];
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "failed-launch",
    lastError: "spawn ENOENT private-path"
  };
  state.detail.events = [
    { runId: "failed-launch", type: "main.run_failed", payload: { failure: { kind: "main_process" } } }
  ];
  render([]);
  assert.equal(document.querySelectorAll(".welcome-empty").length, 0);
  assert.equal(document.querySelector('[role="alert"] strong').textContent, "执行进程退出");
  assert.equal(document.querySelectorAll("[data-retry-request]").length, 1);
  assert.doesNotMatch(
    document.querySelector('[role="alert"]').textContent,
    /你发送的内容|已有过程|private-path/
  );
});

test("typed model failures use only actual HTTP evidence and hide private unclassified details", () => {
  for (const [httpStatus, message] of [
    [400, "请求参数"],
    [401, "认证失败"],
    [403, "访问权限"],
    [404, "API 地址"],
    [429, "限流"],
    [503, "暂时不可用"],
    [undefined, "原因尚未确定"]
  ]) {
    const { document, state, render } = fixture(`model-error-${httpStatus}`, "");
    state.detail.runtime.active = false;
    state.detail.task = {
      ...state.detail.task,
      status: "failed",
      activeRunId: "current-run",
      lastError: "Provider refused Authorization: Bearer sk-test-synthetic-status-401-private"
    };
    state.detail.events = [
      {
        runId: "current-run",
        type: "main.run_failed",
        payload: { failure: { kind: "model_request", ...(httpStatus ? { httpStatus } : {}) } }
      }
    ];
    render();
    assert.equal(document.querySelector('[role="alert"] strong').textContent, "模型请求未完成");
    assert.ok(document.querySelector('[role="alert"]').textContent.includes(message));
    assert.equal(document.querySelectorAll("[data-error-settings]").length, 1);
    assert.doesNotMatch(
      document.querySelector('[role="alert"]').textContent,
      /Bearer|sk-test-synthetic|private/
    );
    if (!httpStatus)
      assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /认证失败|限流|暂时不可用/);
  }
});

test("another run's typed failure cannot classify the selected run's legacy error", () => {
  const { document, state, render } = fixture("legacy-error", "");
  state.detail.runtime.active = false;
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "current-run",
    lastError: "unknown private detail"
  };
  state.detail.events = [
    { runId: "older-run", type: "main.run_failed", payload: { failure: { kind: "main_process" } } }
  ];
  render();
  assert.equal(document.querySelector('[role="alert"] strong').textContent, "任务失败");
  assert.equal(document.querySelectorAll("[data-error-settings]").length, 1);
  assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /private detail/);
});

test("a typed model-not-found failure explains account availability without disclosing provider details", () => {
  const { document, state, render } = fixture("model-not-found", "");
  state.detail.runtime.active = false;
  state.detail.task = {
    ...state.detail.task,
    status: "failed",
    activeRunId: "current-run",
    lastError: '404: {"type":"model_not_found","message":"Bearer sk-test-synthetic-private"}'
  };
  state.detail.events = [
    {
      runId: "current-run",
      type: "main.run_failed",
      payload: { failure: { kind: "model_request", httpStatus: 404, providerCode: "model_not_found" } }
    }
  ];
  render();
  const alert = document.querySelector('[role="alert"]').textContent;
  assert.match(alert, /账号或分组.*HTTP 404.*可用状态/);
  assert.doesNotMatch(alert, /Bearer|sk-test-synthetic|输出上限|推理参数/);
  assert.equal(document.querySelectorAll("[data-retry-request]").length, 1);
});

test("an older errored event cannot overwrite a newer successful assistant snapshot", () => {
  const { document, state, render } = fixture("older-error", "");
  const old = {
    role: "assistant",
    timestamp: 2,
    stopReason: "error",
    errorMessage: "Upstream HTTP/2 stream failed",
    content: []
  };
  const latest = {
    role: "assistant",
    timestamp: 3,
    stopReason: "stop",
    content: [{ type: "text", text: "已恢复并检查完成。" }]
  };
  state.detail.runtimeEvents.push({ type: "message_end", message: old }, { type: "turn_end", message: old });
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, old, latest]);
  assert.equal(document.querySelectorAll('[role="alert"]').length, 0);
});

test("cancelled, aborted, successful completion and an active retry do not report a stale model failure", () => {
  for (const [status, stopReason, active] of [
    ["cancelled", "error", false],
    ["waiting", "aborted", false],
    ["completed", "stop", false],
    ["failed", "error", true]
  ]) {
    const { document, state, render } = fixture(`not-error-${status}-${active}`, "");
    const message = {
      role: "assistant",
      timestamp: 2,
      stopReason,
      errorMessage: "Upstream HTTP/2 stream failed",
      content: stopReason === "stop" ? [{ type: "text", text: "任务已完成。" }] : []
    };
    state.detail.runtimeEvents.push({ type: "message_end", message }, { type: "turn_end", message });
    state.detail.runtime.active = active;
    state.detail.task.status = status;
    state.detail.task.lastError = "Upstream HTTP/2 stream failed";
    render([user, message]);
    assert.equal(document.querySelectorAll('[role="alert"]').length, 0, `${status}/${stopReason}/${active}`);
    assert.equal(
      document.querySelectorAll('[data-answer-kind="final"]').length,
      status === "completed" ? 1 : 0
    );
  }
});

test("the actual model's bold planning heading is plain in the summary and formatted when expanded", () => {
  const thought =
    "**Planning project inspection and testing**\nI should read the project instructions first.";
  const { document } = fixture("markdown-preview", thought);
  assert.equal(
    document.querySelector(".reasoning-preview").textContent,
    "Planning project inspection and testing"
  );
  assert.equal(
    document.querySelector(".reasoning-copy strong").textContent,
    "Planning project inspection and testing"
  );
  assert.match(
    document.querySelector(".reasoning-copy").textContent,
    /I should read the project instructions first\./
  );
  assert.equal(document.querySelector(".activity-raw-copy").textContent, thought);
  assert.equal(document.querySelector(".reasoning-details").open === true, false);
});

test("later streamed sentences do not replace the preview or the user's expansion choice", () => {
  const { document, state, render } = fixture("preview-stream", "先核对文件路径。");
  document.querySelector(".reasoning-details").open = true;
  for (const character of "接着检查文件权限与内容。") {
    state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: character }));
    render();
    assert.equal(document.querySelector(".reasoning-preview")?.textContent, "先核对文件路径。");
    assert.equal(document.querySelector(".reasoning-details").open, true);
  }
  assert.equal(
    document.querySelector(".reasoning-copy").textContent,
    "先核对文件路径。接着检查文件权限与内容。"
  );
});

test("empty thought blocks have a running indication without an empty or invented preview", () => {
  const { document, state, render } = fixture("preview-empty", " \n ");
  assert.equal(document.querySelectorAll(".reasoning-details").length, 0);
  assert.equal(document.querySelectorAll(".reasoning-preview").length, 0);
  assert.match(document.querySelector(".reasoning-step").textContent, /思考中/);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 1);
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "真正的第一句。后续过程。" }));
  render();
  assert.equal(document.querySelector(".reasoning-preview")?.textContent, "真正的第一句。");
});

test("long or HTML-like thinking stays plain in the preview and complete in the expanded body", () => {
  const thought = `<img src=x onerror=alert(1)> ${"核对输入".repeat(30)}。后续说明。`;
  const { document } = fixture("preview-plain", thought);
  const preview = document.querySelector(".reasoning-preview");
  assert.equal(preview.querySelector("img"), null);
  assert.equal(Array.from(preview.textContent).length, 88);
  assert.equal(preview.textContent.endsWith("…"), true);
  assert.equal(document.querySelector(".reasoning-copy").textContent, thought);
});

test("a recovered final snapshot derives its preview and keeps thought text out of the final answer", () => {
  const { document, state, render } = fixture("preview-history", "");
  const thought = "```js\nconst path = 'local.txt';\n```\n读取后继续检查。";
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: thought },
      { type: "text", text: "已经检查完成。" }
    ]
  };
  state.detail.runtimeEvents = [
    { type: "turn_start" },
    { type: "message_start", message: user },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  ];
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, answer]);
  assert.equal(document.querySelector(".reasoning-preview")?.textContent, "const path = 'local.txt';");
  assert.equal(document.querySelector(".reasoning-copy pre code").textContent, "const path = 'local.txt';");
  assert.match(document.querySelector(".reasoning-copy").textContent, /读取后继续检查。/);
  assert.equal(document.querySelector(".activity-raw-copy").textContent, thought);
  assert.equal(answer.content[0].thinking, thought);
  assert.equal(document.querySelector(".execution-history").open === true, false);
  assert.doesNotMatch(document.querySelector('[data-answer-kind="final"]').textContent, /const path|读取后/);
});

test("an expanded live thought stays open through deltas and a user's collapse survives polling", () => {
  const { document, state, render } = fixture();
  document.querySelector(".reasoning-details").open = true;
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "再核对第二部分。" }));
  render();
  assert.equal(document.querySelector(".reasoning-details").open, true);
  assert.match(document.querySelector(".reasoning-copy").textContent, /先核对第一部分。再核对第二部分。/);
  document.querySelector(".reasoning-details").open = false;
  render();
  assert.equal(document.querySelector(".reasoning-details").open, false);
});

test("thought blocks retain independent expansion before and after a tool and completion folds only the outer history", () => {
  const { document, state, render } = fixture();
  document.querySelector(".reasoning-details").open = true;
  state.detail.runtimeEvents.push(
    update("thinking_end", 0, { content: "先核对第一部分。" }),
    update("toolcall_end", 1, {
      toolCall: { id: "inspect", name: "read", arguments: { path: "fixture.txt" } }
    }),
    { type: "tool_execution_start", toolCallId: "inspect", toolName: "read" },
    { type: "tool_execution_end", toolCallId: "inspect", toolName: "read", result: "已读" },
    update("thinking_start", 2),
    update("thinking_delta", 2, { delta: "根据工具结果核对第二部分。" })
  );
  render();
  let blocks = [...document.querySelectorAll(".reasoning-details")];
  assert.deepEqual(
    blocks.map((node) => node.open === true),
    [true, false]
  );
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 1);
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "先核对第一部分。" },
      { type: "toolCall", id: "inspect", name: "read", arguments: { path: "fixture.txt" } },
      { type: "thinking", thinking: "根据工具结果核对第二部分。" },
      { type: "text", text: "核对完成。" }
    ]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, answer]);
  assert.equal(document.querySelector(".execution-history").open === true, false);
  document.querySelector(".execution-history").open = true;
  blocks = [...document.querySelectorAll(".reasoning-details")];
  assert.deepEqual(
    blocks.map((node) => node.open === true),
    [true, false]
  );
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
});

test("leaving a thought for an empty conversation preserves its expansion without leaking into another task", () => {
  const { document, state, render } = fixture();
  const first = state.detail;
  document.querySelector(".reasoning-details").open = true;
  state.selected = "reasoning-two";
  state.detail = { ...first, task: { ...first.task, taskId: state.selected } };
  render([]);
  render();
  assert.equal(document.querySelector(".reasoning-details").open === true, false);
  state.selected = "reasoning-one";
  state.detail = first;
  render();
  assert.equal(document.querySelector(".reasoning-details").open, true);
});

test("thought reading positions and independent follow-up choices survive updates", () => {
  const { document, state, render } = fixture();
  document.querySelector(".reasoning-details").open = true;
  const copy = document.querySelector(".reasoning-copy");
  copy.scrollTop = 37;
  copy.scrollLeft = 12;
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "继续核对。" }));
  render();
  assert.equal(document.querySelector(".reasoning-copy").scrollTop, 37);
  assert.equal(document.querySelector(".reasoning-copy").scrollLeft, 12);
  const answer = {
    role: "assistant",
    timestamp: 2,
    content: [
      { type: "thinking", thinking: "先核对第一部分。继续核对。" },
      { type: "text", text: "第一轮完成。" }
    ]
  };
  const followUp = { ...user, timestamp: 3 };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer },
    { type: "turn_start" },
    { type: "message_start", message: followUp },
    { type: "message_start", message: { role: "assistant", timestamp: 4, content: [] } },
    update("thinking_delta", 0, { delta: "合成追问思考。" })
  );
  render([user, answer, followUp]);
  const blocks = [...document.querySelectorAll(".reasoning-details")];
  assert.deepEqual(
    blocks.map((node) => node.open === true),
    [true, false]
  );
  assert.notEqual(blocks[0].dataset.activityKey, blocks[1].dataset.activityKey);
});

test("an interrupted thought retains its text without a spinner or a completed label", () => {
  const { document, state, render } = fixture();
  const stopped = {
    role: "assistant",
    timestamp: 2,
    stopReason: "aborted",
    content: [{ type: "thinking", thinking: "先核对第一部分。" }]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: stopped },
    { type: "turn_end", message: stopped }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, stopped]);
  assert.match(document.querySelector(".reasoning-step").textContent, /思考已停止/);
  assert.match(document.querySelector(".reasoning-copy").textContent, /先核对第一部分。/);
  assert.equal(document.querySelectorAll(".thinking-spinner").length, 0);
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 0);
});

test("a final answer split into text blocks appears once after persistence catches up", () => {
  const { document, state, render } = fixture();
  const answer = {
    role: "assistant",
    timestamp: 2,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "先核对第一部分。" },
      { type: "text", text: "核对" },
      { type: "text", text: "完成。" }
    ]
  };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user]);
  assert.match(document.querySelector(".live-workflow").textContent, /核对完成。/);
  assert.equal(document.querySelectorAll(".execution-history").length, 0);
  render([user, answer]);
  assert.equal(document.querySelectorAll(".execution-history").length, 1);
  assert.equal(document.querySelectorAll(".execution-history .live-workflow-head").length, 0);
  assert.equal(document.querySelectorAll(".live-answer").length, 0);
  assert.equal(document.querySelector('[data-answer-kind="final"]').textContent.includes("核对完成。"), true);
});

test("tool progress, empty completion and interruption render their actual lifecycle", () => {
  const { document, state, render } = fixture();
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "inspect", name: "read", arguments: { path: "fixture.txt" } }
    }),
    { type: "tool_execution_start", toolCallId: "inspect", toolName: "read" },
    { type: "tool_execution_update", toolCallId: "inspect", partialResult: "读取了第一段。" }
  );
  render();
  assert.equal(document.querySelector(".tool-step").classList.contains("is-running"), true);
  assert.equal(document.querySelector(".activity-status").textContent, "执行中");
  state.detail.runtimeEvents.push({ type: "tool_execution_end", toolCallId: "inspect", result: "" });
  render();
  assert.equal(document.querySelector(".tool-step").classList.contains("is-done"), true);
  state.detail.runtimeEvents.push({ type: "tool_execution_start", toolCallId: "second", toolName: "bash" });
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render();
  assert.equal(document.querySelectorAll(".tool-step.is-running").length, 0);
  assert.equal(document.querySelectorAll(".activity-status")[1].textContent, "已停止");
});

test("the final response leaves an earlier identical update in the execution history", () => {
  const { document, state, render } = fixture();
  const updateMessage = {
    role: "assistant",
    timestamp: 2,
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "先核对第一部分。" },
      { type: "text", text: "已经核对完成。" }
    ]
  };
  const answer = { ...updateMessage, timestamp: 3, stopReason: "stop" };
  state.detail.runtimeEvents.push(
    { type: "message_end", message: updateMessage },
    { type: "message_start", message: { ...answer, content: [] } },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer }
  );
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  render([user, updateMessage, answer]);
  assert.equal(document.querySelectorAll(".execution-history").length, 1);
  assert.equal(document.querySelectorAll(".live-answer").length, 1);
  assert.equal(document.querySelector(".live-answer").textContent, "已经核对完成。");
  assert.equal(document.querySelectorAll('[data-answer-kind="final"]').length, 1);
});

test("saved plain text from a stopped request remains visible without runtime logs", () => {
  const { document, state, render } = fixture();
  state.detail.runtimeEvents = [];
  state.detail.runtime.active = false;
  state.detail.task.status = "waiting";
  render([user, { role: "assistant", content: "还有一部分需要核对。", stopReason: "aborted", timestamp: 2 }]);
  assert.match(document.querySelector("#conversation").textContent, /还有一部分需要核对。/);
});

test("upload filenames and thumbnails render without exposing prompt metadata or executing filename markup", () => {
  const { document, state, render } = fixture("uploaded-files", "");
  const id = "upload-00000000-0000-0000-0000-000000000000";
  const source =
    "用户原话" +
    "\n\n<atria_uploaded_files>\n" +
    JSON.stringify({
      version: 1,
      files: [
        {
          uploadId: id,
          name: "<img src=x onerror=alert(1)>.png",
          kind: "image",
          path: "/private/inputs/original.png"
        }
      ]
    }) +
    "\n</atria_uploaded_files>";
  state.detail.runtimeEvents = [];
  render([{ role: "user", content: source, timestamp: 1 }]);
  const attachments = document.querySelector(".message-attachments");
  assert.ok(attachments);
  assert.equal(attachments.querySelectorAll("img").length, 1);
  const image = attachments.querySelector("img");
  assert.equal(image.getAttribute("data-upload-src"), id);
  assert.equal(image.getAttribute("src"), null);
  assert.equal(attachments.querySelector("[data-upload-preview]").getAttribute("data-upload-preview"), id);
  assert.equal(
    attachments.querySelector("[data-upload-preview]").textContent,
    "<img src=x onerror=alert(1)>.png"
  );
  assert.doesNotMatch(
    document.querySelector("#conversation").textContent,
    /atria_uploaded_files|private\/inputs/
  );
});

test("an async delegation row follows real progress without changing its disclosure identity", () => {
  const { document, state, render } = fixture("async-status", "");
  state.detail.runtimeEvents.push(
    update("toolcall_end", 1, {
      toolCall: { id: "dispatch", name: "call_subagent", arguments: { task: "核对机构", mode: "async" } }
    }),
    {
      type: "tool_execution_end",
      toolCallId: "dispatch",
      result: { details: { accepted: true, callId: "call-one", name: "Ara" } }
    }
  );
  state.detail.coordination = { calls: [{ callId: "call-one", status: "running" }], pending: ["call-one"] };
  render();
  let row = document.querySelector(".tool-details");
  row.open = true;
  assert.equal(row.querySelector(".activity-status").textContent, "协作运行中");
  assert.match(document.querySelector(".live-caption").textContent, /1 项协作未结束/);
  state.detail.runtime.active = false;
  render();
  row = document.querySelector(".tool-details");
  assert.equal(row.open, true);
  assert.equal(document.querySelector(".live-workflow-head strong").textContent, "仍有工作未结束");
  state.detail.coordination = {
    calls: [{ callId: "call-one", status: "completed" }],
    callbackPending: ["call-one"]
  };
  render();
  assert.equal(row.querySelector(".activity-status").textContent, "结果待接收");
  state.detail.coordination.callbackPending = [];
  render();
  assert.equal(document.querySelector(".tool-details"), row);
  assert.equal(row.open, true);
  assert.equal(row.querySelector(".activity-status").textContent, "协作完成");
});

test("an ended question and queued message use action-specific labels", () => {
  const { document, state, render } = fixture("action-status", "");
  for (const [index, name, data] of [
    [1, "askhuman", { status: "timeout" }],
    [2, "send_subagent_message", { status: "queued", messageId: "message" }]
  ])
    state.detail.runtimeEvents.push(
      update("toolcall_end", index, {
        toolCall: { id: name, name, arguments: { question: "怎么展示？", message: "检查行程" } }
      }),
      { type: "tool_execution_end", toolCallId: name, result: { details: data } }
    );
  render();
  assert.deepEqual(
    [...document.querySelectorAll(".activity-status")].map((node) => node.textContent),
    ["未答复，已继续", "已入队"]
  );
  assert.doesNotMatch(document.querySelector(".workflow-rail").textContent, /已完成|等待你的答复/);
});

test("retry status is visible even before content arrives and clears after recovery", () => {
  const { document, state, render } = fixture("retry-visible", "");
  state.detail.runtimeEvents = [
    { type: "message_start", message: user },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "524 status code (no body)" }
  ];
  render();
  assert.match(document.querySelector('[role="status"]').textContent, /HTTP 524.*正在重试/);
  assert.equal(document.querySelectorAll('[role="status"]').length, 1);
  assert.match(document.querySelector('[role="status"]').textContent, /1 \/ 3/);
  state.detail.runtimeEvents.push({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    errorMessage: "524 status code (no body)"
  });
  render();
  assert.match(document.querySelector('[role="status"]').textContent, /2 \/ 3/);
  state.detail.runtimeEvents.push({ type: "auto_retry_end", success: true });
  render();
  assert.equal(document.querySelector(".request-retry"), null);
});

test("cancelled earlier requests stay incomplete after a later request succeeds", () => {
  const { document, state, render } = fixture("cancel-history", "正在执行");
  const partial = { role: "assistant", content: "接下来将创建文稿。", stopReason: "toolUse", timestamp: 2 };
  const followup = { role: "user", content: "先创建空白文稿", timestamp: 3 };
  const answer = { role: "assistant", content: "已创建", stopReason: "stop", timestamp: 4 };
  state.detail.runtime.active = false;
  state.detail.task.status = "completed";
  state.detail.runtimeEvents.push(
    { type: "message_end", message: partial },
    { type: "main.run_cancelled", runId: "first", payload: { reason: "ui_cancel" } },
    { type: "message_start", message: followup },
    { type: "message_end", message: answer },
    { type: "turn_end", message: answer },
    { type: "main.run_completed", runId: "second" }
  );
  render([user, partial, followup, answer]);
  const workflows = document.querySelectorAll(".live-workflow");
  assert.match(workflows[0].textContent, /执行已停止/);
  assert.match(workflows[0].textContent, /整轮任务未完成/);
  assert.doesNotMatch(workflows[0].textContent, /整轮任务已完成/);
  assert.match(document.querySelector('[data-answer-kind="final"]').textContent, /已创建/);
});

test("latest accepted user has an accessible edit button in completed and failed states, owned by its rendered task", () => {
  const edited = [];
  const { document, state, render } = fixture("edit-task", "", { edit: (...args) => edited.push(args) });
  const messages = [
    { ...user, id: "old-user" },
    { role: "assistant", content: "old answer", timestamp: 2 },
    { ...user, id: "latest-user", content: "latest request", timestamp: 3 }
  ];
  state.detail.runtimeEvents = [];
  state.detail.runtime.active = false;
  state.detail.editableMessage = {
    messageId: "latest-user",
    versionId: "version",
    runId: "run",
    body: "latest request",
    attachments: []
  };
  for (const status of ["completed", "failed"]) {
    state.detail.task.status = status;
    render(messages);
    const buttons = document.querySelectorAll("[data-edit-message]");
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].getAttribute("type"), "button");
    assert.equal(buttons[0].getAttribute("aria-label"), "编辑消息");
    buttons[0].click();
  }
  assert.equal(edited.length, 2);
  state.selected = "other-task";
  document.querySelector("[data-edit-message]").click();
  assert.equal(edited.length, 2);
});

test("a restored inline draft stays reachable when another branch replaces its original message", () => {
  const editingMessageId = "saved-user";
  const { document, state, render } = fixture("restored-edit", "", {
    messageEdit: {
      editingMessageId,
      markup: (_taskId, messageId) =>
        messageId === editingMessageId ? "<textarea data-inline-message-edit>保留的编辑草稿</textarea>" : "",
      bind() {}
    }
  });
  state.detail.runtime.active = false;
  state.detail.runtimeEvents = [];
  render([{ ...user, id: "new-branch-user", content: "另一窗口提交的消息" }]);
  assert.equal(document.querySelectorAll("[data-inline-message-edit]").length, 1);
  assert.match(document.querySelector(".is-editing").textContent, /保留的编辑草稿/);
  render([{ ...user, id: editingMessageId }]);
  assert.equal(document.querySelectorAll("[data-inline-message-edit]").length, 1);
  assert.equal(document.querySelectorAll(".chat-message.user").length, 1);
  render([]);
  assert.equal(document.querySelectorAll("[data-inline-message-edit]").length, 1);
});

test("cached earlier replies refresh after edits, disclosure changes and external lifecycle changes", () => {
  const { document, state, render } = fixture("cached-history", "");
  const first = { ...user, id: "first" };
  const answer = { role: "assistant", timestamp: 2, content: "original **answer**" };
  const next = { role: "user", id: "next", timestamp: 3, content: "next request" };
  state.detail.runtimeEvents = [
    { type: "message_start", message: first },
    { type: "message_start", message: answer },
    { type: "message_end", message: answer },
    { type: "main.run_completed" },
    { type: "message_start", message: next }
  ];
  const messages = [first, answer, next];
  render(messages);
  render(messages);
  const reply = document.querySelector('.chat-message[data-answer-kind="final"]');
  assert.match(reply.textContent, /original answer/);
  state.detail.runtimeEvents.push(update("thinking_delta", 0, { delta: "live delta" }));
  render(messages);
  assert.equal(document.querySelector('.chat-message[data-answer-kind="final"]'), reply);
  answer.content = "revised answer";
  state.detail.conversationVersion = 2;
  render(messages);
  assert.match(
    document.querySelector('.chat-message[data-answer-kind="final"]').textContent,
    /revised answer/
  );
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /original answer/);
  state.detail.editableMessage = { messageId: "first" };
  render(messages);
  assert.ok(document.querySelector("[data-edit-message]"));
  state.selected = "other";
  state.detail.task = { taskId: "other", status: "running" };
  state.detail.runtimeEvents = [];
  render([{ role: "user", content: "other request", timestamp: 10 }]);
  assert.doesNotMatch(document.querySelector("#conversation").textContent, /revised answer/);
});
