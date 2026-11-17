import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { startDashboard } from "./dashboard-fixture.mjs";
import { publicModelRoles, resolveModelRole, saveRoleModelBinding } from "../dist/src/runtime/role-models.js";
import { readCoworkConfig } from "../dist/src/runtime/config.js";
import { installDesktopSettings } from "../web/assets/controllers/desktop-settings.js";
import { profileId as connectionId, providerConfig, saveTestConnection } from "./model-provider-fixture.mjs";

/**
 * Role model settings and resolution.
 *
 * The Dashboard routes and the production settings controller are the seams:
 * what a person can configure, what a later restart still reads, and which
 * source a Run will use. Secrets are asserted by looking for them, not by
 * inspecting the field that should have removed them.
 */

const connection = (id, name, model, apiKey, extra = {}) => ({
  id,
  name,
  baseUrl: `https://${id}.example.test/v1`,
  model,
  apiKey,
  api: "openai-completions",
  thinkingFormat: "auto",
  reasoningEffort: "low",
  supportsReasoningEffort: true,
  supportsPromptCacheKey: false,
  mainMaxTokens: 8192,
  subagentMaxTokens: 8192,
  contextWindow: 128000,
  supportsImages: false,
  ...extra
});

function client(dashboard) {
  return async (path, body, method) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

async function createProject(request, dashboard, name) {
  const directory = join(dashboard.root, `project-${name}`);
  await mkdir(directory, { recursive: true });
  const created = await request("/api/projects", {
    projectName: `项目 ${name}`,
    projectDirectory: directory
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project;
}

async function saveConnection(request, value) {
  const saved = await saveTestConnection(request, {
    api: "openai-completions",
    supportsImages: false,
    supportsReasoningEffort: true,
    reasoningEffort: "low",
    ...value
  });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  return saved;
}

const providerOf = (profileId) => profileId.split("#")[0];
const roleMain = (status) => status.modelRoles?.roles?.find((role) => role.role === "main");

test("host role defaults persist, keep their source and never travel with a key", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const keyA = "role-host-key-a-7f31";
  const keyB = "role-host-key-b-2c94";
  // Without a Main binding the first model is the one Main uses ("active").
  await saveConnection(request, {
    profileName: "连接 A",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "model-a",
    apiKey: keyA,
    activate: false
  });
  const withB = await saveConnection(request, {
    profileName: "连接 B",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "model-b",
    apiKey: keyB,
    activate: false
  });
  const profileA = withB.profiles.find((profile) => profile.name === "连接 A");
  const profileB = withB.profiles.find((profile) => profile.name === "连接 B");

  const initial = await request("/api/model-settings");
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(roleMain(initial.body).effective.source, "active");
  assert.equal(roleMain(initial.body).effective.connectionName, "连接 A / model-a");
  assert.equal(roleMain(initial.body).host, null);
  assert.equal(
    initial.body.modelRoles.roles.find((role) => role.role === "executor").wired,
    true,
    "executor and reviewer read their binding when a work item starts"
  );
  // With no binding a delegation keeps the launching Run's own connection, so
  // the role has no fixed effective connection to report.
  assert.equal(initial.body.modelRoles.roles.find((role) => role.role === "executor").effective, null);
  assert.equal(initial.body.modelRoles.roles.find((role) => role.role === "reviewer").wired, true);
  assert.equal(
    initial.body.modelRoles.roles.find((role) => role.role === "router").wired,
    false,
    "router stays a later path's configuration key"
  );

  const host = await request("/api/model-settings/roles", { role: "main", profileId: profileB.id });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  assert.equal(roleMain(host.body).host.profileId, profileB.id);
  assert.equal(roleMain(host.body).effective.source, "host");
  assert.equal(roleMain(host.body).effective.connectionName, "连接 B / model-b");
  assert.equal(roleMain(host.body).effective.model, "model-b");
  const executor = await request("/api/model-settings/roles", { role: "executor", profileId: profileA.id });
  assert.equal(executor.status, 200, JSON.stringify(executor.body));
  const executorRole = executor.body.modelRoles.roles.find((role) => role.role === "executor");
  assert.equal(executorRole.effective.source, "host");
  assert.equal(executorRole.effective.model, "model-a");

  for (const body of [initial.body, host.body, executor.body]) {
    const text = JSON.stringify(body);
    assert.equal(text.includes(keyA), false, "a settings response never returns a key");
    assert.equal(text.includes(keyB), false, "a settings response never returns a key");
  }

  const configPath = join(dashboard.root, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(JSON.stringify(config).includes(keyA), false, "the public config never stores a key");
  assert.deepEqual(config.roleModels, {
    version: 1,
    host: { main: { profileId: profileB.id }, executor: { profileId: profileA.id } }
  });
  const credentials = JSON.parse(await readFile(join(dashboard.root, "credentials.json"), "utf8"));
  assert.equal(credentials.modelProviders[providerOf(profileA.id)], keyA);
  assert.equal(credentials.modelProviders[providerOf(profileB.id)], keyB);

  await dashboard.restart();
  const restarted = await request("/api/model-settings");
  assert.equal(roleMain(restarted.body).effective.source, "host");
  assert.equal(roleMain(restarted.body).effective.connectionName, "连接 B / model-b");

  await request("/api/model-settings/roles", { role: "executor", profileId: "" });
  const cleared = await request("/api/model-settings/roles", { role: "main", profileId: "" });
  assert.equal(roleMain(cleared.body).host, null);
  assert.equal(roleMain(cleared.body).effective.source, "active");
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(stored.roleModels, undefined, "clearing the last binding removes the role section");

  const rejectedRole = await request("/api/model-settings/roles", {
    role: "planner",
    profileId: profileA.id
  });
  assert.equal(rejectedRole.status, 400);
  assert.match(rejectedRole.body.error, /模型角色/);
  const rejectedProfile = await request("/api/model-settings/roles", {
    role: "main",
    profileId: "missing-connection"
  });
  assert.equal(rejectedProfile.status, 400);
  assert.match(rejectedProfile.body.error, /不存在/);
  assert.equal(
    JSON.parse(await readFile(configPath, "utf8")).roleModels,
    undefined,
    "a refused save writes nothing"
  );
});

test("a missing referenced connection is reported where it is used and never replaced by the active one", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const saved = await saveConnection(request, {
    profileName: "连接 A",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "model-a",
    apiKey: "{{SECRET_0k3m9d2q}}"
  });
  const profileId = saved.activeProfileId;
  const project = await createProject(request, dashboard, "dangling");
  const configPath = join(dashboard.root, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.roleModels = { version: 1, host: { main: { profileId: "deleted-connection" } } };
  const credentials = JSON.parse(await readFile(join(dashboard.root, "credentials.json"), "utf8"));
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await dashboard.restart();

  const status = await request("/api/model-settings");
  assert.equal(status.status, 200);
  assert.match(roleMain(status.body).error, /deleted-connection/);
  assert.match(roleMain(status.body).error, /不存在/);
  assert.equal(roleMain(status.body).effective, null, "a broken reference is not shown as an active source");

  const task = await request("/api/tasks", {
    taskId: "dangling-run",
    goal: "不应启动",
    projectId: project.projectId
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const refused = await request("/api/tasks/dangling-run/run", { prompt: "继续" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /deleted-connection/);
  const detail = await request("/api/tasks/dangling-run");
  assert.equal(detail.body.runtime.active, false);
  assert.notEqual(detail.body.task.status, "running", "a refused explicit reference starts no Run");

  // Restoring a real connection restores the host default; the stored account is untouched.
  config.roleModels = { version: 1, host: { main: { profileId } } };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await dashboard.restart();
  const restored = await request("/api/model-settings");
  assert.equal(roleMain(restored.body).effective.source, "host");
  assert.equal(JSON.stringify(restored.body).includes("{{SECRET_0k3m9d2q}}"), false);
  assert.equal(credentials.modelProviders[providerOf(profileId)], "{{SECRET_0k3m9d2q}}");
});

test("resolution prefers an explicit choice, then the host and the active connection", async () => {
  const saved = Object.fromEntries(
    ["COWORK_API_BASE", "COWORK_API_KEY", "COWORK_MODEL"].map((name) => [name, process.env[name]])
  );
  for (const name of Object.keys(saved)) delete process.env[name];
  try {
    const a = connection("a", "A", "model-a", "key-a", { reasoningEffort: "low" });
    const b = connection("b", "B", "model-b", "key-b", { reasoningEffort: "high", api: "openai-responses" });
    const config = {
      ...providerConfig([a, b])
    };
    const active = resolveModelRole(config);
    assert.equal(active.source, "active");
    assert.equal(active.connectionId, "a");

    const hosted = saveRoleModelBinding(config, { role: "main", profileId: connectionId(b) });
    assert.equal(resolveModelRole(hosted).source, "host");
    assert.equal(resolveModelRole(hosted).model, "model-b");
    assert.equal(resolveModelRole(hosted).thinkingLevel, "high");
    assert.equal(resolveModelRole(hosted).profile.api, "openai-responses");

    const explicit = resolveModelRole(hosted, { profileId: connectionId(a), model: "single-shot" });
    assert.equal(explicit.source, "explicit");
    assert.equal(explicit.connectionId, "a");
    assert.equal(explicit.model, "single-shot");
    assert.equal(explicit.apiKey, "key-a", "an explicit connection keeps its own key");
    assert.throws(() => resolveModelRole(hosted, { profileId: "removed" }), /不存在[\s\S]*不会改用其他连接/);

    // A role with no binding on this host keeps the ordinary active connection.
    assert.equal(resolveModelRole(hosted, { role: "executor" }).source, "active");

    const publicView = publicModelRoles(hosted);
    assert.equal(JSON.stringify(publicView).includes("key-a"), false);
    assert.equal(JSON.stringify(publicView).includes("key-b"), false);
    assert.equal(publicView.roles.filter((role) => role.wired).length, 3);

    // A legacy single connection still follows the Task's last explicit model.
    const legacy = { baseUrl: "http://legacy/v1", apiKey: "key-legacy", model: "model-active" };
    assert.equal(resolveModelRole(legacy, { taskModel: "model-task" }).model, "model-task");
    assert.equal(resolveModelRole(legacy, { model: "model-now" }).model, "model-now");
    assert.equal(legacy.api, undefined, "resolution does not rewrite the configuration");
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test("the local configuration rejects a malformed role section instead of ignoring it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-role-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  await writeFile(
    path,
    JSON.stringify({ roleModels: { version: 1, host: { planner: { profileId: "a" } } } })
  );
  assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /未知角色：planner/);
  await writeFile(path, JSON.stringify({ roleModels: { version: 2 } }));
  assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /版本不兼容/);
  await writeFile(
    path,
    JSON.stringify({ roleModels: { version: 1, projects: { p: { main: { profileId: "a" } } } } })
  );
  assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /未知字段：projects/);
});

function settingsFixture(t, { fail } = {}) {
  const { window, document } = parseHTML(
    '<html><body><section data-settings-panel="models"></section><div id="profile-settings-tools"></div></body></html>'
  );
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  t.after(() => Object.assign(globalThis, previous));
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 1, height: 1 }];
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, bottom: 0, top: 0, right: 0 });
  globalThis.innerWidth = 1440;
  globalThis.innerHeight = 900;
  const model = (provider, id, extra = {}) => ({
    id,
    profileId: `${provider}#${id}`,
    supportsImages: false,
    reasoningEffort: "low",
    ...extra
  });
  const state = {
    providers: [
      {
        id: "p-a",
        name: "连接 A",
        baseUrl: "https://a.example.test/v1",
        api: "openai-completions",
        enabled: true,
        configured: true,
        models: [model("p-a", "model-a")]
      },
      {
        id: "p-b",
        name: "连接 B",
        baseUrl: "https://b.example.test/v1",
        api: "openai-completions",
        enabled: true,
        configured: true,
        models: [model("p-b", "model-b", { reasoningEffort: "high" })]
      }
    ],
    host: null,
    executor: null
  };
  const status = () => ({
    providers: state.providers,
    activeProfileId: state.host || "p-a#model-a",
    managedByEnvironment: false,
    modelRoles: {
      roles: [
        {
          role: "main",
          wired: true,
          host: state.host ? { profileId: state.host } : null,
          effective: null
        },
        {
          role: "executor",
          wired: true,
          host: state.executor ? { profileId: state.executor } : null,
          effective: null
        },
        { role: "reviewer", wired: true, host: null, effective: null },
        { role: "router", wired: false, host: null, effective: null }
      ]
    }
  });
  const requests = [];
  const toasts = [];
  const settings = installDesktopSettings({
    showToast: (message) => toasts.push(message),
    host: { close: () => true, open() {}, onSection: () => () => {} },
    identity: () => "backend-a",
    async api(path, options) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, method: options.method, body });
      if (fail?.(path, body)) throw new Error(fail(path, body));
      if (path === "/api/model-settings/roles") {
        if (body.role === "executor") state.executor = body.profileId || null;
        else state.host = body.profileId || null;
        return status();
      }
      return status();
    }
  });
  const panel = document.querySelector('[data-settings-panel="models"]');
  const tick = async () => {
    for (let index = 0; index < 8; index++) await new Promise((done) => setTimeout(done, 0));
  };
  const picker = (role) => panel.querySelector(`[data-role-picker="${role}"]`);
  return {
    state,
    requests,
    toasts,
    panel,
    picker,
    roleSaves: () => requests.filter((request) => request.path === "/api/model-settings/roles"),
    async open() {
      settings.open();
      await tick();
      panel.querySelector('[data-model-tab="roles"]').click();
    },
    async pick(role, profileId) {
      picker(role).click();
      const option = document.querySelector(`.role-menu [data-menu-pick="${profileId}"]`);
      assert.ok(option, `no option ${profileId} for ${role}`);
      option.click();
      await tick();
    },
    async effort(role, value) {
      const select = panel.querySelector(`[data-role-effort="${role}"]`);
      // linkedom's select has no settable value; the page reads `value` at change time.
      Object.defineProperty(select, "value", { value, configurable: true });
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
    }
  };
}

test("the role tab sets Main for the host and shows the choice", async (t) => {
  const f = settingsFixture(t);
  await f.open();
  assert.equal(f.panel.querySelector('[data-model-view="roles"]').hidden, false);
  assert.match(f.picker("main").textContent, /未选择/);
  assert.match(f.picker("executor").textContent, /沿用 Main/);
  assert.equal(
    f.requests.some((request) => request.path.includes("projectId")),
    false
  );

  await f.pick("main", "p-b#model-b");
  assert.deepEqual(f.roleSaves().at(-1).body, { role: "main", profileId: "p-b#model-b" });
  assert.match(f.picker("main").textContent, /model-b/);
  assert.match(f.picker("main").textContent, /连接 B/);
  assert.equal(f.panel.querySelector('[data-role-effort="main"]').value, "high", "effort follows the model");

  await f.pick("main", "");
  assert.deepEqual(f.roleSaves().at(-1).body, { role: "main", profileId: "" });
  assert.match(f.picker("main").textContent, /未选择/);
  assert.equal(f.state.host, null);
});

test("a role change that fails is reported and the saved choice stays on the page", async (t) => {
  const f = settingsFixture(t, {
    fail: (path, body) =>
      path === "/api/model-settings/roles" && body.role === "main"
        ? "保存被拒绝：连接不可用"
        : path === "/api/model-settings/models"
          ? "推理强度保存失败：连接不可用"
          : undefined
  });
  await f.open();
  await f.pick("main", "p-b#model-b");
  assert.match(f.toasts.at(-1), /保存被拒绝/);
  assert.match(f.picker("main").textContent, /未选择/, "the refused choice is not shown as saved");

  await f.pick("executor", "p-a#model-a");
  assert.deepEqual(f.roleSaves().at(-1).body, { role: "executor", profileId: "p-a#model-a" });
  assert.match(f.picker("executor").textContent, /model-a/);
  await f.effort("executor", "high");
  const effortSave = f.requests.filter((request) => request.path === "/api/model-settings/models").at(-1);
  assert.deepEqual(effortSave.body, {
    providerId: "p-a",
    models: [{ id: "model-a", reasoningEffort: "high" }]
  });
  assert.match(f.toasts.at(-1), /推理强度保存失败/);
  assert.equal(f.panel.querySelector('[data-role-effort="executor"]').value, "low", "the saved effort stays");
});
