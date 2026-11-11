import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startDashboard } from "./dashboard-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";

/**
 * Which reasoning effort a real run actually sends.
 *
 * The only evidence used is the request each provider received, so a saved
 * connection whose strength never reaches the wire, or a composer default that
 * silently replaces it, shows up as the wrong `reasoning_effort`. Every request
 * also records whether it belongs to Main: Main alone is offered the
 * `call_subagent` tool, and Main delegates once per run so the Subagent's own
 * request is observed too.
 */

async function provider(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "effort-fixture" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    const main = tools.includes("call_subagent");
    // A tool result in the transcript means the delegation already happened.
    const delegated = (body.messages ?? []).some((message) => message.role === "tool");
    requests.push({
      main,
      model: body.model,
      effort: body.reasoning_effort,
      hasEffort: Object.hasOwn(body, "reasoning_effort")
    });
    const reply =
      main && !delegated
        ? { name: "call_subagent", arguments: { task: "确认推理强度", mode: "sync" } }
        : { text: "done" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream("openai-completions", reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function client(dashboard) {
  return async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

/** One saved connection: its model name carries the level so a request names its account. */
function connection(profileId, level, baseUrl) {
  return {
    id: profileId,
    name: `${profileId} ${level}`,
    baseUrl,
    apiKey: "{{SECRET_p45effort}}",
    model: `model-${level}-${profileId}`,
    api: "openai-completions",
    reasoningEffort: level,
    supportsReasoningEffort: true,
    supportsPromptCacheKey: false,
    mainMaxTokens: 4096,
    subagentMaxTokens: 2048,
    contextWindow: 64000,
    supportsImages: false
  };
}

async function dashboardWith(t, buildProfiles, bindings) {
  const requests = await provider(t);
  const profiles = buildProfiles(requests.base);
  const dashboard = await startDashboard({
    config: {
      modelConnections: { version: 1, activeId: profiles[0].id, profiles },
      roleModels: { version: 1, host: bindings }
    }
  });
  t.after(() => dashboard.stop());
  return { ...requests, dashboard, request: client(dashboard) };
}

async function runMain(request, dashboard, taskId, extra = {}) {
  const created = await request("/api/tasks", {
    taskId,
    goal: `目标 ${taskId}`,
    projectId: dashboard.projectId
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await request(`/api/tasks/${taskId}/run`, {
    prompt: `处理 ${taskId}`,
    resume: false,
    ...extra
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const detail = await request(`/api/tasks/${taskId}`);
    if (detail.status === 200 && !detail.body.runtime.active && detail.body.task.status === "completed")
      return;
    await delay(50);
  }
  assert.fail(`Main ${taskId} did not settle`);
}

test(
  "each role's run sends the reasoning effort saved on its bound connection",
  { timeout: 240_000 },
  async (t) => {
    const levels = ["max", "low", "off"];
    const { dashboard, requests, request } = await dashboardWith(
      t,
      (baseUrl) => levels.map((level) => connection(`conn-${level}`, level, baseUrl)),
      { main: { profileId: "conn-max" }, executor: { profileId: "conn-max" } }
    );

    for (const level of levels) {
      for (const role of ["main", "executor"]) {
        const saved = await request("/api/model-settings/roles", { role, profileId: `conn-${level}` });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
      }
      const before = requests.length;
      await runMain(request, dashboard, `effort-${level}`);

      const main = requests.slice(before).find((entry) => entry.main);
      const subagent = requests.slice(before).find((entry) => !entry.main);
      assert.ok(main, `Main never reached the provider for ${level}`);
      assert.ok(subagent, `the Subagent never reached the provider for ${level}`);
      assert.equal(main.effort, level === "off" ? undefined : level, `Main sent ${level}`);
      assert.equal(subagent.effort, level === "off" ? undefined : level, `the Subagent sent ${level}`);
      // `off` is the absence of the provider parameter, never a literal "off".
      assert.equal(main.hasEffort, level !== "off", `Main wire form for ${level}`);
      assert.equal(subagent.hasEffort, level !== "off", `Subagent wire form for ${level}`);
      assert.equal(main.model, `model-${level}-conn-${level}`);
      assert.equal(subagent.model, `model-${level}-conn-${level}`);
    }

    // Two roles on different connections keep their own settings in one run.
    assert.equal(
      (await request("/api/model-settings/roles", { role: "main", profileId: "conn-max" })).status,
      200
    );
    assert.equal(
      (await request("/api/model-settings/roles", { role: "executor", profileId: "conn-low" })).status,
      200
    );
    const before = requests.length;
    await runMain(request, dashboard, "effort-mixed");
    const main = requests.slice(before).find((entry) => entry.main);
    const subagent = requests.slice(before).find((entry) => !entry.main);
    assert.equal(main.effort, "max");
    assert.equal(main.model, "model-max-conn-max");
    assert.equal(subagent.effort, "low");
    assert.equal(subagent.model, "model-low-conn-low");
  }
);

test(
  "an explicit reasoning choice applies to that run and the connection governs the next one",
  { timeout: 180_000 },
  async (t) => {
    const levels = ["max", "low"];
    const { dashboard, requests, request } = await dashboardWith(
      t,
      (baseUrl) => levels.map((level) => connection(`conn-${level}`, level, baseUrl)),
      { main: { profileId: "conn-max" } }
    );

    const before = requests.length;
    await runMain(request, dashboard, "effort-explicit", { thinkingLevel: "low" });
    const explicit = requests.slice(before);
    assert.equal(explicit[0].main, true);
    assert.equal(explicit[0].effort, "low", "an explicit choice reaches the wire");
    // The Subagent has no binding of its own, so it inherits the launching Run.
    assert.equal(explicit.find((entry) => !entry.main)?.effort, "low");

    const after = requests.length;
    await runMain(request, dashboard, "effort-connection");
    const next = requests.slice(after);
    assert.equal(next[0].main, true);
    assert.equal(next[0].effort, "max", "the choice did not leak into the next Run");
  }
);

test("/api/models reports the effort the next Main run will use", { timeout: 120_000 }, async (t) => {
  const levels = ["max", "low"];
  const { dashboard, request } = await dashboardWith(
    t,
    (baseUrl) => levels.map((level) => connection(`conn-${level}`, level, baseUrl)),
    { main: { profileId: "conn-max" } }
  );

  const first = await request("/api/models");
  assert.equal(first.status, 200);
  assert.equal(first.body.reasoningEffort, "max", "the composer's default comes from the Main connection");

  assert.equal(
    (await request("/api/model-settings/roles", { role: "main", profileId: "conn-low" })).status,
    200
  );
  const switched = await request("/api/models");
  assert.equal(switched.body.reasoningEffort, "low", "switching the Main connection moves the default");
});
