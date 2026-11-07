import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchMacApplication } from "./mac-application-launch.mjs";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function developmentToolchain(input = {}) {
  const nodeExecutable =
    input.nodeExecutable || process.env.COWORK_DESKTOP_NODE_EXECUTABLE || process.execPath;
  const npmCli = input.npmCli || process.env.COWORK_DESKTOP_NPM_CLI || process.env.npm_execpath;
  return { nodeExecutable: resolve(nodeExecutable), ...(npmCli ? { npmCli: resolve(npmCli) } : {}) };
}

/** Brand a cached development runtime; app sources and private data stay in place. */
export async function developmentExecutable({ root = projectRoot, toolchain } = {}) {
  const tools = developmentToolchain(toolchain);
  const require = createRequire(join(root, "package.json"));
  const electron = require("electron");
  if (process.platform !== "darwin") return electron;
  const source = resolve(dirname(electron), "../..");
  const icon = join(root, "build/atria.icns");
  const entitlements = join(root, "desktop/entitlements.mac.plist");
  const hash = createHash("sha256")
    .update(root)
    .update(await readFile(join(root, "package.json")))
    .update(source)
    .update(process.arch)
    .update(await readFile(join(root, "node_modules/electron/package.json")))
    .update(await readFile(join(source, "Contents/Info.plist")))
    .update(await readFile(icon))
    .update(await readFile(entitlements))
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(JSON.stringify(tools))
    .digest("hex")
    .slice(0, 24);
  const cache = join(root, ".tmp/desktop-runtime");
  const destination = join(cache, hash);
  // Ad-hoc signatures bind grants to a code hash. Never reuse one TCC identity
  // for different immutable runtimes/worktrees, even when their names match.
  const identifier = `org.atria.cowork.dev.runtime.${hash}`;
  const displayName = `CoworkOS Dev (${hash.slice(0, 8)})`;
  const executable = join(destination, "CoworkOS Dev.app/Contents/MacOS/CoworkOS Dev");
  const complete = join(destination, "ready");
  if (
    await access(complete).then(
      () => true,
      () => false
    )
  ) {
    await access(executable);
    return executable;
  }
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, ".prepare-"));
  const bundle = join(staging, "CoworkOS Dev.app");
  try {
    // APFS clones share unchanged runtime blocks; no hard links or vendor mutation.
    try {
      await run("/bin/cp", ["-cR", source, bundle]);
    } catch {
      await rm(bundle, { recursive: true, force: true });
      await run("/bin/cp", ["-R", source, bundle]);
    }
    // Electron locates Helper executables using CFBundleName; vary only the
    // display label while keeping that name aligned with the executable paths.
    const brand = async (contents, oldName, name, identifier, usage = {}, label = name) => {
      const plist = join(contents, "Info.plist");
      for (const [key, value] of Object.entries({
        CFBundleDisplayName: label,
        CFBundleName: name,
        CFBundleExecutable: name,
        CFBundleIdentifier: identifier,
        ...usage
      })) {
        try {
          await run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
        } catch (error) {
          if (!error.stderr?.includes("Does Not Exist")) throw error;
          await run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
        }
      }
      await rename(join(contents, "MacOS", oldName), join(contents, "MacOS", name));
    };
    const contents = join(bundle, "Contents");
    const framework = join(contents, "Frameworks");
    for (const entry of await readdir(framework)) {
      if (!entry.startsWith("Electron Helper") || !entry.endsWith(".app")) continue;
      const oldName = entry.slice(0, -4);
      const name = oldName.replace("Electron", "CoworkOS Dev");
      const helper = join(framework, entry);
      const { stdout } = await run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleIdentifier",
        join(helper, "Contents/Info.plist")
      ]);
      await brand(
        join(helper, "Contents"),
        oldName,
        name,
        stdout.trim().replace("com.github.Electron", identifier)
      );
      await rename(helper, join(framework, `${name}.app`));
    }
    await brand(contents, "Electron", "CoworkOS Dev", identifier, {}, displayName);
    // Strip Electron's default microphone description before sealing this runtime.
    for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
      try {
        await run("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, join(contents, "Info.plist")]);
      } catch (error) {
        if (!error.stderr?.includes("Does Not Exist")) throw error;
      }
    }
    await copyFile(icon, join(contents, "Resources/atria.icns"));
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Set :CFBundleIconFile atria.icns",
      join(contents, "Info.plist")
    ]);
    const app = join(contents, "Resources/app");
    await mkdir(app, { recursive: true });
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "atria-dev", version, main: "bootstrap.cjs" })
    );
    await writeFile(
      join(app, "bootstrap.cjs"),
      [
        'process.env.COWORK_DESKTOP_DEV = "1";',
        `process.env.COWORK_DESKTOP_SOURCE_ROOT = ${JSON.stringify(root)};`,
        `process.env.COWORK_DESKTOP_NODE_EXECUTABLE = ${JSON.stringify(tools.nodeExecutable)};`,
        tools.npmCli
          ? `process.env.COWORK_DESKTOP_NPM_CLI = ${JSON.stringify(tools.npmCli)};`
          : "delete process.env.COWORK_DESKTOP_NPM_CLI;",
        `process.chdir(${JSON.stringify(root)});`,
        `require(${JSON.stringify(join(root, "desktop/main.cjs"))});`,
        ""
      ].join("\n")
    );
    // Seal installation metadata once. Publishing a Finder copy must not
    // re-sign it and turn it into a second code identity under the same ID.
    await writeFile(
      join(contents, "Resources/development-runtime.json"),
      JSON.stringify({ root, runtime: join(destination, "CoworkOS Dev.app"), ...tools })
    );
    await run("/usr/bin/codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--preserve-metadata=entitlements",
      bundle
    ]);
    // Keep nested Electron signatures/entitlements, then sign only our parent
    // identity with the release entitlements.
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements", entitlements, bundle]);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    await writeFile(join(staging, "ready"), `${hash}\n`);
    try {
      await rename(staging, destination);
    } catch (error) {
      // Another launch may have published the same complete, immutable runtime.
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      await access(complete);
    }
    return executable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Publish one Finder entry; its bootstrap reads the source checkout rather than copying the app. */
export async function installDevelopmentApp({
  root = projectRoot,
  directory = join(homedir(), "Applications"),
  toolchain
} = {}) {
  if (process.platform !== "darwin") throw new Error("The development app installer requires macOS");
  const tools = developmentToolchain(toolchain);
  const cached = await developmentExecutable({ root, toolchain: tools });
  const source = resolve(cached, "../../..");
  const destination = join(directory, "CoworkOS Dev.app");
  const executable = join(destination, "Contents/MacOS/CoworkOS Dev");
  const marker = join(destination, "Contents/Resources/development-runtime.json");
  const metadata = JSON.stringify({ root, runtime: source, ...tools });
  if ((await readFile(marker, "utf8").catch(() => "")) === metadata) return executable;
  if (
    await access(destination).then(
      () => true,
      () => false
    )
  ) {
    const { stdout } = await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      join(destination, "Contents/Info.plist")
    ]);
    if (!/^org\.atria\.cowork\.dev(?:\.runtime\.[a-f0-9]{24})?$/.test(stdout.trim()))
      throw new Error("CoworkOS Dev.app 已被其他应用占用");
    const pattern = "^" + executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "( |$)";
    try {
      await run("/usr/bin/pgrep", ["-f", pattern]);
      throw new Error("请先退出 CoworkOS Dev，再更新开发运行时");
    } catch (error) {
      if (error.code !== 1) throw error;
    }
  }
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, ".atria-dev-"));
  const bundle = join(staging, "CoworkOS Dev.app");
  const previous = join(staging, "previous.app");
  let moved = false,
    published = false;
  try {
    try {
      await run("/bin/cp", ["-cR", source, bundle]);
    } catch {
      await rm(bundle, { recursive: true, force: true });
      await run("/bin/cp", ["-R", source, bundle]);
    }
    if ((await readFile(join(bundle, "Contents/Resources/development-runtime.json"), "utf8")) !== metadata)
      throw new Error("开发运行时元数据不匹配，未替换现有 App");
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    try {
      await rename(destination, previous);
      moved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(bundle, destination);
      published = true;
    } catch (error) {
      if (moved) {
        await rename(previous, destination);
        moved = false;
      }
      throw error;
    }
    return executable;
  } finally {
    if (!moved || published) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const executable =
    process.platform === "darwin" ? await installDevelopmentApp() : await developmentExecutable();
  if (process.argv.includes("--install")) {
    console.log(`Development app ready: ${executable}`);
    process.exit(0);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.COWORK_DESKTOP_DEV = "1";
  env.COWORK_DESKTOP_SOURCE_ROOT = projectRoot;
  const tools = developmentToolchain();
  env.COWORK_DESKTOP_NODE_EXECUTABLE = tools.nodeExecutable;
  if (tools.npmCli) env.COWORK_DESKTOP_NPM_CLI = tools.npmCli;
  const args = [projectRoot, ...process.argv.slice(2)];
  if (process.platform === "darwin") {
    await launchMacApplication(executable, { args, env, cwd: projectRoot });
  } else {
    const child = spawn(executable, args, { env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
