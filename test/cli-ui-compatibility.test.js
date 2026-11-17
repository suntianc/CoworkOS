import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { preflightCliUi } from "../scripts/cli-ui-compatibility.mjs";
import { buildCliUiManifest } from "../scripts/build-cli-ui.mjs";
import { preflightCliShell } from "../scripts/cli-shell-compatibility.mjs";

const exec = promisify(execFile);
const sdkRoot = fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
const policy = JSON.parse(await readFile(new URL("../scripts/cli-ui-policy.json", import.meta.url)));

test("shell source mismatches are rejected before headless runtime and user-state preparation", async (t) => {
  const f = await guardedFixture(t);
  const state = join(f.root, "headless-state");
  await mkdir(state);
  const shell = preflightCliShell({ piPackageDir: f.sdk });
  const target = fileURLToPath(new URL(shell.targets[0].targetURL));
  await writeFile(target, (await readFile(target, "utf8")) + "\n// private unsupported shell fixture\n");
  assert.throws(() => preflightCliShell({ piPackageDir: f.sdk }), /CoworkOS Agent.*兼容性校验失败/);
  const before = await snapshot(state);
  const result = await exec(
    process.execPath,
    [join(f.root, "scripts/atria.mjs"), "start", "--mode", "json", "--print", "fixture"],
    {
      cwd: f.root,
      env: { ...f.env, ATRIA_HOME: state },
      timeout: 10000
    }
  ).then(
    () => {
      throw new Error("Unexpected headless startup");
    },
    (error) => error
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /CoworkOS Agent.*兼容性校验失败/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_RUNTIME_IMPORT|file:\/\/|SyntaxError/);
  assert.deepEqual(await snapshot(state), before);
});

async function guardedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-ui-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
  for (const file of ["package.json", ...Object.keys(policy.files)]) {
    await mkdir(dirname(join(sdk, file)), { recursive: true });
    await cp(join(sdkRoot, file), join(sdk, file));
  }
  // Current model-profile validation imports the proxy transport even when no
  // model is called; keep that genuine dependency in the isolated CLI fixture.
  await cp(resolve("node_modules/undici"), join(root, "node_modules/undici"), { recursive: true });
  await mkdir(join(root, "scripts"));
  for (const file of [
    "atria.mjs",
    "start-pi.mjs",
    "cli-information.mjs",
    "cli-startup-error.mjs",
    "cli-ui-compatibility.mjs",
    "cli-ui-policy.json",
    "cli-ui-boot.mjs",
    "cli-shell-policy.json",
    "cli-shell-compatibility.mjs",
    "cli-shell-boot.mjs",
    "data-home.cjs",
    "cli-runtime-host.mjs"
  ])
    await cp(resolve("scripts", file), join(root, "scripts", file));
  await mkdir(join(root, "dist"));
  await cp(resolve("dist/src"), join(root, "dist/src"), { recursive: true });
  await cp(resolve("dist/scripts"), join(root, "dist/scripts"), { recursive: true });
  await cp(resolve("dist/web"), join(root, "dist/web"), { recursive: true });
  await cp(resolve("package.json"), join(root, "package.json"));
  const manifestPath = join(root, "dist/cli-ui-manifest.json");
  await buildCliUiManifest(manifestPath);
  await writeFile(
    join(root, "scripts/start-pi-runtime.mjs"),
    'throw new Error("UNEXPECTED_RUNTIME_IMPORT");'
  );
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(COWORK_|PI_|ATRIA_|NODE_OPTIONS)/.test(k))
    ),
    HOME: root,
    COWORK_HARNESS_ROOT: root,
    COWORK_API_KEY: "fixture-local",
    COWORK_API_BASE: "http://127.0.0.1:1/v1",
    COWORK_MODEL: "fixture",
    PI_OFFLINE: "1"
  };
  async function run(args, extraEnv) {
    const child = spawn("python3", [resolve("test/fixtures/cli-ui-pty.py")], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.stdin.end(
      JSON.stringify({
        command: [process.execPath, join(root, "scripts/atria.mjs"), ...args],
        cwd: root,
        env: { ...env, ...extraEnv },
        ready: "兼容性校验失败",
        actions: []
      })
    );
    const code = await new Promise((done, fail) => {
      child.once("close", done);
      child.once("error", fail);
    });
    assert.equal(code, 0, err);
    return JSON.parse(out);
  }
  return { root, sdk, manifestPath, env, run };
}

async function snapshot(directory) {
  const entries = [];
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const file = join(path, item.name);
      if (item.isDirectory()) await walk(file);
      else
        entries.push([
          file,
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex")
        ]);
    }
  }
  await walk(directory);
  return entries.sort();
}

test(
  "public TUI refuses unreviewed manifests before new, resume, concurrent or existing workspace preparation",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await guardedFixture(t),
      state = join(f.root, "state");
    await mkdir(state);
    const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
    manifest.spans[0].replacement = '"unreviewed"';
    await writeFile(f.manifestPath, JSON.stringify(manifest));
    for (const kind of ["new", "resume", "concurrent", "existing"]) {
      const home = join(state, kind),
        workspace = join(home, "workspace"),
        profile = join(home, "pi");
      const extra = { ATRIA_HOME: home, COWORK_WORKSPACE: workspace, PI_CODING_AGENT_DIR: profile };
      if (kind !== "new") {
        await mkdir(join(workspace, "existing"), { recursive: true });
        await writeFile(
          join(workspace, "existing/task.json"),
          JSON.stringify({
            id: "existing",
            status: "running",
            userMarker: "keep-existing-task"
          })
        );
        await mkdir(profile, { recursive: true });
        await writeFile(join(profile, "keep.jsonl"), '{"user":"Pi retained"}\n');
        extra.COWORK_TASK_ID = "existing";
      }
      const before = await snapshot(state),
        args = kind === "resume" ? ["--continue"] : [];
      const results = await Promise.all(
        Array.from({ length: kind === "concurrent" ? 2 : 1 }, () => f.run(["start", ...args], extra))
      );
      for (const result of results) {
        assert.equal(result.exitCode, 1, result.plain);
        assert.match(result.plain, /CoworkOS Agent.*兼容性校验失败/);
        assert.doesNotMatch(result.plain, /UNEXPECTED_RUNTIME_IMPORT|file:\/\/|SyntaxError/);
      }
      assert.deepEqual(await snapshot(state), before);
    }
  }
);

test(
  "child TOCTOU refusal releases its project lease and never acknowledges SDK readiness",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await guardedFixture(t),
      home = join(f.root, "state"),
      workspace = join(home, "workspace");
    // Real parent preflight passes. A fixture runtime then changes only its private SDK copy.
    await writeFile(
      join(f.root, "scripts/start-pi-runtime.mjs"),
      `import {appendFile} from "node:fs/promises";
import {runCliProcess} from "./cli-runtime-host.mjs";
import {beginProjectExecution} from "../dist/src/workspace/project-execution.js";
export async function startPi(){
await appendFile(${JSON.stringify(join(f.sdk, policy.target))},"\\n// private TOCTOU fixture");
const lease=await beginProjectExecution(process.env.COWORK_WORKSPACE,"fixture-task");
try {
process.exitCode=await runCliProcess({executable:${JSON.stringify(join(f.root, "scripts/cli-ui-boot.mjs"))},args:[],env:process.env,
projectDirectory:process.cwd(),uiCompatibility:true,
onSdkReady:()=>appendFile(${JSON.stringify(join(home, "unexpected-supervisor"))},"ready")});
} finally {await lease.release();}
}`
    );
    const result = await f.run(["start"], {
      ATRIA_HOME: home,
      COWORK_WORKSPACE: workspace,
      PI_CODING_AGENT_DIR: join(home, "pi")
    });
    assert.equal(result.exitCode, 1, result.plain);
    assert.match(result.plain, /兼容性校验失败/);
    await assert.rejects(readFile(join(workspace, "fixture-task/agents/main/project-execution.json")), {
      code: "ENOENT"
    });
    await assert.rejects(readFile(join(home, "unexpected-supervisor")), { code: "ENOENT" });
  }
);

test("missing hook API fails before SDK lookup, and non-target modules retain their exact exports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ui-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = (await readFile(resolve("scripts/cli-ui-compatibility.mjs"), "utf8")).replace(
    'import * as nodeModule from "node:module";',
    "const nodeModule = {};"
  );
  await writeFile(join(root, "compatibility.mjs"), copy);
  await cp(resolve("scripts/cli-ui-policy.json"), join(root, "cli-ui-policy.json"));
  const absent = await import(new URL(`file://${join(root, "compatibility.mjs")}`).href);
  assert.throws(
    () => absent.preflightCliUi({ piPackageDir: join(root, "absent") }),
    (error) => /registerHooks unavailable/.test(error.cause.message)
  );
  const { installCliUiHook } = await import("../scripts/cli-ui-compatibility.mjs");
  let ready = 0;
  const hook = installCliUiHook(preflightCliUi(), () => ready++);
  try {
    const content = 'export const text = "Pi user content /dementedelves sends a report to the developers.";';
    await writeFile(join(root, "ordinary.mjs"), content);
    const imported = await import(new URL(`file://${join(root, "ordinary.mjs")}`).href);
    assert.equal(imported.text, "Pi user content /dementedelves sends a report to the developers.");
    assert.equal(ready, 0);
    assert.equal(await readFile(join(root, "ordinary.mjs"), "utf8"), content);
  } finally {
    hook.deregister();
  }
});

test("UI manifest covers six reviewed positions and rejects corrupt or unsupported inputs without writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ui-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, "manifest.json");
  const manifest = await buildCliUiManifest(manifestPath);
  assert.deepEqual(new Set(manifest.spans.map((span) => span.id)), new Set(policy.methods));
  const sdk = join(root, "sdk");
  for (const file of ["package.json", ...Object.keys(policy.files)]) {
    await mkdir(dirname(join(sdk, file)), { recursive: true });
    await cp(join(sdkRoot, file), join(sdk, file));
  }
  assert.ok(preflightCliUi({ piPackageDir: sdk, manifestPath }).targetURL.endsWith(policy.target));
  for (const change of [
    (m) => {
      m.spans.pop();
    },
    (m) => {
      m.spans[0].start++;
    },
    (m) => {
      m.spans[0].id = m.spans[1].id;
    },
    (m) => {
      m.spans[0].replacement = "invalid JavaScript {{{";
    },
    (m) => {
      m.spans[0].replacement = '"unreviewed replacement"';
    },
    (m) => {
      m.files[m.target] = "wrong";
    }
  ]) {
    const altered = structuredClone(manifest);
    change(altered);
    await writeFile(manifestPath, JSON.stringify(altered));
    assert.throws(
      () => preflightCliUi({ piPackageDir: sdk, manifestPath }),
      /CoworkOS Agent.*兼容性校验失败/
    );
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  const metadata = JSON.parse(await readFile(join(sdk, "package.json"), "utf8"));
  await writeFile(join(sdk, "package.json"), JSON.stringify({ ...metadata, version: "0.88.0" }));
  assert.throws(() => preflightCliUi({ piPackageDir: sdk, manifestPath }), /兼容性校验失败/);
  await writeFile(join(sdk, "package.json"), JSON.stringify(metadata));
  const target = join(sdk, policy.target),
    original = await readFile(target);
  await writeFile(target, Buffer.concat([original, Buffer.from("\n// changed SDK")]));
  assert.throws(() => preflightCliUi({ piPackageDir: sdk, manifestPath }), /兼容性校验失败/);
  assert.deepEqual(await readFile(target), Buffer.concat([original, Buffer.from("\n// changed SDK")]));
  await rm(target);
  assert.throws(() => preflightCliUi({ piPackageDir: sdk, manifestPath }), /兼容性校验失败/);
  assert.deepEqual((await readdir(root)).sort(), ["manifest.json", "sdk"]);
});

test("the real bundle boot loads with cache enabled while SDK source and empty profiles remain intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ui-boot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await Promise.all(Object.keys(policy.files).map((file) => readFile(join(sdkRoot, file))));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(COWORK_|PI_|ATRIA_|NODE_OPTIONS)/.test(key))
    ),
    HOME: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "profile"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    NODE_COMPILE_CACHE: join(root, "cache")
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { stdout, stderr } = await exec(
      process.execPath,
      [resolve("scripts/cli-ui-boot.mjs"), "--version"],
      { cwd: root, env, timeout: 10000 }
    );
    assert.equal(stdout.trim(), policy.sdkVersion);
    assert.equal(stderr, "");
  }
  assert.deepEqual(
    await Promise.all(Object.keys(policy.files).map((file) => readFile(join(sdkRoot, file)))),
    before
  );
  await assert.rejects(readFile(join(root, "profile/settings.json")), { code: "ENOENT" });
});
