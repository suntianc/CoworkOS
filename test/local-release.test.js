import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSync } from "node:fs";
import { test } from "node:test";
import { downloadNpmReleaseAssets } from "../scripts/download-npm-release-assets.mjs";
import { runLocalRelease } from "../scripts/release-local.mjs";

const version = "0.1.3";
const tag = `v${version}`;
const repo = "RUC-NLPIR/CoworkOS";

test("local release builds once and uploads candidate archives without publishing them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-local-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "release"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  const desktopName = `coworkos-desktop-darwin-arm64-${version}.tgz`;
  await writeFile(
    join(root, "release", desktopName + ".sha256"),
    "stale checksum from an earlier candidate\n"
  );
  const calls = [];
  const commandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "npm" && args[1] === "desktop:npm:pack")
      await writeFile(join(root, "release", `coworkos-desktop-darwin-arm64-${version}.tgz`), "desktop");
    if (command === "npm" && args[1] === "npm:pack") {
      const name = `coworkos-app-${version}.tgz`;
      const bytes = Buffer.from("cli");
      await writeFile(join(root, "release", name), bytes);
      await writeFile(
        join(root, "release", name + ".sha256"),
        `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`
      );
    }
    return { status: 0 };
  };
  await runLocalRelease({ tag, repository: repo, root, platform: "darwin", arch: "arm64", commandRunner });
  const commands = calls.map(({ command, args }) => `${command} ${args.join(" ")}`);
  assert.deepEqual(commands.slice(0, 6), [
    "node scripts/release-metadata.mjs",
    "npm run desktop:dist",
    "npm run cli:pack",
    "npm run desktop:npm:pack",
    "npm run npm:pack",
    "node scripts/release-artifacts.mjs"
  ]);
  assert.match(commands.at(-1), /--clobber/);
  assert.equal(
    calls.some(({ command, args }) => command === "gh" && args[0] === "workflow"),
    false
  );
  assert.ok(
    calls.find(({ command, args }) => command === "gh" && args[0] === "release").args.includes("--clobber")
  );
  assert.equal(calls[3].options.env.RELEASE_TAG, tag);
  assert.equal(calls[3].options.env.ATRIA_DESKTOP_NPM_PACKAGE_DIR, join(root, "release"));
  assert.equal(
    await readFile(join(root, "release", desktopName + ".sha256"), "utf8"),
    `${createHash("sha256").update("desktop").digest("hex")}  ${desktopName}\n`
  );
});

test("local release refuses to run on a non-Apple-Silicon host before invoking commands", async () => {
  let invoked = false;
  await assert.rejects(
    runLocalRelease({ tag, platform: "linux", arch: "x64", commandRunner: () => (invoked = true) }),
    /Apple Silicon Mac/
  );
  assert.equal(invoked, false);
});

test("npm publisher requires a draft and permits published assets only for verification with intact checksums", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-npm-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloads = new Map();
  const assets = [];
  const dmgArtifact = { name: `CoworkOS-${version}-mac-arm64.dmg`, size: 234, sha256: "a".repeat(64) };
  const releaseManifest = {
    version,
    source: { tag, commit: "release-commit" },
    artifacts: [dmgArtifact]
  };
  const archiveNames = [`coworkos-desktop-darwin-arm64-${version}.tgz`, `coworkos-app-${version}.tgz`];
  for (const [index, name] of [...archiveNames, `atria-release-${version}.json`].entries()) {
    const bytes = Buffer.from(
      name.startsWith("atria-release-") ? JSON.stringify(releaseManifest) : `${name}-archive`
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    payloads.set(index * 2 + 1, bytes);
    payloads.set(index * 2 + 2, Buffer.from(`${digest}  ${name}\n`));
    assets.push({ id: index * 2 + 1, name }, { id: index * 2 + 2, name: `${name}.sha256` });
  }
  const release = { tag_name: tag, draft: true, assets };
  const commandRunner = (command, args) => {
    if (command === "gh") return JSON.stringify([[release]]);
    if (command === "git") return "release-commit";
    assert.equal(command, "tar");
    const archive = args[1];
    if (archive.includes("coworkos-app-")) {
      return JSON.stringify(
        args[2] === "package/build-info.json"
          ? { version, commit: "release-commit", dirty: false, distribution: "npm" }
          : { name: "coworkos-app", version }
      );
    }
    return JSON.stringify({
      name: "coworkos-desktop-darwin-arm64",
      version,
      desktopRelease: { appVersion: version, artifact: dmgArtifact }
    });
  };
  const binaryRunner = (_command, args, options) => {
    const id = Number(args[1].split("/").at(-1));
    writeSync(options.stdio[1], payloads.get(id));
    return { status: 0 };
  };
  const result = await downloadNpmReleaseAssets({
    tag,
    version,
    repository: repo,
    root,
    commandRunner,
    binaryRunner
  });
  assert.equal(result.files.length, 2);
  assert.equal(result.releaseManifest, `atria-release-${version}.json`);
  assert.equal(
    (await readFile(join(result.directory, result.files[0]))).toString(),
    `${result.files[0]}-archive`
  );
  release.draft = false;
  await assert.rejects(
    downloadNpmReleaseAssets({ tag, version, repository: repo, root, commandRunner, binaryRunner }),
    /exactly one draft/
  );
  const published = await downloadNpmReleaseAssets({
    tag,
    version,
    repository: repo,
    root,
    commandRunner,
    binaryRunner,
    allowPublished: true
  });
  assert.deepEqual(published.files, result.files);
  payloads.set(1, Buffer.from("changed published archive"));
  await assert.rejects(
    downloadNpmReleaseAssets({
      tag,
      version,
      repository: repo,
      root,
      commandRunner,
      binaryRunner,
      allowPublished: true
    }),
    /checksum differs/
  );
});
