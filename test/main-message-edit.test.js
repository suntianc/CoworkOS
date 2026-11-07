import { finishMessageEditTransaction } from "../dist/src/runtime/main-message-edit-transaction.js";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { singleConnectionMainModel } from "./role-model-fixture.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  latestEditableMessage,
  prepareMessageEdit,
  readMessageVersions,
  readArchivedMessageVersion,
  messageVersionSummaries,
  alignMessageVersionSession,
  rejectAcceptedMainMessage,
  saveAcceptedMainMessage,
  versionRuntimeEvents
} from "../dist/src/runtime/main-message-edit.js";
import { mainInputPath, saveMainInput } from "../dist/src/runtime/main-continuation.js";
import { queuedUserTurn } from "../dist/src/runtime/queued-user-turn.js";
import { mainContextPaths, persistMainContext } from "../dist/src/runtime/main-context.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { createDashboardRunService } from "../dist/src/dashboard/run-service.js";
import { readJsonFile } from "../dist/src/dashboard/event-stream.js";

const textMessage = (role, text, timestamp) => ({
  role,
  content: [{ type: "text", text }],
  timestamp,
  ...(role === "assistant"
    ? {
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          totalTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
        }
      }
    : {})
});
async function fixture(t, first = false) {
  const root = await mkdtemp(join(tmpdir(), "atria-edit-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await new LocalWorkspaceStore(root).createTask("task", { goal: "old input" });
  const session = SessionManager.create(root, join(root, "task", "sessions", "main", "pi"));
  const time = Date.now() - 100;
  if (first) session.appendCustomEntry("fixture-settings-before-first-user", { fixture: true });
  if (!first) {
    session.appendMessage(textMessage("user", "prefix question", time - 2));
    session.appendMessage(textMessage("assistant", "prefix response", time - 1));
  }
  const messageId = randomUUID();
  const prompt = "old input\nsecond line";
  session.appendMessage(
    textMessage("user", queuedUserTurn({ taskId: "task", runId: "old-run", messageId, text: prompt }), time)
  );
  session.appendMessage(textMessage("assistant", "old response", time + 1));
  await saveMainInput(mainInputPath(root, "task", "old-run"), {
    version: 1,
    prompt,
    body: prompt,
    messageId,
    source: "composer",
    submittedAt: time
  });
  await persistMainContext(mainContextPaths(root, "task"), session.getBranch());
  const directory = join(root, "task", "runs", "old-run");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "runtime-output.log"),
    [
      {
        type: "message_start",
        message: textMessage(
          "user",
          queuedUserTurn({ taskId: "task", runId: "old-run", messageId, text: prompt }),
          time
        )
      },
      { type: "message_end", message: textMessage("assistant", "old response", time + 1) }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
  );
  const latest = await latestEditableMessage(root, "task", "old-run");
  assert.equal(latest.target.messageId, messageId);
  assert.equal(latest.target.body, prompt);
  return {
    root,
    session,
    time,
    latest,
    request: {
      ...Object.fromEntries(
        ["messageId", "versionId", "runId", "scopeToken"].map((key) => [key, latest.target[key]])
      ),
      editId: randomUUID()
    }
  };
}
test("SDK branch retains full prefix, archives old records and resumes only the new version", async (t) => {
  const f = await fixture(t);
  const originalFile = f.session.getSessionFile();
  const originalBytes = await readFile(originalFile, "utf8");
  const branch = await prepareMessageEdit(f.root, "task", f.request, "new input", "new-run");
  const session = SessionManager.open(branch.sessionFile);
  assert.deepEqual(
    session.buildSessionContext().messages.map((message) => message.content[0].text),
    ["prefix question", "prefix response"]
  );
  assert.equal(await readFile(originalFile, "utf8"), originalBytes);
  const versions = await readMessageVersions(f.root, "task");
  assert.equal(
    (await readArchivedMessageVersion(f.root, "task", versions.archives[0].versionId)).messages.at(-1)
      .content[0].text,
    "old response"
  );
  assert.deepEqual(versionRuntimeEvents(f.latest.allEvents, versions), []);
  const duplicate = await prepareMessageEdit(f.root, "task", f.request, "new input", "other-run");
  assert.equal(duplicate.repeatedRunId, "new-run");
  await assert.rejects(
    prepareMessageEdit(f.root, "task", f.request, "different input", "other-run"),
    /其他输入/
  );
});
test("project-folder changes retain the selected version and full prefix, even before assistant output", async (t) => {
  for (const first of [false, true]) {
    const f = await fixture(t, first);
    await prepareMessageEdit(f.root, "task", f.request, "new input", "new-run");
    const versions = await readMessageVersions(f.root, "task");
    const oldBytes = await readFile(versions.sessionFile, "utf8");
    const oldContext = SessionManager.open(versions.sessionFile).buildSessionContext();
    const nextProject = join(f.root, "next-project");
    await mkdir(nextProject);
    const aligned = await alignMessageVersionSession(f.root, "task", nextProject, versions);
    assert.notEqual(aligned.sessionFile, versions.sessionFile);
    assert.equal(aligned.versionId, versions.versionId);
    assert.deepEqual(SessionManager.open(aligned.sessionFile).buildSessionContext(), oldContext);
    assert.equal(await readFile(versions.sessionFile, "utf8"), oldBytes);
    assert.equal((await readMessageVersions(f.root, "task")).sessionFile, aligned.sessionFile);
    assert.equal(
      (await alignMessageVersionSession(f.root, "task", nextProject, aligned)).sessionFile,
      aligned.sessionFile
    );
  }
});

test("multiple edits keep histories associated with their current message and preserve legacy archives", async (t) => {
  const f = await fixture(t);
  const messageId = randomUUID();
  const prepared = await prepareMessageEdit(f.root, "task", f.request, "new input", "new-run", messageId);
  const versions = await readMessageVersions(f.root, "task");
  const history = await readArchivedMessageVersion(f.root, "task", versions.archives[0].versionId);
  assert.equal(versions.archives[0].messages, undefined);
  assert.equal(messageVersionSummaries(versions)[0].currentMessageId, messageId);
  assert.equal(messageVersionSummaries(versions)[0].runtimeEvents, undefined);
  const session = SessionManager.open(prepared.sessionFile);
  const time = Date.now();
  session.appendMessage(
    textMessage(
      "user",
      queuedUserTurn({ taskId: "task", runId: "new-run", messageId, text: "new input" }),
      time
    )
  );
  session.appendMessage(textMessage("assistant", "new response", time + 1));
  await saveMainInput(mainInputPath(f.root, "task", "new-run"), {
    version: 1,
    prompt: "new input",
    body: "new input",
    submittedAt: time,
    messageId,
    source: "composer"
  });
  await finishMessageEditTransaction(f.root, "task");
  // Previous installations stored the complete archive inline. It remains readable,
  // then is moved to the private history file when the next edit is accepted.
  delete versions.archives[0].historyFile;
  Object.assign(versions.archives[0], history);
  await writeFile(join(f.root, "task/sessions/main/versions.json"), JSON.stringify(versions));
  assert.deepEqual(await readArchivedMessageVersion(f.root, "task", versions.archives[0].versionId), history);
  const latest = await latestEditableMessage(f.root, "task", "new-run");
  const replacementId = randomUUID();
  await prepareMessageEdit(
    f.root,
    "task",
    { ...latest.target, editId: randomUUID() },
    "second edit",
    "second-run",
    replacementId
  );
  const updated = await readMessageVersions(f.root, "task");
  assert.equal(updated.archives.length, 2);
  assert.ok(
    updated.archives.every(
      (value) => value.currentMessageId === replacementId && !value.messages && value.historyFile
    )
  );
  assert.equal(updated.archives[0].groupId, updated.archives[1].groupId);
  assert.deepEqual(await readArchivedMessageVersion(f.root, "task", updated.archives[0].versionId), history);
});

test("editing the first turn creates an empty model prefix and preserves old session", async (t) => {
  const f = await fixture(t, true);
  const originalFile = f.session.getSessionFile();
  const branch = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  assert.deepEqual(SessionManager.open(branch.sessionFile).buildSessionContext().messages, []);
  assert.match(await readFile(originalFile, "utf8"), /old response/);
});
test("stale message or version cannot branch, and internal/human inputs are not editable", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareMessageEdit(f.root, "task", { ...f.request, messageId: "assistant-id" }, "replacement", "new-run"),
    /消息或会话版本/
  );
  assert.equal(await readMessageVersions(f.root, "task"), undefined);
  const answered = "answer to internal question";
  f.session.appendMessage(textMessage("user", answered, f.time + 3));
  await saveMainInput(mainInputPath(f.root, "task", "human-run"), {
    version: 1,
    prompt: answered,
    source: "human",
    submittedAt: f.time + 3
  });
  const latest = await latestEditableMessage(f.root, "task", "human-run");
  assert.equal(latest.target.messageId, f.request.messageId);
  assert.equal(latest.target.runId, "human-run");
});

test("accepted composer identity survives a human resume overwriting the Run input slot", async (t) => {
  const f = await fixture(t);
  const input = JSON.parse(await readFile(mainInputPath(f.root, "task", "old-run"), "utf8"));
  await saveAcceptedMainMessage(f.root, "task", input);
  f.session.appendMessage(textMessage("user", "internal human answer", f.time + 3));
  await saveMainInput(mainInputPath(f.root, "task", "old-run"), {
    version: 1,
    prompt: "internal human answer",
    source: "human",
    submittedAt: f.time + 3
  });
  const latest = await latestEditableMessage(f.root, "task", "old-run");
  assert.equal(latest.target.messageId, f.request.messageId);
  assert.equal(latest.target.body, "old input\nsecond line");
});

test("scope changes reject stale editing without altering the original session", async (t) => {
  const f = await fixture(t);
  const changed = join(f.root, "changed-project");
  await mkdir(changed);
  await new LocalWorkspaceStore(f.root).updateTask("task", { projectDirectory: changed });
  await assert.rejects(prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run"), /会话版本/);
  assert.equal(await readMessageVersions(f.root, "task"), undefined);
});

test("a pre-spawn rollback anchors the source session and restores its private retry record", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "task", "sessions", "main", "request-retry.json");
  await writeFile(path, "private original retry bytes");
  const edit = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  await rm(path);
  await edit.rollback();
  const versions = await readMessageVersions(f.root, "task");
  assert.equal(versions.sessionFile, f.session.getSessionFile());
  assert.equal(versions.archives.length, 0);
  assert.equal(await readFile(path, "utf8"), "private original retry bytes");
  const latest = await latestEditableMessage(f.root, "task", "old-run");
  assert.equal(latest.target.messageId, f.request.messageId);
});

test("editing retires only unresolved questions from the replaced tail and rollback restores them", async (t) => {
  const f = await fixture(t);
  const human = new HumanRequestStore(f.root);
  const create = (question, runId = "old-run") => human.create({ taskId: "task", runId, question });
  const pending = await create("pending tail");
  const unanswered = await create("unanswered tail");
  await human.markUnanswered("task", unanswered.requestId);
  const answered = await create("answered tail");
  await human.submitAnswer("task", answered.requestId, "accepted decision");
  const cancelled = await create("cancelled tail");
  await human.cancel("task", cancelled.requestId);
  const unrelated = await create("another run", "other-run");
  const prefix = await create("prefix question");
  await writeFile(
    join(f.root, "task", "human", "requests", `${prefix.requestId}.json`),
    JSON.stringify({ ...prefix, createdAt: new Date(f.time - 10).toISOString() })
  );
  const edit = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  for (const request of [pending, unanswered]) {
    assert.equal((await human.read("task", request.requestId)).status, "cancelled");
    await human.restoreSuperseded("task", request.requestId, "another-edit-run");
    assert.equal((await human.read("task", request.requestId)).status, "cancelled");
    await assert.rejects(human.submitAnswer("task", request.requestId, "late decision"), /cancelled/);
  }
  assert.equal((await human.read("task", prefix.requestId)).status, "pending");
  assert.equal((await human.read("task", unrelated.requestId)).status, "pending");
  assert.equal((await human.read("task", answered.requestId)).answer, "accepted decision");
  assert.equal((await human.read("task", cancelled.requestId)).status, "cancelled");
  await edit.rollback();
  assert.equal((await human.read("task", pending.requestId)).status, "pending");
  assert.equal((await human.read("task", unanswered.requestId)).status, "unanswered");
  assert.equal((await human.read("task", cancelled.requestId)).status, "cancelled");
  assert.equal(
    (await human.submitAnswer("task", pending.requestId, "restored decision")).request.answer,
    "restored decision"
  );
});

for (const reason of ["persistence failure", "unrelated pending question"]) {
  test(`rejected edit startup restores old questions after ${reason}`, async (t) => {
    const f = await fixture(t);
    const store = new LocalWorkspaceStore(f.root);
    await store.updateTask("task", { activeRunId: "old-run" });
    await store.transitionTask("task", "running", { runId: "old-run" });
    await store.transitionTask("task", "waiting", { runId: "old-run" });
    const human = new HumanRequestStore(f.root);
    const pending = await human.create({ taskId: "task", runId: "old-run", question: "Old tail" });
    if (reason === "unrelated pending question")
      await human.create({ taskId: "task", runId: "another-run", question: "Unrelated decision" });
    const service = createDashboardRunService({
      projectRoot: f.root,
      tabStorePath: join(f.root, "tabs.json"),
      dashboardUrl: "http://127.0.0.1:1",
      coordinator: {},
      locateTask: async () => ({ workspaceRoot: f.root, store, task: await store.readTask("task") }),
      resolveMainModel: singleConnectionMainModel(),
      normalizeModel: () => "fixture",
      appendRunEvent: async () => {
        throw new Error("isolated persistence failure");
      },
      readJsonFile
    });
    t.after(() => service.stop());
    await assert.rejects(
      service.editMainMessage("task", f.request, "replacement", []),
      reason === "persistence failure" ? /isolated persistence failure/ : /请先回答/
    );
    assert.equal(service.activeRuns.size, 0);
    assert.equal((await store.readTask("task")).activeRunId, "old-run");
    assert.equal((await store.readTask("task")).status, "waiting");
    assert.equal((await human.read("task", pending.requestId)).status, "pending");
    assert.equal(
      (await latestEditableMessage(f.root, "task", "old-run")).target.messageId,
      f.request.messageId
    );
    assert.equal((await readMessageVersions(f.root, "task")).archives.length, 0);
  });
}

test("rejected pre-spawn edit remains rejected after rollback and reopening real stores", async (t) => {
  const f = await fixture(t);
  const old = JSON.parse(await readFile(mainInputPath(f.root, "task", "old-run"), "utf8"));
  await saveAcceptedMainMessage(f.root, "task", { ...old, taskId: "task", runId: "old-run" });
  const prepared = await prepareMessageEdit(f.root, "task", f.request, "replacement", "new-run");
  const next = {
    ...old,
    prompt: "replacement",
    body: "replacement",
    taskId: "task",
    runId: "new-run",
    messageId: randomUUID(),
    submittedAt: old.submittedAt + 10
  };
  await saveMainInput(mainInputPath(f.root, "task", "new-run"), next);
  await saveAcceptedMainMessage(f.root, "task", next);
  await writeFile(
    join(f.root, "task", "runs", "new-run", "run_events.jsonl"),
    JSON.stringify({
      type: "main.run_waiting",
      taskId: "task",
      runId: "new-run",
      payload: { reason: "desktop_shutdown_before_spawn" }
    }) + "\n"
  );
  await rejectAcceptedMainMessage(f.root, "task", next.messageId);
  await prepared.rollback();
  const latest = await latestEditableMessage(f.root, "task", "old-run");
  assert.equal(latest?.target.messageId, f.request.messageId);
  assert.equal(latest?.target.body, old.body);
  assert.equal(
    JSON.parse(await readFile(mainInputPath(f.root, "task", "new-run"), "utf8")).messageId,
    next.messageId
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(f.root, "task", "sessions", "main", "user-inputs", `${next.messageId}.json`),
        "utf8"
      )
    ).accepted,
    false
  );
});

async function childProcess(code, killAtReady = false) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "",
    errors = "";
  child.stderr.on("data", (bytes) => {
    errors += bytes;
  });
  child.stdout.on("data", (bytes) => {
    output += bytes;
    if (killAtReady && output.includes("READY_TO_KILL")) child.kill("SIGKILL");
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (killAtReady ? signal === "SIGKILL" : status === 0) resolve();
      else reject(new Error(`child failed ${status}/${signal}: ${errors}`));
    });
  });
  return output;
}
for (const stage of ["prepared", "input", "task", "launch_ready"]) {
  test(`SIGKILL at edit transaction ${stage} recovers consistently in a fresh runtime`, async (t) => {
    const f = await fixture(t);
    const store = new LocalWorkspaceStore(f.root);
    await store.updateTask("task", { activeRunId: "old-run", model: "old-model", goal: "old-goal" });
    await store.transitionTask("task", "running", { runId: "old-run" });
    await store.transitionTask("task", "failed", { runId: "old-run" });
    const old = JSON.parse(await readFile(mainInputPath(f.root, "task", "old-run"), "utf8"));
    await saveAcceptedMainMessage(f.root, "task", { ...old, taskId: "task", runId: "old-run" });
    const retry = join(f.root, "task", "sessions", "main", "request-retry.json");
    await writeFile(retry, "OLD_EXACT_RETRY_BYTES");
    await writeFile(`${retry}.cleared`, "OLD_CLEARED_BYTES");
    const context = mainContextPaths(f.root, "task");
    const beforeContext = await readFile(context.state, "utf8");
    const original = await readFile(f.session.getSessionFile(), "utf8");
    const human = new HumanRequestStore(f.root);
    const pending = await human.create({
      taskId: "task",
      runId: "old-run",
      question: "Pending old question"
    });
    const unanswered = await human.create({
      taskId: "task",
      runId: "old-run",
      question: "Unanswered old question"
    });
    await human.markUnanswered("task", unanswered.requestId);
    const moduleUrl = (path) => JSON.stringify(pathToFileURL(resolve(path)).href);
    const common = `
      import { prepareMessageEdit, saveAcceptedMainMessage } from ${moduleUrl("dist/src/runtime/main-message-edit.js")};
      import { readyMessageEditTransaction, recoverMessageEditTransaction } from ${moduleUrl("dist/src/runtime/main-message-edit-transaction.js")};
      import { saveMainInput, mainInputPath } from ${moduleUrl("dist/src/runtime/main-continuation.js")};
      import { LocalWorkspaceStore } from ${moduleUrl("dist/src/workspace/workspace-store.js")};
      import { createWorkspaceDirectory } from ${moduleUrl("dist/src/dashboard/workspace-directory.js")};
      import { rm } from "node:fs/promises";
      const root = ${JSON.stringify(f.root)};
    `;
    const input = {
      ...old,
      prompt: "edited body",
      body: "edited body",
      taskId: "task",
      runId: "new-run",
      messageId: randomUUID(),
      submittedAt: Date.now()
    };
    await childProcess(
      common +
        `
      await prepareMessageEdit(root, "task", ${JSON.stringify(f.request)}, "edited body", "new-run");
      if (${JSON.stringify(stage)} !== "prepared") {
        const input = ${JSON.stringify(input)};
        await saveMainInput(mainInputPath(root, "task", "new-run"), input);
        await saveAcceptedMainMessage(root, "task", input);
      }
      if (["task", "launch_ready"].includes(${JSON.stringify(stage)})) {
        const store = new LocalWorkspaceStore(root);
        await rm(${JSON.stringify(retry)}, { force: true });
        await rm(${JSON.stringify(`${retry}.cleared`)}, { force: true });
        await store.transitionTask("task", "running", { runId: "new-run" });
        await store.updateTask("task", { activeRunId: "new-run", goal: "edited goal", model: "new-model" });
        await store.createRun("task", "new-run");
      }
      if (${JSON.stringify(stage)} === "launch_ready") await readyMessageEditTransaction(root, "task");
      console.log("READY_TO_KILL");
      setInterval(() => {}, 1000);
    `,
      true
    );
    await childProcess(
      common +
        'const directory = createWorkspaceDirectory(root, root + "/test-global-index.json", () => undefined); await directory.locateTask("task");'
    );
    const restored = await store.readTask("task");
    assert.equal(await readFile(f.session.getSessionFile(), "utf8"), original);
    if (stage === "launch_ready") {
      assert.equal((await human.read("task", pending.requestId)).status, "cancelled");
      assert.equal((await human.read("task", unanswered.requestId)).status, "cancelled");
      assert.equal(restored.activeRunId, "new-run");
      assert.equal(restored.status, "waiting");
      assert.equal(restored.model, "new-model");
      assert.equal((await readMessageVersions(f.root, "task")).edits[0].editId, f.request.editId);
      assert.equal(
        JSON.parse(
          await readFile(
            join(f.root, "task", "sessions", "main", "user-inputs", `${input.messageId}.json`),
            "utf8"
          )
        ).accepted,
        true
      );
      await assert.rejects(readFile(retry), { code: "ENOENT" });
    } else {
      assert.equal((await human.read("task", pending.requestId)).status, "pending");
      assert.equal((await human.read("task", unanswered.requestId)).status, "unanswered");
      assert.equal(restored.activeRunId, "old-run");
      assert.equal(restored.status, "failed");
      assert.equal(restored.goal, "old-goal");
      assert.equal(restored.model, "old-model");
      assert.equal(await readFile(retry, "utf8"), "OLD_EXACT_RETRY_BYTES");
      assert.equal(await readFile(`${retry}.cleared`, "utf8"), "OLD_CLEARED_BYTES");
      assert.equal(await readFile(context.state, "utf8"), beforeContext);
      assert.equal(
        (await latestEditableMessage(f.root, "task", "old-run")).target.messageId,
        f.request.messageId
      );
    }
    await childProcess(common + 'await recoverMessageEditTransaction(root, "task");');
    assert.deepEqual(await store.readTask("task"), restored);
  });
}
