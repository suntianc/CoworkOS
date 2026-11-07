import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateRelease } from "./release-metadata.mjs";
import { releaseAssetUrl, updateRepository } from "./update-release.mjs";

const execute = promisify(execFile);
export const releaseFiles = (version) => ({
  manifest: "atria-release-" + version + ".json",
  notes: "atria-release-" + version + ".md"
});

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= 0 || !Number.isSafeInteger(info.size))
    throw new Error("Release artifact must be a nonempty regular file: " + basename(path));
  return info;
}

async function fingerprint(directory, name) {
  const path = join(directory, name);
  const info = await regularFile(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { name, size: info.size, sha256: hash.digest("hex") };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function checkChecksum(directory, artifact) {
  const checksum = (await readFile(join(directory, artifact.name + ".sha256"), "utf8")).trim();
  const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(checksum);
  if (!match || match[1].toLowerCase() !== artifact.sha256 || match[2] !== artifact.name)
    throw new Error("Release checksum does not match its artifact: " + artifact.name);
}

async function archiveJson(archive, member, commandRunner) {
  const { stdout } = await commandRunner("tar", ["-xOf", archive, member], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout);
}

function macSigningReport(report, version) {
  const developerId = report?.mode === "developer-id";
  if (
    report?.version !== version ||
    !["adhoc", "developer-id"].includes(report.mode) ||
    report.developerId !== developerId ||
    report.strictVerified !== true ||
    report.minimumSystemVersion !== "14.0" ||
    report.notarized !== (developerId ? null : false) ||
    typeof report.bundleVersion !== "string" ||
    !report.bundleVersion
  )
    throw new Error("Mac signing report differs from the release version or validated distribution mode");
  const signature = report.parent;
  if (
    signature?.identifier !== "org.atria.cowork" ||
    signature.mode !== report.mode ||
    signature.hardenedRuntime !== true ||
    signature.audioInput !== false ||
    !/^[a-f0-9]{40,64}$/.test(signature.cdHash ?? "")
  )
    throw new Error("Mac signing report is missing its verified App signature or permits audio input");
  if (developerId && (!signature.teamIdentifier || signature.teamIdentifier === "not set"))
    throw new Error("Mac signing report is missing its Developer ID team");
  return {
    signing: report.mode,
    developerId,
    notarized: report.notarized,
    minimumSystemVersion: report.minimumSystemVersion,
    strictVerified: true
  };
}

/** Validate actual artifacts against their tag and embedded CLI provenance before writing metadata. */
export async function inspectReleaseArtifacts({
  root = process.cwd(),
  tag = process.env.RELEASE_TAG,
  repository,
  commandRunner = execute,
  requireSigningReport = false,
  prepareSigningChecksum = false
} = {}) {
  const metadata = await validateRelease(root, tag);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const sourceRepository = updateRepository(pkg.repository);
  if (repository !== undefined && updateRepository(repository) !== sourceRepository)
    throw new Error(
      "Release repository differs from package.repository; single-repository releases are required"
    );
  const directory = resolve(root, "release");
  const dmg = "CoworkOS-" + metadata.version + "-mac-arm64.dmg";
  const cli = "coworkos-cli-" + metadata.version + ".tgz";
  const zip = "CoworkOS-" + metadata.version + "-mac-arm64.zip";
  const feedName = "atria-update-mac-arm64.json";
  const signingName = "CoworkOS-" + metadata.version + "-mac-arm64.signing.json";
  const hasSigning = await exists(join(directory, signingName));
  if (requireSigningReport && !hasSigning)
    throw new Error("Mac distribution requires the actual package signing report");
  let mac;
  if (hasSigning) {
    await regularFile(join(directory, signingName));
    mac = macSigningReport(
      JSON.parse(await readFile(join(directory, signingName), "utf8")),
      metadata.version
    );
  }
  const signedFiles = [zip, zip + ".sha256", feedName];
  const present = await Promise.all(signedFiles.map((name) => exists(join(directory, name))));
  if (present.some(Boolean) && !present.every(Boolean))
    throw new Error("Signed update ZIP, checksum and feed must be present together");
  if (mac && mac.developerId !== present.every(Boolean))
    throw new Error("Mac signing report and Developer ID ZIP/feed distribution disagree");
  const names = [dmg, dmg + ".sha256", cli, cli + ".sha256", ...(present.every(Boolean) ? signedFiles : [])];
  const artifacts = await Promise.all(names.map((name) => fingerprint(directory, name)));

  if (hasSigning) {
    const signing = await fingerprint(directory, signingName);
    artifacts.push(signing);
    if (prepareSigningChecksum) {
      const content = signing.sha256 + "  " + signingName + "\n";
      artifacts.push({
        name: signingName + ".sha256",
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex")
      });
    } else {
      await checkChecksum(directory, signing);
      artifacts.push(await fingerprint(directory, signingName + ".sha256"));
    }
  }
  const lookup = (name) => artifacts.find((artifact) => artifact.name === name);
  await checkChecksum(directory, lookup(dmg));
  await checkChecksum(directory, lookup(cli));
  const archive = join(directory, cli);
  const [build, manifest] = await Promise.all([
    archiveJson(archive, "package/build-info.json", commandRunner),
    archiveJson(archive, "package/package.json", commandRunner)
  ]);
  if (
    build.version !== metadata.version ||
    build.commit !== metadata.commit ||
    build.dirty !== false ||
    manifest.name !== "atria-cowork-cli" ||
    manifest.version !== metadata.version ||
    updateRepository(manifest.repository) !== sourceRepository
  )
    throw new Error(
      "CLI archive provenance differs from the clean release tag; rebuild from that exact source"
    );
  if (present.every(Boolean)) {
    await checkChecksum(directory, lookup(zip));
    const feed = JSON.parse(await readFile(join(directory, feedName), "utf8"));
    const release = feed.releases?.[0];
    const update = release?.updateTo;
    const expectedUrl = releaseAssetUrl(sourceRepository, tag, zip);
    if (
      feed.currentRelease !== metadata.version ||
      feed.releases?.length !== 1 ||
      release?.version !== metadata.version ||
      update?.version !== metadata.version ||
      update?.url !== expectedUrl ||
      update?.sha256 !== lookup(zip).sha256 ||
      update?.size !== lookup(zip).size
    )
      throw new Error("Signed update feed differs from the release ZIP, source repository or version");
  }
  return {
    schemaVersion: 1,
    version: metadata.version,
    prerelease: metadata.prerelease,
    source: { repository: sourceRepository, commit: metadata.commit, tag },
    ...(mac ? { mac } : {}),
    artifacts
  };
}

export async function renderReleaseNotes(root, manifest) {
  const maintained = join(root, "docs", "releases", manifest.version + ".md");
  const source = (await exists(maintained))
    ? maintained
    : new URL("../.github/RELEASE_TEMPLATE.md", import.meta.url);
  let notes = await readFile(source, "utf8");
  if (!notes.trim() || Buffer.byteLength(notes) > 128 * 1024)
    throw new Error("Release notes must be nonempty and at most 128 KiB");
  const repositoryUrl = "https://github.com/" + manifest.source.repository;
  const values = {
    VERSION: manifest.version,
    TAG: manifest.source.tag,
    REPOSITORY_URL: repositoryUrl,
    MAC_SIGNING_NOTICE:
      manifest.mac?.developerId === true
        ? "Developer ID 签名更新产物已生成；公证与 Gatekeeper 安装仍须单独验收。"
        : "此包使用 ad-hoc 签名，不含 Developer ID 签名或公证。首次打开可能需要在“系统设置 → 隐私与安全性”批准；无需关闭系统安全保护。"
  };
  notes = notes.replace(/\{\{(VERSION|TAG|REPOSITORY_URL|MAC_SIGNING_NOTICE)\}\}/g, (_, key) => values[key]);
  const name = releaseFiles(manifest.version).manifest;
  const url = releaseAssetUrl(manifest.source.repository, manifest.source.tag, name);
  const tick = String.fromCharCode(96);
  return (
    notes.trimEnd() +
    "\n\n---\n\n来源 / Provenance: [" +
    tick +
    manifest.source.commit +
    tick +
    "](" +
    repositoryUrl +
    "/tree/" +
    manifest.source.commit +
    "), tag " +
    tick +
    manifest.source.tag +
    tick +
    ".\n" +
    "产物名称、大小及 SHA-256 见 [" +
    name +
    "](" +
    url +
    ")；同时下载清单的 " +
    tick +
    ".sha256" +
    tick +
    "。\n" +
    (manifest.mac
      ? "Mac 签名记录见同版本 .signing.json 与 .sha256；实际模式：" +
        manifest.mac.signing +
        "，最低 macOS " +
        manifest.mac.minimumSystemVersion +
        "；公证状态：" +
        (manifest.mac.notarized === false ? "未公证" : "未独立验证") +
        "。\n"
      : "") +
    "发布前由维护者核对最终安装验收与已知限制；此工作流只准备草稿，不证明干净机器或真实模型已通过。\n"
  );
}

export async function writeReleaseArtifacts(options = {}) {
  const manifest = await inspectReleaseArtifacts({ ...options, prepareSigningChecksum: true });
  const root = options.root ?? process.cwd();
  const generatedAt = new Date().toISOString();
  const notes = await renderReleaseNotes(root, manifest);
  const files = releaseFiles(manifest.version);
  const path = resolve(root, "release", files.manifest);
  const content = JSON.stringify({ ...manifest, generatedAt }, null, 2) + "\n";
  const signing = manifest.artifacts.find(({ name }) => name.endsWith(".signing.json"));
  if (signing)
    await writeFile(
      resolve(root, "release", signing.name + ".sha256"),
      signing.sha256 + "  " + signing.name + "\n"
    );
  await writeFile(path, content);
  await writeFile(
    path + ".sha256",
    createHash("sha256").update(content).digest("hex") + "  " + files.manifest + "\n"
  );
  await writeFile(resolve(root, "release", files.notes), notes);
  return { ...manifest, generatedAt, manifestPath: path, notesPath: resolve(root, "release", files.notes) };
}

/** Detect artifact replacement or a changed checkout before any remote mutation. */
export async function verifyReleaseArtifacts(options = {}) {
  const current = await inspectReleaseArtifacts(options);
  const root = options.root ?? process.cwd();
  const files = releaseFiles(current.version);
  const path = resolve(root, "release", files.manifest);
  const saved = JSON.parse(await readFile(path, "utf8"));
  const { generatedAt, ...record } = saved;
  if (
    typeof generatedAt !== "string" ||
    !Number.isFinite(Date.parse(generatedAt)) ||
    JSON.stringify(record) !== JSON.stringify(current)
  )
    throw new Error(
      "Release manifest differs from the source or artifacts; regenerate and review the candidate"
    );
  await checkChecksum(resolve(root, "release"), await fingerprint(resolve(root, "release"), files.manifest));
  await regularFile(resolve(root, "release", files.notes));
  return {
    ...current,
    files: [...current.artifacts.map(({ name }) => name), files.manifest, files.manifest + ".sha256"]
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await writeReleaseArtifacts({
      repository: process.env.GITHUB_REPOSITORY,
      requireSigningReport: true
    });
    console.log("Release manifest: " + result.manifestPath + "\nReview draft notes: " + result.notesPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
