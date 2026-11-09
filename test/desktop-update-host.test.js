import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
const { createDesktopUpdateHost } = createRequire(import.meta.url)("../desktop/update-host.cjs");

async function fixture(
  t,
  {
    development = false,
    version = "0.1.1",
    channel,
    env = {},
    observe,
    managedScheduleError,
    managedDiscardError
  } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "atria-update-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "program"),
    userData = join(directory, "profile");
  await mkdir(root);
  await mkdir(userData);
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(userData, "model-config.json"), "fixture encrypted settings");
  if (channel) await writeFile(join(userData, "update-preferences.json"), JSON.stringify({ channel }));
  const calls = [];
  const snapshots = [];
  let constructor, result, checkWait, restartWait, recoverWait, restartError, nativeError, recoverError;
  const createUpdates = (options) => {
    constructor = options;
    let state = { mode: options.mode, channel: options.channel, phase: "idle", busy: false };
    const publish = (patch) => {
      state = { ...state, ...patch };
      options.onStatus({ ...state });
      return { ...state };
    };
    return {
      status: () => ({ ...state }),
      dispose: () => calls.push("dispose"),
      installationFailed: (error, { discard = false } = {}) => {
        calls.push(["failed", error.message]);
        publish({
          phase: "error",
          error: error.message,
          installReady: false,
          needsRelaunch: false,
          ...(discard ? { downloaded: false, downloadPath: undefined } : {})
        });
      },
      check: async (input) => {
        publish({ phase: "checking", busy: true });
        await checkWait;
        return publish({ phase: "up-to-date", busy: false, channel: input?.channel || options.channel });
      },
      apply: async () => {
        calls.push("apply");
        if (result instanceof Error) throw result;
        return publish({
          phase: "ready",
          busy: false,
          error: undefined,
          downloadPath: undefined,
          updated: false,
          needsRelaunch: false,
          installReady: false,
          downloaded: false,
          ...result
        });
      }
    };
  };
  const host = await createDesktopUpdateHost({
    profile: { development, appRoot: root },
    userData,
    env,
    executable: "/fixture/CoworkOS.app/Contents/MacOS/CoworkOS",
    createUpdates,
    onStatus: (state) => {
      snapshots.push(state);
      return observe?.(state);
    },
    isSigned: async () => {
      calls.push("signature");
      return true;
    },
    recover: async () => {
      calls.push("recover");
      await recoverWait;
      if (recoverError) throw recoverError;
    },
    scheduleRestart: async (metadata) => {
      calls.push(["restart", metadata]);
      await restartWait;
      if (restartError) throw restartError;
    },
    quitForSource: () => calls.push("quit"),
    installNative: async () => {
      calls.push("native");
      if (nativeError) throw nativeError;
    },
    quitForManaged: () => calls.push("quit-managed"),
    managedInstaller: {
      readResult: async () => undefined,
      schedule: async () => {
        calls.push("managed");
        if (managedScheduleError) throw managedScheduleError;
      },
      discard: async () => {
        calls.push("discard");
        if (managedDiscardError) throw managedDiscardError;
      },
      dispose: async () => calls.push("managed-dispose")
    }
  });
  return {
    host,
    root,
    userData,
    calls,
    snapshots,
    constructor,
    setResult: (value) => {
      result = value;
    },
    setCheckWait: (value) => {
      checkWait = value;
    },
    setRestartError: (value) => {
      restartError = value;
    },
    setRestartWait: (value) => {
      restartWait = value;
    },
    setRecoverWait: (value) => {
      recoverWait = value;
    },
    setRecoverError: (value) => {
      recoverError = value;
    },
    setNativeError: (value) => {
      nativeError = value;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("desktop host ignores legacy channel preferences and preserves private settings", async (t) => {
  const f = await fixture(t, {
    channel: "preview",
    version: "0.2.0-beta.1",
    env: { ATRIA_UPDATE_CHANNEL: "stable" }
  });
  assert.equal(f.constructor.channel, undefined);
  assert.equal(f.constructor.signed, true);
  for (const input of [
    { channel: "stable" },
    { repository: "other/repo" },
    { url: "https://invalid.example" },
    null
  ])
    await assert.rejects(f.host.check(input), /不接受配置参数/);
  await f.host.check({});
  assert.deepEqual(JSON.parse(await readFile(join(f.userData, "update-preferences.json"))), {
    channel: "preview"
  });
  assert.equal(await readFile(join(f.userData, "model-config.json"), "utf8"), "fixture encrypted settings");
  await f.host.dispose();
  assert.ok(f.calls.includes("dispose"));
  assert.ok(f.calls.includes("managed-dispose"));
});

test("source host rejects an old bootstrap before applying and never treats Electron as the Node toolchain", async (t) => {
  const f = await fixture(t, { development: true });
  await assert.rejects(f.host.apply(), /npm run desktop/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.constructor.toolchain, undefined);
});

test("source host refreshes the development runtime before quitting and recovers on promotion or restart failure", async (t) => {
  const f = await fixture(t, {
    development: true,
    env: {
      COWORK_DESKTOP_NODE_EXECUTABLE: process.execPath,
      COWORK_DESKTOP_NPM_CLI: "/fixture/npm-cli.js"
    }
  });
  assert.deepEqual(f.constructor.toolchain, {
    nodeExecutable: process.execPath,
    npmCli: "/fixture/npm-cli.js"
  });
  f.setResult({ updated: true, needsRelaunch: true });
  await f.host.apply();
  assert.equal(f.calls[0], "apply");
  assert.equal(f.calls[1][0], "restart");
  assert.equal(f.calls[1][1].root, f.root);
  assert.equal(f.calls[2], "quit");
  f.calls.length = 0;
  f.setResult(new Error("fixture promotion failure"));
  await assert.rejects(f.host.apply(), /fixture promotion failure/);
  assert.deepEqual(f.calls, ["apply", "recover"]);
  f.calls.length = 0;
  f.setResult({ updated: true, needsRelaunch: true });
  f.setRestartError(new Error("fixture restart failure"));
  await assert.rejects(f.host.apply(), /fixture restart failure/);
  assert.equal(f.calls.at(-1), "recover");
  assert.ok(!f.calls.includes("quit"));
});

test("release host keeps downloads in the App and schedules the managed helper only after readiness", async (t) => {
  const f = await fixture(t);
  f.calls.length = 0;
  f.setResult({
    downloaded: true,
    installMethod: "managed",
    downloadPath: join(f.userData, "updates/fixture.dmg")
  });
  await f.host.apply();
  assert.deepEqual(f.calls, ["apply", "recover"]);
  f.calls.length = 0;
  f.setResult({ installMethod: "managed", installReady: true, needsRelaunch: true });
  await f.host.apply();
  assert.deepEqual(f.calls, ["apply", "managed", "quit-managed"]);
  f.calls.length = 0;
  f.setResult({ installMethod: "native", installReady: true, needsRelaunch: true });
  await f.host.apply();
  assert.deepEqual(f.calls, ["apply", "native"]);
});

test("host serializes the full public check before another update operation", async (t) => {
  const f = await fixture(t);
  let done;
  f.setCheckWait(
    new Promise((resolve) => {
      done = resolve;
    })
  );
  const first = f.host.check({});
  await assert.rejects(f.host.check({}), /另一次/);
  await assert.rejects(f.host.apply(), /另一次/);
  done();
  await first;
  assert.equal(f.host.status().channel, undefined);
});

test("a native installation error resets staged state and resumes the backend instead of quitting silently", async (t) => {
  const f = await fixture(t);
  f.calls.length = 0;
  f.setResult({ installReady: true, needsRelaunch: true });
  f.setNativeError(new Error("fixture native installation failure"));
  await assert.rejects(f.host.apply(), /fixture native installation failure/);
  assert.deepEqual(f.calls, [
    "apply",
    "native",
    ["failed", "fixture native installation failure"],
    "recover"
  ]);
});

test("source apply remains busy until the restart helper is scheduled, even after promotion finishes", async (t) => {
  const f = await fixture(t, {
    development: true,
    env: { COWORK_DESKTOP_NODE_EXECUTABLE: process.execPath }
  });
  const schedule = deferred();
  f.setRestartWait(schedule.promise);
  f.setResult({ updated: true, needsRelaunch: true });
  const pending = f.host.apply();
  await nextTurn();
  assert.equal(f.host.status().updated, true);
  assert.equal(f.host.status().busy, true);
  assert.equal(f.host.status().applying, true);
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === "restart"));
  assert.ok(!f.calls.includes("quit"));
  assert.ok(f.snapshots.every((state) => state.busy && state.applying));
  await assert.rejects(f.host.apply(), /另一次/);
  await assert.rejects(f.host.check(), /另一次/);
  assert.equal(f.host.status().error, undefined, "competing requests cannot corrupt the active transaction");
  schedule.resolve();
  const result = await pending;
  assert.equal(result.busy, false);
  assert.equal(result.applying, false);
  assert.ok(f.calls.includes("quit"));
  assert.equal(f.snapshots.at(-1).busy, false);
  assert.equal(f.snapshots.at(-1).applying, false);
});

test("recovery keeps apply exclusive and exposes the restart error to a newly loaded renderer", async (t) => {
  const f = await fixture(t, {
    development: true,
    env: { COWORK_DESKTOP_NODE_EXECUTABLE: process.execPath }
  });
  const recovery = deferred();
  f.setRecoverWait(recovery.promise);
  f.setRestartError(new Error("fixture restart schedule failure"));
  f.setResult({ updated: true, needsRelaunch: true });
  const pending = f.host.apply();
  const rejected = assert.rejects(pending, /restart schedule failure/);
  await nextTurn();
  const reloaded = f.host.status();
  assert.equal(reloaded.busy, true);
  assert.equal(reloaded.applying, true);
  assert.equal(reloaded.updated, true);
  assert.equal(reloaded.phase, "error");
  assert.equal(reloaded.error, "fixture restart schedule failure");
  assert.equal(reloaded.installReady, false);
  assert.equal(reloaded.needsRelaunch, false);
  assert.equal(f.calls.at(-1), "recover");
  assert.ok(!f.calls.includes("quit"));
  assert.ok(f.snapshots.every((state) => state.busy && state.applying));
  await assert.rejects(f.host.check(), /另一次/);
  recovery.resolve();
  await rejected;
  assert.equal(f.host.status().busy, false);
  assert.equal(f.host.status().applying, false);
  assert.equal(f.host.status().updated, true);
  assert.equal(f.host.status().error, "fixture restart schedule failure");
  assert.equal(f.snapshots.at(-1).error, "fixture restart schedule failure");
  await assert.rejects(f.host.check(), /restart schedule failure/);
  assert.equal(f.host.status().updated, true, "a renderer's automatic check preserves pending relaunch");
  assert.equal(f.host.status().error, "fixture restart schedule failure");
  f.setRestartError(undefined);
  const retry = await f.host.apply();
  assert.equal(retry.error, undefined);
  assert.equal(retry.updated, true);
  assert.equal(retry.needsRelaunch, true);
  assert.ok(f.calls.includes("quit"));
});

test("a failed backend recovery releases the transaction with an actionable persistent error", async (t) => {
  const f = await fixture(t, {
    development: true,
    env: { COWORK_DESKTOP_NODE_EXECUTABLE: process.execPath }
  });
  f.setResult(new Error("fixture build failure"));
  f.setRecoverError(new Error("private recovery diagnostic"));
  await assert.rejects(f.host.apply(), /本地服务无法恢复/);
  assert.equal(f.host.status().busy, false);
  assert.equal(f.host.status().applying, false);
  assert.match(f.host.status().error, /请重新打开 Formicand/);
  assert.doesNotMatch(f.host.status().error, /private/);
  assert.ok(!f.calls.includes("quit"));
});

test("a source check is busy without becoming an installation or blocking source exit", async (t) => {
  const f = await fixture(t, { development: true });
  const check = deferred();
  f.setCheckWait(check.promise);
  const pending = f.host.check();
  await nextTurn();
  assert.equal(f.host.status().busy, true);
  assert.equal(f.host.status().applying, false);
  assert.ok(f.snapshots.every((state) => state.busy && !state.applying));
  check.resolve();
  const result = await pending;
  assert.equal(result.busy, false);
  assert.equal(result.applying, false);
  assert.ok(!f.calls.includes("recover"));
  assert.ok(!f.calls.includes("quit"));
});

test("a closing renderer observer cannot break host restart scheduling or final cleanup", async (t) => {
  const f = await fixture(t, {
    development: true,
    env: { COWORK_DESKTOP_NODE_EXECUTABLE: process.execPath },
    observe: () => {
      throw new Error("renderer destroyed");
    }
  });
  f.setResult({ updated: true, needsRelaunch: true });
  assert.equal((await f.host.apply()).updated, true);
  assert.equal(f.host.status().busy, false);
  assert.equal(f.host.status().applying, false);
  assert.ok(f.calls.includes("quit"));
});

test("managed scheduling failure invalidates the download even when its own staging cleanup fails", async (t) => {
  const f = await fixture(t, {
    managedScheduleError: new Error("fixture candidate was removed"),
    managedDiscardError: new Error("fixture damaged owner lock")
  });
  f.calls.length = 0;
  f.setResult({
    installMethod: "managed",
    downloaded: true,
    installReady: true,
    needsRelaunch: true,
    downloadPath: join(f.userData, "fixture.dmg")
  });
  await assert.rejects(f.host.apply(), /candidate was removed.*暂存清理未完成/);
  assert.deepEqual(f.calls.slice(0, 3), ["apply", "managed", "discard"]);
  assert.equal(f.calls.at(-1), "recover");
  assert.ok(!f.calls.includes("quit-managed"));
  assert.equal(f.host.status().downloaded, false);
  assert.equal(f.host.status().downloadPath, undefined);
  assert.equal(f.host.status().installReady, false);
  assert.equal(f.host.status().needsRelaunch, false);
});
