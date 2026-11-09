import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { resolveCapabilities } from "../dist/src/runtime/task-capabilities.js";

// Foreground commands have no input provider, so a command that reads stdin to
// end must observe EOF. Holding its stdin open hangs real commands until the
// caller cancels; the observation deadline below turns that regression into a
// bounded failure instead of a hanging suite.
const EOF_DEADLINE_MS = 5_000;
const readerScript = `
  const fs = require('node:fs');
  fs.writeFileSync('reader.pid', String(process.pid));
  process.stdout.write('child-started\\n');
  process.stderr.write('child-stderr\\n');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    fs.writeFileSync('reader-input.txt', input);
    process.stdout.write('stdin-eof\\n');
  });
  process.stdin.resume();
`;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-stdin-eof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "read-stdin.cjs"), readerScript);
  await mkdir(join(root, "agent"));
  await mkdir(join(root, "project"));
  return root;
}

function toolsFor(root) {
  return createBuiltinTools({
    rootDirectory: root,
    // Explicit unlimited command mode: no deadline may end a hung reader.
    commandTimeoutMs: 0
  });
}

// Shell pipelines and redirection need the production project-write grant.
function shellToolsFor(root) {
  return createBuiltinTools({
    rootDirectory: join(root, "agent"),
    projectDirectory: join(root, "project"),
    allowProjectWrites: true,
    capabilities: resolveCapabilities({ projectWrite: true, shell: true }, {}),
    commandTimeoutMs: 0
  });
}

async function executeBounded(t, tools, name, input) {
  const controller = new AbortController();
  let settled = false;
  const deadline = setTimeout(() => {
    if (!settled) controller.abort();
  }, EOF_DEADLINE_MS);
  t.after(() => {
    clearTimeout(deadline);
    if (!settled) controller.abort();
  });
  const result = await tools.get(name).execute(input, controller.signal);
  settled = true;
  clearTimeout(deadline);
  return result;
}

async function readerPid(root) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return Number(await readFile(join(root, "reader.pid"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await wait(10);
    }
  }
  assert.fail("the stdin reader never started");
}

async function assertReaderGone(pid) {
  // A hung reader's group is reaped by cancellation, so a red run leaves no
  // fixture process behind even though the assertion above already failed.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await wait(10);
  }
  assert.fail(`stdin reader ${pid} survived its command`);
}

test(
  "a no-input run_command reads stdin EOF and exits without cancellation",
  { timeout: 20_000 },
  async (t) => {
    const root = await workspace(t);
    const tools = toolsFor(root);
    const result = await executeBounded(t, tools, "run_command", {
      command: process.execPath,
      args: ["read-stdin.cjs"]
    });
    const pid = await readerPid(root);
    assert.equal(result.cancelled, undefined, "a command with no input must not need cancellation");
    assert.equal(result.timedOut, undefined);
    assert.equal(result.failed, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "child-started\nstdin-eof\n");
    assert.equal(result.stderr, "child-stderr\n");
    assert.equal(await readFile(join(root, "reader-input.txt"), "utf8"), "");
    await assertReaderGone(pid);
  }
);

test("run_tests follows the same noninteractive input contract", { timeout: 20_000 }, async (t) => {
  const root = await workspace(t);
  const tools = toolsFor(root);
  const result = await executeBounded(t, tools, "run_tests", {
    command: process.execPath,
    args: ["read-stdin.cjs"]
  });
  const pid = await readerPid(root);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.failed, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "child-started\nstdin-eof\n");
  await assertReaderGone(pid);
});

test("explicit shell redirection and pipelines keep their own input", { timeout: 20_000 }, async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "project", "input.txt"), "redirected-input\n");
  const tools = shellToolsFor(root);
  const redirected = await executeBounded(t, tools, "run_command", {
    command: "cat input.txt && tr 'a-z' 'A-Z' < input.txt"
  });
  assert.equal(redirected.failed, undefined);
  assert.equal(redirected.exitCode, 0);
  assert.equal(redirected.stdout, "redirected-input\nREDIRECTED-INPUT\n");
  const piped = await executeBounded(t, tools, "run_command", {
    command: "printf 'alpha\\nbeta\\n' | grep beta"
  });
  assert.equal(piped.failed, undefined);
  assert.equal(piped.exitCode, 0);
  assert.equal(piped.stdout, "beta\n");
  // Without its own redirection the shell command still reads EOF, not the
  // owner's lifecycle pipe and not an open command pipe.
  const bare = await executeBounded(t, tools, "run_command", { command: "cat" });
  assert.equal(bare.cancelled, undefined);
  assert.equal(bare.failed, undefined);
  assert.equal(bare.exitCode, 0);
  assert.equal(bare.stdout, "");
});
