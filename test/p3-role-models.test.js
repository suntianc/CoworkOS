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
  const saved = await request("/api/model-settings", {
    api: "openai-completions",
    supportsImages: false,
    supportsReasoningEffort: true,
    reasoningEffort: "low",
    ...value
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
}

const roleMain = (status) => status.modelRoles?.roles?.find((role) => role.role === "main");

test("host defaults and project overrides persist, keep their source and never travel with a key", async (t) => {
  const dashboard = await startDashboard({ defaultProject: false });
  t.after(() => dashboard.stop());
  const request = client(dashboard);
  const keyA = "role-host-key-a-7f31";
  const keyB = "role-host-key-b-2c94";
  await saveConnection(request, {
    profileName: "连接 A",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "model-a",
    apiKey: keyA
  });
  const withB = await saveConnection(request, {
    profileId: "",
    profileName: "连接 B",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "model-b",
    apiKey: keyB
  });
  const profileA = withB.profiles.find((profile) => profile.name === "连接 A");
  const profileB = withB.profiles.find((profile) => profile.name === "连接 B");
  await saveConnection(request, {
    profileId: profileA.id,
    profileName: "连接 A",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "model-a",
    apiKey: "",
    activate: true
  });
  const projectA = await createProject(request, dashboard, "a");
  const projectB = await createProject(request, dashboard, "b");

  const initial = await request(`/api/model-settings?projectId=${projectA.projectId}`);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(roleMain(initial.body).effective.source, "active");
  assert.equal(roleMain(initial.body).host, null);
  assert.equal(roleMain(initial.body).project, null);
  assert.equal(
    initial.body.modelRoles.roles.find((role) => role.role === "executor").wired,
    false,
    "later roles are listed as configuration-only"
  );
  assert.equal(initial.body.modelRoles.roles.find((role) => role.role === "executor").effective, null);

  const host = await request("/api/model-settings/roles", { role: "main", profileId: profileB.id });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  assert.equal(roleMain(host.body).host.profileId, profileB.id);
  assert.equal(roleMain(host.body).effective.source, "host");
  assert.equal(roleMain(host.body).effective.connectionName, "连接 B");
  assert.equal(roleMain(host.body).effective.model, "model-b");

  const project = await request("/api/model-settings/roles", {
    role: "main",
    projectId: projectA.projectId,
    profileId: profileA.id
  });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  assert.equal(roleMain(project.body).project.profileId, profileA.id);
  assert.equal(roleMain(project.body).effective.source, "project");

  const other = await request(`/api/model-settings?projectId=${projectB.projectId}`);
  assert.equal(roleMain(other.body).effective.source, "host", "project B keeps the host default");
  assert.equal(roleMain(other.body).project, null);
  const scoped = await request(`/api/model-settings?projectId=${projectA.projectId}`);
  assert.equal(roleMain(scoped.body).effective.source, "project");
  const unscoped = await request("/api/model-settings");
  assert.equal(roleMain(unscoped.body).effective.source, "host");

  for (const body of [initial.body, host.body, project.body, other.body, scoped.body, unscoped.body]) {
    const text = JSON.stringify(body);
    assert.equal(text.includes(keyA), false, "a settings response never returns a key");
    assert.equal(text.includes(keyB), false, "a settings response never returns a key");
  }

  const configPath = join(dashboard.root, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(JSON.stringify(config).includes(keyA), false, "the public config never stores a key");
  assert.equal(config.roleModels.version, 1);
  assert.equal(config.roleModels.host.main.profileId, profileB.id);
  assert.equal(config.roleModels.projects[projectA.projectId].main.profileId, profileA.id);
  const credentials = JSON.parse(await readFile(join(dashboard.root, "credentials.json"), "utf8"));
  assert.equal(credentials.modelConnections[profileA.id], keyA);
  assert.equal(credentials.modelConnections[profileB.id], keyB);

  await dashboard.restart();
  const restarted = await request(`/api/model-settings?projectId=${projectA.projectId}`);
  assert.equal(roleMain(restarted.body).effective.source, "project");
  assert.equal(roleMain(restarted.body).effective.connectionName, "连接 A");
  const restartedHost = await request("/api/model-settings");
  assert.equal(roleMain(restartedHost.body).effective.source, "host");

  const cleared = await request("/api/model-settings/roles", {
    role: "main",
    projectId: projectA.projectId,
    profileId: ""
  });
  assert.equal(roleMain(cleared.body).project, null);
  assert.equal(roleMain(cleared.body).effective.source, "host");
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(stored.roleModels.projects, undefined, "clearing the last project binding removes the map");

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
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).roleModels.host.main.profileId, profileB.id);
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

  const status = await request(`/api/model-settings?projectId=${project.projectId}`);
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
  assert.equal(credentials.modelConnections[profileId], "{{SECRET_0k3m9d2q}}");
});

test("resolution prefers an explicit choice, then the project, the host and the active connection", async () => {
  const saved = Object.fromEntries(
    ["COWORK_API_BASE", "COWORK_API_KEY", "COWORK_MODEL"].map((name) => [name, process.env[name]])
  );
  for (const name of Object.keys(saved)) delete process.env[name];
  try {
    const config = {
      modelConnections: {
        version: 1,
        activeId: "a",
        profiles: [
          connection("a", "A", "model-a", "key-a", { reasoningEffort: "low" }),
          connection("b", "B", "model-b", "key-b", { reasoningEffort: "high", api: "openai-responses" })
        ]
      }
    };
    const active = resolveModelRole(config);
    assert.equal(active.source, "active");
    assert.equal(active.connectionId, "a");

    const hosted = saveRoleModelBinding(config, { role: "main", profileId: "b" });
    assert.equal(resolveModelRole(hosted).source, "host");
    assert.equal(resolveModelRole(hosted).model, "model-b");
    assert.equal(resolveModelRole(hosted).thinkingLevel, "high");
    assert.equal(resolveModelRole(hosted).profile.api, "openai-responses");

    const scoped = saveRoleModelBinding(hosted, { role: "main", projectId: "project-1", profileId: "a" });
    const project = resolveModelRole(scoped, { projectId: "project-1" });
    assert.equal(project.source, "project");
    assert.equal(project.model, "model-a");
    assert.equal(resolveModelRole(scoped, { projectId: "project-2" }).source, "host");

    const explicit = resolveModelRole(scoped, {
      projectId: "project-1",
      profileId: "b",
      model: "single-shot"
    });
    assert.equal(explicit.source, "explicit");
    assert.equal(explicit.connectionId, "b");
    assert.equal(explicit.model, "single-shot");
    assert.equal(explicit.apiKey, "key-b", "an explicit connection keeps its own key");
    assert.throws(() => resolveModelRole(scoped, { profileId: "removed" }), /不存在[\s\S]*不会改用其他连接/);

    // A role with no binding on this host keeps the ordinary active connection.
    assert.equal(resolveModelRole(scoped, { role: "executor" }).source, "active");

    const publicView = publicModelRoles(scoped, "project-1");
    assert.equal(JSON.stringify(publicView).includes("key-a"), false);
    assert.equal(JSON.stringify(publicView).includes("key-b"), false);
    assert.equal(publicView.roles.filter((role) => role.wired).length, 1);

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
    JSON.stringify({ roleModels: { version: 1, projects: { "": { main: { profileId: "a" } } } } })
  );
  assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /项目 ID 不合法/);
});

function settingsFixture(t) {
  const { window, document } = parseHTML(
    '<html><body><div id="profile-settings-general"></div><div id="profile-settings-connections"></div></body></html>'
  );
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  t.after(() => Object.assign(globalThis, previous));
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 1, height: 1 }];
  };
  const state = {
    profiles: [
      { id: "a", name: "连接 A", baseUrl: "https://a.example.test/v1", model: "model-a", configured: true },
      { id: "b", name: "连接 B", baseUrl: "https://b.example.test/v1", model: "model-b", configured: true }
    ],
    projectId: "project-1",
    host: null,
    project: null
  };
  // The server scopes the role view by the request: a host-default save names
  // no project, so its answer carries no project override. The fake keeps that
  // boundary instead of always echoing the selected project.
  const effective = (scoped) => {
    const project = scoped ? state.project : null;
    const source = project ? "project" : state.host ? "host" : "active";
    const profile = state.profiles.find((entry) => entry.id === (project || state.host || "a"));
    return {
      role: "main",
      source,
      connectionId: profile.id,
      connectionName: profile.name,
      model: profile.model,
      api: "openai-completions",
      thinkingLevel: "low",
      supportsImages: false,
      ...(project ? { projectId: state.projectId } : {})
    };
  };
  const status = (scoped = state.projectId) => {
    const project = scoped ? state.project : null;
    return {
      ...state.profiles[0],
      activeProfileId: "a",
      visionProfileId: "",
      profiles: state.profiles,
      managedByEnvironment: false,
      modelRoles: {
        projectId: scoped ?? null,
        roles: [
          {
            role: "main",
            wired: true,
            host: state.host ? { profileId: state.host } : null,
            project: project ? { profileId: project } : null,
            effective: effective(scoped)
          },
          { role: "executor", wired: false, host: null, project: null, effective: null },
          { role: "reviewer", wired: false, host: null, project: null, effective: null },
          { role: "router", wired: false, host: null, project: null, effective: null }
        ]
      }
    };
  };
  const requests = [];
  installDesktopSettings({
    showToast() {},
    overview: { close: () => true, open() {} },
    identity: () => "backend-a",
    projectId: () => state.projectId,
    async api(path, options) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, method: options.method, body });
      if (path === "/api/model-settings/roles") {
        if (body.projectId) state.project = body.profileId || null;
        else state.host = body.profileId || null;
        return status(body.projectId ?? null);
      }
      return status(new URL(path, "http://fixture.test").searchParams.get("projectId"));
    }
  });
  const panel = document.querySelector("[aria-labelledby=model-settings-title]").parentNode;
  const form = panel.querySelector("form");
  const elements = Object.fromEntries(
    [...form.querySelectorAll("[name]")].map((element) => [element.name, element])
  );
  Object.defineProperty(form, "elements", { value: elements });
  form.reportValidity = () => true;
  for (const select of form.querySelectorAll("select"))
    Object.defineProperty(select, "value", {
      value: select.querySelector("option")?.value || "",
      writable: true
    });
  const hostSelect = panel.querySelector("[data-role-host]");
  const projectSelect = panel.querySelector("[data-role-project]");
  const tick = async () => {
    for (let index = 0; index < 8; index++) await new Promise((done) => setTimeout(done, 0));
  };
  return {
    state,
    requests,
    panel,
    hostSelect,
    projectSelect,
    projectField: projectSelect.closest("label"),
    effective: () => panel.querySelector("[data-role-effective]").textContent,
    async open() {
      document.querySelector("#desktop-model-settings").click();
      await tick();
    },
    async choose(select, value) {
      select.value = value;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
    }
  };
}

test("the production settings view configures Main and shows which source is in effect", async (t) => {
  const f = settingsFixture(t);
  await f.open();
  assert.deepEqual(
    [...f.hostSelect.querySelectorAll("option")].map((option) => option.textContent),
    ["跟随当前启用连接", "连接 A", "连接 B"]
  );
  assert.equal(f.projectField.hidden, false, "a selected project offers its override");
  // The real control is the select inside the field, not the field itself.
  assert.equal(f.projectSelect.tagName, "SELECT", "the project override is a select");
  assert.equal(f.projectField.tagName, "LABEL");
  assert.equal(f.projectField.querySelector("select"), f.projectSelect);
  assert.match(f.effective(), /当前启用连接/);
  assert.match(f.effective(), /连接 A · model-a/);
  assert.doesNotMatch(f.panel.textContent, /Executor|Reviewer|Router|已运行/);

  await f.choose(f.projectSelect, "b");
  const projectSave = f.requests.find((request) => request.path === "/api/model-settings/roles");
  assert.deepEqual(projectSave.body, { role: "main", projectId: "project-1", profileId: "b" });
  assert.match(f.effective(), /项目覆盖/);
  assert.match(f.effective(), /连接 B · model-b/);

  await f.choose(f.hostSelect, "b");
  const hostSave = f.requests.filter((request) => request.path === "/api/model-settings/roles").at(-1);
  assert.deepEqual(hostSave.body, { role: "main", profileId: "b" });
  // A host-default save must not hide the project override the person is editing.
  assert.equal(f.projectField.hidden, false, "the project override stays editable");
  assert.equal(f.projectSelect.value, "b", "the project override keeps its saved choice");
  assert.match(f.effective(), /项目覆盖/, "the project override still outranks the host default");
  assert.match(f.effective(), /连接 B · model-b/);

  await f.choose(f.projectSelect, "");
  const clear = f.requests.filter((request) => request.path === "/api/model-settings/roles").at(-1);
  assert.deepEqual(clear.body, { role: "main", projectId: "project-1", profileId: "" });
  assert.match(f.effective(), /主机默认/);
  assert.match(f.effective(), /连接 B · model-b/);
  assert.equal(f.state.host, "b");
  assert.equal(f.state.project, null);
});
