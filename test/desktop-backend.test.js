import "./application-fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
const require = createRequire(import.meta.url);
const { startBackend } = require("../desktop/backend.cjs");
const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
const { createModelSettings } = require("../desktop/model-settings.cjs");

test("a packaged backend preserves an explicit CAD runtime instead of replacing it with the bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-backend-component-override-"));
  let backend;
  t.after(async () => {
    await backend?.stop();
    await rm(root, { recursive: true, force: true });
  });
  const appRoot = join(root, "CoworkOS.app/Contents/Resources/app");
  const bundled = join(appRoot, "../cadquery/bin/python3");
  const external = join(root, "external-python3");
  await mkdir(dirname(bundled), { recursive: true });
  await mkdir(join(appRoot, "dist/src/cli"), { recursive: true });
  await writeFile(bundled, "bundled fixture");
  await writeFile(external, "explicit fixture");
  await writeFile(
    join(appRoot, "dist/src/cli/dashboard.js"),
    `
    process.send({type:"dashboard.ready", url:"http://127.0.0.1:"+process.env.COWORK_UI_PORT});
    process.on("message", message => {
      if(message.type === "probe-component") process.send({type:"component-env", python:process.env.COWORK_CADQUERY_PYTHON});
    });
    process.on("SIGTERM", () => process.exit(0));
  `
  );
  const paths = desktopPaths(appRoot, join(root, "data"), {});
  await prepareDesktopData(paths, "0.1.0");
  const previous = process.env.COWORK_CADQUERY_PYTHON;
  try {
    process.env.COWORK_CADQUERY_PYTHON = external;
    backend = await startBackend(paths, {}, process.execPath);
  } finally {
    if (previous === undefined) delete process.env.COWORK_CADQUERY_PYTHON;
    else process.env.COWORK_CADQUERY_PYTHON = previous;
  }
  const reply = once(backend.child, "message");
  backend.child.send({ type: "probe-component" });
  assert.deepEqual((await reply)[0], { type: "component-env", python: external });
});

test(
  "a Finder-launched backend resolves installed user tools without loading shell profiles",
  { skip: process.platform !== "darwin" && "Finder environment is specific to macOS" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-backend-path-"));
    let backend;
    t.after(async () => {
      await backend?.stop();
      await rm(root, { recursive: true, force: true });
    });
    const home = join(root, "home");
    const bin = join(home, ".local/bin");
    const appRoot = join(root, "app");
    await mkdir(bin, { recursive: true });
    await mkdir(join(appRoot, "dist/src/cli"), { recursive: true });
    for (const tool of ["atria-fixture-tool", "python3"]) {
      await writeFile(join(bin, tool), "#!/bin/sh\nprintf 'fixture-tool\\n'\n", { mode: 0o700 });
    }
    const profileMarker = join(root, "profile-was-loaded");
    for (const profile of [".profile", ".zprofile", ".zshrc", ".bash_profile", ".bashrc"]) {
      await writeFile(join(home, profile), `touch '${profileMarker}'\n`);
    }
    await writeFile(
      join(appRoot, "dist/src/cli/dashboard.js"),
      `const { createServer } = require("node:http");
const { spawnSync } = require("node:child_process");
const server = createServer((_request, response) => {
  const command = spawnSync("/bin/sh", ["-c", "atria-fixture-tool && python3"], { encoding: "utf8" });
  response.end(JSON.stringify({ status: command.status, stdout: command.stdout, path: process.env.PATH }));
});
server.listen(Number(process.env.COWORK_UI_PORT), "127.0.0.1", () => {
  process.send({ type: "dashboard.ready", url: "http://127.0.0.1:" + process.env.COWORK_UI_PORT });
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`
    );
    const paths = desktopPaths(appRoot, join(root, "data"), {});
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    try {
      process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
      process.env.HOME = home;
      await prepareDesktopData(paths, "0.1.0");
      backend = await startBackend(paths, {}, process.execPath);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    const result = await (await fetch(backend.url)).json();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "fixture-tool\nfixture-tool\n");
    assert.ok(result.path.startsWith(`${bin}:`));
    assert.ok(result.path.endsWith(":/usr/bin:/bin:/usr/sbin:/sbin"));
    await assert.rejects(access(profileMarker), { code: "ENOENT" });
  }
);

test("native backend owns readiness, authenticates its API, reaches MCP and shuts down", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-backend-"));
  const paths = desktopPaths(resolve("."), root, {});
  let backend;
  try {
    await prepareDesktopData(paths, "0.1.0");
    await writeFile(paths.configPath, "{}");
    backend = await startBackend(paths, {}, process.execPath);
    const request = async (path, body) => {
      const response = await fetch(`${backend.url}${path}`, {
        headers: { "x-atria-token": backend.token, "content-type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {})
      });
      assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
      return response.json();
    };
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
    await backend.stop();
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
    await prepareDesktopData(paths, "0.1.0");
    await assert.rejects(startBackend(paths, {}, join(root, "not-an-executable")), /无法启动/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable saved secret still starts an unconfigured backend for connection recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-backend-key-recovery-"));
  const paths = desktopPaths(resolve("."), root, {});
  let backend;
  try {
    await prepareDesktopData(paths, "0.1.0");
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
    backend = await startBackend(paths, launchSettings, process.execPath);
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
