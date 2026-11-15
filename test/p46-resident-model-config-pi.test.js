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

/** The output cap each request asked for; Pi may send either spelling. */
const askedTokens = (request) => request.body.max_completion_tokens ?? request.body.max_tokens;
const toolNames = (request) => request.body.tools.map((tool) => tool.function.name);

test(
  "AC: every turn keeps the endpoint limits its launch applied, and a saved switch takes the new endpoint's",
  { timeout: 180_000 },
  async (t) => {
    // A advertises a small window, a large output cap and image input; B a
    // larger window, a smaller output cap and text only. The numbers are the
    // provider's, not the host file's default of 256000/8192.
    const completions = await modelProtocolFixture(
      "openai-completions",
      (_body, requests) =>
        requests.length === 1
          ? // Ask for an image-only tool group: it exists here only if the
            // turn still sees the endpoint's image support.
            { name: "enable_tools", arguments: { groups: ["computer"] } }
          : { text: `limits turn ${requests.length}` },
      {
        models: [
          {
            id: "limits-a",
            context_window: 40000,
            max_output_tokens: 128000,
            modalities: { input: ["text", "image"] }
          }
        ]
      }
    );
    const textOnly = await modelProtocolFixture(
      "openai-completions",
      (_body, requests) => ({ text: `B ${requests.length}` }),
      {
        models: [{ id: "limits-b", context_window: 120000, max_output_tokens: 30000 }]
      }
    );
    const dashboard = await startDashboard();
    t.after(async () => {
      await dashboard.stop();
      await completions.close();
      await textOnly.close();
    });
    const request = client(dashboard);

    await request("/api/model-settings", {
      profileId: "",
      profileName: "端点 A",
      baseUrl: completions.baseUrl,
      api: "openai-completions",
      model: "limits-a",
      apiKey: "{{SECRET_q4m6x2vd}}"
    });
    await request("/api/tasks", { taskId: "resident-limits", goal: "回合沿用端点上限" });
    await request("/api/tasks/resident-limits/run", { prompt: "LIMITS_ONE" });
    await settle(request, "resident-limits");

    // Turn one: the enable_tools call is answered, so the second request shows
    // the tool the image capability added. A 40k window caps output at 20000.
    assert.equal(completions.requests.length, 2);
    assert.ok(askedTokens(completions.requests[1]) > 8192, "the endpoint output cap replaced 8192");
    assert.ok(
      askedTokens(completions.requests[1]) <= 20000,
      "the output cap stays within half the 40k window"
    );
    assert.ok(
      toolNames(completions.requests[1]).includes("computer_status"),
      "the endpoint's images kept the group"
    );
    const record = await mainRecord(dashboard, "resident-limits");
    assert.ok(record?.pid);

    // Two more turns in the same process re-read the saved connection and must
    // keep what the endpoint advertised instead of falling back to 256000/8192.
    for (const prompt of ["LIMITS_TWO", "LIMITS_THREE"]) {
      await request("/api/tasks/resident-limits/run", { prompt });
      await settle(request, "resident-limits");
      const latest = completions.requests.at(-1);
      assert.ok(askedTokens(latest) > 8192, `${prompt} kept the endpoint output cap`);
      assert.ok(askedTokens(latest) <= 20000, `${prompt} kept the endpoint context window`);
      assert.ok(toolNames(latest).includes("computer_status"), `${prompt} kept the endpoint's image support`);
    }
    assert.equal(completions.requests.length, 4);
    assert.equal(
      (await mainRecord(dashboard, "resident-limits")).pid,
      record.pid,
      "all turns used one process"
    );

    // A connection saved between turns brings its own provider limits, and the
    // same process must not keep the previous connection's image capability.
    await request("/api/model-settings", {
      profileId: "",
      profileName: "端点 B",
      baseUrl: textOnly.baseUrl,
      api: "openai-completions",
      model: "limits-b",
      apiKey: "{{SECRET_r8n1c7zk}}",
      activate: true
    });
    await request("/api/tasks/resident-limits/run", { prompt: "LIMITS_FOUR" });
    await settle(request, "resident-limits");
    assert.equal(textOnly.requests.length, 1, "the new connection served the turn");
    assert.ok(askedTokens(textOnly.requests[0]) > 20000, "the new endpoint's larger output cap applied");
    assert.ok(askedTokens(textOnly.requests[0]) <= 30000, "the new endpoint's own cap applied");
    assert.equal(
      toolNames(textOnly.requests[0]).includes("computer_status"),
      false,
      "the text-only connection dropped the image-only group"
    );
    assert.equal((await mainRecord(dashboard, "resident-limits")).pid, record.pid, "no new Main was started");
  }
);
