import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileTarget, resolveProtectedTarget } from "../dist/src/tools/file-path.js";
import {
  ProtectedPaths,
  configuredProtectedPaths,
  projectWritesEnabled,
  guessedProtection,
  atriaInstallRoot,
  DEFAULT_PROTECTED_PATHS
} from "../dist/src/tools/protected-paths.js";

async function project(t) {
  // Resolve symlinks: on macOS /var is /private/var, and `pwd` reports the real path.
  const base = await realpath(await mkdtemp(join(tmpdir(), "atria-guard-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  // The agent's workspace sits outside the project, as it does in a real run.
  const workDir = join(base, "workspace", "agent");
  await mkdir(join(root, "pipeline"), { recursive: true });
  await mkdir(join(root, "eval"), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(root, "pipeline", "synth.py"), "# synthesis\n");
  await writeFile(join(root, "eval", "score.py"), "# the referee\n");
  return { root, workDir };
}

test("the guard protects the referee and version control, but not the project's own code", async (t) => {
  const { root } = await project(t);
  const guard = new ProtectedPaths({ root });
  for (const path of ["eval/score.py", "benchmarks/run.sh", "tests/fixtures/a.json", ".git/config"]) {
    assert.ok(guard.match(join(root, path)), `${path} must be protected`);
  }
  // The patterns resolve against the user's project, so a project that happens
  // to keep its code in src/ must not find it locked: that is what the agent
  // is here to change.
  for (const path of [
    "pipeline/synth.py",
    "configs/data.yaml",
    "train.py",
    "src/synth/mix.py",
    "dist/bundle.js",
    "README.md"
  ]) {
    assert.equal(guard.match(join(root, path)), undefined, `${path} must stay writable`);
  }
  // A name that merely starts with a protected one is a different path.
  assert.equal(guard.match(join(root, "evaluation_notes.md")), undefined);
  assert.ok(guard.match(join(root, "evaluation/notes.md")));
  // Paths outside the guarded root are some other check's business.
  assert.equal(guard.match("/tmp/elsewhere/file.txt"), undefined);
});

test("the harness install is protected by absolute path, wherever it sits", async (t) => {
  const { root } = await project(t);
  const install = "/opt/atria";
  const guard = new ProtectedPaths({ root, protectedRoots: [install] });
  // An agent improving a pipeline must not edit the runtime that records
  // whether the pipeline improved — including from outside the project.
  assert.equal(guard.match("/opt/atria/src/runtime/experiment-program-store.ts"), install);
  assert.equal(guard.match("/opt/atria/.pi/extensions/cowork.ts"), install);
  assert.equal(
    guard.match(join(root, "src/synth/mix.py")),
    undefined,
    "the project's own src/ is untouched by this"
  );

  // Emptying the project patterns is allowed; the runtime stays protected.
  const opened = configuredProtectedPaths(root, { COWORK_PROTECTED_PATHS: "" }, [install]);
  assert.equal(opened.match(join(root, "eval/score.py")), undefined);
  assert.equal(
    opened.match("/opt/atria/src/x.ts"),
    install,
    "the recorder is never a legitimate target of what it records"
  );
});

test("atriaInstallRoot points at the harness, not at dist", () => {
  const root = atriaInstallRoot();
  assert.ok(existsSync(join(root, "package.json")), `${root} should be the install root`);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name, "coworkos");
});

test("the environment preset can grant project writes for a preconfigured run", () => {
  // The normal path is a Task grant. This exists for a run configured ahead of
  // time — a benchmark harness, an unattended job — and is off unless set.
  assert.equal(projectWritesEnabled({}), false, "an ordinary task gets the sandbox");
  assert.equal(projectWritesEnabled({ COWORK_PROJECT_WRITE: "1" }), true);
  assert.equal(projectWritesEnabled({ COWORK_PROJECT_WRITE: "0" }), false);
  assert.equal(projectWritesEnabled({ COWORK_PROJECT_WRITE: "false" }), false);
});

test("the protected set is configurable, and can be emptied deliberately", () => {
  const root = "/project";
  assert.ok(configuredProtectedPaths(root, {}).match("/project/eval/x.py"), "defaults apply when unset");

  const custom = configuredProtectedPaths(root, { COWORK_PROTECTED_PATHS: "scoring/, golden.json" });
  assert.ok(custom.match("/project/scoring/run.py"));
  assert.ok(custom.match("/project/golden.json"));
  assert.equal(
    custom.match("/project/eval/x.py"),
    undefined,
    "an override replaces the defaults rather than adding to them"
  );

  assert.equal(
    configuredProtectedPaths(root, { COWORK_PROTECTED_PATHS: "" }).match("/project/eval/x.py"),
    undefined,
    "the guard can be turned off, but only by saying so"
  );
});

test("COWORK_EVAL_PATHS protects the scorer wherever the user actually keeps it", () => {
  const root = "/proj";
  // The layouts the guessed fallback misses — which is most of them.
  const declared = configuredProtectedPaths(root, {
    COWORK_EVAL_PATHS: "src/eval/, scripts/evaluate.py, data/test.jsonl"
  });
  assert.ok(declared.match("/proj/src/eval/scorer.py"));
  assert.ok(declared.match("/proj/scripts/evaluate.py"));
  assert.ok(declared.match("/proj/data/test.jsonl"));
  // Declaring eval paths does not lock the rest of the project.
  assert.equal(declared.match("/proj/src/synth/mix.py"), undefined);
  assert.equal(declared.match("/proj/data/train.jsonl"), undefined);
  // It is additive: the conventional names stay protected too.
  assert.ok(declared.match("/proj/eval/run.py"));
  assert.ok(declared.match("/proj/.git/config"));
});

test("a declared eval path cannot be unprotected by clearing the fallback", () => {
  const root = "/proj";
  const guard = configuredProtectedPaths(
    root,
    { COWORK_EVAL_PATHS: "scoring/", COWORK_PROTECTED_PATHS: "" },
    ["/opt/atria"]
  );
  assert.ok(guard.match("/proj/scoring/run.py"), "the referee stays the referee");
  assert.equal(guard.match("/proj/eval/run.py"), undefined, "but the guessed fallback is gone as asked");
  assert.equal(guard.match("/opt/atria/src/x.ts"), "/opt/atria");
});

test("guessedProtection reports when only the fallback is in effect", () => {
  // This drives the startup warning: a guess that misses is invisible until
  // the recorded results are already worthless.
  assert.equal(guessedProtection({}), true);
  assert.equal(
    guessedProtection({ COWORK_PROTECTED_PATHS: "eval/" }),
    true,
    "overriding the guess is still a guess"
  );
  assert.equal(guessedProtection({ COWORK_EVAL_PATHS: "src/eval/" }), false);
  assert.equal(guessedProtection({ COWORK_EVAL_PATHS: "  " }), true, "blank is not a declaration");
});

test("the default set covers scoring inputs, not the project's own layout", () => {
  assert.ok(DEFAULT_PROTECTED_PATHS.includes("eval/"));
  assert.ok(DEFAULT_PROTECTED_PATHS.includes("benchmarks/"));
  assert.ok(DEFAULT_PROTECTED_PATHS.includes(".git/"));
  // src/ and dist/ belong to the project being optimized; the harness's own
  // copies are protected by absolute path instead.
  assert.ok(!DEFAULT_PROTECTED_PATHS.includes("src/"));
  assert.ok(!DEFAULT_PROTECTED_PATHS.includes("dist/"));
});

test("protected target resolution bounds link chains and ordinary files still reject cycles", async (t) => {
  const { root } = await project(t);
  for (let index = 0; index < 40; index += 1)
    await symlink(index === 39 ? "future" : `link-${index + 1}`, join(root, `link-${index}`));
  assert.equal(await resolveProtectedTarget(join(root, "link-0")), join(root, "future"));
  await symlink("link-0", join(root, "too-long"));
  await assert.rejects(resolveProtectedTarget(join(root, "too-long")), /too many symbolic links/);
  await symlink("cycle-b", join(root, "cycle-a"));
  await symlink("cycle-a", join(root, "cycle-b"));
  await assert.rejects(resolveProtectedTarget(join(root, "cycle-a")), /too many symbolic links/);
  await assert.rejects(resolveFileTarget(join(root, "cycle-a")), { code: "ELOOP" });
});
