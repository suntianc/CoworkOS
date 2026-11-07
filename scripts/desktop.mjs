import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { checkNpmDesktopRelease, downloadNpmDesktopRelease } from "./update-npm-desktop.mjs";

const execute = promisify(execFile);
const { verifyApplication } = createRequire(import.meta.url)("../desktop/update-install.cjs");
const expectedId = "org.atria.cowork";
const sameIdentity = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const controlCharacters = (value) =>
  Array.from(value).some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);

export function desktopHelp() {
  return `Usage: coworkos desktop install [--directory PATH]

Download, verify and install the published Mac App without administrator access.
  --directory PATH  Applications directory (default: ~/Applications)
  -h, --help        Show help without downloading or changing files

Requires macOS 14 or newer on Apple Silicon. Existing Apps are not overwritten;
update an installed App from Settings. Installation preserves macOS security checks.`;
}

export function parseDesktopOptions(args) {
  if (!args.length || ["--help", "-h"].includes(args[0])) {
    if (args.length > 1) throw new Error("Use coworkos desktop install --help");
    return { help: true };
  }
  if (args[0] !== "install") throw new Error("Use coworkos desktop install [--directory PATH]");
  const options = { help: false };
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (["--help", "-h"].includes(argument)) options.help = true;
    else if (argument === "--directory") {
      if (options.directory !== undefined) throw new Error("--directory may only be specified once");
      const value = args[++index];
      if (!value || !isAbsolute(value) || controlCharacters(value))
        throw new Error("--directory requires an absolute directory path");
      options.directory = resolve(value);
    } else throw new Error(`Unknown desktop install option: ${argument}`);
  }
  return options;
}

async function assertAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `CoworkOS is already installed at ${target}. Back up your data and upgrade with a local installer; no files were replaced.`
  );
}

async function actualDirectory(path) {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error("The installation directory changed or contains a symbolic link");
  return value;
}

/** The downloaded App is independent of the npm package and never owns user data. */
export async function installDesktop({
  root = fileURLToPath(new URL("..", import.meta.url)),
  directory = join(homedir(), "Applications"),
  platform = process.platform,
  arch = process.arch,
  systemRelease = release(),
  fetchImpl = fetch,
  runner = execute,
  check = checkNpmDesktopRelease,
  download = downloadNpmDesktopRelease,
  signal,
  onProgress = () => {}
} = {}) {
  if (platform !== "darwin" || arch !== "arm64")
    throw new Error("The desktop installer currently supports Apple Silicon Macs only");
  if (!/^\d+\./.test(systemRelease) || Number(systemRelease.split(".")[0]) < 23)
    throw new Error("The desktop App requires macOS 14 or newer");
  if (!isAbsolute(directory) || controlCharacters(directory))
    throw new Error("The installation directory must be an absolute path");
  signal?.throwIfAborted();
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  // Canonicalize normal parent aliases, but do not follow a replacement of the directory itself.
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("The installation directory must not be a symbolic link");
  directory = await realpath(directory);
  const parentIdentity = await actualDirectory(directory);
  await access(directory, constants.W_OK | constants.X_OK);
  const target = join(directory, "CoworkOS.app");
  await assertAbsent(target);
  const lock = join(directory, ".coworkos-desktop-install.lock");
  let lockIdentity;
  try {
    await mkdir(lock, { mode: 0o700 });
    lockIdentity = await actualDirectory(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Another desktop installation is active in this directory; retry after it finishes");
    throw error;
  }
  let stage,
    stageIdentity,
    reservation,
    mount,
    mounted = false,
    preserveStage = false;
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { flag: "wx" });
    signal?.throwIfAborted();
    await assertAbsent(target);
    onProgress("Checking the published Mac App…");
    const checked = await check({ root, kind: "mac", arch, fetchImpl, signal });
    const npmRelease = checked.source === "npm-registry";
    if (
      !checked.asset ||
      !checked.asset.name.startsWith("CoworkOS-") ||
      (npmRelease ? checked.manifest?.artifact?.name !== checked.asset.name : !checked.checksum)
    )
      throw new Error("A CoworkOS desktop release has not been published yet");
    signal?.throwIfAborted();
    stage = await mkdtemp(join(directory, ".coworkos-install-"));
    stageIdentity = await actualDirectory(stage);
    const archive = await download({
      // A first installation also needs the release when its version equals the CLI version.
      check: { ...checked, available: true },
      directory: join(stage, "downloads"),
      fetchImpl,
      signal,
      onProgress: (value) => {
        if (value.phase === "downloaded") onProgress("Download and SHA-256 verification complete.");
      }
    });
    signal?.throwIfAborted();
    mount = join(stage, "volume");
    await mkdir(mount, { mode: 0o700 });
    try {
      await runner("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive], {
        signal,
        timeout: 120_000,
        maxBuffer: 1024 * 1024
      });
      mounted = true;
    } catch (error) {
      // An interrupted attach can mount the image before its process exits. A failed
      // attach that never mounted must not become a permanent 'unable to detach' lock.
      const current = await lstat(mount).catch(() => undefined);
      mounted = Boolean(current && current.dev !== stageIdentity.dev);
      throw error;
    }
    const apps = (await readdir(mount, { withFileTypes: true })).filter((entry) =>
      entry.name.endsWith(".app")
    );
    if (apps.length !== 1 || apps[0].name !== "CoworkOS.app" || !apps[0].isDirectory())
      throw new Error("The installation image must contain exactly one CoworkOS.app");
    const source = join(mount, apps[0].name);
    const verification = { expectedId, version: checked.version, arch, runner, signal };
    await verifyApplication(source, verification);
    const candidate = join(stage, "CoworkOS.app");
    onProgress("Installing the verified Mac App…");
    // ditto retains framework symlinks, signed resources and quarantine attributes.
    await runner("/usr/bin/ditto", [source, candidate], {
      signal,
      timeout: 180_000,
      maxBuffer: 1024 * 1024
    });
    await verifyApplication(candidate, verification);
    await detach();
    signal?.throwIfAborted();
    if (!sameIdentity(parentIdentity, await actualDirectory(directory)))
      throw new Error("The installation directory changed; no App was installed");
    if (!sameIdentity(stageIdentity, await actualDirectory(stage)))
      throw new Error("The staged installation changed; no App was installed");
    await assertAbsent(target);
    // Claim an empty target exclusively. The final rename replaces only our reservation,
    // so a concurrent installer cannot have an existing empty directory overwritten.
    await mkdir(target, { mode: 0o700 });
    reservation = await actualDirectory(target);
    signal?.throwIfAborted();
    if (!sameIdentity(reservation, await actualDirectory(target)))
      throw new Error("The installation target changed; no App was installed");
    await rename(candidate, target);
    reservation = undefined;
    onProgress(`CoworkOS ${checked.version} installed at ${target}`);
    onProgress("Open CoworkOS from Applications. Future App updates are available in Settings.");
    return { target, version: checked.version };
  } finally {
    try {
      if (mounted) await detach();
    } finally {
      if (reservation && sameIdentity(reservation, await lstat(target).catch(() => undefined)))
        await rmdir(target).catch(() => {});
      if (!preserveStage) {
        if (stage && sameIdentity(stageIdentity, await lstat(stage).catch(() => undefined)))
          await rm(stage, { recursive: true, force: true });
        if (sameIdentity(lockIdentity, await lstat(lock).catch(() => undefined)))
          await rm(lock, { recursive: true, force: true });
      }
    }
  }

  async function detach() {
    try {
      // Cancellation must not prevent unmounting a read-only installation image.
      await runner("/usr/bin/hdiutil", ["detach", mount], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024
      });
      mounted = false;
    } catch (error) {
      preserveStage = true;
      mounted = false;
      throw new Error(`Unable to unmount the installation image. Temporary files retained at ${stage}`, {
        cause: error
      });
    }
  }
}

export async function runDesktop({ args = [], onProgress = console.log, ...options } = {}) {
  const parsed = parseDesktopOptions(args);
  if (parsed.help) return onProgress(desktopHelp());
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Desktop installation cancelled"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    return await installDesktop({ ...options, ...parsed, signal: controller.signal, onProgress });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runDesktop({ args: process.argv.slice(2) });
  } catch (error) {
    console.error(`CoworkOS: ${error.message}`);
    process.exitCode = 1;
  }
}
