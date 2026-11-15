import assert from "node:assert/strict";
import { test } from "node:test";
import { mainRunEnv } from "../dist/src/dashboard/main-run-env.js";
import { atriaDataPaths } from "../scripts/data-home.cjs";

/**
 * What the Dashboard hands a Main run.
 *
 * Two of these are locations the Agent process cannot derive on its own, and
 * both were learned the hard way. They are asserted here rather than only in
 * an integration test because an integration test has to set up the
 * environment itself, so it cannot notice the Dashboard failing to pass one.
 */

const base = {
  baseUrl: "https://api.example.test",
  apiKey: "k",
  model: "glm-5.3",
  taskWorkspace: "/tmp/ws",
  taskId: "task",
  runId: "main-1",
  dashboardUrl: "http://127.0.0.1:4321",
  projectRoot: "/tmp/project"
};

test("a Main run is told where the Dashboard is", () => {
  // Host-dependent tools read COWORK_DASHBOARD_URL to reach their Dashboard.
  assert.equal(mainRunEnv(base).COWORK_DASHBOARD_URL, "http://127.0.0.1:4321");
  // It must follow the port the Dashboard actually listens on, not a default:
  // assuming 3880 breaks every instance that is not on it, tests included.
  assert.equal(
    mainRunEnv({ ...base, dashboardUrl: "http://127.0.0.1:9999" }).COWORK_DASHBOARD_URL,
    "http://127.0.0.1:9999"
  );
});

test("the run's identity and workspace travel with it", () => {
  const env = mainRunEnv(base);
  assert.equal(env.COWORK_TASK_ID, "task");
  assert.equal(env.COWORK_RUN_ID, "main-1");
  assert.equal(env.COWORK_CLI_SESSION, "0", "Dashboard Main uses its own fixed Task recovery policy");
  assert.equal(env.COWORK_WORKSPACE, "/tmp/ws");
  assert.equal(env.COWORK_MODEL, "glm-5.3");
  assert.equal(env.COWORK_API_BASE, "https://api.example.test");
  // Every value is a string: this object is spread into a process env, where a
  // non-string is either coerced or dropped depending on the platform.
  for (const [key, value] of Object.entries(env)) {
    assert.equal(typeof value, "string", `${key} must be a string`);
  }
});

test("an explicit reasoning level overrides the connection default for one Main run", () => {
  assert.equal(mainRunEnv({ ...base, thinkingLevel: "low" }).COWORK_REASONING_EFFORT, "low");
  assert.equal(mainRunEnv(base).COWORK_REASONING_EFFORT, undefined);
});

test("only a connection resolved from the host file is re-readable at the next turn", () => {
  const selection = (source) => ({
    role: "main",
    source,
    baseUrl: base.baseUrl,
    apiKey: base.apiKey,
    model: base.model,
    profile: {},
    thinkingLevel: "off",
    supportsImages: false
  });
  // A resident Main adopts a newer saved connection per turn; a connection
  // pinned by the environment, a one-off profile or an archived retry is
  // fixed for the process's whole life.
  for (const source of ["active", "host", "project"])
    assert.equal(
      mainRunEnv({ ...base, selection: selection(source) }).COWORK_MAIN_MODEL_FROM_CONFIG,
      "1",
      source
    );
  for (const source of ["environment", "explicit", "retry"])
    assert.equal(
      mainRunEnv({ ...base, selection: selection(source) }).COWORK_MAIN_MODEL_FROM_CONFIG,
      undefined,
      source
    );
});

test("an explicit Pi agent directory wins over the derived one", () => {
  assert.equal(mainRunEnv({ ...base, piAgentDir: "/tmp/explicit" }).PI_CODING_AGENT_DIR, "/tmp/explicit");
  assert.equal(mainRunEnv(base).PI_CODING_AGENT_DIR, atriaDataPaths().piAgentDir);
});

test("a reassigned project changes execution CWD while task storage stays stable", () => {
  const env = mainRunEnv({ ...base, projectDirectory: "/tmp/new-project" });
  assert.equal(env.COWORK_PROJECT_DIR, "/tmp/new-project");
  assert.equal(env.COWORK_WORKSPACE, base.taskWorkspace);
  assert.equal(mainRunEnv(base).COWORK_PROJECT_DIR, base.taskWorkspace);
});
