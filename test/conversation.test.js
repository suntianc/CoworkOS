import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  messagesWithRuntimeHistory,
  readTaskRuntimeEvents,
  runtimeEventRecord,
  settledRuntimeEvents,
  viewRuntimeEvent
} from "../dist/src/runtime/conversation-history.js";
import { conversationMessages } from "../dist/src/runtime/conversation-view.js";
import {
  buildConversationExchanges,
  finalAnswerIndex,
  isMachineTurn,
  mergeRuntimeEvents,
  exchangeExecutionState,
  runtimeLogMarks,
  streamRecordKey,
  SUPERVISOR_WAKE_TURN
} from "../web/assets/conversation.js";
import { SUPERVISOR_WAKE_TURN as RUNTIME_WAKE_TURN } from "../dist/src/runtime/main-supervisor.js";
import { buildLiveActivity } from "../web/assets/activity.js";

test("a supervisor wake-up never appears as something the person said", () => {
  // The bug this pins, seen in a real transcript: after answering a question,
  // "Resume this task from its durable state: consume the pending Inbox
  // messages and continue." appeared as a user message. Pi needs a turn to
  // start running, so a relaunch has to send one — but nobody said it, and in
  // that same transcript Main went looking for who had asked it to consume an
  // Inbox.
  assert.equal(
    RUNTIME_WAKE_TURN,
    SUPERVISOR_WAKE_TURN,
    "the runtime's wake turn and the browser's copy must match, or the filter silently stops working"
  );

  const wake = { role: "user", content: [{ type: "text", text: SUPERVISOR_WAKE_TURN }], timestamp: 3 };
  assert.equal(isMachineTurn(wake), true);
  // Something a person typed is never filtered, even if it mentions resuming.
  assert.equal(isMachineTurn({ role: "user", content: "resume 一下这个任务" }), false);
  assert.equal(isMachineTurn({ role: "assistant", content: SUPERVISOR_WAKE_TURN }), false);

  // It opens no exchange, so CoworkOS's reply stays attached to the request it is
  // actually answering rather than being split under a machine turn.
  const exchanges = buildConversationExchanges(
    [
      { role: "user", content: "帮我改一下这个文档", timestamp: 1 },
      { role: "assistant", content: "需要确认一件事", timestamp: 2 },
      wake,
      { role: "assistant", content: "已经改好了", timestamp: 4 }
    ],
    []
  );
  assert.equal(exchanges.length, 1, "one request, one exchange");
  assert.equal(exchanges[0].user.timestamp, 1);
  assert.equal(exchanges[0].messages.length, 3, "the wake turn is dropped, the replies are kept");

  // Its own activity is not lost: it lands in the exchange already in progress.
  const withEvents = buildConversationExchanges(
    [
      { role: "user", content: "改文档", timestamp: 1 },
      { role: "assistant", content: "好", timestamp: 9 }
    ],
    [
      {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "改文档" }], timestamp: 1 }
      },
      {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: SUPERVISOR_WAKE_TURN }], timestamp: 3 }
      },
      { type: "tool_execution_end", toolName: "write" }
    ]
  );
  assert.equal(withEvents.length, 1);
  assert.ok(
    withEvents[0].events.some((event) => event.toolName === "write"),
    "work done after the wake-up still belongs to the request that caused it"
  );
});

const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text, timestamp) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: `reasoning ${text}` },
    { type: "text", text }
  ],
  timestamp,
  stopReason: "stop"
});
const runEvents = (request, answer) => [
  { type: "turn_start" },
  { type: "message_start", message: request },
  { type: "message_end", message: request },
  { type: "message_start", message: { ...answer, content: [] } },
  { type: "message_end", message: answer },
  { type: "turn_end", message: answer }
];

test("Main text becomes final after natural completion and callbacks, without requiring finish_task", () => {
  const messages = [user("verify", 1), assistant("provisional", 2), assistant("verified", 3)];
  const completed = {
    task: { status: "completed", completion: { policy: "explicit", signal: "finish_task" } },
    runtime: { active: false },
    coordination: { pending: [], callbackPending: [] }
  };
  assert.equal(finalAnswerIndex(messages, completed), 2);
  assert.equal(finalAnswerIndex(messages, { ...completed, runtime: { active: true } }), -1);
  assert.equal(finalAnswerIndex(messages, { ...completed, coordination: { pending: ["one"] } }), -1);
  assert.equal(finalAnswerIndex(messages, { ...completed, coordination: { callbackPending: ["one"] } }), -1);
  assert.equal(finalAnswerIndex(messages, { ...completed, task: { status: "waiting" } }), -1);
  assert.equal(
    finalAnswerIndex(messages, {
      ...completed,
      task: { status: "completed", completion: { policy: "explicit", signal: "natural_stop" } }
    }),
    2
  );
  for (const stopReason of ["toolUse", "length", "aborted", "error"]) {
    assert.equal(
      finalAnswerIndex([...messages, { ...assistant("incomplete", 4), stopReason }], completed),
      -1,
      "an interrupted last response must not promote an earlier provisional answer"
    );
  }
  assert.equal(
    finalAnswerIndex(messages, { ...completed, runtime: { active: true } }, false),
    2,
    "new requests must not hide earlier completed replies"
  );
});

test("follow-ups keep the preceding request's activity anchored, including repeated prompts and answers", () => {
  const first = [user("continue", 1), assistant("answer", 2)];
  const second = [user("continue", 3), assistant("answer", 4)];
  const events = [...runEvents(...first), ...runEvents(...second)];
  const groups = buildConversationExchanges([...first, ...second], events);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].key, groups[1].key);
  for (const group of groups) {
    assert.equal(buildLiveActivity(group.events).length, 1);
    assert.equal(buildLiveActivity(group.events)[0].reasoning, "reasoning answer");
    assert.equal(buildLiveActivity(group.events)[0].answer, "answer");
  }
  const pending = buildConversationExchanges(
    [...first, { ...user("continue"), taskId: "task" }],
    runEvents(...first)
  );
  assert.equal(buildLiveActivity(pending[0].events)[0].reasoning, "reasoning answer");
  assert.deepEqual(pending[1].events, []);
  assert.equal(pending[0].key, groups[0].key);
});

test("saved assistant thinking remains available even without runtime logs", () => {
  const groups = buildConversationExchanges([user("one", 1), assistant("first", 2), user("two", 3)], []);
  assert.equal(buildLiveActivity(groups[0].events)[0].reasoning, "reasoning first");
  assert.deepEqual(groups[1].events, []);
});

test("stream replay deduplicates by run and event position, without dropping identical deltas", () => {
  const delta = {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ha" }
  };
  const first = runtimeEventRecord("task", "one", 0, delta);
  const repeat = runtimeEventRecord("task", "one", 1, delta);
  const nextRun = runtimeEventRecord("task", "two", 0, delta);
  assert.equal(new Set([first, repeat, nextRun].map(streamRecordKey)).size, 3);
  const merged = mergeRuntimeEvents([first], [first, repeat, nextRun]);
  assert.deepEqual(merged, [first, repeat, nextRun]);
  assert.deepEqual(mergeRuntimeEvents(merged, merged), merged);
  assert.equal(buildLiveActivity(merged.slice(0, 2))[0].reasoning, "haha");
});

test("all run logs survive an active-run change and recover an overwritten transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-conversation-"));
  try {
    const first = [user("first request", 1), assistant("first answer", 2)];
    const second = [user("second request", 3), assistant("second answer", 4)];
    for (const [runId, createdAt, messages] of [
      ["z-first", "2026-01-01", first],
      ["a-second", "2026-01-02", second]
    ]) {
      const directory = join(root, "task", "runs", runId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "run.json"), JSON.stringify({ createdAt }));
      await writeFile(
        join(directory, "runtime-output.log"),
        `diagnostic line\n${runEvents(...messages)
          .map(JSON.stringify)
          .join("\n")}\n{"partial":`
      );
    }
    const events = await readTaskRuntimeEvents(root, "task");
    assert.equal(events.length, 12);
    assert.equal(events[0].runId, "z-first");
    assert.equal(events.at(-1).runId, "a-second");
    assert.equal(events[0].eventId, "runtime-z-first-0");
    const restored = messagesWithRuntimeHistory(conversationMessages(second), events);
    assert.deepEqual(
      restored.map((message) => message.timestamp),
      [1, 2, 3, 4]
    );
    assert.equal(buildConversationExchanges(restored, events).length, 2);
    assert.deepEqual(
      messagesWithRuntimeHistory(conversationMessages([...first, ...second]), events),
      restored
    );
    assert.deepEqual(await readTaskRuntimeEvents(root, "unknown"), []);
    const repeated = conversationMessages([user("again"), assistant("yes"), user("again"), assistant("yes")]);
    assert.deepEqual(messagesWithRuntimeHistory(repeated, []), repeated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promoted queued messages remain steering messages after reload without duplicating their text", () => {
  const original = {
    type: "user.interjected",
    occurredAt: "2026-10-10T01:00:00Z",
    payload: { messageId: "q1", message: "change direction", delivery: "followUp" }
  };
  assert.equal(messagesWithRuntimeHistory([], [original])[0].pending, true);
  for (const type of ["user.message_promoted", "inbox.consumed"]) {
    const restored = messagesWithRuntimeHistory(
      [],
      [
        original,
        { type, occurredAt: "2026-10-10T01:00:01Z", payload: { messageId: "q1", delivery: "steer" } }
      ]
    );
    assert.equal(restored.length, 1);
    assert.equal(restored[0].delivery, "steer");
    assert.equal(restored[0].pending, false);
    assert.equal(restored[0].interjected, true);
  }
});

test("delivered steering input recovers its context position and identity instead of its submission time", () => {
  const before = assistant("before steering", 20);
  const after = assistant("after steering", 50);
  const delivered = {
    role: "custom",
    customType: "cowork-user-message",
    content: "Harness delivery envelope",
    timestamp: 40,
    details: { message: "try again", delivery: "steer", _coworkInbox: { messageId: "steer-context" } }
  };
  const events = [
    ...runEvents(user("start", 10), before),
    { type: "message_start", message: delivered },
    { type: "message_end", message: delivered },
    { type: "turn_start" },
    { type: "message_start", message: after },
    { type: "message_end", message: after },
    { type: "turn_end", message: after },
    {
      type: "user.interjected",
      payload: {
        messageId: "steer-context",
        message: "try again",
        delivery: "steer",
        createdAt: new Date(15).toISOString()
      }
    },
    {
      type: "inbox.consumed",
      occurredAt: new Date(41).toISOString(),
      payload: { messageId: "steer-context", delivery: "steer" }
    }
  ];
  for (const saved of [
    [],
    conversationMessages([
      user("start", 10),
      before,
      {
        ...delivered,
        role: undefined,
        type: "custom_message",
        id: "pi-custom-entry",
        timestamp: new Date(40).toISOString()
      },
      after
    ])
  ]) {
    const restored = messagesWithRuntimeHistory(saved, events);
    assert.deepEqual(
      restored.map((message) => message.timestamp),
      [10, 20, saved.length ? 40 : 41, 50]
    );
    assert.equal(restored[2].id, "steer-context");
    assert.equal(restored[2].content, "try again");
    assert.equal(restored[2].interjected, true);
    const exchanges = buildConversationExchanges(restored, events);
    assert.equal(exchanges.length, 2);
    assert.equal(exchanges[0].continued, true);
    assert.equal(buildLiveActivity(exchanges[0].events).at(-1).answer, "before steering");
    assert.equal(buildLiveActivity(exchanges[1].events).at(-1).answer, "after steering");
    assert.equal(exchanges[1].key, "steer-context");
  }
});

test("real SDK ISO steering entries retain their position while receipts are repaired later", () => {
  const session = SessionManager.inMemory("/fixture");
  session.appendCustomMessageEntry("cowork-user-message", "Harness delivery envelope", true, {
    message: "try again",
    delivery: "steer",
    _coworkInbox: { messageId: "steer-sdk" }
  });
  const sdkEntry = session.getEntries().at(-1);
  assert.equal(sdkEntry.type, "custom_message");
  assert.equal(typeof sdkEntry.timestamp, "string");
  assert.ok(Number.isFinite(Date.parse(sdkEntry.timestamp)));
  const before = assistant("before steering", 20);
  const after = assistant("after steering", 50);
  const saved = conversationMessages([
    user("start", 10),
    before,
    { ...sdkEntry, timestamp: new Date(40).toISOString() },
    after
  ]);
  const runtimeQueued = {
    role: "custom",
    customType: sdkEntry.customType,
    content: sdkEntry.content,
    timestamp: 15,
    details: sdkEntry.details
  };
  const events = [
    ...runEvents(user("start", 10), before),
    { type: "message_start", message: runtimeQueued },
    { type: "message_end", message: runtimeQueued },
    { type: "turn_start" },
    { type: "message_start", message: after },
    { type: "message_end", message: after },
    { type: "turn_end", message: after },
    {
      type: "user.interjected",
      payload: {
        messageId: "steer-sdk",
        message: "try again",
        delivery: "steer",
        createdAt: new Date(15).toISOString()
      }
    },
    {
      type: "inbox.consumed",
      occurredAt: new Date(100).toISOString(),
      payload: { messageId: "steer-sdk", delivery: "steer" }
    }
  ];
  const logs = events;
  const restored = messagesWithRuntimeHistory(saved, logs);
  assert.deepEqual(
    restored.map((message) => message.timestamp),
    [10, 20, 40, 50]
  );
  assert.equal(restored[2].id, "steer-sdk");
  assert.equal(restored[2].content, "try again");
  const exchanges = buildConversationExchanges(restored, logs);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].continued, true);
  assert.deepEqual(
    exchanges.map((exchange) => buildLiveActivity(exchange.events).at(-1).answer),
    ["before steering", "after steering"]
  );
  assert.equal(exchanges[1].key, "steer-sdk");
  const normalReceipt = events.map((event) =>
    event.type === "inbox.consumed" ? { ...event, occurredAt: new Date(41).toISOString() } : event
  );
  const old = messagesWithRuntimeHistory([], normalReceipt);
  assert.deepEqual(
    old.map((message) => message.timestamp),
    [10, 20, 41, 50]
  );
  assert.deepEqual(
    buildConversationExchanges(old, normalReceipt).map(
      (exchange) => buildLiveActivity(exchange.events).at(-1).answer
    ),
    ["before steering", "after steering"]
  );
});

test("custom user-message timestamps normalize ISO and finite numeric values without inventing invalid times", () => {
  for (const [timestamp, expected] of [
    [new Date(40).toISOString(), 40],
    [40, 40],
    [0, 0],
    [undefined, undefined],
    [null, undefined],
    ["invalid-timestamp", undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined]
  ]) {
    for (const shape of [{ type: "custom_message" }, { role: "custom" }]) {
      const [message] = conversationMessages([
        {
          ...shape,
          customType: "cowork-user-message",
          id: "pi-entry",
          timestamp,
          details: { message: "same input", delivery: "followUp", _coworkInbox: { messageId: "same-id" } }
        }
      ]);
      assert.equal(message.timestamp, expected);
      assert.equal(message.id, "same-id");
      assert.equal(message.content, "same input");
      assert.equal(message.delivery, "followUp");
      assert.equal(message.interjected, false);
      assert.equal(message.pending, false);
      if (expected === undefined) assert.equal("timestamp" in JSON.parse(JSON.stringify(message)), false);
    }
  }
});

test("receipt fallback preserves replayed IDs across runs, distinct repeated input and queue cancellation", () => {
  const custom = (id, delivery, timestamp) => ({
    role: "custom",
    customType: "cowork-user-message",
    timestamp,
    details: { message: "same input", delivery, _coworkInbox: { messageId: id } }
  });
  const first = custom("first-input", "steer", 15);
  const second = custom("second-input", "followUp", 61);
  const queued = (id, delivery, timestamp, runId) => ({
    type: "user.interjected",
    runId,
    payload: { messageId: id, message: "same input", delivery, createdAt: new Date(timestamp).toISOString() }
  });
  const receipt = (id, delivery, timestamp, runId) => ({
    type: "inbox.consumed",
    runId,
    occurredAt: new Date(timestamp).toISOString(),
    payload: { messageId: id, delivery }
  });
  const saved = conversationMessages([
    user("start", 10),
    assistant("before steering", 20),
    { ...first, role: undefined, type: "custom_message", timestamp: new Date(40).toISOString() },
    assistant("after steering", 50),
    user("later request", 60),
    assistant("later process", 70),
    { ...second, role: undefined, type: "custom_message", timestamp: new Date(90).toISOString() },
    assistant("queued response", 100)
  ]);
  const events = [
    { ...receipt("first-input", "steer", 0, "first-run"), occurredAt: "invalid-receipt" },
    runtimeEventRecord("task", "first-run", 0, { type: "message_end", message: user("start", 10) }),
    runtimeEventRecord("task", "first-run", 1, {
      type: "message_end",
      message: assistant("before steering", 20)
    }),
    runtimeEventRecord("task", "first-run", 2, { type: "message_end", message: first }),
    queued("first-input", "steer", 15, "first-run"),
    receipt("first-input", "steer", 41, "first-run"),
    runtimeEventRecord("task", "first-run", 3, {
      type: "message_end",
      message: assistant("after steering", 50)
    }),
    runtimeEventRecord("task", "later-run", 0, {
      type: "message_end",
      message: user("later request", 60)
    }),
    runtimeEventRecord("task", "later-run", 1, {
      type: "message_end",
      message: assistant("later process", 70)
    }),
    runtimeEventRecord("task", "later-run", 2, { type: "message_end", message: first }),
    receipt("first-input", "steer", 80, "later-run"),
    runtimeEventRecord("task", "later-run", 3, { type: "message_end", message: second }),
    queued("second-input", "followUp", 61, "later-run"),
    receipt("second-input", "followUp", 95, "later-run"),
    queued("cancelled-input", "followUp", 62, "later-run"),
    { type: "user.message_cancelled", runId: "later-run", payload: { messageId: "cancelled-input" } },
    queued("pending-input", "followUp", 65, "later-run"),
    runtimeEventRecord("task", "later-run", 4, {
      type: "message_end",
      message: assistant("queued response", 100)
    })
  ];
  const reversedReceipts = [
    ...events.filter((event) => event.type !== "inbox.consumed"),
    ...events.filter((event) => event.type === "inbox.consumed").reverse()
  ];
  for (const logs of [events, reversedReceipts]) {
    for (const snapshot of [saved, []]) {
      const restored = messagesWithRuntimeHistory(snapshot, logs);
      const firstTimestamp = snapshot.length ? 40 : 41;
      assert.equal(restored.filter((message) => message.id === "first-input").length, 1);
      assert.equal(restored.find((message) => message.id === "first-input").timestamp, firstTimestamp);
      assert.equal(restored.find((message) => message.id === "first-input").interjected, true);
      assert.deepEqual(
        restored.slice(0, 5).map((message) => message.timestamp),
        [10, 20, firstTimestamp, 50, 60]
      );
      const delivered = restored.find((message) => message.id === "second-input");
      assert.equal(delivered.timestamp, snapshot.length ? 90 : 95);
      assert.equal(delivered.content, "same input");
      assert.equal(delivered.delivery, "followUp");
      assert.equal(delivered.interjected, false);
      assert.equal(delivered.pending, false);
      assert.equal(
        restored.some((message) => message.id === "cancelled-input"),
        false
      );
      assert.equal(restored.find((message) => message.id === "pending-input").pending, true);
      assert.equal(
        restored.filter((message) => message.content === "same input" && !message.pending).length,
        2
      );
    }
  }
});

test("repeated steering instructions keep distinct event groups and pending follow-ups do not split them", () => {
  const instructions = [3, 5].map((timestamp) => ({
    ...user("same instruction", timestamp),
    id: `steer-${timestamp}`,
    interjected: true,
    delivery: "steer"
  }));
  const messages = [
    user("start", 1),
    assistant("first", 2),
    instructions[0],
    assistant("second", 4),
    instructions[1],
    assistant("third", 6)
  ];
  const events = [...runEvents(messages[0], messages[1])];
  for (const [index, instruction] of instructions.entries()) {
    const custom = {
      role: "custom",
      customType: "cowork-user-message",
      timestamp: instruction.timestamp,
      details: {
        message: instruction.content,
        delivery: "steer",
        _coworkInbox: { messageId: instruction.id }
      }
    };
    events.push(
      { type: "message_start", message: custom },
      { type: "message_end", message: custom },
      ...runEvents(instruction, messages[index * 2 + 3]).slice(3)
    );
  }
  const exchanges = buildConversationExchanges(
    [...messages, { ...user("queued", 7), delivery: "followUp", pending: true, interjected: true }],
    events
  );
  assert.equal(exchanges.length, 3);
  assert.deepEqual(
    exchanges.map((exchange) => buildLiveActivity(exchange.events).at(-1).answer),
    ["first", "second", "third"]
  );
  assert.deepEqual(
    exchanges.map((exchange) => exchange.continued),
    [true, true, false]
  );
  assert.equal(new Set(exchanges.map((exchange) => exchange.key)).size, 3);
});

test("cancelled queue entries disappear and resumed prompts reuse the original message identity", async () => {
  const { queuedUserTurn } = await import("../dist/src/runtime/queued-user-turn.js");
  const original = {
    type: "user.interjected",
    occurredAt: "2026-10-10T01:00:00Z",
    payload: { messageId: "queued", message: "resume this", delivery: "followUp" }
  };
  assert.deepEqual(
    messagesWithRuntimeHistory(
      [],
      [original, { type: "user.message_cancelled", payload: { messageId: "queued" } }]
    ),
    []
  );
  const saved = conversationMessages([
    {
      type: "message",
      id: "pi-entry",
      message: {
        role: "user",
        timestamp: 123456,
        content: [
          {
            type: "text",
            text: queuedUserTurn({ taskId: "task", runId: "run", messageId: "queued", text: "resume this" })
          }
        ]
      }
    }
  ]);
  const merged = messagesWithRuntimeHistory(saved, [
    {
      type: "runtime_event",
      payload: {
        type: "message_end",
        message: {
          role: "user",
          content: queuedUserTurn({ taskId: "task", runId: "run", messageId: "queued", text: "resume this" }),
          timestamp: 123456
        }
      }
    },
    original
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "queued");
  assert.equal(merged[0].content, "resume this");
  assert.equal(merged[0].pending, undefined);
});

test("queued user identity is removed from both live and replayed runtime events", async () => {
  const { queuedUserTurn } = await import("../dist/src/runtime/queued-user-turn.js");
  const payload = {
    type: "message_end",
    message: {
      role: "user",
      content: queuedUserTurn({ taskId: "task", runId: "run", messageId: "queue-1", text: "continue" })
    }
  };
  const record = runtimeEventRecord("task", "run", 0, payload);
  assert.equal(record.payload.message.id, "queue-1");
  assert.equal(record.payload.message.content, "continue");
  assert.match(payload.message.content, /atria-queued-user/, "the original durable record is unchanged");
  assert.equal(conversationMessages([record.payload.message])[0].id, "queue-1");
});

test("a stop in a resident Run belongs to the round it stopped, not the Run's last round", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-conversation-"));
  try {
    const at = Date.parse("2026-11-18T10:00:00Z");
    const stopped = [user("stopped request", at), assistant("partial", at + 1_000)];
    const next = [user("next request", at + 60_000), assistant("next answer", at + 61_000)];
    const directory = join(root, "task", "runs", "resident");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "run.json"), JSON.stringify({ createdAt: "2026-11-18" }));
    await writeFile(
      join(directory, "runtime-output.log"),
      [...runEvents(...stopped), ...runEvents(...next)].map(JSON.stringify).join("\n")
    );
    await writeFile(
      join(directory, "run_events.jsonl"),
      `${JSON.stringify({
        eventId: "stop",
        type: "main.run_stopped",
        runId: "resident",
        occurredAt: new Date(at + 2_000).toISOString(),
        payload: { subagents: 2 }
      })}\n`
    );
    const events = await readTaskRuntimeEvents(root, "task");
    const exchanges = buildConversationExchanges(
      messagesWithRuntimeHistory(conversationMessages([...stopped, ...next]), events),
      events
    );
    assert.equal(exchanges.length, 2);
    assert.ok(exchanges[0].events.some((event) => event.type === "main.run_stopped"));
    assert.ok(!exchanges[1].events.some((event) => event.type === "main.run_stopped"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a re-read history keeps streamed ledger news it saves, not a pause it never saves", () => {
  const ledger = (eventId, type) => ({ eventId, runId: "one", type, occurredAt: eventId });
  const answer = runtimeEventRecord("task", "one", 0, { type: "turn_end", message: { role: "assistant" } });
  const completed = ledger("3", "main.run_completed");
  // Live: paused, resumed, then completed. The saved history has the completion only.
  const streamed = [
    ledger("1", "main.run_pause_requested"),
    ledger("2", "main.run_paused"),
    answer,
    completed
  ];
  const merged = mergeRuntimeEvents([answer, completed], streamed);
  assert.deepEqual(merged, [answer, completed]);
  assert.equal(exchangeExecutionState(merged).terminal, "completed");
  // News the history does save still survives a read that started before it.
  const late = ledger("4", "main.run_waiting");
  assert.deepEqual(mergeRuntimeEvents([answer], [answer, late]), [answer, late]);
});

test("a saved history keeps one copy of what an ended message, turn and tool repeat", () => {
  const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } };
  const ended = {
    role: "assistant",
    timestamp: 1,
    stopReason: "toolUse",
    content: [{ type: "thinking", thinking: "list it", thinkingSignature: "sig".repeat(100) }, call]
  };
  const result = { content: [{ type: "text", text: "a.md" }] };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: result.content,
    timestamp: 2
  };
  const update = (assistantMessageEvent) => ({
    type: "message_update",
    usage: { totalTokens: 9 },
    assistantMessageEvent
  });
  const payloads = [
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "list it" }),
    update({ type: "thinking_end", contentIndex: 0, content: "list it" }),
    update({ type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" }),
    update({ type: "toolcall_end", contentIndex: 1, toolCall: call }),
    { type: "message_end", message: ended },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: call.arguments },
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: [] } },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result, isError: false },
    { type: "message_start", message: toolResult },
    { type: "message_end", message: toolResult },
    { type: "turn_end", message: ended, toolResults: [toolResult] },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 3, content: [] } },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "next" }),
    update({ type: "thinking_end", contentIndex: 0, content: "next" }),
    { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} },
    { type: "tool_execution_update", toolCallId: "call-2", toolName: "bash", partialResult: { content: [] } }
  ];
  const full = payloads.map((payload, index) => runtimeEventRecord("task", "run", index, payload));
  const saved = settledRuntimeEvents(full).map(viewRuntimeEvent);
  const payload = (type, from = saved) =>
    from.filter((record) => record.payload.type === type).map((record) => record.payload);

  assert.deepEqual(buildLiveActivity(saved), buildLiveActivity(full.map(viewRuntimeEvent)));
  assert.deepEqual(payload("turn_end")[0], {
    type: "turn_end",
    message: { role: "assistant", id: undefined, timestamp: 1, stopReason: "toolUse" }
  });
  // An ended block keeps its place but not its text; an open one keeps both.
  assert.deepEqual(
    payload("message_update").map((entry) => entry.assistantMessageEvent),
    [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_end", contentIndex: 0 },
      { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" },
      { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call-1", name: "bash" } },
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "next" },
      { type: "thinking_end", contentIndex: 0, content: "next" }
    ]
  );
  assert.ok(payload("message_update").every((entry) => !("usage" in entry)));
  // Progress is dropped once the tool's result is in.
  assert.deepEqual(
    payload("tool_execution_update").map((entry) => entry.toolCallId),
    ["call-2"]
  );
  assert.deepEqual(
    payload("message_end").map((entry) => entry.message),
    [
      { ...ended, content: [{ type: "thinking", thinking: "list it" }, call] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: undefined, timestamp: 2 }
    ]
  );
  assert.equal(runtimeLogMarks(saved).get("run"), full.length - 1);
});

test("a saved history drops the deltas of ended messages and draws the same conversation", () => {
  const delta = (type, text, contentIndex) => ({
    type: "message_update",
    assistantMessageEvent: { type, contentIndex, delta: text }
  });
  const call = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.md" } };
  const ended = {
    role: "assistant",
    timestamp: 1,
    content: [{ type: "thinking", thinking: "look first" }, call]
  };
  const payloads = [
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } },
    delta("thinking_delta", "look ", 0),
    delta("thinking_delta", "first", 0),
    {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolCall: call }
    },
    delta("toolcall_delta", '{"path":', 1),
    delta("toolcall_delta", '"a.md"}', 1),
    { type: "message_end", message: ended },
    { type: "turn_end", message: ended },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } },
    delta("text_delta", "still ", 0),
    delta("text_delta", "writing", 0)
  ];
  const full = payloads.map((payload, index) => runtimeEventRecord("task", "run", index, payload));
  const saved = settledRuntimeEvents(full);
  assert.equal(saved.length, full.length - 4);
  // The message being written keeps its deltas for the live view.
  assert.deepEqual(
    saved.slice(-2).map((record) => record.payload.assistantMessageEvent.delta),
    ["still ", "writing"]
  );
  assert.deepEqual(buildLiveActivity(saved), buildLiveActivity(full));
  assert.equal(runtimeLogMarks(saved).get("run"), full.length - 1);

  // Deltas streamed before the message ended are covered by the saved
  // history; the page neither keeps them nor appends them a second time.
  const streamed = full.slice(2, 4);
  const merged = mergeRuntimeEvents(saved, streamed);
  assert.deepEqual(merged, saved);
  const later = runtimeEventRecord("task", "run", full.length, delta("text_delta", "!", 0));
  assert.deepEqual(mergeRuntimeEvents(saved, [...streamed, later]), [...saved, later]);
});
