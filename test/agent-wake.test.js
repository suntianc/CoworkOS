import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentWakeEndpoint, startAgentWake, stopAgentWake } from "../dist/src/runtime/agent-wake.js";

/**
 * A wake endpoint is a filesystem socket on POSIX, and the address the OS
 * accepts is `sun_path`: 104 bytes on macOS, 108 on Linux, both counting the
 * terminator. A temporary directory deeper than that budget used to produce an
 * endpoint the resident Main could not bind — Electron's Node answers `listen`
 * with EINVAL — so the process started without a wake channel and the next
 * message sat in its durable Inbox until an OS file event happened to arrive.
 * The desktop case that found this had a temporary directory one level deeper
 * than the usual one; its second message never reached the model.
 *
 * A too-long name cannot be caught by trying to bind alone: Electron reports
 * EINVAL, while plain Node truncates the name silently and still accepts a
 * writer, so the invariant is checked directly — the path fits the OS address —
 * and the bind confirms the product created a socket exactly where the process
 * record says it is.
 */

/** `sun_path` including its terminator, from the platform's own limits. */
const SOCKET_ADDRESS_BYTES = process.platform === "darwin" ? 104 : 108;

/** Windows has named pipes rather than filesystem sockets, so no path budget applies. */
const posix = { skip: process.platform === "win32" ? "filesystem sockets are POSIX only" : false };

/** Bind the endpoint the product would use and check a writer can reach it. */
async function bindAndReach(endpoint) {
  const previous = process.env.COWORK_WAKE_ENDPOINT;
  process.env.COWORK_WAKE_ENDPOINT = endpoint;
  try {
    const listener = await startAgentWake();
    assert.equal(listener?.endpoint, endpoint);
    let created = false;
    try {
      created = statSync(endpoint).isSocket();
    } catch {
      created = false;
    }
    assert.ok(created, `no socket at the recorded path ${endpoint}`);
    const reached = await new Promise((done) => {
      const socket = connect(endpoint);
      socket.setTimeout(2_000, () => done(false));
      socket.once("error", () => done(false));
      socket.once("connect", () => {
        socket.end();
        done(true);
      });
    });
    assert.ok(reached, `a writer cannot reach ${endpoint}`);
  } finally {
    await stopAgentWake();
    if (previous === undefined) delete process.env.COWORK_WAKE_ENDPOINT;
    else process.env.COWORK_WAKE_ENDPOINT = previous;
  }
}

async function withTempDirectory(base, temporaryDirectory, run) {
  const previous = process.env.TMPDIR;
  const root = await mkdtemp(join(base, "aw-"));
  process.env.TMPDIR = temporaryDirectory(root);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("a temporary directory too deep for a socket address still yields a wake channel", posix, async () => {
  await withTempDirectory(
    tmpdir(),
    (root) => join(root, "run-root", "workspace", "task-00000000-0000-4000-8000-000000000000"),
    async () => {
      const endpoint = agentWakeEndpoint(
        join(tmpdir(), "workspace", "task-00000000-0000-4000-8000-000000000000", "agents", "main"),
        "launch-token"
      );
      assert.ok(
        Buffer.byteLength(endpoint) < SOCKET_ADDRESS_BYTES,
        `the OS cannot address ${endpoint} (${Buffer.byteLength(endpoint)} bytes)`
      );
      await bindAndReach(endpoint);
    }
  );
});

test("a temporary directory that fits keeps the endpoint beside the user's own files", posix, async () => {
  // The temporary directory of this case is short enough on its own: a run's
  // own root is already deep enough to be the thing the other case is about.
  await withTempDirectory(
    "/tmp",
    (root) => root,
    async () => {
      const endpoint = agentWakeEndpoint(
        join(tmpdir(), "workspace", "task", "agents", "main"),
        "launch-token"
      );
      const uid = process.getuid?.();
      assert.equal(
        dirname(endpoint),
        join(tmpdir(), uid === undefined ? "cowork-wake" : `cowork-wake-${uid}`)
      );
      await bindAndReach(endpoint);
    }
  );
});
