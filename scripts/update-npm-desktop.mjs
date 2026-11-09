import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { compareUpdateVersions, parseUpdateVersion } from "./update-release.mjs";

const exec = promisify(execFile);
export const NPM_DESKTOP_PACKAGE = "coworkos-desktop-darwin-arm64";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const MAX_NPM_METADATA_BYTES = 256 * 1024;
export const MAX_NPM_TARBALL_BYTES = 1024 * 1024 * 1024;
const maximumDmgBytes = 2 * 1024 * 1024 * 1024 - 1;
const archiveEntriesLimit = 16 * 1024;

function desktopChannel(version) {
  return parseUpdateVersion(version).prerelease.length ? "beta" : "latest";
}

function packageTarballUrl(version) {
  return `${NPM_REGISTRY}/${NPM_DESKTOP_PACKAGE}/-/${NPM_DESKTOP_PACKAGE}-${encodeURIComponent(version)}.tgz`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRelease(value, version) {
  const artifact = value?.artifact;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "appVersion", "platform", "arch", "artifact"].includes(key)
    ) ||
    value.schemaVersion !== 1 ||
    value.appVersion !== version ||
    value.platform !== "darwin" ||
    value.arch !== "arm64" ||
    !artifact ||
    typeof artifact !== "object" ||
    Array.isArray(artifact) ||
    Object.keys(artifact).some((key) => !["name", "size", "sha256"].includes(key)) ||
    artifact.name !== `CoworkOS-${version}-mac-arm64.dmg` ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    artifact.size > maximumDmgBytes ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    throw new Error("npm 桌面发行信息与版本或平台不匹配");
  return { ...value, artifact: { ...artifact } };
}

function sameDesktopRelease(left, right) {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.appVersion === right.appVersion &&
    left.platform === right.platform &&
    left.arch === right.arch &&
    left.artifact.name === right.artifact.name &&
    left.artifact.size === right.artifact.size &&
    left.artifact.sha256 === right.artifact.sha256
  );
}

function parseIntegrity(value) {
  if (typeof value !== "string") throw new Error("npm 桌面包缺少完整性校验值");
  const entries = value
    .trim()
    .split(/\s+/)
    .map((entry) => /^(sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(entry));
  const valid = entries.filter(Boolean).at(-1);
  if (!valid) throw new Error("npm 桌面包的完整性校验值格式无效");
  const digest = Buffer.from(valid[2], "base64");
  if (digest.length !== 64 || digest.toString("base64") !== valid[2])
    throw new Error("npm 桌面包的完整性校验值格式无效");
  return { algorithm: valid[1], digest };
}

function trustedTarballUrl(value, version) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("npm 桌面包下载地址无效");
  }
  const expected = new URL(packageTarballUrl(version));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== expected.pathname
  )
    throw new Error("npm 桌面包下载地址无效");
  return url.href;
}

async function readBounded(response, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error("npm 桌面发行信息超过允许大小");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function request(url, { fetchImpl, signal, limit, accept = "application/json" }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept },
      signal: signal ?? AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error("无法连接 npm 更新服务，请检查网络后重试");
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error("npm 尚未发布适用于此版本通道的桌面包");
    throw new Error(`npm 更新服务请求失败（HTTP ${response.status}）`);
  }
  if (response.url) {
    const final = new URL(response.url);
    if (final.protocol !== "https:" || final.hostname !== "registry.npmjs.org" || final.port)
      throw new Error("npm 更新服务重定向到了非官方 registry");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("npm 更新内容超过允许大小");
  return response;
}

/** Resolve the Mac version independently from the CLI's npm dist-tag. */
export async function checkNpmDesktopRelease({
  root,
  kind = "mac",
  arch = process.arch,
  fetchImpl = fetch,
  signal
} = {}) {
  if (kind !== "mac" || arch !== "arm64") throw new Error("当前更新渠道不支持此平台");
  const app = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  parseUpdateVersion(app.version);
  const tag = desktopChannel(app.version);
  const metadataUrl = `${NPM_REGISTRY}/${NPM_DESKTOP_PACKAGE}/${tag}`;
  const response = await request(metadataUrl, { fetchImpl, signal, limit: MAX_NPM_METADATA_BYTES });
  let metadata;
  try {
    metadata = JSON.parse(await readBounded(response, MAX_NPM_METADATA_BYTES));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("npm 返回了无效的桌面版本信息");
    throw error;
  }
  const version = metadata?.version;
  parseUpdateVersion(version);
  const manifest = boundedRelease(metadata.desktopRelease, version);
  if (
    metadata.name !== NPM_DESKTOP_PACKAGE ||
    !Array.isArray(metadata.os) ||
    !metadata.os.includes("darwin") ||
    !Array.isArray(metadata.cpu) ||
    !metadata.cpu.includes("arm64") ||
    desktopChannel(version) !== tag
  )
    throw new Error("npm 返回的桌面包名、版本通道或平台不匹配");
  const url = trustedTarballUrl(metadata.dist?.tarball, version);
  const integrity = parseIntegrity(metadata.dist?.integrity);
  const unpackedSize = metadata.dist?.unpackedSize;
  if (
    !Number.isSafeInteger(unpackedSize) ||
    unpackedSize < manifest.artifact.size ||
    unpackedSize > manifest.artifact.size + 1024 * 1024
  )
    throw new Error("npm 桌面包大小信息无效");
  return {
    mode: "release",
    source: "npm-registry",
    package: NPM_DESKTOP_PACKAGE,
    tag,
    currentVersion: app.version,
    version,
    available: compareUpdateVersions(version, app.version) > 0,
    manifest,
    tarball: { url, integrity: `${integrity.algorithm}-${integrity.digest.toString("base64")}` },
    asset: manifest.artifact
  };
}

async function downloadTarball({ url, integrity, directory, fetchImpl, signal, onProgress }) {
  const response = await request(url, {
    fetchImpl,
    signal: signal ?? AbortSignal.timeout(30 * 60_000),
    limit: MAX_NPM_TARBALL_BYTES,
    accept: "application/octet-stream"
  });
  const expected = parseIntegrity(integrity);
  const path = join(directory, "desktop-package.tgz");
  const handle = await open(path, "wx", 0o600);
  const digest = createHash(expected.algorithm);
  let downloaded = 0;
  const total = Number(response.headers.get("content-length")) || undefined;
  try {
    for await (const chunk of response.body ?? []) {
      downloaded += chunk.length;
      if (!downloaded || downloaded > MAX_NPM_TARBALL_BYTES) throw new Error("npm 桌面包超过允许大小");
      digest.update(chunk);
      await handle.writeFile(chunk);
      onProgress({ phase: "downloading", message: "正在从 npm 下载 CoworkOS", downloaded, total });
    }
    if (!downloaded || !digest.digest().equals(expected.digest)) throw new Error("npm 桌面包完整性校验失败");
    await handle.close();
    onProgress({ phase: "downloaded", message: "npm 桌面包已校验", downloaded, total });
    return path;
  } catch (error) {
    // eslint-disable-next-line no-restricted-syntax -- 下载失败已在下一行重新抛出，关闭临时文件句柄失败不能覆盖原始原因
    await handle.close().catch(() => {});
    await rm(path, { force: true });
    throw error;
  }
}

async function listArchive({ archive, commandRunner = exec }) {
  let output;
  try {
    output = (
      await commandRunner("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: archiveEntriesLimit })
    ).stdout;
  } catch {
    throw new Error("npm 桌面包压缩格式无效");
  }
  if (Buffer.byteLength(output) > archiveEntriesLimit) throw new Error("npm 桌面包包含过多文件");
  const entries = output.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (
    entries.some(
      (entry) =>
        entry !== "package/" &&
        !/^package\/(?:package\.json|LICENSE|CoworkOS-[0-9A-Za-z.+-]+-mac-arm64\.dmg)$/.test(entry)
    )
  )
    throw new Error("npm 桌面包包含未允许的路径");
  if (new Set(entries).size !== entries.length) throw new Error("npm 桌面包包含重复文件");
  return entries;
}

async function readTarManifest(archive, commandRunner) {
  try {
    const result = await commandRunner("tar", ["-xOf", archive, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: MAX_NPM_METADATA_BYTES
    });
    if (Buffer.byteLength(result.stdout) > MAX_NPM_METADATA_BYTES) throw new Error("oversized");
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("npm 桌面包缺少有效的 package.json");
  }
}

async function extractDmg({ archive, name, path, expectedSize, expectedSha256, signal }) {
  const temporary = `${path}.partial-${randomUUID()}`;
  const child = spawn("tar", ["-xOf", archive, `package/${name}`], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  const digest = createHash("sha256");
  let bytes = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  const limiter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > expectedSize || bytes > maximumDmgBytes)
        return done(new Error("npm 桌面包中的 DMG 超过清单大小"));
      digest.update(chunk);
      done(null, chunk);
    }
  });
  try {
    const finished = pipeline(
      child.stdout,
      limiter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 })
    );
    try {
      await finished;
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    const [code] = await closed;
    if (signal?.aborted) signal.throwIfAborted();
    if (code !== 0) throw new Error(`npm 桌面包 DMG 提取失败${stderr.trim() ? `：${stderr.trim()}` : ""}`);
    if (bytes !== expectedSize || digest.digest("hex") !== expectedSha256)
      throw new Error("npm 桌面包中的 DMG 校验失败");
    await rename(temporary, path);
    return path;
  } finally {
    signal?.removeEventListener("abort", abort);
    await rm(temporary, { force: true });
  }
}

/** Verify npm's SRI tarball, inspect exact members, then stream only the expected DMG out. */
export async function downloadNpmDesktopRelease({
  check,
  directory,
  fetchImpl = fetch,
  commandRunner = exec,
  signal,
  onProgress = () => {}
} = {}) {
  if (!check?.available || check.source !== "npm-registry" || check.package !== NPM_DESKTOP_PACKAGE)
    throw new Error("请先检查可用的 npm 桌面更新");
  const expectedUrl = packageTarballUrl(check.version);
  if (
    trustedTarballUrl(check.tarball?.url, check.version) !== expectedUrl ||
    !["latest", "beta"].includes(check.tag) ||
    desktopChannel(check.version) !== check.tag ||
    check.manifest?.artifact?.name !== `CoworkOS-${check.version}-mac-arm64.dmg`
  )
    throw new Error("npm 桌面更新信息无效");
  parseIntegrity(check.tarball.integrity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(tmpdir(), "coworkos-npm-desktop-"));
  const dmg = join(directory, check.manifest.artifact.name);
  try {
    const archive = await downloadTarball({
      ...check.tarball,
      directory: temporary,
      fetchImpl,
      signal,
      onProgress
    });
    const entries = await listArchive({ archive, commandRunner });
    const expectedEntries = ["package/LICENSE", "package/package.json", `package/${dmg.split("/").at(-1)}`];
    const actualFiles = entries.filter((entry) => entry !== "package/");
    if (
      actualFiles.length !== expectedEntries.length ||
      expectedEntries.some((entry) => !actualFiles.includes(entry))
    )
      throw new Error("npm 桌面包文件清单不匹配");
    const manifest = await readTarManifest(archive, commandRunner);
    const packagedRelease = boundedRelease(manifest.desktopRelease, check.version);
    const checkedRelease = boundedRelease(check.manifest, check.version);
    if (
      manifest.name !== NPM_DESKTOP_PACKAGE ||
      manifest.version !== check.version ||
      manifest.os?.length !== 1 ||
      manifest.os[0] !== "darwin" ||
      manifest.cpu?.length !== 1 ||
      manifest.cpu[0] !== "arm64" ||
      !sameDesktopRelease(packagedRelease, checkedRelease)
    )
      throw new Error("npm 桌面包的内部清单与 registry 元数据不匹配");
    return await extractDmg({
      archive,
      name: check.manifest.artifact.name,
      path: dmg,
      expectedSize: check.manifest.artifact.size,
      expectedSha256: check.manifest.artifact.sha256,
      signal
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function npmDesktopManifest({ version, bytes, size, sha256: artifactSha256 }) {
  parseUpdateVersion(version);
  const artifactSize = Buffer.isBuffer(bytes) ? bytes.length : size;
  const digest = Buffer.isBuffer(bytes) ? sha256(bytes) : artifactSha256;
  if (
    (bytes !== undefined && !Buffer.isBuffer(bytes)) ||
    !Number.isSafeInteger(artifactSize) ||
    artifactSize <= 0 ||
    artifactSize > maximumDmgBytes ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error("Mac DMG 不存在或超过允许大小");
  return {
    schemaVersion: 1,
    appVersion: version,
    platform: "darwin",
    arch: "arm64",
    artifact: {
      name: `CoworkOS-${version}-mac-arm64.dmg`,
      size: artifactSize,
      sha256: digest
    }
  };
}
