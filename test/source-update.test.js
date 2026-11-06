import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkSourceUpdate, isSourceCheckout, updateSource } from "../scripts/update-source.mjs";
import { parseUpdateOptions } from "../scripts/update.mjs";

const execute = promisify(execFile);
const environment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
for (const name of Object.keys(environment))
  if (name.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(name))
    delete environment[name];

async function fixture(t, { name = "coworkos" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atria-source-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, "upstream.git");
  const author = join(directory, "author");
  const root = join(directory, "installed");
  const git = async (cwd, ...args) => (await execute("git", args, { cwd, env: environment })).stdout.trim();
  await mkdir(author);
  await git(author, "init", "--initial-branch=preview", "--template=");
  await git(author, "config", "user.name", "Fixture Developer");
  await git(author, "config", "user.email", "fixture@example.invalid");
  await writeFile(
    join(author, ".gitignore"),
    ".tmp/\nnode_modules/\ndist/\nbuild/\n/config.json\n/workspace/\n/src/software/cad/*.generated.ts\n/web/assets/math/generated/\n/web/assets/pptist/generated/\n"
  );
  await writeFile(join(author, "tsconfig.json"), "{}\n");
  await writeFile(
    join(author, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.1",
      scripts: { build: "fixture", "build:cli": "fixture" }
    })
  );
  await writeFile(
    join(author, "package-lock.json"),
    JSON.stringify({ name, version: "0.1.1", lockfileVersion: 3, packages: {} })
  );
  await writeFile(join(author, "notes.md"), "old source\n");
  await writeFile(join(author, "movable.md"), "source content\n");
  await git(author, "add", ".");
  await git(author, "commit", "-m", "Initial fixture");
  await git(directory, "clone", "--bare", author, remote);
  await git(author, "remote", "add", "origin", remote);
  await git(directory, "clone", remote, root);
  await git(root, "config", "user.name", "Fixture Developer");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "dependency.txt"), "old dependencies\n");
  await mkdir(join(root, "dist/src/runtime"), { recursive: true });
  await writeFile(join(root, "dist/src/runtime/config.js"), "old build\n");
  await writeFile(join(root, "config.json"), "private configuration\n");
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "workspace/task.txt"), "private task\n");
  const npmCli = join(directory, "fixture-npm.mjs");
  await writeFile(
    npmCli,
    `
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
const root = process.cwd();
if (args[0] === 'ci') {
  await mkdir('node_modules', {recursive:true});
  await writeFile('node_modules/dependency.txt', 'new dependencies\\n');
} else {
  if (args[0] !== 'run' || !['build:cli','build'].includes(args[1])) process.exit(4);
  await mkdir('dist/src/runtime', {recursive:true});
  await writeFile('dist/src/runtime/config.js', await readFile('notes.md','utf8'));
  await mkdir('src/software/cad', {recursive:true});
  await writeFile('src/software/cad/runtime-source.generated.ts', 'generated\\n');
  if (args[1] === 'build') {
    await mkdir('web/assets/math/generated', {recursive:true});
    await writeFile('web/assets/math/generated/bundle.js', 'new browser bundle\\n');
  }
  if (process.env.FIXTURE_LIVE_ROOT) await writeFile(join(process.env.FIXTURE_LIVE_ROOT,'notes.md'),'concurrent edit\\n');
}
if (process.env.FIXTURE_NPM_FAIL === args[0]) {
  console.error('sensitive-output-must-not-be-forwarded');
  process.exit(7);
}
`
  );
  const toolchain = { nodeExecutable: process.execPath, npmCli };
  const publish = async ({ lock = false, name: remoteName = name } = {}) => {
    await writeFile(join(author, "notes.md"), "new source\n");
    if (remoteName !== name) {
      const pkg = JSON.parse(await readFile(join(author, "package.json"), "utf8"));
      await writeFile(join(author, "package.json"), JSON.stringify({ ...pkg, name: remoteName }));
    }
    if (lock || remoteName !== name)
      await writeFile(
        join(author, "package-lock.json"),
        JSON.stringify({
          name: remoteName,
          version: "0.1.1",
          lockfileVersion: 3,
          packages: { fixture: { version: "1.0.0" } }
        })
      );
    await git(author, "add", ".");
    await git(author, "commit", "-m", "New fixture commit, same package version");
    await git(author, "push", "origin", "preview");
    return git(author, "rev-parse", "HEAD");
  };
  return { root, author, directory, toolchain, publish, git, options: { root, toolchain, env: environment } };
}

async function assertOldInstallation(f, commit) {
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), commit);
  assert.equal(await readFile(join(f.root, "notes.md"), "utf8"), "old source\n");
  assert.equal(await readFile(join(f.root, "node_modules/dependency.txt"), "utf8"), "old dependencies\n");
  assert.equal(await readFile(join(f.root, "dist/src/runtime/config.js"), "utf8"), "old build\n");
}

test("source check follows the owning checkout's upstream and detects commits with the same version", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  const next = await f.publish();
  assert.equal(await isSourceCheckout(f.root), true);
  assert.equal(await isSourceCheckout(f.directory), false);
  const result = await updateSource({ ...f.options, check: true });
  assert.equal(result.available, true);
  assert.equal(result.updated, false);
  assert.equal(result.branch, "preview");
  assert.equal(result.currentVersion, result.version);
  assert.equal(result.remoteCommit, next);
  await assertOldInstallation(f, old);
  await assert.rejects(readFile(join(f.root, ".tmp/atria-updates")), { code: "ENOENT" });
});

test("successful CLI source update builds before fast-forward and preserves ignored user data", async (t) => {
  const f = await fixture(t);
  const next = await f.publish();
  const progress = [];
  const result = await updateSource({ ...f.options, onProgress: (message) => progress.push(message) });
  assert.equal(result.updated, true);
  assert.equal(result.needsRelaunch, false);
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), next);
  assert.equal(await readFile(join(f.root, "dist/src/runtime/config.js"), "utf8"), "new source\n");
  assert.equal(await readFile(join(f.root, "node_modules/dependency.txt"), "utf8"), "old dependencies\n");
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), "private configuration\n");
  assert.equal(await readFile(join(f.root, "workspace/task.txt"), "utf8"), "private task\n");
  assert.equal(await f.git(f.root, "status", "--porcelain"), "");
  assert(progress.some((message) => message.includes("独立副本")));
  assert.equal((await checkSourceUpdate(f.options)).available, false);
});

test("source updates accept the product rename and reject foreign or reversed identities", async (t) => {
  for (const [current, remote, allowed] of [
    ["coworkos", "coworkos", true],
    ["cowork-harness", "cowork-harness", true],
    ["cowork-harness", "coworkos", true],
    ["foreign-project", "coworkos", false],
    ["coworkos", "foreign-project", false],
    ["cowork-harness", "foreign-project", false],
    ["coworkos", "cowork-harness", false]
  ]) {
    await t.test(`${current} -> ${remote}`, async (t) => {
      const f = await fixture(t, { name: current });
      const old = await f.git(f.root, "rev-parse", "HEAD");
      const next = await f.publish({ name: remote });
      if (!allowed) {
        await assert.rejects(updateSource(f.options), { code: "SOURCE_IDENTITY_CHANGED" });
        await assertOldInstallation(f, old);
        return;
      }
      const result = await updateSource(f.options);
      assert.equal(result.updated, true);
      assert.equal(await f.git(f.root, "rev-parse", "HEAD"), next);
      assert.equal(JSON.parse(await readFile(join(f.root, "package.json"), "utf8")).name, remote);
      assert.equal(await readFile(join(f.root, "workspace/task.txt"), "utf8"), "private task\n");
      assert.equal((await checkSourceUpdate(f.options)).available, false);
    });
  }
});

test("desktop update installs changed locked dependencies and publishes its browser build", async (t) => {
  const f = await fixture(t);
  await f.publish({ lock: true });
  const result = await updateSource({ ...f.options, target: "desktop" });
  assert.equal(result.updated, true);
  assert.equal(result.needsRelaunch, true);
  assert.equal(await readFile(join(f.root, "node_modules/dependency.txt"), "utf8"), "new dependencies\n");
  assert.equal(
    await readFile(join(f.root, "web/assets/math/generated/bundle.js"), "utf8"),
    "new browser bundle\n"
  );
});

test("a CLI-only source update makes the App rebuild the same commit before reporting it current", async (t) => {
  const f = await fixture(t);
  const next = await f.publish();
  await updateSource(f.options);
  const check = await checkSourceUpdate({ ...f.options, target: "desktop" });
  assert.equal(check.available, true);
  assert.equal(check.rebuildRequired, true);
  assert.equal(check.currentCommit, next);
  assert.equal(check.remoteCommit, next);
  let merges = 0;
  const result = await updateSource({
    ...f.options,
    target: "desktop",
    commandRunner: async ({ command, args, cwd, env }) => {
      if (command === "git" && args.includes("merge")) merges++;
      return execute(command, args, { cwd, env });
    }
  });
  assert.equal(result.updated, true);
  assert.equal(merges, 0);
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), next);
  assert.equal(
    await readFile(join(f.root, "web/assets/math/generated/bundle.js"), "utf8"),
    "new browser bundle\n"
  );
  assert.equal((await checkSourceUpdate({ ...f.options, target: "desktop" })).available, false);
  await assert.rejects(readFile(join(f.root, ".git/atria-cli-build-commit")), { code: "ENOENT" });
});

test("failed same-commit App rebuild preserves its prior outputs and pending build marker", async (t) => {
  const f = await fixture(t);
  const next = await f.publish();
  await updateSource(f.options);
  await mkdir(join(f.root, "web/assets/math/generated"), { recursive: true });
  await writeFile(join(f.root, "web/assets/math/generated/bundle.js"), "old browser bundle\n");
  await assert.rejects(
    updateSource({ ...f.options, target: "desktop", env: { ...environment, FIXTURE_NPM_FAIL: "run" } }),
    { code: "UPDATE_BUILD_FAILED" }
  );
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), next);
  assert.equal(await readFile(join(f.root, "dist/src/runtime/config.js"), "utf8"), "new source\n");
  assert.equal(
    await readFile(join(f.root, "web/assets/math/generated/bundle.js"), "utf8"),
    "old browser bundle\n"
  );
  assert.equal((await readFile(join(f.root, ".git/atria-cli-build-commit"), "utf8")).trim(), next);
  assert.equal((await checkSourceUpdate({ ...f.options, target: "desktop" })).rebuildRequired, true);
});

for (const stage of ["ci", "run"]) {
  test(`${stage} failure leaves the previous source, dependencies and build usable and hides command output`, async (t) => {
    const f = await fixture(t);
    const old = await f.git(f.root, "rev-parse", "HEAD");
    await f.publish({ lock: true });
    await assert.rejects(
      updateSource({ ...f.options, env: { ...environment, FIXTURE_NPM_FAIL: stage } }),
      (error) => {
        assert.equal(error.code, stage === "ci" ? "UPDATE_INSTALL_FAILED" : "UPDATE_BUILD_FAILED");
        assert(!error.message.includes("sensitive-output"));
        return true;
      }
    );
    await assertOldInstallation(f, old);
    assert.equal(await f.git(f.root, "status", "--porcelain"), "");
  });
}

test("source update refuses tracked edits, untracked files, detached HEAD and local commits", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await writeFile(join(f.root, "notes.md"), "user edit\n");
  await assert.rejects(updateSource(f.options), { code: "SOURCE_DIRTY" });
  assert.equal(await readFile(join(f.root, "notes.md"), "utf8"), "user edit\n");
  await f.git(f.root, "restore", "notes.md");
  await writeFile(join(f.root, "untracked.txt"), "user file\n");
  await assert.rejects(updateSource(f.options), { code: "SOURCE_DIRTY" });
  await rm(join(f.root, "untracked.txt"));
  await f.git(f.root, "checkout", "--detach");
  await assert.rejects(updateSource(f.options), { code: "SOURCE_DETACHED" });
  await f.git(f.root, "checkout", "preview");
  await writeFile(join(f.root, "notes.md"), "local commit\n");
  await f.git(f.root, "add", "notes.md");
  await f.git(f.root, "commit", "-m", "Local change");
  await assert.rejects(updateSource(f.options), { code: "SOURCE_DIVERGED" });
  assert.equal(await readFile(join(f.root, "notes.md"), "utf8"), "local commit\n");
});

test("in-progress Git operations and missing upstream are rejected", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await mkdir(join(f.root, ".git/rebase-merge"));
  await assert.rejects(updateSource(f.options), { code: "SOURCE_OPERATION_IN_PROGRESS" });
  await rm(join(f.root, ".git/rebase-merge"), { recursive: true });
  await f.git(f.root, "branch", "--unset-upstream");
  await assert.rejects(updateSource(f.options), { code: "SOURCE_NO_UPSTREAM" });
});

test("an upstream file colliding with ignored local configuration is refused without overwriting it", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await writeFile(join(f.author, "config.json"), "upstream configuration\n");
  await f.git(f.author, "add", "--force", "config.json");
  await f.git(f.author, "commit", "-m", "Add conflicting file");
  await f.git(f.author, "push", "origin", "preview");
  await assert.rejects(updateSource(f.options), { code: "SOURCE_FILE_COLLISION" });
  await assertOldInstallation(f, old);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), "private configuration\n");
});

test("rename detection cannot bypass ignored local configuration collision protection", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await f.git(f.author, "mv", "movable.md", "config.json");
  await f.git(f.author, "commit", "-m", "Move tracked file into ignored path");
  await f.git(f.author, "push", "origin", "preview");
  await assert.rejects(updateSource(f.options), { code: "SOURCE_FILE_COLLISION" });
  await assertOldInstallation(f, old);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), "private configuration\n");
});

test("fetch failure reports a safe diagnostic and does not expose remote command output", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await f.publish();
  await assert.rejects(
    updateSource({
      ...f.options,
      commandRunner: async ({ command, args, cwd, env }) => {
        if (command === "git" && args.includes("fetch"))
          throw Object.assign(new Error("private remote URL"), { code: 1, stderr: "private credential" });
        return execute(command, args, { cwd, env });
      }
    }),
    (error) => {
      assert.equal(error.code, "UPDATE_COMMAND_FAILED");
      assert(!error.message.includes("private"));
      return true;
    }
  );
  await assertOldInstallation(f, old);
});

test("an existing update lock refuses another install", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await f.publish();
  await mkdir(join(f.root, ".git/atria-update.lock"));
  await assert.rejects(updateSource(f.options), { code: "UPDATE_BUSY" });
  await assertOldInstallation(f, old);
});

test("an edit made while the isolated build runs is preserved and aborts publication", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await f.publish();
  await assert.rejects(updateSource({ ...f.options, env: { ...environment, FIXTURE_LIVE_ROOT: f.root } }), {
    code: "SOURCE_DIRTY"
  });
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), old);
  assert.equal(await readFile(join(f.root, "notes.md"), "utf8"), "concurrent edit\n");
  assert.equal(await readFile(join(f.root, "dist/src/runtime/config.js"), "utf8"), "old build\n");
});

test("switching branches at the same commit during a build aborts the source update", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await f.publish();
  await assert.rejects(
    updateSource({
      ...f.options,
      commandRunner: async ({ command, args, cwd, env }) => {
        const result = await execute(command, args, { cwd, env });
        if (command !== "git" && args.includes("run"))
          await f.git(f.root, "checkout", "-b", "another-branch");
        return result;
      }
    }),
    { code: "SOURCE_CHANGED" }
  );
  await assertOldInstallation(f, old);
  assert.equal(await f.git(f.root, "branch", "--show-current"), "another-branch");
});

test("publication failure restores the old tracked tree and already-swapped build without reset or clean", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await f.publish({ lock: true });
  await assert.rejects(
    updateSource({
      ...f.options,
      onProgress: (message) => {
        if (message === "更新构建产物：dist") throw new Error("Injected publication failure");
      }
    }),
    /Injected publication failure/
  );
  await assertOldInstallation(f, old);
  assert.equal(await f.git(f.root, "status", "--porcelain"), "");
});

test("a merge command failure after a real fast-forward restores the previous source and leaves dependencies usable", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  await f.publish({ lock: true });
  await assert.rejects(
    updateSource({
      ...f.options,
      commandRunner: async ({ command, args, cwd, env, timeout }) => {
        if (command === "git") assert.equal(timeout, 120_000);
        const result = await execute(command, args, { cwd, env });
        if (command === "git" && args.includes("merge"))
          throw Object.assign(new Error("Injected command failure after fast-forward"), { code: 1 });
        return result;
      }
    }),
    { code: "UPDATE_COMMAND_FAILED" }
  );
  await assertOldInstallation(f, old);
  assert.equal(await f.git(f.root, "status", "--porcelain"), "");
});

test("a failed ref write or concurrent ref change preserves an altered index and recovery files", async (t) => {
  const f = await fixture(t);
  const old = await f.git(f.root, "rev-parse", "HEAD");
  const next = await f.publish();
  await assert.rejects(
    updateSource({
      ...f.options,
      commandRunner: async ({ command, args, cwd, env }) => {
        const result = await execute(command, args, { cwd, env });
        if (command === "git" && args.includes("merge")) {
          await f.git(f.root, "update-ref", "HEAD", old, next);
          throw Object.assign(new Error("Injected failed ref write"), { code: 1 });
        }
        return result;
      }
    }),
    { code: "UPDATE_RECOVERY_REQUIRED" }
  );
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), old);
  assert.equal(await readFile(join(f.root, "notes.md"), "utf8"), "new source\n");
  assert.equal(await readFile(join(f.root, "node_modules/dependency.txt"), "utf8"), "old dependencies\n");
  assert.equal(await readFile(join(f.root, "dist/src/runtime/config.js"), "utf8"), "old build\n");
  assert((await readdir(join(f.root, ".tmp/atria-updates"))).some((name) => name.startsWith(".update-")));
});

test("a merge result failure with a concurrent edit preserves that edit and recovery files", async (t) => {
  const f = await fixture(t);
  const next = await f.publish();
  await assert.rejects(
    updateSource({
      ...f.options,
      commandRunner: async ({ command, args, cwd, env }) => {
        const result = await execute(command, args, { cwd, env });
        if (command === "git" && args.includes("merge")) {
          await writeFile(join(f.root, "notes.md"), "concurrent edit\n");
          throw Object.assign(new Error("Injected command failure after fast-forward"), { code: 1 });
        }
        return result;
      }
    }),
    { code: "UPDATE_RECOVERY_REQUIRED" }
  );
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), next);
  assert.equal(await readFile(join(f.root, "notes.md"), "utf8"), "concurrent edit\n");
  assert.equal(await readFile(join(f.root, "node_modules/dependency.txt"), "utf8"), "old dependencies\n");
  assert.equal(await readFile(join(f.root, "dist/src/runtime/config.js"), "utf8"), "old build\n");
  assert((await readdir(join(f.root, ".tmp/atria-updates"))).some((name) => name.startsWith(".update-")));
});

test("a concurrent edit after publication begins prevents destructive source rollback", async (t) => {
  const f = await fixture(t);
  const next = await f.publish();
  await assert.rejects(
    updateSource({
      ...f.options,
      onProgress: (message) => {
        if (message === "更新构建产物：dist") {
          throw Object.assign(new Error("Injected publication failure"), { cause: undefined });
        }
      },
      commandRunner: async ({ command, args, cwd, env }) => {
        const result = await execute(command, args, { cwd, env });
        if (command === "git" && args.includes("merge"))
          await writeFile(join(f.root, "notes.md"), "concurrent edit\n");
        return result;
      }
    }),
    { code: "UPDATE_RECOVERY_REQUIRED" }
  );
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), next);
  assert.equal(await readFile(join(f.root, "notes.md"), "utf8"), "concurrent edit\n");
  assert.equal(await readFile(join(f.root, "dist/src/runtime/config.js"), "utf8"), "old build\n");
});

test("CLI update options reject typos and distinguish an explicitly selected release channel", () => {
  assert.deepEqual(parseUpdateOptions(["--check", "--channel", "preview"]), {
    check: true,
    channel: "preview",
    explicitChannel: true,
    help: false
  });
  assert.equal(parseUpdateOptions([]).explicitChannel, false);
  assert.equal(parseUpdateOptions([]).channel, undefined);
  assert.throws(() => parseUpdateOptions(["--channel", "nightly"]), /stable or preview/);
  assert.throws(() => parseUpdateOptions(["--force"]), /Unknown update option/);
});

test("installed CLI dispatch leaves repository and implicit channel defaults to the release helper", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atria-update-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, "scripts");
  await mkdir(scripts);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", version: "0.1.2-beta.1" })
  );
  for (const file of ["atria.mjs", "cli-information.mjs", "data-home.cjs", "update.mjs", "update-source.mjs"])
    await writeFile(join(scripts, file), await readFile(new URL(`../scripts/${file}`, import.meta.url)));
  await writeFile(
    join(scripts, "update-release.mjs"),
    `
export async function checkRelease(options) {
  if ('repository' in options || options.channel !== undefined) throw new Error('Implicit defaults were overridden');
  if (process.env.ATRIA_UPDATE_REPOSITORY !== 'example/new-public-repo') throw new Error('Repository override absent');
  return {mode:'release', available:true, version:'0.1.2-beta.2'};
}
export async function installCliRelease(options) { return {mode:'release', updated:true, version:options.channel}; }
`
  );
  const result = await execute(process.execPath, [join(scripts, "atria.mjs"), "update", "--check"], {
    cwd: directory,
    env: { ...environment, ATRIA_UPDATE_REPOSITORY: "example/new-public-repo" }
  });
  assert.match(result.stdout, /0\.1\.2-beta\.2/);
  const explicit = await execute(
    process.execPath,
    [join(scripts, "atria.mjs"), "update", "--channel", "preview"],
    { cwd: directory, env: environment }
  );
  assert.match(explicit.stdout, /preview/);
  const help = await execute(process.execPath, [join(scripts, "atria.mjs"), "update", "--help"], {
    cwd: directory,
    env: environment
  });
  assert.match(help.stdout, /Usage: coworkos update/);
});
