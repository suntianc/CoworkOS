import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const launcher = resolve("scripts/start-pi.mjs");

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-watch-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, "supervisor.json");
  const supervisorEnv = join(root, "supervisor-env.json");
  const piEnv = join(root, "pi-env.json");
  await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(root, "dist", "src", "cli"), { recursive: true });
  await writeFile(
    join(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi"),
    `require('node:fs').writeFileSync(${JSON.stringify(piEnv)},JSON.stringify({
      apiKey: process.env.COWORK_API_KEY ?? null,
      apiBase: process.env.COWORK_API_BASE ?? null,
      model: process.env.COWORK_MODEL ?? null,
      visionKey: process.env.COWORK_VISION_API_KEY ?? null,
      visionBase: process.env.COWORK_VISION_API_BASE ?? null,
      visionModel: process.env.COWORK_VISION_MODEL ?? null
    }));
console.log('fixture Pi exited');
`
  );
  await writeFile(
    join(root, "dist", "src", "cli", "cowork.js"),
    `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(supervisorEnv)},JSON.stringify({
  apiKey: process.env.COWORK_API_KEY ?? null,
  visionKey: process.env.COWORK_VISION_API_KEY ?? null
}));`
  );
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    typeof options.config === "string" ? options.config : `${JSON.stringify(options.config ?? {}, null, 2)}\n`
  );
  if (options.credentials)
    await writeFile(join(root, "credentials.json"), JSON.stringify(options.credentials), {
      mode: 0o600
    });
  const isolatedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_|EXA_)/.test(name))
  );
  const workspace = join(root, "workspace");
  const launch = (args = []) => {
    const env = {
      ...isolatedEnv,
      ATRIA_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      COWORK_CONFIG: configPath,
      COWORK_HARNESS_ROOT: root,
      COWORK_WORKSPACE: workspace,
      COWORK_TASK_ID: "first-task",
      ...(options.env ?? { COWORK_API_BASE: "http://unused.test", COWORK_API_KEY: "fixture" })
    };
    for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
    return execute(process.execPath, [launcher, ...args], { cwd: root, timeout: 10_000, env });
  };
  return { root, evidence, supervisorEnv, piEnv, workspace, launch };
}

test("an automatic Watch supervisor receives the whole workspace rather than its launch Task", async (t) => {
  const f = await fixture(t);
  await f.launch();
  let args;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      args = JSON.parse(await readFile(f.evidence, "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  assert.ok(args, "the detached fixture supervisor must launch");
  assert.equal(args[0], "watch-supervisor");
  assert.equal(args[args.indexOf("--workspace") + 1], f.workspace);
  assert.equal(args.includes("--task"), false, "later Tasks must not be excluded by the singleton owner");
});

test("host-stored credentials autostart the Watch supervisor and reach the Pi child", async (t) => {
  const f = await fixture(t, {
    config: {
      baseUrl: "http://unused.test",
      model: "fixture-model",
      modelConnections: {
        version: 1,
        activeId: "main",
        visionId: "vision",
        profiles: [
          {
            id: "main",
            name: "Main",
            baseUrl: "http://unused.test",
            model: "fixture-model",
            api: "openai-completions",
            supportsImages: false
          },
          {
            id: "vision",
            name: "Vision",
            baseUrl: "http://vision.example/v1",
            model: "vision-model",
            api: "openai-completions",
            supportsImages: true
          }
        ]
      }
    },
    credentials: {
      version: 1,
      modelConnections: { main: "host-main-key", vision: "host-vision-key" }
    },
    env: { COWORK_API_KEY: undefined }
  });
  await f.launch();
  const waitFor = async (path) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await delay(10);
    }
    return undefined;
  };
  const args = await waitFor(f.evidence);
  assert.ok(args, "a host-stored key must still autostart the Watch supervisor");
  assert.equal(args[0], "watch-supervisor");
  const supervisor = await waitFor(f.supervisorEnv);
  assert.equal(supervisor.apiKey, "host-main-key");
  const pi = await waitFor(f.piEnv);
  assert.equal(pi.apiKey, "host-main-key", "the Pi child receives the host-stored model key");
  assert.equal(pi.apiBase, "http://unused.test");
  assert.equal(pi.model, "fixture-model");
  assert.equal(pi.visionKey, "host-vision-key", "the Pi child receives the host-stored vision key");
  assert.equal(pi.visionBase, "http://vision.example/v1");
  assert.equal(pi.visionModel, "vision-model");
});

test("information-only Pi commands do not start a detached Watch supervisor", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "config.json"), "invalid fixture configuration");
  for (const argument of ["--help", "-h", "--version", "--list-models"]) await f.launch([argument]);
  await assert.rejects(readFile(f.evidence, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.root, "pi", "settings.json"), "utf8"), { code: "ENOENT" });
});
