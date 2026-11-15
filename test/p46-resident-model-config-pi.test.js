import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

/**
 * A resident Main adopts the model configuration saved for its next turn.
 *
 * One Run keeps one Pi process, so a connection saved after a finished turn
 * reaches that same process only if it re-reads the host configuration at the
 * turn boundary. Two strict local providers make the connection, protocol and
 * model visible in the request each one receives, and a per-message reasoning
 * choice must win for that turn only. Nothing here is an in-process stand-in.
 */

const waitFor = async (check, message, timeout = 30_000) => {
  const until = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= until) assert.fail(message);
    await delay(25);
  }
};

function client(dashboard) {
  return async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json();
    assert.ok(response.ok, `${path} ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
}

/** The newest Main process record this Task started. */
async function mainRecord(dashboard, taskId) {
  const runs = await readdir(join(dashboard.workspaceRoot, taskId, "runs")).catch(() => []);
  const records = [];
  for (const runId of runs) {
    const value = await readFile(
      join(dashboard.workspaceRoot, taskId, "runs", runId, "agents", "main", "process.json"),
      "utf8"
    )
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (value?.pid) records.push(value);
  }
  records.sort((left, right) => String(left.launchedAt).localeCompare(String(right.launchedAt)));
  return records.at(-1);
}

async function settle(request, taskId) {
  return waitFor(async () => {
    const detail = await request(`/api/tasks/${taskId}`);
    return detail.runtime.active ? undefined : detail;
  }, `Main ${taskId} to settle its turn`);
}

test(
  "AC: the same resident Main sends the next turn with the saved protocol, model and reasoning level",
  { timeout: 180_000 },
  async (t) => {
    const completions = await modelProtocolFixture("openai-completions", (_body, requests) => ({
      text: `第一回合完成 ${requests.length}`
    }));
    const responses = await modelProtocolFixture("openai-responses", (_body, requests) => ({
      text: `第二回合完成 ${requests.length}`
    }));
    const dashboard = await startDashboard();
    t.after(async () => {
      await dashboard.stop();
      await completions.close();
      await responses.close();
    });
    const request = client(dashboard);
    const keyA = "{{SECRET_q4m6x2vd}}";
    const keyB = "{{SECRET_r8n1c7zk}}";

    const first = await request("/api/model-settings", {
      profileId: "",
      profileName: "连接 A",
      baseUrl: completions.baseUrl,
      api: "openai-completions",
      model: "model-a",
      apiKey: keyA,
      reasoningEffort: "low",
      supportsReasoningEffort: true,
      supportsImages: false
    });
    assert.ok(first.profiles[0].id, "the first connection is the active one");

    await request("/api/tasks", { taskId: "resident-model", goal: "常驻 Main 采用最新模型配置" });
    const run = await request("/api/tasks/resident-model/run", { prompt: "FIRST_TURN_INPUT" });
    await settle(request, "resident-model");
    const turn = await request("/api/tasks/resident-model");
    assert.equal(turn.task.status, "completed");
    assert.equal(completions.requests.length, 1);
    assert.equal(completions.requests[0].path, "/v1/chat/completions");
    assert.equal(completions.requests[0].body.model, "model-a");
    assert.equal(completions.requests[0].body.reasoning_effort, "low");
    assert.match(JSON.stringify(completions.requests[0].body.messages), /FIRST_TURN_INPUT/);
    const record = await mainRecord(dashboard, "resident-model");
    assert.ok(record?.pid, "the first turn ran in a Main process");

    // A connection saved between turns names another protocol, model and
    // default level. The resident process reads it at the next turn boundary.
    const switched = await request("/api/model-settings", {
      profileId: "",
      profileName: "连接 B",
      baseUrl: responses.baseUrl,
      api: "openai-responses",
      model: "model-b",
      apiKey: keyB,
      reasoningEffort: "max",
      supportsReasoningEffort: true,
      supportsImages: false,
      activate: true
    });
    assert.equal(switched.activeProfileId, switched.profiles.find((entry) => entry.name === "连接 B").id);

    const second = await request("/api/tasks/resident-model/run", {
      prompt: "SECOND_TURN_INPUT",
      thinkingLevel: "high"
    });
    assert.equal(second.runId, run.runId, "the message joins the Run the same process owns");
    await settle(request, "resident-model");
    assert.equal((await mainRecord(dashboard, "resident-model")).pid, record.pid, "no new Main was started");
    assert.equal(completions.requests.length, 1, "the previous connection gets no further request");
    assert.equal(responses.requests.length, 1);
    assert.equal(responses.requests[0].path, "/v1/responses", "the saved protocol reached the same process");
    assert.equal(responses.requests[0].body.model, "model-b", "the saved model reached the same process");
    assert.equal(
      responses.requests[0].body.reasoning.effort,
      "high",
      "the message's explicit level wins for this turn"
    );
    assert.match(
      JSON.stringify(responses.requests[0].body.input),
      /FIRST_TURN_INPUT/,
      "the session continued"
    );

    // The explicit pick was this turn's only. The next turn returns to the
    // saved connection's own level in the same process.
    await request("/api/tasks/resident-model/run", { prompt: "THIRD_TURN_INPUT" });
    await settle(request, "resident-model");
    assert.equal((await mainRecord(dashboard, "resident-model")).pid, record.pid);
    assert.equal(responses.requests.length, 2);
    assert.equal(responses.requests[1].body.reasoning.effort, "max");
  }
);
