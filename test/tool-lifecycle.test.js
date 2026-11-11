import assert from "node:assert/strict";
import { test } from "node:test";
import { presentToolCall } from "../web/assets/tool-presentation.js";
import { outstandingWork } from "../web/assets/tool-lifecycle.js";
import { finalAnswerIndex } from "../web/assets/conversation.js";

const call = {
  name: "call_subagent",
  arguments: { task: "核对机构", mode: "async" },
  completed: true,
  durationMs: 20,
  rawResult: { details: { accepted: true, callId: "one", name: "Ara" } }
};
const present = (status, extra = {}) =>
  presentToolCall(call, {
    active: false,
    detail: {
      coordination: { calls: [{ callId: "one", status }], ...extra }
    }
  });

test("asynchronous dispatch return is never completion, including historical logs without live snapshots", () => {
  assert.equal(presentToolCall(call).statusLabel, "已派发");
  assert.equal(presentToolCall(call).durationMs, undefined);
  for (const [status, label] of [
    ["queued", "协作排队中"],
    ["leased", "协作运行中"],
    ["running", "协作运行中"],
    ["waiting", "协作等待中"]
  ]) {
    assert.equal(present(status).statusLabel, label);
    assert.notEqual(present(status).status, "completed");
  }
});

test("delegated work completes only after terminal evidence and callback delivery", () => {
  assert.equal(present("completed", { callbackPending: ["one"] }).statusLabel, "结果待接收");
  assert.equal(present("completed").statusLabel, "协作完成");
  assert.equal(present("failed").statusLabel, "协作失败");
  assert.equal(present("cancelled").statusLabel, "协作已取消");
  assert.equal(
    presentToolCall(call, { detail: { progress: { agents: [{ callId: "one", status: "timed_out" }] } } })
      .statusLabel,
    "协作超时"
  );
  assert.equal(
    presentToolCall({ ...call, arguments: { mode: "sync" }, rawResult: { details: { status: "succeeded" } } })
      .statusLabel,
    "协作完成"
  );
});

test("a returned business payload cannot change generic tool lifecycle", () => {
  assert.equal(
    presentToolCall({
      name: "read",
      completed: true,
      rawResult: { details: { status: "running", accepted: true } }
    }).statusLabel,
    "调用完成"
  );
  assert.equal(presentToolCall({ ...call, failed: true }).statusLabel, "调用失败");
});

test("question result distinguishes answers, timeout fallback and cancellation", () => {
  for (const [status, label] of [
    ["answered", "已答复"],
    ["timeout", "未答复，已继续"],
    ["cancelled", "询问已取消"]
  ]) {
    const row = presentToolCall({ name: "askhuman", completed: true, rawResult: { details: { status } } });
    assert.equal(row.title, "询问你的意见");
    assert.equal(row.statusLabel, label);
  }
  assert.equal(presentToolCall({ name: "askhuman" }).statusLabel, "等待答复");
});

test("queued guidance never claims the collaborator has finished acting on it", () => {
  for (const [delivered, label] of [
    [undefined, "已入队"],
    ["not_delivered", "未送达"],
    ["too_late", "未送达"],
    ["unblocked_waiting_subagent", "已解答"]
  ])
    assert.equal(
      presentToolCall({
        name: "send_subagent_message",
        completed: true,
        rawResult: { details: { delivered } }
      }).statusLabel,
      label
    );
});

test("background jobs use live process evidence and unknown exits never imply success", () => {
  const jobCall = {
    name: "start_job",
    completed: true,
    rawResult: { details: { jobId: "job-1", logPath: "/one/log" } }
  };
  assert.equal(presentToolCall(jobCall).statusLabel, "已启动后台任务");
  for (const [job, label] of [
    [{ state: "running" }, "后台运行中"],
    [{ state: "exited", exitCode: 0 }, "后台任务完成"],
    [{ state: "exited", exitCode: 2 }, "后台任务失败"],
    [{ state: "exited", signal: "SIGTERM" }, "后台任务已停止"],
    [{ state: "exited" }, "已退出，结果待核实"]
  ]) {
    const options = { active: false, detail: { jobs: [{ jobId: "job-1", logPath: "/one/log", ...job }] } };
    assert.equal(presentToolCall(jobCall, options).statusLabel, label);
  }
  assert.equal(
    presentToolCall(jobCall, {
      detail: { jobs: [{ jobId: "job-1", logPath: "/other/log", state: "exited", exitCode: 0 }] }
    }).statusLabel,
    "已启动后台任务"
  );
});

test("coordination wait timeout is still waiting, rather than successful work completion", () => {
  for (const [data, label] of [
    [{ pending: ["one"] }, "协作仍在运行"],
    [{ callbackPending: ["one"] }, "结果待接收"],
    [{ pending: [], callbackPending: [] }, "等待已结束"]
  ])
    assert.equal(
      presentToolCall({ name: "wait_for_subagents", completed: true, rawResult: { details: data } })
        .statusLabel,
      label
    );
});

test("outstanding work deduplicates live snapshots and blocks final presentation on stale completed tasks", () => {
  const detail = {
    task: { status: "completed" },
    runtime: { active: false },
    coordination: { calls: [{ callId: "one", status: "running" }], pending: ["one"] },
    progress: { agents: [{ callId: "one", status: "running", callbackPending: true }] },
    jobs: [{ state: "running" }],
    humanRequests: [{ status: "pending" }]
  };
  assert.deepEqual(outstandingWork(detail), { agents: 1, callbacks: 1, jobs: 1, human: 1 });
  assert.equal(finalAnswerIndex([{ role: "assistant", content: "尚有任务在运行" }], detail), -1);
});

test("old dispatches recover completion from durable callbacks without borrowing another call's result", () => {
  const detail = {
    runtimeEvents: [
      {
        type: "runtime_event",
        payload: {
          type: "message_end",
          message: { customType: "cowork-callback", details: { callId: "one", status: "succeeded" } }
        }
      }
    ]
  };
  assert.equal(presentToolCall(call, { detail }).statusLabel, "协作完成");
  assert.equal(
    presentToolCall({ ...call, rawResult: { details: { accepted: true, callId: "other" } } }, { detail })
      .statusLabel,
    "已派发"
  );
});

test("an interrupted question does not remain waiting unless a durable human request is still pending", () => {
  assert.equal(
    presentToolCall({ name: "askhuman", arguments: { question: "选择？" } }, { active: false }).statusLabel,
    "已停止"
  );
  assert.equal(
    presentToolCall(
      { name: "askhuman", arguments: { question: "选择？" } },
      { active: false, detail: { humanRequests: [{ question: "选择？", status: "pending" }] } }
    ).statusLabel,
    "等待答复"
  );
});

test("a historical timed-out wait follows its collaborators without borrowing unrelated work", () => {
  const call = { name: "wait_for_subagents", completed: true, rawResult: { details: { pending: ["one"] } } };
  for (const [coordination, label] of [
    [{ calls: [{ callId: "one", status: "running" }] }, "协作仍在运行"],
    [{ calls: [{ callId: "one", status: "completed" }], callbackPending: ["one"] }, "结果待接收"],
    [
      {
        calls: [
          { callId: "one", status: "completed" },
          { callId: "other", status: "running" }
        ],
        pending: ["other"]
      },
      "等待已结束"
    ]
  ])
    assert.equal(presentToolCall(call, { detail: { coordination } }).statusLabel, label);
});
