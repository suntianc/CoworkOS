import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { normalizeContext } from "@earendil-works/pi-ai";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";
import { MainRequestRetry, mainRequestEnvironment } from "../dist/src/runtime/main-request-retry.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { installedPiVersion } from "./pi-version-fixture.mjs";

const storeModule = new URL("../dist/src/storage/main-request-store.js", import.meta.url).href;
const retryModule = new URL("../dist/src/runtime/main-request-retry.js", import.meta.url).href;
const childEnvironment = Object.fromEntries(
  ["PATH", "SystemRoot", "LANG", "TMPDIR", "TEMP", "TMP"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
);
const snapshotChanged = { code: "main_retry_snapshot_invalid", status: 400 };

async function storage(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-request-slot-"));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  await new LocalWorkspaceStore(root).createTask("task", { goal: "Request slot fixture", projectDirectory });
  const environment = await mainRequestEnvironment(root, "task", projectDirectory);
  const model = {
    id: "fixture",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 64
  };
  const context = normalizeContext({
    systemPrompt: "Original system",
    tools: [{ name: "fixture_tool", description: "Fixture tool", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "Original input", timestamp: 1 }]
  });
  const { executionScope, ...recordedEnvironment } = environment;
  const input = {
    runId: "original-run",
    requestId: "original-request",
    model,
    context,
    environment: recordedEnvironment,
    executionScope,
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
    piVersion: installedPiVersion,
    body: '{ "model": "fixture", "messages": [], "temperature": 0.4 }'
  };
  const capture = {
    requestId: "retry-request",
    retryOf: input.requestId,
    model,
    context,
    endpoint: input.endpoint,
    body: input.body
  };
  return {
    root,
    children,
    environment,
    model,
    context,
    input,
    capture,
    store: new MainRequestStore(mainRequestPath(root, "task"), "task")
  };
}

test("claiming an original request refuses a replaced Run, replaced request, completed or missing slot", async (t) => {
  for (const [name, replace] of [
    ["same requestId in a different Run", (f) => f.store.begin({ ...f.input, runId: "new-run" })],
    ["different request", (f) => f.store.begin({ ...f.input, requestId: "new-request" })],
    ["completed request", (f) => f.store.settle(f.input.requestId, "completed")],
    ["cleared request", (f) => f.store.clear()]
  ]) {
    await t.test(name, async (t) => {
      const f = await storage(t);
      await f.store.begin(f.input);
      await replace(f);
      const before = await readFile(f.store.filePath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      await assert.rejects(
        f.store.begin(
          { ...f.input, runId: "retry-run", requestId: "retry-request" },
          { runId: f.input.runId, requestId: f.input.requestId }
        ),
        snapshotChanged
      );
      if (before === undefined) await assert.rejects(readFile(f.store.filePath), { code: "ENOENT" });
      else assert.equal(await readFile(f.store.filePath, "utf8"), before);
    });
  }
});

test("a prepared retry cannot overwrite a replacement request or recreate a cleared turn", async (t) => {
  for (const [name, replace] of [
    ["same requestId in a different Run", (f) => f.store.begin({ ...f.input, runId: "new-run" })],
    ["different request", (f) => f.store.begin({ ...f.input, requestId: "new-request" })],
    ["completed request", (f) => f.store.settle(f.input.requestId, "completed")],
    ["cleared turn", (f) => f.store.clear()]
  ]) {
    await t.test(name, async (t) => {
      const f = await storage(t);
      await f.store.begin(f.input);
      await f.store.settle(f.input.requestId, "failed");
      const retry = new MainRequestRetry(f.store, "retry-run", async () => f.environment, f.input.requestId);
      assert.equal((await retry.prepare(f.model, f.context)).replay.requestId, f.input.requestId);
      await replace(f);
      const before = await f.store.read();
      const bytes = before ? await readFile(f.store.filePath, "utf8") : undefined;
      await assert.rejects(retry.capture(f.capture), snapshotChanged);
      assert.deepEqual(await f.store.read(), before);
      if (bytes !== undefined) assert.equal(await readFile(f.store.filePath, "utf8"), bytes);
      else await assert.rejects(readFile(f.store.filePath), { code: "ENOENT" });
    });
  }
});

test("a retry Run transfer preserves the complete request and refuses stale or cleared ownership", async (t) => {
  const f = await storage(t);
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "failed");
  const original = await f.store.pending();
  await f.store.reassignRun(original, "selected-retry-run");
  const moved = await f.store.pending();
  assert.equal(moved.runId, "selected-retry-run");
  const { runId: _run, checksum: _checksum, ...request } = moved;
  const { runId: _originalRun, checksum: _originalChecksum, ...originalRequest } = original;
  assert.deepEqual(request, originalRequest);
  const bytes = await readFile(f.store.filePath, "utf8");
  await assert.rejects(f.store.reassignRun(original, "stale-run"), snapshotChanged);
  assert.equal(await readFile(f.store.filePath, "utf8"), bytes);
  await f.store.clear();
  await assert.rejects(f.store.reassignRun(moved, "cleared-run"), snapshotChanged);
  assert.equal(await f.store.read(), undefined);
});

function waitForMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.child.off("message", onMessage);
      worker.child.off("error", onError);
      worker.child.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`retry contender exited before ${type}: ${code ?? signal}; ${worker.errors()}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`retry contender did not send ${type}; ${worker.errors()}`));
    }, 5000);
    worker.child.on("message", onMessage);
    worker.child.once("error", onError);
    worker.child.once("exit", onExit);
  });
}

function contender(f, runId) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { MainRequestStore } from ${JSON.stringify(storeModule)};
        import { MainRequestRetry } from ${JSON.stringify(retryModule)};
        const { path, environment, model, context, capture, runId, originalRequestId } = JSON.parse(process.argv[1]);
        const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
        const retry = new MainRequestRetry(new MainRequestStore(path, "task"), runId, async () => environment, originalRequestId);
        try {
          await retry.prepare(model, context);
          const start = new Promise((resolve) => process.once("message", resolve));
          await send({ type: "ready" });
          await start;
          try {
            await retry.capture({ ...capture, requestId: runId + "-request" });
            await send({ type: "result", claimed: true, runId });
          } catch (error) {
            await send({ type: "result", claimed: false, code: error.code, runId });
          }
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        } finally {
          process.disconnect();
        }
      `,
      JSON.stringify({
        path: f.store.filePath,
        environment: f.environment,
        model: f.model,
        context: f.context,
        capture: f.capture,
        runId,
        originalRequestId: f.input.requestId
      })
    ],
    { cwd: f.root, env: childEnvironment, stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  f.children.add(child);
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  return { child, errors: () => errors, closed: once(child, "close") };
}

test(
  "two independently prepared processes can claim an original request only once",
  { timeout: 15000 },
  async (t) => {
    const f = await storage(t);
    await f.store.begin(f.input);
    await f.store.settle(f.input.requestId, "failed");
    const workers = [contender(f, "retry-one"), contender(f, "retry-two")];
    await Promise.all(workers.map((worker) => waitForMessage(worker, "ready")));
    const results = workers.map((worker) => waitForMessage(worker, "result"));
    for (const worker of workers) worker.child.send({ type: "start" });
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter((outcome) => outcome.claimed).length, 1);
    const winner = outcomes.find((outcome) => outcome.claimed);
    const loser = outcomes.find((outcome) => !outcome.claimed);
    assert.equal(loser.code, snapshotChanged.code);
    const claimed = await f.store.pending();
    assert.equal(claimed.runId, winner.runId);
    assert.equal(claimed.requestId, `${winner.runId}-request`);
    assert.equal(claimed.retryOf, f.input.requestId);
    assert.equal(claimed.body, f.input.body);
    for (const worker of workers) {
      const [code, signal] = await worker.closed;
      assert.equal(code, 0, worker.errors());
      assert.equal(signal, null, worker.errors());
    }
  }
);

test("clearing the active slot survives a process restart", async (t) => {
  const f = await storage(t);
  await f.store.begin(f.input);
  await f.store.settle(f.input.requestId, "failed");
  await f.store.clear();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { MainRequestStore } from ${JSON.stringify(storeModule)};
      const store = new MainRequestStore(process.argv[1], "task");
      console.log(JSON.stringify({ pending: Boolean(await store.pending()) }));
    `,
      f.store.filePath
    ],
    { cwd: f.root, env: childEnvironment, timeout: 5000 }
  );
  assert.deepEqual(JSON.parse(stdout), { pending: false });
  await assert.rejects(readFile(f.store.filePath), { code: "ENOENT" });
});

test("malformed version annotations report a damaged snapshot instead of throwing", async (t) => {
  for (const [name, patch] of [
    ["a non-string Pi version", { piVersion: 123 }],
    ["a missing Pi version", { piVersion: undefined }],
    ["a null replay reason", { replaySkipped: null }],
    ["an unknown replay reason", { replaySkipped: { reason: "unknown" } }],
    ["a missing execution scope", { executionScope: undefined }],
    ["a missing endpoint", { endpoint: undefined }]
  ]) {
    await t.test(name, async (t) => {
      const f = await storage(t);
      await f.store.begin({ ...f.input, ...patch });
      await assert.rejects(f.store.read(), snapshotChanged);
    });
  }
});
