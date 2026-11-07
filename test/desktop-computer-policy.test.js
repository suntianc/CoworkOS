import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { createComputerPolicyStore } = createRequire(import.meta.url)("../desktop/computer-policy.cjs");
const { createComputerPolicyController } = createRequire(import.meta.url)("../desktop/computer-policy.cjs");

function permissionFixture(options = {}) {
  let policy = { enabled: false, mode: "control" };
  let livePolicy = { enabled: false, mode: "control" };
  const calls = [],
    shortcuts = [],
    opened = [];
  const status = { available: true, screenRecording: true, accessibility: true, postEventAccess: true };
  const backend = {
    async computer(input) {
      calls.push(input);
      if (input.operation === "access") return { policy: { ...livePolicy } };
      if (input.operation === "policy") livePolicy = { enabled: input.enabled, mode: input.mode };
      if (input.operation === "status") return options.status ? options.status() : { ...status };
      if (input.operation === "permissions")
        return options.request ? options.request(input) : { requested: true };
      return {};
    }
  };
  const controller = createComputerPolicyController({
    store: {
      snapshot: () => policy,
      save: async (next) => {
        policy = next;
      }
    },
    getBackend: () => backend,
    openPermissionSettings: async (permission) => opened.push(permission),
    registerTakeover: (enabled) => {
      shortcuts.push(enabled);
      return null;
    }
  });
  return { controller, backend, calls, shortcuts, status, opened };
}

for (const permission of ["screenRecording", "accessibility"]) {
  test(`the ${permission} button requests only its permission and never enables access`, async () => {
    const { controller, calls, status, opened } = permissionFixture();
    status[permission] = false;
    await controller.request({ operation: "permissions", permission });
    assert.deepEqual(
      calls.filter((call) => call.operation === "permissions"),
      [{ operation: "permissions", permission }]
    );
    assert.deepEqual(opened, [permission]);
    assert.equal((await controller.request({ operation: "policy-status" })).enabled, false);
    assert.equal(
      calls.some((call) => call.operation === "policy" && call.enabled),
      false
    );
    status[permission] = true;
    calls.length = 0;
    await controller.request({ operation: "permissions", permission });
    assert.equal(
      calls.some((call) => call.operation === "permissions"),
      false
    );
    assert.deepEqual(opened, [permission]);
  });
}

for (const missing of ["screenRecording", "accessibility", "postEventAccess", "available"]) {
  test(`window access cannot be enabled while ${missing} is false, even through trusted IPC`, async () => {
    const { controller, calls, status } = permissionFixture();
    status[missing] = false;
    await assert.rejects(
      controller.request({ operation: "policy", enabled: true, mode: "control" }),
      /系统权限|不可用/
    );
    assert.equal((await controller.request({ operation: "policy-status" })).enabled, false);
    assert.equal(
      calls.some((call) => call.operation === "policy" && call.enabled),
      false
    );
    assert.equal(
      calls.some((call) => call.operation === "permissions"),
      false
    );
  });
}

test("revoking an OS permission also prevents a paused policy from resuming", async () => {
  const { controller, calls, status } = permissionFixture();
  await controller.request({ operation: "policy", enabled: true, mode: "control" });
  await controller.request({ operation: "pause" });
  status.screenRecording = false;
  calls.length = 0;
  await assert.rejects(controller.request({ operation: "resume" }), /系统权限/);
  assert.equal(
    calls.some((call) => call.operation === "resume" || call.enabled),
    false
  );
});

test("restart with revoked OS access preserves the human preference without requesting permissions", async () => {
  const { controller, backend, calls, status } = permissionFixture();
  await controller.request({ operation: "policy", enabled: true, mode: "control" });
  status.accessibility = false;
  calls.length = 0;
  await controller.initialize(backend);
  assert.deepEqual(await controller.request({ operation: "policy-status" }), {
    enabled: true,
    mode: "control"
  });
  assert.equal(
    calls.some((call) => call.operation === "permissions"),
    false
  );
});

test("window access uses fresh granted status without requesting either OS permission", async () => {
  const { controller, backend, calls } = permissionFixture();
  await controller.initialize(backend);
  await controller.request({ operation: "policy", enabled: true, mode: "control" });
  await controller.initialize(backend);
  await controller.request({ operation: "pause" });
  await controller.request({ operation: "resume" });
  await controller.request({ operation: "policy", enabled: false, mode: "control" });
  assert.equal(
    calls.some((call) => call.operation === "permissions"),
    false
  );
  assert.equal(
    calls.some((call) => call.operation === "status"),
    true
  );
});

for (const operation of ["disable", "pause", "end"]) {
  test(`a pending system permission response cannot undo ${operation} or open stale settings`, async () => {
    const { promise: held, resolve: release } = Promise.withResolvers();
    const { promise: started, resolve: begin } = Promise.withResolvers();
    const { controller, calls, status, opened } = permissionFixture({
      request: async () => {
        begin();
        await held;
        return { requested: true };
      }
    });
    status.screenRecording = false;
    const requesting = controller.request({ operation: "permissions", permission: "screenRecording" });
    await started;
    await controller.request(
      operation === "disable" ? { operation: "policy", enabled: false, mode: "control" } : { operation }
    );
    release();
    assert.equal((await requesting).cancelled, true);
    assert.equal(
      calls.some((call) => call.operation === "policy" && call.enabled),
      false
    );
    assert.deepEqual(opened, []);
  });
}

test("permission request failures remain retryable and invalid permission kinds never reach the driver", async () => {
  const { controller, calls, status } = permissionFixture({
    request: async () => {
      throw new Error("permission helper failed");
    }
  });
  status.screenRecording = false;
  await assert.rejects(
    controller.request({ operation: "permissions", permission: "screenRecording" }),
    /permission helper failed/
  );
  assert.equal((await controller.request({ operation: "policy-status" })).enabled, false);
  const count = calls.length;
  for (const permission of [undefined, "all", "camera", {}, true])
    await assert.rejects(controller.request({ operation: "permissions", permission }), /无效/);
  assert.equal(calls.length, count);
});

test("desktop CUA policy defaults off and persists only human policy across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-computer-policy-"));
  try {
    const store = createComputerPolicyStore(root);
    assert.deepEqual(await store.load(), { enabled: false, mode: "observe" });
    await store.save({ enabled: true, mode: "control" });
    const saved = JSON.parse(await readFile(join(root, "computer-policy.json"), "utf8"));
    assert.deepEqual(saved, { version: 1, policy: { enabled: true, mode: "control" } });
    assert.equal((await stat(join(root, "computer-policy.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await createComputerPolicyStore(root).load(), { enabled: true, mode: "control" });
    await store.save({ enabled: false, mode: "observe" });
    assert.deepEqual(await createComputerPolicyStore(root).load(), { enabled: false, mode: "observe" });
    for (const bad of [
      null,
      { enabled: "true", mode: "control" },
      { enabled: true, mode: "all" },
      { enabled: true, mode: "control", sessionId: "old" }
    ])
      assert.throws(() => store.save(bad), /格式/);
    await writeFile(
      join(root, "computer-policy.json"),
      JSON.stringify({ version: 2, policy: { enabled: true, mode: "control" } })
    );
    const corrupt = await createComputerPolicyStore(root).load();
    assert.equal(corrupt.enabled, false);
    assert.match(corrupt.warning, /默认关闭/);
    assert.equal(JSON.parse(await readFile(join(root, "computer-policy.json"), "utf8")).version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop policy controller rejects late enable after takeover and explicit resume consumes saved policy", async () => {
  const { createComputerPolicyController } = createRequire(import.meta.url)("../desktop/computer-policy.cjs");
  let policy = { enabled: false, mode: "observe" },
    release,
    started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [],
    shortcuts = [];
  const backend = {
    computer: async (input) => {
      calls.push(input);
      return input.operation === "status"
        ? { available: true, screenRecording: true, accessibility: true }
        : {};
    }
  };
  const controller = createComputerPolicyController({
    store: {
      snapshot: () => policy,
      save: async (next) => {
        started();
        await held;
        policy = next;
      }
    },
    getBackend: () => backend,
    registerTakeover: (enabled) => {
      shortcuts.push(enabled);
      return enabled ? "shortcut" : null;
    }
  });
  await controller.initialize(backend);
  assert.deepEqual(calls, [{ operation: "access" }]);
  const enabling = controller.request({ operation: "policy", enabled: true, mode: "control" });
  await began;
  await controller.request({ operation: "pause" });
  release();
  assert.equal((await enabling).cancelled, true);
  assert.equal(
    calls.some((input) => input.operation === "policy" && input.enabled),
    false
  );
  assert.equal(shortcuts.at(-1), false);
  await controller.request({ operation: "resume" });
  assert.deepEqual(calls.slice(-2), [
    { operation: "policy", enabled: true, mode: "control" },
    { operation: "resume" }
  ]);
  assert.equal(shortcuts.at(-1), true);
});

test("desktop failed policy persistence stays disabled and never publishes expanded authority", async () => {
  const { createComputerPolicyController } = createRequire(import.meta.url)("../desktop/computer-policy.cjs");
  const calls = [];
  const backend = {
    computer: async (input) => {
      calls.push(input);
      if (input.operation === "status")
        return { available: true, screenRecording: true, accessibility: true };
    }
  };
  const controller = createComputerPolicyController({
    store: {
      snapshot: () => ({ enabled: false, mode: "observe" }),
      save: async () => {
        throw new Error("disk full");
      }
    },
    getBackend: () => backend,
    registerTakeover: () => assert.fail("must not register input on failed persistence")
  });
  await assert.rejects(
    controller.request({ operation: "policy", enabled: true, mode: "control" }),
    /disk full/
  );
  assert.deepEqual(
    calls.filter((call) => call.operation !== "status"),
    [{ operation: "policy", enabled: false, mode: "control" }]
  );
});

test("a human pause cancels a resume still waiting to apply saved policy", async () => {
  const { createComputerPolicyController } = createRequire(import.meta.url)("../desktop/computer-policy.cjs");
  let release, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const backend = {
    computer: async (input) => {
      calls.push(input);
      if (input.operation === "policy") {
        started();
        await held;
      }
      return input.operation === "status"
        ? { available: true, screenRecording: true, accessibility: true }
        : {};
    }
  };
  const controller = createComputerPolicyController({
    store: { snapshot: () => ({ enabled: true, mode: "control" }) },
    getBackend: () => backend,
    registerTakeover: () => null
  });
  const resuming = controller.request({ operation: "resume" });
  await began;
  await controller.request({ operation: "pause" });
  release();
  assert.equal((await resuming).cancelled, true);
  assert.equal(
    calls.some((input) => input.operation === "resume"),
    false
  );
});

test("an old observe-only policy is disabled on upgrade instead of silently gaining control", async () => {
  const root = await mkdtemp(join(tmpdir(), "atria-computer-policy-upgrade-"));
  try {
    const legacy = JSON.stringify({ version: 1, policy: { enabled: true, mode: "observe" } });
    await writeFile(join(root, "computer-policy.json"), legacy);
    const policy = await createComputerPolicyStore(root).load();
    assert.equal(policy.enabled, false);
    assert.match(policy.warning, /仅观察/);
    assert.equal(await readFile(join(root, "computer-policy.json"), "utf8"), legacy);
    const store = createComputerPolicyStore(root);
    await store.load();
    await store.save({ enabled: true, mode: "control" });
    assert.deepEqual(await createComputerPolicyStore(root).load(), { enabled: true, mode: "control" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer session cleanup leaves the saved policy and takeover shortcut enabled", async () => {
  const { controller, backend, calls, shortcuts } = permissionFixture();
  await controller.request({ operation: "policy", enabled: true, mode: "control" });
  calls.length = 0;
  await controller.request({ operation: "release-sessions" });
  assert.deepEqual(calls, [{ operation: "release-sessions" }]);
  assert.equal(shortcuts.at(-1), true);
  assert.deepEqual(await controller.request({ operation: "policy-status" }), {
    enabled: true,
    mode: "control"
  });
  await controller.initialize(backend);
  assert.equal(calls.at(-1).operation, "access");
});
