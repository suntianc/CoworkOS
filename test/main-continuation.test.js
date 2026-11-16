import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readMainInput, saveMainInput } from "../dist/src/runtime/main-continuation.js";
import { restorePendingTaskInput } from "../scripts/main-session.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-main-continuation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sessions: join(root, "sessions"), inputPath: join(root, "input.json") };
}

test("pending input restoration flushes the original input once across repeated launches", async (t) => {
  const f = await fixture(t);
  const input = { version: 1, prompt: "Original input and preserved attachment", submittedAt: 1 };
  await saveMainInput(f.inputPath, input);
  await restorePendingTaskInput(f.sessions, f.root, f.inputPath);
  const [first] = await SessionManager.listAll(f.sessions);
  const original = await readFile(first.path, "utf8");
  await restorePendingTaskInput(f.sessions, f.root, f.inputPath);
  assert.equal(await readFile(first.path, "utf8"), original);
  const users = SessionManager.open(first.path)
    .getBranch()
    .filter((entry) => entry.type === "message");
  assert.equal(users.length, 1);
  assert.equal(users[0].message.content, input.prompt);
});

test("an identical later request is restored without mistaking an older turn for its delivery", async (t) => {
  const f = await fixture(t);
  const input = { version: 1, prompt: "The same text", submittedAt: 1 };
  await saveMainInput(f.inputPath, input);
  await restorePendingTaskInput(f.sessions, f.root, f.inputPath);
  await saveMainInput(f.inputPath, { ...input, submittedAt: 2 });
  await restorePendingTaskInput(f.sessions, f.root, f.inputPath);
  await restorePendingTaskInput(f.sessions, f.root, f.inputPath);
  const [latest] = await SessionManager.listAll(f.sessions);
  const users = SessionManager.open(latest.path)
    .getBranch()
    .filter((entry) => entry.type === "message");
  assert.deepEqual(
    users.map((entry) => entry.message.timestamp),
    [1, 2]
  );
});

test("a continuation without its saved input is refused and an invalid input is preserved", async (t) => {
  const f = await fixture(t);
  assert.equal(await readMainInput(f.inputPath), undefined);
  await assert.rejects(restorePendingTaskInput(f.sessions, f.root, f.inputPath), /缺少已保存的输入记录/);
  assert.deepEqual(await SessionManager.listAll(f.sessions), []);
  await writeFile(f.inputPath, JSON.stringify({ version: 1, prompt: "keep", submittedAt: "invalid" }));
  const original = await readFile(f.inputPath, "utf8");
  await assert.rejects(restorePendingTaskInput(f.sessions, f.root, f.inputPath), /原始请求无法恢复/);
  assert.equal(await readFile(f.inputPath, "utf8"), original);
});

test("explicit edited session restoration ignores newer abandoned history and retains the accepted message identity", async (t) => {
  const f = await fixture(t);
  const selected = SessionManager.create(f.root, f.sessions);
  selected.appendMessage({ role: "user", content: "correct prefix", timestamp: 1 });
  selected.appendMessage({ role: "assistant", content: [], timestamp: 2, stopReason: "stop" });
  const abandoned = SessionManager.create(f.root, f.sessions);
  abandoned.appendMessage({ role: "user", content: "abandoned branch", timestamp: 3 });
  abandoned.appendMessage({ role: "assistant", content: [], timestamp: 4, stopReason: "stop" });
  const sourceFile = abandoned.getSessionFile();
  const original = await readFile(sourceFile, "utf8");
  const input = {
    version: 1,
    prompt: "new edited input",
    submittedAt: 5,
    source: "composer",
    taskId: "task",
    runId: "run",
    messageId: "accepted-message"
  };
  await saveMainInput(f.inputPath, input);
  await restorePendingTaskInput(f.sessions, f.root, f.inputPath, selected.getSessionFile());
  await restorePendingTaskInput(f.sessions, f.root, f.inputPath, selected.getSessionFile());
  const entries = SessionManager.open(selected.getSessionFile()).getBranch();
  assert.equal(
    entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
    2
  );
  assert.match(JSON.stringify(entries), /accepted-message/);
  assert.doesNotMatch(JSON.stringify(entries), /abandoned branch/);
  assert.equal(await readFile(sourceFile, "utf8"), original);
});
