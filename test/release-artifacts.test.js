import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  inspectReleaseArtifacts,
  releaseFiles,
  verifyReleaseArtifacts,
  writeReleaseArtifacts
} from "../scripts/release-artifacts.mjs";
import { readReleaseDraft, uploadReleaseDraft } from "../scripts/release-draft.mjs";
import { macUpdateFeed } from "../scripts/update-feed.mjs";

const repository = "fixture-owner/atria";
const version = "0.1.2-beta.1";
const tag = "v" + version;
const artifactScript = fileURLToPath(new URL("../scripts/release-artifacts.mjs", import.meta.url));
const draftScript = fileURLToPath(new URL("../scripts/release-draft.mjs", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, { notes } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-release-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scratch", "package"), { recursive: true });
  await mkdir(join(root, "release"));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|RELEASE_TAG|ATRIA_UPDATE)/.test(key))
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Release Fixture",
    GIT_AUTHOR_EMAIL: "release-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Release Fixture",
    GIT_COMMITTER_EMAIL: "release-fixture@example.invalid"
  };
  const git = (args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=" + join(root, "scratch", "hooks"),
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args
      ],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  await writeFile(join(root, ".gitignore"), "/scratch/\n/release/\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ version, repository }));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({ version, packages: { "": { version } } })
  );
  if (notes !== undefined) {
    await mkdir(join(root, "docs", "releases"), { recursive: true });
    await writeFile(join(root, "docs", "releases", version + ".md"), notes);
  }
  git(["init", "--template=" + join(root, "scratch", "empty-template")]);
  git(["add", "."]);
  git(["commit", "-m", "Fixture release"]);
  git(["tag", "--no-sign", tag]);
  const commit = git(["rev-parse", "HEAD"]);
  const dmg = "CoworkOS-" + version + "-mac-arm64.dmg";
  const cli = "coworkos-cli-" + version + ".tgz";
  async function checksum(name) {
    const bytes = await readFile(join(root, "release", name));
    await writeFile(join(root, "release", name + ".sha256"), hash(bytes) + "  " + name + "\n");
  }
  async function pack(build = {}, manifest = {}) {
    await writeFile(
      join(root, "scratch", "package", "build-info.json"),
      JSON.stringify({ version, commit, dirty: false, ...build })
    );
    await writeFile(
      join(root, "scratch", "package", "package.json"),
      JSON.stringify({ name: "atria-cowork-cli", version, repository, ...manifest })
    );
    execFileSync("tar", ["-czf", join(root, "release", cli), "-C", join(root, "scratch"), "package"]);
    await checksum(cli);
  }
  await writeFile(join(root, "release", dmg), "isolated fixture DMG payload");
  await checksum(dmg);
  await pack();
  return { root, env, git, commit, dmg, cli, checksum, pack, options: { root, tag, repository } };
}

async function addSigningReport(f, changes = {}) {
  const signature = (identifier) => ({
    identifier,
    mode: "adhoc",
    cdHash: "a".repeat(40),
    teamIdentifier: null,
    hardenedRuntime: true,
    audioInput: false
  });
  const report = {
    version,
    mode: "adhoc",
    developerId: false,
    notarized: false,
    strictVerified: true,
    minimumSystemVersion: "14.0",
    bundleVersion: "0.1.2",
    parent: signature("org.atria.cowork"),
    ...changes
  };
  const name = "CoworkOS-" + version + "-mac-arm64.signing.json";
  await writeFile(join(f.root, "release", name), JSON.stringify(report));
  return { report, name };
}

test("beta manifest fingerprints actual payloads and binds a clean tag and embedded CLI source", async (t) => {
  const f = await fixture(t);
  const result = await writeReleaseArtifacts(f.options);
  assert.equal(result.version, version);
  assert.equal(result.prerelease, true);
  assert.deepEqual(result.source, { repository, commit: f.commit, tag });
  assert.equal(result.artifacts.length, 4);
  for (const artifact of result.artifacts) {
    const bytes = await readFile(join(f.root, "release", artifact.name));
    assert.equal(artifact.size, bytes.length);
    assert.equal(artifact.sha256, hash(bytes));
  }
  const verified = await verifyReleaseArtifacts(f.options);
  assert.equal(verified.files.length, 6);
  const notes = await readFile(result.notesPath, "utf8");
  assert.match(notes, /macOS 14/);
  assert.match(notes, /ad-hoc.*Developer ID/);
  assert.match(notes, /Node.js >=22.19.0/);
  assert.match(notes, /npm install --global/);
  assert.ok(notes.includes(f.commit));
  assert.ok(notes.includes(releaseFiles(version).manifest));
  assert.doesNotMatch(notes, /\{\{[A-Z_]+\}\}/);
});

test("version-specific review notes override the generic template and keep automatic provenance", async (t) => {
  const f = await fixture(t, {
    notes: "# Reviewed {{VERSION}}\n\nFixture installation evidence; known limits remain explicit."
  });
  const result = await writeReleaseArtifacts(f.options);
  const notes = await readFile(result.notesPath, "utf8");
  assert.match(notes, /^# Reviewed 0.1.2-beta.1/);
  assert.match(notes, /Fixture installation evidence/);
  assert.doesNotMatch(notes, /待维护者填写/);
  assert.ok(notes.includes(f.commit));
});

test("actual signing reports and their generated checksum are included in distribution provenance", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    writeReleaseArtifacts({ ...f.options, requireSigningReport: true }),
    /requires.*signing report/
  );
  const { name } = await addSigningReport(f);
  const manifest = await writeReleaseArtifacts({ ...f.options, requireSigningReport: true });
  assert.deepEqual(manifest.mac, {
    signing: "adhoc",
    developerId: false,
    notarized: false,
    minimumSystemVersion: "14.0",
    strictVerified: true
  });
  assert.ok(manifest.artifacts.some((artifact) => artifact.name === name));
  assert.ok(manifest.artifacts.some((artifact) => artifact.name === name + ".sha256"));
  const github = githubFixture();
  const result = await uploadReleaseDraft({ ...f.options, ...github, requireSigningReport: true });
  assert.equal(result.uploaded, 8);
  assert.ok(github.calls.at(-1).some((arg) => arg.endsWith(name)));
  const notes = await readFile(manifest.notesPath, "utf8");
  assert.match(notes, /实际模式：adhoc/);
  await writeFile(join(f.root, "release", name + ".sha256"), "0".repeat(64) + "  " + name + "\n");
  await assert.rejects(verifyReleaseArtifacts(f.options), /checksum/);
});

test("invalid signing evidence and ad-hoc native-update artifacts cannot enter a release", async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { version: "0.1.1" },
    { strictVerified: false },
    { mode: "unknown" },
    { developerId: true },
    { notarized: true },
    { minimumSystemVersion: "13.0" },
    { parent: { identifier: "foreign.application" } }
  ]) {
    await addSigningReport(f, invalid);
    await assert.rejects(writeReleaseArtifacts(f.options), /Mac signing report/);
  }
  await addSigningReport(f);
  const zip = "CoworkOS-" + version + "-mac-arm64.zip";
  const bytes = Buffer.from("isolated native update fixture");
  await writeFile(join(f.root, "release", zip), bytes);
  await f.checksum(zip);
  await writeFile(
    join(f.root, "release", "atria-update-mac-arm64.json"),
    JSON.stringify(
      macUpdateFeed({
        version,
        repository,
        sha256: hash(bytes),
        size: bytes.length
      })
    )
  );
  await assert.rejects(writeReleaseArtifacts(f.options), /distribution disagree/);
});

test("dirty sources, foreign repositories and stale or dirty CLI provenance are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    inspectReleaseArtifacts({ ...f.options, repository: "other/atria" }),
    /single-repository/
  );
  for (const build of [{ dirty: true }, { commit: "a".repeat(40) }, { version: "0.1.1" }]) {
    await f.pack(build);
    await assert.rejects(writeReleaseArtifacts(f.options), /CLI archive provenance/);
  }
  await f.pack({}, { name: "wrong-cli" });
  await assert.rejects(writeReleaseArtifacts(f.options), /CLI archive provenance/);
  await f.pack();
  await writeFile(join(f.root, "uncommitted-source.txt"), "changed source");
  await assert.rejects(writeReleaseArtifacts(f.options), /uncommitted changes/);
  await assert.rejects(readFile(join(f.root, "release", releaseFiles(version).manifest)), { code: "ENOENT" });
});

test("missing payloads, wrong checksums and symlink artifacts fail before writing a manifest", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "release", f.dmg + ".sha256"), "0".repeat(64) + "  " + f.dmg + "\n");
  await assert.rejects(writeReleaseArtifacts(f.options), /checksum/);
  await f.checksum(f.dmg);
  await rm(join(f.root, "release", f.dmg));
  await assert.rejects(writeReleaseArtifacts(f.options), { code: "ENOENT" });
  await writeFile(join(f.root, "scratch", "fixture-dmg"), "fixture");
  await symlink(join(f.root, "scratch", "fixture-dmg"), join(f.root, "release", f.dmg));
  await assert.rejects(writeReleaseArtifacts(f.options), /regular file/);
  await assert.rejects(readFile(join(f.root, "release", releaseFiles(version).manifest)), { code: "ENOENT" });
});

test("signed update artifacts must be complete and the feed must match the actual ZIP", async (t) => {
  const f = await fixture(t);
  const zip = "CoworkOS-" + version + "-mac-arm64.zip";
  const bytes = Buffer.from("isolated ZIP fixture; not signature acceptance");
  await writeFile(join(f.root, "release", zip), bytes);
  await assert.rejects(writeReleaseArtifacts(f.options), /present together/);
  await f.checksum(zip);
  const feed = macUpdateFeed({ version, repository, sha256: hash(bytes), size: bytes.length });
  const feedPath = join(f.root, "release", "atria-update-mac-arm64.json");
  await writeFile(feedPath, JSON.stringify(feed));
  assert.equal((await writeReleaseArtifacts(f.options)).artifacts.length, 7);
  feed.releases[0].updateTo.url = "https://example.invalid/update.zip";
  await writeFile(feedPath, JSON.stringify(feed));
  await assert.rejects(writeReleaseArtifacts(f.options), /feed differs/);
});

test("manifest verification detects replaced payloads or edited provenance before upload", async (t) => {
  const f = await fixture(t);
  await writeReleaseArtifacts(f.options);
  await writeFile(join(f.root, "release", f.dmg), "replaced");
  await assert.rejects(verifyReleaseArtifacts(f.options), /checksum/);
  await f.checksum(f.dmg);
  await assert.rejects(verifyReleaseArtifacts(f.options), /manifest differs/);
});

function githubFixture({ initial, publishBeforeUpload = false, readError } = {}) {
  const calls = [];
  let current = initial;
  let views = 0;
  const commandRunner = async (command, args) => {
    assert.equal(command, "gh");
    calls.push(args);
    const operation = args[1];
    if (operation === "view") {
      views++;
      if (readError) throw readError;
      if (!current) throw Object.assign(new Error("not found"), { code: 1, stderr: "release not found\n" });
      if (publishBeforeUpload && views > 1) current = { ...current, isDraft: false };
      return { stdout: JSON.stringify(current) };
    }
    if (operation === "create" || operation === "edit")
      current = { tagName: tag, isDraft: true, isPrerelease: args.includes("--prerelease=true") };
    return { stdout: "" };
  };
  return { calls, commandRunner };
}

test("new beta upload creates only a prerelease draft with reviewed notes and all verified assets", async (t) => {
  const f = await fixture(t);
  await writeReleaseArtifacts(f.options);
  const github = githubFixture();
  const result = await uploadReleaseDraft({ ...f.options, ...github });
  assert.equal(result.draft, true);
  assert.equal(result.uploaded, 6);
  assert.deepEqual(
    github.calls.map((args) => args[1]),
    ["view", "create", "view", "upload"]
  );
  assert.ok(github.calls[1].includes("--draft"));
  assert.ok(github.calls[1].includes("--verify-tag"));
  assert.ok(github.calls[1].includes("--prerelease=true"));
  assert.ok(github.calls[1].includes("--notes-file"));
  assert.ok(github.calls[1].includes("--latest=false"));
  assert.ok(github.calls.at(-1).some((arg) => arg.endsWith(releaseFiles(version).manifest)));
});

for (const replaceNotes of [false, true]) {
  test(
    "draft retries " + (replaceNotes ? "explicitly replace" : "preserve") + " maintainer notes",
    async (t) => {
      const f = await fixture(t);
      await writeReleaseArtifacts(f.options);
      const github = githubFixture({ initial: { tagName: tag, isDraft: true, isPrerelease: true } });
      await uploadReleaseDraft({ ...f.options, ...github, replaceNotes });
      const edit = github.calls.find((args) => args[1] === "edit");
      assert.equal(Boolean(edit), replaceNotes);
      if (edit) assert.ok(edit.includes("--notes-file"));
      assert.equal(github.calls.at(-1)[1], "upload");
    }
  );
}

test("an existing beta draft with the wrong channel is corrected without replacing its reviewed notes", async (t) => {
  const f = await fixture(t);
  await writeReleaseArtifacts(f.options);
  const github = githubFixture({ initial: { tagName: tag, isDraft: true, isPrerelease: false } });
  await uploadReleaseDraft({ ...f.options, ...github });
  const edit = github.calls.find((args) => args[1] === "edit");
  assert.ok(edit.includes("--prerelease=true"));
  assert.ok(!edit.includes("--notes-file"));
});

for (const late of [false, true]) {
  test(
    "published releases cannot be overwritten " + (late ? "after preparation" : "before preparation"),
    async (t) => {
      const f = await fixture(t);
      await writeReleaseArtifacts(f.options);
      const github = githubFixture({
        initial: { tagName: tag, isDraft: late, isPrerelease: true },
        publishBeforeUpload: late
      });
      await assert.rejects(uploadReleaseDraft({ ...f.options, ...github }), /already published/);
      assert.ok(github.calls.every((args) => args[1] === "view"));
    }
  );
}

test("remote permission/network errors and incomplete metadata fail closed", async () => {
  for (const error of [
    { code: 1, stderr: "HTTP 403: Resource not accessible\n" },
    { code: 1, stderr: "Could not resolve host api.github.com\n" },
    { code: "ENOENT", stderr: "" }
  ]) {
    const github = githubFixture({ readError: error });
    await assert.rejects(readReleaseDraft({ repository, tag, ...github }), /Unable to verify/);
    assert.equal(github.calls.length, 1);
  }
  await assert.rejects(
    readReleaseDraft({
      repository,
      tag,
      commandRunner: async () => ({ stdout: '{"isDraft":true}' })
    }),
    /incomplete release metadata/
  );
});

test("artifact CLI generates local review files and draft CLI rejects arguments before calling GitHub", async (t) => {
  const f = await fixture(t);
  await addSigningReport(f);
  const generated = spawnSync(process.execPath, [artifactScript], {
    cwd: f.root,
    env: { ...f.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository },
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /Release manifest/);
  await verifyReleaseArtifacts(f.options);
  const rejected = spawnSync(process.execPath, [draftScript, "upload", "--publish"], {
    cwd: f.root,
    env: { ...f.env, PATH: dirname(process.execPath) },
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Usage:/);
});
