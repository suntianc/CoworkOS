import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendsUnder, closeTestRun, openTestRun } from "../scripts/test-run-root.mjs";

// A stand-in for a detached backend: alive until killed, its data root in the environment.
function plant(home) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ATRIA_HOME: home }
  });
  child.unref();
  return child.pid;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "a backend left under the run's root is found, stopped and reported (#35)",
  { skip: process.platform === "win32" },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "leak-parent-"));
    const outside = mkdtempSync(join(tmpdir(), "leak-outside-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = parent;
    const others = [];
    t.after(() => {
      process.env.TMPDIR = previous;
      for (const pid of others) if (alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(parent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    const root = await openTestRun();
    const leaked = plant(join(root, "atria-desktop-links-x", "home"));
    // Another run's backend, or the user's own, is never touched.
    const foreign = plant(join(outside, "home"));
    others.push(leaked, foreign);

    for (let waited = 0; !(await backendsUnder(root)).length && waited < 3000; waited += 50)
      await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(
      (await backendsUnder(root)).map(({ pid }) => pid),
      [leaked]
    );
    const reported = await closeTestRun(root);
    assert.deepEqual(
      reported.map(({ pid }) => pid),
      [leaked]
    );
    assert.equal(alive(leaked), false, "the leaked backend is stopped");
    assert.equal(alive(foreign), true, "a backend outside the run is left alone");
    assert.equal(existsSync(root), false, "the run's root is removed");
  }
);

test(
  "a run whose runner was killed is swept by the next run",
  { skip: process.platform === "win32" },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "leak-parent-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = parent;
    let leaked;
    t.after(() => {
      process.env.TMPDIR = previous;
      if (leaked && alive(leaked)) process.kill(leaked, "SIGKILL");
      rmSync(parent, { recursive: true, force: true });
    });
    // The runner of this root has exited; its backend is still running.
    const gone = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).stdout.trim();
    const abandoned = join(parent, "formicand-run-abandoned");
    mkdirSync(join(abandoned, "atria-recovery-handoff-x", "home"), { recursive: true });
    writeFileSync(join(abandoned, "owner.json"), JSON.stringify({ pid: Number(gone) }));
    leaked = plant(join(abandoned, "atria-recovery-handoff-x", "home"));
    for (let waited = 0; !(await backendsUnder(abandoned)).length && waited < 3000; waited += 50)
      await new Promise((done) => setTimeout(done, 50));

    const root = await openTestRun();
    assert.equal(alive(leaked), false, "the abandoned run's backend is stopped");
    assert.equal(existsSync(abandoned), false, "the abandoned root is removed");
    assert.deepEqual(await closeTestRun(root), []);
  }
);
