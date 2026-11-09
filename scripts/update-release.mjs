import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, basename, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const PUBLIC_RELEASE_REPOSITORY = "ignorejjj/Atria-Releases";
export const PUBLIC_UPDATE_FEED_URL =
  "https://raw.githubusercontent.com/ignorejjj/Atria-Releases/main/updates/coworkos-latest.json";
export const MAX_PUBLIC_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const maximumFeedBytes = 32 * 1024;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;

export function parseUpdateVersion(value) {
  const match = typeof value === "string" && versionPattern.exec(value);
  if (!match || value.length > 128) throw new Error("更新版本格式无效");
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") ?? [] };
}

export function compareUpdateVersions(left, right) {
  const a = parseUpdateVersion(left),
    b = parseUpdateVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index],
      y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function updateRepository(value) {
  const raw = typeof value === "object" && value ? value.url : value;
  const repository = String(raw ?? "")
    .replace(/^git\+/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))
    throw new Error("未配置有效的 GitHub 更新仓库；请设置 ATRIA_UPDATE_REPOSITORY=owner/repo");
  return repository;
}

export function releaseAssetUrl(repository, tag, name) {
  return `https://github.com/${updateRepository(repository)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function trustedAsset(asset, repository, tag, name) {
  if (!asset || asset.name !== name) return undefined;
  const expected = releaseAssetUrl(repository, tag, name);
  if (asset.browser_download_url !== expected) return undefined;
  return {
    name,
    url: expected,
    size: asset.size,
    ...(Number.isSafeInteger(asset.id) && asset.id > 0
      ? { apiUrl: `https://api.github.com/repos/${repository}/releases/assets/${asset.id}` }
      : {})
  };
}

async function request(url, { fetchImpl = fetch, token, signal, asset = false } = {}) {
  const headers = { Accept: asset ? "application/octet-stream" : "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, { headers, signal: signal ?? AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("无法连接更新服务，请检查网络后重试");
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error("更新仓库或附件尚未发布，或当前账户无权访问");
    if ([401, 403].includes(response.status)) throw new Error("更新服务访问受限，请检查访问权限或稍后重试");
    throw new Error(`更新服务请求失败（HTTP ${response.status}）`);
  }
  return response;
}

async function boundedText(response, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error("更新信息超过允许的大小");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function publicReleaseArtifactNames(version, { legacy = false } = {}) {
  parseUpdateVersion(version);
  const brand = legacy ? "Atria" : "CoworkOS";
  const cli = legacy ? "atria-cowork-cli" : "coworkos-cli";
  const names = [
    `${brand}-${version}-mac-arm64.dmg`,
    `${cli}-${version}.tgz`,
    `${brand}-${version}-mac-arm64.signing.json`,
    `atria-release-${version}.json`
  ];
  return names.flatMap((name) => [name, `${name}.sha256`]);
}

function boundedRecord(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("公开更新信息格式无效");
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key)))
    throw new Error("公开更新信息包含无效字段");
}

function publicArtifact(artifact, repository, version, names) {
  boundedRecord(artifact, ["name", "size", "sha256", "url"]);
  if (
    typeof artifact.name !== "string" ||
    !names.includes(artifact.name) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    artifact.size > MAX_PUBLIC_ARTIFACT_BYTES ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    artifact.url !== releaseAssetUrl(repository, `v${version}`, artifact.name)
  )
    throw new Error("公开更新附件名称、地址、大小或校验值无效");
  return { name: artifact.name, size: artifact.size, sha256: artifact.sha256, url: artifact.url };
}

/** One maintainer-selected version, with no channel or anonymous API dependency. */
export function validatePublicReleaseFeed(value, { repository = PUBLIC_RELEASE_REPOSITORY } = {}) {
  repository = updateRepository(repository);
  boundedRecord(
    value,
    ["schemaVersion", "repository", "version", "publishedAt", "releaseUrl", "artifacts", "feedUrl"],
    ["schemaVersion", "repository", "version", "publishedAt", "releaseUrl", "artifacts"]
  );
  parseUpdateVersion(value.version);
  if (
    value.schemaVersion !== 1 ||
    value.repository !== repository ||
    typeof value.publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.publishedAt) ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    new Date(value.publishedAt).toISOString() !== value.publishedAt ||
    value.releaseUrl !==
      `https://github.com/${repository}/releases/tag/${encodeURIComponent(`v${value.version}`)}` ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 4 ||
    value.artifacts.length > 11 ||
    Buffer.byteLength(JSON.stringify(value)) > maximumFeedBytes
  )
    throw new Error("公开更新信息的仓库、版本、日期或附件无效");
  const legacy = value.artifacts.some(
    (artifact) => artifact?.name === `atria-cowork-cli-${value.version}.tgz`
  );
  const names = publicReleaseArtifactNames(value.version, { legacy });
  const zip = `${legacy ? "Atria" : "CoworkOS"}-${value.version}-mac-arm64.zip`;
  const feed = "atria-update-mac-arm64.json";
  if (value.feedUrl !== undefined) {
    if (value.feedUrl !== releaseAssetUrl(repository, `v${value.version}`, feed))
      throw new Error("公开签名更新地址无效");
    names.push(zip, `${zip}.sha256`, feed);
  }
  const artifacts = value.artifacts.map((artifact) =>
    publicArtifact(artifact, repository, value.version, names)
  );
  if (new Set(artifacts.map(({ name }) => name)).size !== artifacts.length)
    throw new Error("公开更新附件重复");
  const required = names.slice(0, 4);
  if (value.feedUrl !== undefined) required.push(zip, `${zip}.sha256`, feed);
  if (required.some((name) => !artifacts.some((artifact) => artifact.name === name)))
    throw new Error("公开更新缺少安装包或校验附件");
  return { ...value, artifacts };
}

export async function checkRelease(options = {}) {
  if (options.legacy === true || options.channel !== undefined) return checkLegacyRelease(options);
  const { root, kind = "cli", arch = process.arch, fetchImpl = fetch, signal } = options;
  if (!["cli", "mac"].includes(kind) || (kind === "mac" && arch !== "arm64"))
    throw new Error("当前更新渠道不支持此平台");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  parseUpdateVersion(pkg.version);
  const repository = updateRepository(options.repository ?? PUBLIC_RELEASE_REPOSITORY);
  const url =
    repository === PUBLIC_RELEASE_REPOSITORY
      ? PUBLIC_UPDATE_FEED_URL
      : `https://raw.githubusercontent.com/${repository}/main/updates/coworkos-latest.json`;
  const response = await request(url, { fetchImpl, signal, token: null });
  let feed;
  try {
    feed = validatePublicReleaseFeed(JSON.parse(await boundedText(response, maximumFeedBytes)), {
      repository
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("更新服务返回了无效的版本信息");
    throw error;
  }
  const legacy = feed.artifacts.some((artifact) => artifact.name === `atria-cowork-cli-${feed.version}.tgz`);
  const name =
    kind === "cli"
      ? `${legacy ? "atria-cowork-cli" : "coworkos-cli"}-${feed.version}.tgz`
      : `${legacy ? "Atria" : "CoworkOS"}-${feed.version}-mac-arm64.dmg`;
  return {
    mode: "release",
    source: "public-feed",
    repository,
    currentVersion: pkg.version,
    version: feed.version,
    available: compareUpdateVersions(feed.version, pkg.version) > 0,
    publishedAt: feed.publishedAt,
    releaseUrl: feed.releaseUrl,
    asset: feed.artifacts.find((artifact) => artifact.name === name),
    checksum: feed.artifacts.find((artifact) => artifact.name === `${name}.sha256`),
    ...(kind === "mac" && feed.feedUrl ? { feedUrl: feed.feedUrl } : {})
  };
}

export async function checkLegacyRelease({
  root,
  repository,
  channel,
  kind = "cli",
  arch = process.arch,
  fetchImpl = fetch,
  token = process.env.ATRIA_UPDATE_TOKEN,
  signal
} = {}) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const currentVersion = pkg.version;
  const parsed = parseUpdateVersion(currentVersion);
  channel ??= process.env.ATRIA_UPDATE_CHANNEL || (parsed.prerelease.length ? "preview" : "stable");
  if (!["stable", "preview"].includes(channel)) throw new Error("更新通道只能是 stable 或 preview");
  if (!["cli", "mac"].includes(kind) || (kind === "mac" && arch !== "arm64"))
    throw new Error("当前更新渠道不支持此平台");
  repository = updateRepository(repository ?? process.env.ATRIA_UPDATE_REPOSITORY ?? pkg.repository);
  const response = await request(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
    fetchImpl,
    token,
    signal
  });
  let releases;
  try {
    releases = JSON.parse(await boundedText(response, 2 * 1024 * 1024));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("更新服务返回了无效的版本信息");
    throw error;
  }
  if (!Array.isArray(releases)) throw new Error("更新服务返回了无效的版本列表");
  const candidates = [];
  for (const release of releases) {
    if (release.draft || typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) continue;
    const version = release.tag_name.slice(1);
    let candidate;
    try {
      candidate = parseUpdateVersion(version);
      // eslint-disable-next-line no-restricted-syntax -- GitHub release 的 tag 未必是版本号，解析失败就跳过这一条
    } catch {
      continue;
    }
    if (channel === "stable" && (release.prerelease || candidate.prerelease.length)) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const names =
      kind === "cli"
        ? [`coworkos-cli-${version}.tgz`, `atria-cowork-cli-${version}.tgz`]
        : [`CoworkOS-${version}-mac-${arch}.dmg`, `Atria-${version}-mac-${arch}.dmg`];
    const name = names.find((name) =>
      assets.some(
        (asset) => asset.name === name && assets.some((checksum) => checksum.name === `${name}.sha256`)
      )
    );
    const asset = trustedAsset(
      assets.find((a) => a.name === name),
      repository,
      release.tag_name,
      name
    );
    const checksum = trustedAsset(
      assets.find((a) => a.name === `${name}.sha256`),
      repository,
      release.tag_name,
      `${name}.sha256`
    );
    if (!asset || !checksum) continue;
    const feedName = `atria-update-mac-${arch}.json`;
    const feed =
      kind === "mac" &&
      trustedAsset(
        assets.find((a) => a.name === feedName),
        repository,
        release.tag_name,
        feedName
      );
    candidates.push({
      version,
      asset,
      checksum,
      ...(feed ? { feedUrl: feed.url } : {}),
      releaseUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`
    });
  }
  candidates.sort((a, b) => compareUpdateVersions(b.version, a.version));
  const latest = candidates[0];
  return {
    mode: "release",
    channel,
    repository,
    currentVersion,
    available: Boolean(latest && compareUpdateVersions(latest.version, currentVersion) > 0),
    ...(latest ?? { version: currentVersion }),
    message: latest ? undefined : "尚无适用于此安装方式的已发布更新"
  };
}

export async function downloadRelease({
  check,
  directory,
  onProgress = () => {},
  fetchImpl = fetch,
  token = process.env.ATRIA_UPDATE_TOKEN,
  signal
} = {}) {
  if (!check?.available || !check.asset || !check.checksum) throw new Error("请先检查可用更新");
  const publicFeed = check.source === "public-feed";
  if (publicFeed) {
    const names = publicReleaseArtifactNames(check.version, {
      legacy: check.asset.name.startsWith("Atria-") || check.asset.name.startsWith("atria-cowork-cli-")
    });
    publicArtifact(check.asset, check.repository, check.version, names);
    publicArtifact(check.checksum, check.repository, check.version, names);
    token = undefined;
  }
  const expected = releaseAssetUrl(check.repository, `v${check.version}`, check.asset.name);
  if (
    check.asset.url !== expected ||
    check.checksum.url !== `${expected}.sha256` ||
    (publicFeed && check.checksum.name !== `${check.asset.name}.sha256`) ||
    basename(check.asset.name) !== check.asset.name
  )
    throw new Error("更新附件地址无效");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fetchAsset = (asset) => {
    if (
      asset.apiUrl &&
      !new RegExp(
        `^https://api\\.github\\.com/repos/${check.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/releases/assets/[1-9]\\d*$`
      ).test(asset.apiUrl)
    )
      throw new Error("更新附件 API 地址无效");
    return request(token && asset.apiUrl ? asset.apiUrl : asset.url, {
      fetchImpl,
      token,
      signal: signal ?? AbortSignal.timeout(30 * 60_000),
      asset: true
    });
  };
  const checksumBytes = await boundedText(await fetchAsset(check.checksum), 4096);
  if (
    publicFeed &&
    (Buffer.byteLength(checksumBytes) !== check.checksum.size ||
      createHash("sha256").update(checksumBytes).digest("hex") !== check.checksum.sha256)
  )
    throw new Error("更新校验文件校验失败");
  const checksum = checksumBytes.trim();
  const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(checksum);
  if (
    !match ||
    match[2] !== check.asset.name ||
    (publicFeed && match[1].toLowerCase() !== check.asset.sha256)
  )
    throw new Error("更新校验文件无效或与安装包不匹配");
  const path = join(directory, check.asset.name);
  const partial = `${path}.partial-${randomUUID()}`;
  const digest = createHash("sha256");
  let handle,
    downloaded = 0;
  const maxBytes = 2 * 1024 * 1024 * 1024;
  try {
    const response = await fetchAsset(check.asset);
    const total = Number(response.headers.get("content-length")) || check.asset.size || undefined;
    if (total > maxBytes) throw new Error("更新安装包超过允许的大小");
    handle = await open(partial, "wx", 0o600);
    onProgress({ phase: "downloading", message: "正在下载更新", downloaded, total });
    for await (const chunk of response.body ?? []) {
      downloaded += chunk.length;
      if (downloaded > maxBytes) throw new Error("更新安装包超过允许的大小");
      digest.update(chunk);
      await handle.writeFile(chunk);
      onProgress({ phase: "downloading", message: "正在下载更新", downloaded, total });
    }
    if (
      !downloaded ||
      (publicFeed && downloaded !== check.asset.size) ||
      digest.digest("hex") !== match[1].toLowerCase()
    )
      throw new Error("更新安装包校验失败，未安装更新；请重新下载");
    await handle.close();
    handle = undefined;
    await rename(partial, path);
    onProgress({ phase: "downloaded", message: "下载与校验完成", downloaded, total });
    return path;
  } finally {
    await handle?.close();
    await rm(partial, { force: true });
  }
}

export function cliInstallPrefix(root, platform = process.platform) {
  root = resolve(root);
  if (
    !["coworkos-cli", "atria-cowork-cli"].includes(basename(root)) ||
    basename(dirname(root)) !== "node_modules"
  )
    throw new Error("此 CLI 不是独立全局安装；请使用原来的包管理方式升级");
  if (platform === "win32") return dirname(dirname(root));
  if (basename(dirname(dirname(root))) !== "lib")
    throw new Error("此 CLI 不是独立全局安装；请使用原来的包管理方式升级");
  return dirname(dirname(dirname(root)));
}

export async function installCliRelease({
  root,
  repository,
  channel,
  legacy = false,
  onProgress = () => {},
  fetchImpl = fetch,
  commandRunner = exec
} = {}) {
  root = resolve(root);
  const prefix = cliInstallPrefix(root);
  await access(dirname(root), constants.W_OK);
  const check = await checkRelease({ root, repository, channel, legacy, fetchImpl });
  if (!check.available) return { ...check, updated: false };
  const lock = join(dirname(root), ".atria-cli-update.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("另一个 CLI 更新正在进行，请等待完成后重试");
    throw error;
  }
  let directory,
    preserveDirectory = false;
  try {
    directory = await mkdtemp(join(dirname(root), ".atria-cli-update-"));
    const archive = await downloadRelease({ check, directory, onProgress, fetchImpl });
    const result = await commandRunner("tar", ["-xOf", archive, "package/package.json"], {
      encoding: "utf8"
    });
    const manifest = JSON.parse(result.stdout);
    if (
      !["coworkos-cli", "atria-cowork-cli"].includes(manifest.name) ||
      manifest.version !== check.version ||
      manifest.bin?.atria !== "scripts/atria.mjs" ||
      (manifest.name === "coworkos-cli" && manifest.bin?.coworkos !== "scripts/atria.mjs")
    )
      throw new Error("更新安装包的名称、版本或命令不匹配");
    onProgress({ phase: "installing", message: "正在安装 CLI 更新" });
    // The installed program determines its prefix; the caller's current project is never rewritten.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|COWORK_|PI_|ATRIA_|GIT_)/.test(key)
      )
    );
    const stagingPrefix = join(directory, "prefix");
    try {
      await commandRunner(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["install", "--global", "--prefix", stagingPrefix, archive],
        { cwd: directory, env, maxBuffer: 4 * 1024 * 1024 }
      );
    } catch {
      throw new Error("CLI 更新安装失败；配置和任务数据未修改，请使用原安装方式重试");
    }
    const candidate = join(
      stagingPrefix,
      process.platform === "win32" ? "" : "lib",
      "node_modules",
      manifest.name
    );
    const installed = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
    if (installed.name !== manifest.name || installed.version !== manifest.version)
      throw new Error("候选 CLI 安装验证失败，保留当前版本");
    const probe = await commandRunner(process.execPath, [join(candidate, "scripts/atria.mjs"), "--version"], {
      cwd: directory,
      env,
      maxBuffer: 1024 * 1024
    });
    if (
      ![
        `CoworkOS ${check.version}`,
        ...(manifest.name === "atria-cowork-cli" ? [`Atria ${check.version}`] : [])
      ].includes(probe.stdout.trim())
    )
      throw new Error("候选 CLI 无法启动，保留当前版本");
    // npm stages new command shims outside the active prefix. Publish the new
    // command alongside the retained alias when upgrading an older installation.
    const aliases = [];
    const publishAlias = async (name, content) => {
      const target = join(prefix, process.platform === "win32" ? name : `bin/${name}`);
      try {
        if (process.platform === "win32") await writeFile(target, content, { flag: "wx" });
        else await symlink(relative(dirname(target), join(root, "scripts/atria.mjs")), target);
        aliases.push(target);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    };
    const previous = join(directory, "previous");
    await rename(root, previous);
    try {
      await rename(candidate, root);
      if (manifest.bin?.coworkos === "scripts/atria.mjs") {
        if (process.platform === "win32") {
          for (const suffix of ["", ".cmd", ".ps1"]) {
            const shim = await readFile(join(stagingPrefix, `coworkos${suffix}`), "utf8");
            await publishAlias(
              `coworkos${suffix}`,
              shim
                .replaceAll("node_modules/coworkos-cli", `node_modules/${basename(root)}`)
                .replaceAll("node_modules\\coworkos-cli", `node_modules\\${basename(root)}`)
            );
          }
        } else await publishAlias("coworkos");
      }
    } catch (error) {
      for (const alias of aliases) await rm(alias, { force: true });
      // A failed shim publication must roll back the whole program switch.
      if (
        await access(root).then(
          () => true,
          () => false
        )
      )
        await rename(root, candidate);
      try {
        await rename(previous, root);
      } catch {
        preserveDirectory = true;
        throw new Error(`更新切换失败，旧程序保留在 ${previous}`);
      }
      throw error;
    }
    onProgress({ phase: "updated", message: `CLI 已更新到 ${check.version}`, prefix });
    return { ...check, updated: true };
  } finally {
    if (directory && !preserveDirectory) await rm(directory, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
