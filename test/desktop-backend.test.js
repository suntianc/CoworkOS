import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { connectBackend, backendEnvironment } = require("../desktop/backend.cjs");
const { desktopBackendEnvironment } = require("../desktop/backend-environment.cjs");
const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
const { createModelSettings } = require("../desktop/model-settings.cjs");

/** Create the empty configuration a fresh installation starts with. */
async function prepare(paths) {
  await prepareDesktopData(paths, "0.1.0");
  await writeFile(paths.configPath, "{}", { flag: "wx" }).catch(() => undefined);
}

test("the execution host keeps an explicit CAD runtime instead of replacing it with the bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-backend-component-override-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const external = join(root, "external-python3");
  await writeFile(external, "explicit fixture");
  const paths = desktopPaths(resolve("."), join(root, "data"), {});
  const previous = process.env.COWORK_CADQUERY_PYTHON;
  try {
    process.env.COWORK_CADQUERY_PYTHON = external;
    const env = await backendEnvironment(paths, {});
    assert.equal(env.COWORK_CADQUERY_PYTHON, external);
  } finally {
    if (previous === undefined) delete process.env.COWORK_CADQUERY_PYTHON;
    else process.env.COWORK_CADQUERY_PYTHON = previous;
  }
});

test(
  "a Finder-launched execution host resolves installed user tools without loading shell profiles",
  { skip: process.platform !== "darwin" && "Finder environment is specific to macOS" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-backend-path-"));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const home = join(root, "home");
    const bin = join(home, ".local/bin");
    await mkdir(bin, { recursive: true });
    const paths = desktopPaths(resolve("."), join(root, "data"), {});
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    try {
      process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
      process.env.HOME = home;
      const env = await backendEnvironment(paths, {});
      assert.ok(env.PATH.startsWith(`${bin}:`), env.PATH);
      assert.ok(env.PATH.endsWith(":/usr/bin:/bin:/usr/sbin:/sbin"), env.PATH);
      assert.equal(env.PATH, desktopBackendEnvironment().PATH);
      assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(env.ATRIA_HOME, paths.userData);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  }
);

test("native backend owns readiness, authenticates its API, reaches MCP and shuts down", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-backend-"));
  const paths = desktopPaths(resolve("."), root, {});
  let backend;
  try {
    await prepare(paths);
    backend = await connectBackend(paths, {}, process.execPath);
    const request = async (path, body) => {
      const response = await fetch(`${backend.url}${path}`, {
        headers: { "x-atria-token": backend.token, "content-type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {})
      });
      assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
      return response.json();
    };
    assert.equal(backend.url, `http://127.0.0.1:${backend.port}`);
    assert.equal((await fetch(`${backend.url}/api/tasks`)).status, 401);
    await request("/api/tasks", { taskId: "native-mcp", goal: "native MCP auth" });
    const created = await request("/api/tasks/native-mcp/resources", {
      kind: "text/markdown",
      title: "native.md",
      initialContent: "# Heading\nbody\n"
    });
    await request("/api/workbench/tabs", {
      kind: "application",
      taskId: "native-mcp",
      appInstanceId: created.appInstance.appInstanceId
    });
    const resourceId = created.resource.resourceId;
    const discovery = await request(`/api/workbench/mcp/tools?resourceId=${resourceId}`);
    assert.ok(discovery.tools.some((tool) => tool.name === "replace_section"));
    const result = await request("/api/workbench/mcp/call", {
      taskId: "native-mcp",
      resourceId,
      name: "replace_section",
      params: { heading: "Heading", body: "updated" }
    });
    assert.ok(JSON.stringify(result).includes("updated"));
    const origin = backend.url;
    assert.equal((await backend.stop()).state, "stopped");
    backend = undefined;
    await assert.rejects(fetch(`${origin}/api/tasks`));
  } finally {
    await backend?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable native runtime reports startup failure without hanging shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-runtime-missing-"));
  try {
    const paths = desktopPaths(resolve("."), root, {});
    await prepare(paths);
    await assert.rejects(
      connectBackend(paths, {}, join(root, "not-an-executable")),
      /未能启动|启动失败|无法启动/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable saved secret still starts an unconfigured backend for connection recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-backend-key-recovery-"));
  const paths = desktopPaths(resolve("."), root, {});
  let backend;
  try {
    await prepare(paths);
    await writeFile(paths.configPath, JSON.stringify({ baseUrl: "http://127.0.0.1:1/v1", model: "fixture" }));
    await writeFile(paths.secretPath, "invalid-old-secret");
    const settings = createModelSettings(paths, {
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw new Error("old secret is unavailable");
      }
    });
    await assert.rejects(settings.read(), /无法解密/);
    const launchSettings = await settings.read({ allowUnavailableSecret: true });
    assert.equal(launchSettings.apiKey, undefined);
    backend = await connectBackend(paths, launchSettings, process.execPath);
    const response = await fetch(`${backend.url}/api/models`, {
      headers: { "x-atria-token": backend.token }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).configured, false);
    assert.equal((await settings.status()).configured, false, "native model setup remains reachable");
  } finally {
    await backend?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
