import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { connectBackend, backendEnvironment } = require("../desktop/backend.cjs");
const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");

/** A stale client must not stop a new instance that took over the same data root. */
test(
  "desktop stop refuses a replacement backend while the replacement remains serving",
  { timeout: 120000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-backend-stop-identity-"));
    const userHome = join(root, "user-home");
    await mkdir(userHome);
    const previousHome = process.env.HOME;
    process.env.HOME = userHome;
    const paths = desktopPaths(resolve("."), join(root, "data"), {});
    let replacement;
    try {
      await prepareDesktopData(paths, "0.1.0");
      await writeFile(paths.configPath, "{}\n");
      const original = await connectBackend(paths, {}, process.execPath);
      assert.equal((await original.stop()).state, "stopped");
      replacement = await connectBackend(paths, {}, process.execPath);
      assert.equal(replacement.backendId, original.backendId);
      assert.notEqual(replacement.pid, original.pid);
      await assert.rejects(original.stop(), /身份|实例|变化|不一致/);
      const response = await fetch(`${replacement.url}/api/backend`, {
        headers: { "x-atria-token": replacement.token },
        signal: AbortSignal.timeout(5000)
      });
      assert.equal(response.status, 200);
      const identity = await response.json();
      assert.equal(identity.pid, replacement.pid);
      assert.equal(identity.backendId, replacement.backendId);
      const { stopBackend } = await import("../dist/src/cli/backend.js");
      const env = await backendEnvironment(paths, {});
      for (const [field, value] of [
        ["backendId", "backend_replaced"],
        ["pid", replacement.pid + 1],
        ["url", "http://127.0.0.1:1"],
        ["startedAt", "replacement-start"],
        ["token", "replacement-token"]
      ]) {
        await assert.rejects(stopBackend(env, { ...replacement, [field]: value }), /身份/);
        const current = await fetch(`${replacement.url}/api/backend`, {
          headers: { "x-atria-token": replacement.token },
          signal: AbortSignal.timeout(5000)
        });
        assert.equal(current.status, 200, `backend must survive ${field} mismatch`);
      }
      assert.equal((await replacement.stop()).state, "stopped");
      replacement = undefined;
    } finally {
      if (replacement) await replacement.stop().catch(() => {});
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }
);
