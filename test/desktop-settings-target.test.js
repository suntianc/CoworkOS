import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const root = resolve(new URL("..", import.meta.url).pathname);
const mainSource = readFileSync(join(root, "desktop/main.cjs"), "utf8");

/** Exercise the actual registered IPC handlers with deterministic host seams. */
function createHost() {
  const handlers = new Map();
  const calls = [];
  const a = {
    backendId: "backend_A",
    url: "http://127.0.0.1:39001",
    pid: 101,
    startedAt: "A-start",
    token: "fixture-A"
  };
  const b = {
    backendId: "backend_B",
    url: "http://127.0.0.1:39002",
    pid: 202,
    startedAt: "B-start",
    token: "fixture-B"
  };
  let live = a;
  let choice = b;
  let gate;
  let onReached;
  let statusGate;
  let onStatusReached;
  const reached = new Promise((resolveReached) => {
    onReached = resolveReached;
  });
  const statusReached = new Promise((resolveReached) => {
    onStatusReached = resolveReached;
  });
  const fakeElectron = {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => "/fixture",
      setName() {},
      setPath() {},
      requestSingleInstanceLock: () => false,
      quit() {},
      on() {}
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/fixture/B"] }),
      showErrorBox: () => {}
    },
    session: { defaultSession: { cookies: {} } }
  };
  const fakeRequire = (name) => {
    if (name === "electron") return fakeElectron;
    if (name === "./settings-target.cjs") return require(join(root, "desktop/settings-target.cjs"));
    if (name === "./keychain-worker.cjs") return { workerFlag: "--fixture-keychain" };
    if (name === "./update-install.cjs") return { managedUpdateLaunch: () => undefined };
    if (name === "./profile.cjs")
      return { desktopProfile: () => ({ name: "Fixture", userData: "/fixture", appRoot: root }) };
    if (name === "./computer-target.cjs")
      return {
        createComputerTargetCoordinator: () => ({
          beginSwitch: async () => {},
          activate: async () => ({ ok: true }),
          endSwitch: () => {},
          invalidateStopped: () => {},
          releaseForNavigation: async () => {},
          pauseForTakeover: async () => {},
          request: async () => ({})
        })
      };
    if (name === "./computer-navigation.cjs")
      return {
        createComputerNavigationGuard: () => ({ navigate: async (_url, load) => load(), started() {} })
      };
    if (name === "./speech-input.cjs")
      return {
        createDesktopSpeechInput: () => ({
          cancelActive: async () => {
            if (gate) {
              onReached();
              await gate;
            }
          }
        })
      };
    if (name === "./renderer-flush.cjs")
      return { createRendererFlush: () => ({ request: async () => true }) };
    if (name === "./trusted-content.cjs") return { assertTrustedSender: () => {} };
    if (name === "./update-lifecycle.cjs")
      return { prepareDesktopChange: async () => calls.push("prepare-A") };
    if (name === "./renderer-connection.cjs") return { connectRenderer: async () => {} };
    if (name === "node:fs/promises") return { writeFile: async () => {} };
    if (name.startsWith("node:")) return require(name);
    return {};
  };
  const source =
    `(function(require,process,console,setTimeout,clearTimeout,handlers,calls,a,b,api) {\n${mainSource}\n` +
    `backend={...a, stop:async()=>{calls.push('stop-A');return {state:'stopped'};}}; selectedBackend=b; paths={userData:'/fixture'};\n` +
    `settings={status:async()=>{calls.push('status-model-A');await api.modelStatus();return {owner:'A'};},test:async()=>{calls.push('test-model-A');return {owner:'A'};},save:async()=>{calls.push('save-model-A');return {owner:'A'};}};\n` +
    `webSearchSettings={status:async()=>{calls.push('status-search-A');return {owner:'A'};},save:async()=>{calls.push('save-search-A');return {owner:'A'};}};\n` +
    `backendAuthorization={select:async()=>api.choice(),verifySelected:async(expected)=>api.verify(expected)};\n` +
    `return {handlers,setSelected:(value)=>{selectedBackend=value;},setClosing:()=>{closing=true;},getRestart:()=>restartPromise};\n})`;
  const host = new Script(source, { filename: join(root, "desktop/main.cjs") }).runInThisContext()(
    fakeRequire,
    { argv: [], env: {}, platform: "linux" },
    console,
    setTimeout,
    clearTimeout,
    handlers,
    calls,
    a,
    b,
    {
      choice: () => choice,
      modelStatus: async () => {
        if (statusGate) {
          onStatusReached();
          await statusGate;
        }
      },
      verify: async (expected) => {
        if (JSON.stringify(expected) !== JSON.stringify(live)) throw new Error("后端实例身份已变化");
        return live;
      }
    }
  );
  return {
    ...host,
    a,
    b,
    calls,
    reached,
    statusReached,
    holdStatus: (promise) => {
      statusGate = promise;
    },
    hold: (promise) => {
      gate = promise;
    },
    setLive: (value) => {
      live = value;
    },
    setChoice: (value) => {
      choice = value;
    }
  };
}

test("settings for default backend are refused while another backend is selected", async () => {
  const host = createHost();
  for (const [name, input] of [
    ["bookman:model-status"],
    ["bookman:web-search-status"],
    ["bookman:test-model", {}],
    ["bookman:save-model", {}],
    ["bookman:save-web-search", {}]
  ]) {
    await assert.rejects(host.handlers.get(name)({}, input), (error) => {
      assert.match(error.message, /backend_B/);
      assert.match(error.message, /backend_A/);
      return true;
    });
  }
  assert.deepEqual(host.calls, []);
});

test("model and search status can load concurrently for the same selected backend", async () => {
  const host = createHost();
  host.setSelected(host.a);
  host.setLive(host.a);
  let release;
  host.holdStatus(
    new Promise((done) => {
      release = done;
    })
  );
  const model = host.handlers.get("bookman:model-status")({});
  try {
    await host.statusReached;
    assert.equal((await host.handlers.get("bookman:web-search-status")({})).owner, "A");
  } finally {
    release();
  }
  assert.equal((await model).owner, "A");
});

test("a pending default-backend settings save prevents switching until restart finishes", async () => {
  const host = createHost();
  host.setSelected(host.a);
  host.setLive(host.a);
  let release;
  host.hold(
    new Promise((done) => {
      release = done;
    })
  );
  const saving = host.handlers.get("bookman:save-model")({}, {});
  try {
    await host.reached;
    await assert.rejects(host.handlers.get("bookman:choose-backend")({}), /后端|设置/);
    assert.deepEqual(host.calls, []);
  } finally {
    release();
  }
  assert.equal((await saving).owner, "A");
  assert.deepEqual(host.calls, ["prepare-A", "save-model-A"]);
  await assert.rejects(host.handlers.get("bookman:choose-backend")({}), /后端|设置|重启/);
  host.setClosing();
  await host.getRestart();
  assert.deepEqual(host.calls, ["prepare-A", "save-model-A", "stop-A"]);
});

test("replacing the selected process during save preparation prevents the settings write", async () => {
  const host = createHost();
  host.setSelected(host.a);
  host.setLive(host.a);
  let release;
  host.hold(
    new Promise((done) => {
      release = done;
    })
  );
  const saving = host.handlers.get("bookman:save-model")({}, {});
  await host.reached;
  host.setLive({ ...host.a, pid: 303, startedAt: "replacement" });
  release();
  await assert.rejects(saving, /身份/);
  assert.deepEqual(host.calls, ["prepare-A"]);
  host.setLive(host.a);
  assert.equal((await host.handlers.get("bookman:model-status")({})).owner, "A");
});

test("settings target lease rejects identity changes and releases after failure and restart", async () => {
  const { createSettingsTargetGuard } = require("../desktop/settings-target.cjs");
  const a = { backendId: "backend_A", url: "http://127.0.0.1:39001", pid: 101, startedAt: "start-A" };
  let owner = a;
  let selected = a;
  let live = a;
  const target = createSettingsTargetGuard({
    getOwner: () => owner,
    getSelected: () => selected,
    verifySelected: async () => live
  });
  assert.equal(await target.settings(async () => "A status"), "A status");
  live = { ...a, pid: 303 };
  await assert.rejects(
    target.settings(async () => "wrong"),
    /身份/
  );
  live = a;
  await assert.rejects(
    target.select(async () => {
      throw new Error("cancelled");
    }),
    /cancelled/
  );
  assert.equal(await target.settings(async () => "A again"), "A again");
  let releaseRestart;
  const restart = new Promise((done) => {
    releaseRestart = done;
  });
  assert.equal(
    await target.settings(async ({ retainUntil }) => {
      retainUntil(restart);
      return "saved";
    }),
    "saved"
  );
  await assert.rejects(
    target.select(async () => {}),
    /后端|设置/
  );
  releaseRestart();
  await restart;
  assert.equal(await target.select(async () => "selected"), "selected");
  const b = { ...a, backendId: "backend_B", url: "http://127.0.0.1:39002", pid: 202, startedAt: "start-B" };
  selected = b;
  live = b;
  await assert.rejects(
    target.settings(async () => "wrong"),
    /backend_B.*backend_A/
  );
  owner = b;
  assert.equal(await target.settings(async () => "B status"), "B status");
});

test("a delayed settings read cannot return after the selected live instance changes", async () => {
  const { createSettingsTargetGuard } = require("../desktop/settings-target.cjs");
  const a = { backendId: "backend_A", url: "http://127.0.0.1:39001", pid: 101, startedAt: "start-A" };
  let live = a;
  const target = createSettingsTargetGuard({
    getOwner: () => a,
    getSelected: () => a,
    verifySelected: async () => live
  });
  let release;
  let reached;
  const started = new Promise((done) => {
    reached = done;
  });
  const waiting = new Promise((done) => {
    release = done;
  });
  const read = target.settings(async () => {
    reached();
    await waiting;
    return "stale A settings";
  });
  await started;
  await assert.rejects(
    target.select(async () => {}),
    /后端|设置/
  );
  live = { ...a, pid: 202, startedAt: "new-start" };
  release();
  await assert.rejects(read, /身份/);
  assert.equal(await target.select(async () => "unlocked"), "unlocked");
});
