import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const jobsUrl = new URL("../dist/src/tools/jobs.js", import.meta.url).href;

for (const failure of ["missing-cwd", "missing-executable", "invalid-command"]) {
  test(`job startup failure is recoverable in the same process: ${failure}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-spawn-error-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // A separate Node process proves that an unhandled ChildProcess error
    // cannot be hidden by the test runner's own uncaught-exception handling.
    const script = `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import { join } from "node:path";
      import { startJob, jobStatus, listJobs } from ${JSON.stringify(jobsUrl)};
      const [root, failure] = process.argv.slice(1);
      const directory = join(root, "logs", "jobs");
      const options = { directory, cwd: root, command: "echo unused" };
      if (failure === "missing-cwd") options.cwd = join(root, "missing");
      if (failure === "missing-executable") {
        options.shell = false;
        options.command = join(root, "missing-executable");
      }
      if (failure === "invalid-command") options.command = "bad\\0command";
      const launch = () => startJob(options);
      await assert.rejects(launch, (error) => {
        assert.match(error.message, /Failed to start job job-1/);
        assert.equal(error.cause.code, failure === "invalid-command" ? "ERR_INVALID_ARG_VALUE" : "ENOENT");
        return true;
      });
      const [failed] = await listJobs({ directory });
      assert.equal(failed.state, "exited");
      assert.match(failed.spawnError, /Failed to start job job-1/);
      assert.equal(failed.exitCode, undefined, "a spawn failure is not a command exit code");
      assert.equal(failed.note, undefined, "a known failure must not look like an unobserved exit");
      const record = JSON.parse(await readFile(join(directory, "job-1.json"), "utf8"));
      assert.ok(record.finishedAt);
      assert.equal(record.pid, undefined);
      const next = await startJob({ directory, cwd: root, command: "echo recovered", shell: true });
      assert.equal(next.jobId, "job-2", "preserve the failed attempt instead of overwriting it");
      const deadline = Date.now() + 10000;
      let done;
      do {
        done = await jobStatus({ directory, jobId: next.jobId });
        if (done.exitCode !== undefined && done.tail.includes("recovered")) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.equal(done.exitCode, 0);
      assert.match(done.tail, /recovered/);
      assert.equal(done.spawnError, undefined);
      console.log("recovered in the same process");
    `;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, root, failure],
      { timeout: 20_000 }
    );
    assert.match(stdout, /recovered in the same process/);
    assert.doesNotMatch(stderr, /Unhandled|uncaught/i);
  });
}
