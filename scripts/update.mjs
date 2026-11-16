import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSourceCheckout, updateSource } from "./update-source.mjs";

export function updateHelp() {
  return `Usage: coworkos update [--check] [--channel stable|preview]

  --check     Check for a new commit or published release without installing
  --channel   Use the legacy release API with stable or preview filtering

Source installations follow the current branch's Git upstream and build the CLI.
Installed packages use the public CoworkOS update feed and download a verified CLI asset.
The npm package stays managed by npm; coworkos update prints its npm upgrade command.
Configuration, task history and project files are preserved.`;
}

export function parseUpdateOptions(args) {
  const options = { check: false, channel: undefined, explicitChannel: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (["--help", "-h"].includes(argument)) options.help = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--channel") {
      const channel = args[++index];
      if (!["stable", "preview"].includes(channel)) throw new Error("--channel requires stable or preview.");
      options.channel = channel;
      options.explicitChannel = true;
    } else throw new Error(`Unknown update option: ${argument}`);
  }
  return options;
}

export async function runUpdate({
  root,
  args = [],
  onProgress = (message) => console.log(message),
  print = (message) => console.log(message),
  fetchImpl = fetch
}) {
  const options = parseUpdateOptions(args);
  if (options.help) {
    print(updateHelp());
    return;
  }
  let result;
  if (await isSourceCheckout(root)) {
    if (options.explicitChannel)
      throw new Error("源码版跟随当前分支的 Git upstream；--channel 仅适用于 CLI 安装包。");
    result = await updateSource({ root, target: "cli", check: options.check, onProgress });
  } else {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (pkg.name === "coworkos-app") {
      const build = JSON.parse(await readFile(join(root, "build-info.json"), "utf8"));
      if (build.distribution !== "npm" || build.version !== pkg.version)
        throw new Error("无法确认 npm 安装来源；请使用原安装方式重新安装 coworkos。");
      // An npm installation follows its own dist-tag, so the release channel option does not apply.
      const tag = pkg.version.split("+")[0].includes("-") ? "beta" : "latest";
      const updateCommand = `npm install --global coworkos-app@${tag}`;
      let version = pkg.version,
        available;
      if (options.check) {
        const response = await fetchImpl(`https://registry.npmjs.org/coworkos-app/${tag}`, {
          signal: AbortSignal.timeout(30_000),
          headers: { accept: "application/json" }
        });
        if (!response.ok) throw new Error(`npm 版本检查失败（HTTP ${response.status}）；稍后重试。`);
        const metadata = await response.text();
        if (Buffer.byteLength(metadata) > 256 * 1024) throw new Error("npm 版本信息超过允许大小。");
        const published = JSON.parse(metadata);
        const { compareUpdateVersions } = await import("./update-release.mjs");
        if (published.name !== "coworkos-app") throw new Error("npm 返回的包名不匹配。");
        version = published.version;
        available = compareUpdateVersions(version, pkg.version) > 0;
        print(available ? `发现 npm 更新：${version}。` : "当前已是最新 npm 版本。");
      }
      print(`此安装由 npm 管理。升级请运行 ${updateCommand}；本地项目安装请省略 --global。`);
      return {
        mode: "npm",
        source: "npm-registry",
        currentVersion: pkg.version,
        version,
        available,
        updated: false,
        updateCommand
      };
    }
    const { checkRelease, installCliRelease } = await import("./update-release.mjs");
    result = options.check
      ? await checkRelease({ root, channel: options.channel, kind: "cli" })
      : await installCliRelease({ root, channel: options.channel, onProgress });
  }
  if (options.check) {
    print(
      result.available
        ? `发现更新：${result.version}${result.mode === "source" ? `（${result.remoteCommit.slice(0, 7)}）` : ""}。运行 coworkos update${options.explicitChannel ? ` --channel ${options.channel}` : ""} 安装。`
        : "当前已是最新版本。"
    );
  } else {
    print(
      result.updated
        ? `更新完成：${result.version}${result.mode === "source" ? `（${result.remoteCommit.slice(0, 7)}）` : ""}。下次启动 coworkos 即使用新版本。`
        : "当前已是最新版本。"
    );
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runUpdate({ root: fileURLToPath(new URL("..", import.meta.url)), args: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
