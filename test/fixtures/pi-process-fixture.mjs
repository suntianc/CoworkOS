import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { protocolStream } from "../model-protocol-fixture.mjs";
import { readFixtureRequestBody } from "../http-request-body-fixture.mjs";

/**
 * Shared harness for tests that run a real Pi process.
 *
 * Both existing P4.6 tests and the delegated-process tests need the same three
 * things: an environment that cannot inherit the user's model or agent
 * configuration, a recorded local provider, and the documented RPC driver.
 * Keeping one copy means a change to any of them lands in every real-process
 * test at once instead of drifting per file.
 */

/** Remove every inherited Cowork/Pi/model setting before applying the fixture's own. */
export function isolatedPiEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:COWORK_|PI_|ATRIA_|OPENAI_|ANTHROPIC_|SERPER_|EXA_|NODE_OPTIONS)/.test(key)
      )
    ),
    ...overrides
  };
}

/**
 * A recorded OpenAI-compatible provider.
 *
 * `handle(body, requests)` returns the reply for this request, or a promise
 * when a test needs the turn to stay open (for example while a backend
 * restarts). Non-POST requests answer the model catalog.
 */
export async function startLocalProvider({ model = "p46-fixture-model", handle } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: model }] }));
    }
    requests.push(JSON.parse(await readFixtureRequestBody(request)));
    const reply = (await handle?.(requests.at(-1), requests)) ?? { text: "ok" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream("openai-completions", reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}

/**
 * One real Pi process driven through its documented newline-delimited RPC.
 *
 * `command`/`args` stay explicit so a test can select the Cowork launcher or a
 * specific Pi bundle without this fixture deciding which runtime it is testing.
 */
export function spawnPiRpc({ command, args, cwd, env, label = "p46" }) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(value);
      const request = value.type === "response" ? pending.get(value.id) : undefined;
      if (!request) continue;
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.success) request.resolve(value.data);
      else request.reject(new Error(JSON.stringify(value)));
    }
  });
  const send = (type, values = {}) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = `${label}-${events.length}-${pending.size}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`RPC ${type} timed out: ${stderr}`));
      }, 30_000);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...values })}\n`);
    });
  const waitFor = async (predicate, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await delay(25);
    }
    throw new Error(`missing RPC event: ${stderr}`);
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "close");
    child.kill("SIGTERM");
    const timeout = new AbortController();
    try {
      await Promise.race([exited, delay(3_000, undefined, { signal: timeout.signal })]);
    } finally {
      timeout.abort();
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await exited;
  };
  return { child, events, send, waitFor, stop, getStderr: () => stderr };
}

/**
 * End the Main processes a test started through a run service.
 *
 * A resident Main is not a child whose life the backend owns, so a stopped
 * backend leaves it running on purpose. A test that builds the run service
 * itself must therefore reap what it spawned, by the process record's host and
 * OS start time, or the test process would keep its handles (and the machine
 * its processes) after the assertions are done.
 */
export async function reapRecordedMains(workspaceRoot) {
  const { readdir, readFile } = await import("node:fs/promises");
  const { hostname } = await import("node:os");
  const { join } = await import("node:path");
  const expectedHost = hostname();
  for (const task of await readdir(workspaceRoot, { withFileTypes: true }).catch(() => [])) {
    if (!task.isDirectory()) continue;
    const runs = await readdir(join(workspaceRoot, task.name, "runs")).catch(() => []);
    for (const runId of runs) {
      const record = await readFile(
        join(workspaceRoot, task.name, "runs", runId, "agents", "main", "process.json"),
        "utf8"
      )
        .then((value) => JSON.parse(value))
        .catch(() => undefined);
      if (!record?.pid || record.host !== expectedHost || !record.startedAt) continue;
      const { verifyProcessIdentity } = await import("../../dist/src/runtime/process-identity.js");
      if (!(await verifyProcessIdentity({ pid: record.pid, startedAt: record.startedAt }))) continue;
      try {
        process.kill(-record.pid, "SIGKILL");
      } catch {
        /* the group already exited */
      }
    }
  }
}
