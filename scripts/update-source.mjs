import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const outputs = ["dist"];
const desktopOutputs = ["build", "web/assets/math/generated", "web/assets/markdown/generated"];

function updateError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeEnvironment(input = process.env) {
  const environment = { ...input, GIT_TERMINAL_PROMPT: "0" };
  for (const name of Object.keys(environment)) {
    if (
      (name.startsWith("GIT_") && name !== "GIT_TERMINAL_PROMPT") ||
      /^(?:COWORK_|PI_|ATRIA_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)
    )
      delete environment[name];
  }
  return environment;
}

async function exists(file) {
  return lstat(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  );
}

function commands({ root, env, toolchain, commandRunner } = {}) {
  const environment = safeEnvironment(env);
  if (toolchain?.nodeExecutable)
    environment.PATH = `${dirname(toolchain.nodeExecutable)}${delimiter}${environment.PATH ?? ""}`;
  const run = async (command, args, cwd = root) => {
    const timeout = command === "git" ? 120_000 : undefined;
    try {
      return await (commandRunner
        ? commandRunner({ command, args, cwd, env: environment, timeout })
        : execute(command, args, { cwd, env: environment, timeout, maxBuffer: 32 * 1024 * 1024 }));
    } catch (error) {
      // Child output can include remote URLs and npm credentials. Report the stage, never that output.
      throw updateError(
        "UPDATE_COMMAND_FAILED",
        `${command === "git" ? "Git" : "更新命令"}执行失败${Number.isInteger(error.code) ? `（退出码 ${error.code}）` : ""}。`
      );
    }
  };
  const git = async (...args) => (await run("git", args)).stdout.trim();
  return { run, git };
}

/** Only the checkout owning this installation counts; a user's current project never does. */
export async function isSourceCheckout(root) {
  if (!(await exists(join(root, ".git"))) || !(await exists(join(root, "tsconfig.json")))) return false;
  try {
    const { git } = commands({ root });
    return (await realpath(await git("rev-parse", "--show-toplevel"))) === (await realpath(root));
    // eslint-disable-next-line no-restricted-syntax -- 不是 Git 仓库或 rev-parse 失败就判定为“非源码检出”，不是更新错误
  } catch {
    return false;
  }
}

async function idleGitOperation(root, git) {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (await exists(resolve(root, await git("rev-parse", "--git-path", marker))))
      throw updateError(
        "SOURCE_OPERATION_IN_PROGRESS",
        "仓库正在合并、变基或拣选提交，请先完成或取消该操作。"
      );
  }
}

async function cleanCheckout(root, git) {
  await idleGitOperation(root, git);
  if (await git("status", "--porcelain=v1", "--untracked-files=all"))
    throw updateError(
      "SOURCE_DIRTY",
      "源码包含未提交修改或未跟踪文件，请先自行提交或移走这些文件。更新不会重置、清理或暂存它们。"
    );
}

async function inspect(options) {
  const root = await realpath(resolve(options.root));
  const { git, run } = commands({ ...options, root });
  if (!(await isSourceCheckout(root)))
    throw updateError("NOT_SOURCE_CHECKOUT", "当前安装不是可更新的 CoworkOS 源码仓库。");
  await cleanCheckout(root, git);
  let branch;
  try {
    branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
  } catch {
    throw updateError("SOURCE_DETACHED", "源码处于 detached HEAD，请先切换到有上游分支的开发分支。");
  }
  let remote;
  try {
    await git("rev-parse", "--verify", "@{upstream}");
    remote = await git("config", "--get", `branch.${branch}.remote`);
  } catch {
    throw updateError("SOURCE_NO_UPSTREAM", "当前分支没有上游分支，请先配置 Git upstream。");
  }
  if (remote !== "." && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote))
    throw updateError("SOURCE_BAD_REMOTE", "当前分支的 Git remote 名称无效。");
  options.onProgress?.("检查当前开发分支的上游提交…");
  if (remote !== ".") await git("fetch", "--no-tags", remote);
  await cleanCheckout(root, git);
  if ((await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== branch)
    throw updateError("SOURCE_CHANGED", "检查期间源码分支已改变，请重新检查。");
  const currentCommit = await git("rev-parse", "HEAD");
  const remoteCommit = await git("rev-parse", "@{upstream}^{commit}");
  const [ahead, behind] = (await git("rev-list", "--left-right", "--count", "HEAD...@{upstream}"))
    .split(/\s+/)
    .map(Number);
  if (ahead > 0)
    throw updateError(
      "SOURCE_DIVERGED",
      "当前分支有未同步的本地提交或与上游分叉，请先自行处理 Git 同步。更新只接受 fast-forward。"
    );
  const currentPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const remotePackage = JSON.parse(await git("show", `${remoteCommit}:package.json`));
  const sameProduct = ["coworkos", "cowork-harness"].includes(currentPackage.name);
  const compatibleName =
    remotePackage.name === currentPackage.name ||
    (currentPackage.name === "cowork-harness" && remotePackage.name === "coworkos");
  if (!sameProduct || !compatibleName)
    throw updateError("SOURCE_IDENTITY_CHANGED", "上游提交的项目标识不匹配，未执行更新。");
  const cliMarker = resolve(root, await git("rev-parse", "--git-path", "atria-cli-build-commit"));
  const cliBuiltCommit = await readFile(cliMarker, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const rebuildRequired =
    options.target === "desktop" && behind === 0 && cliBuiltCommit.trim() === currentCommit;
  return {
    root,
    git,
    run,
    cliMarker,
    result: {
      mode: "source",
      available: behind > 0 || rebuildRequired,
      rebuildRequired,
      updated: false,
      currentVersion: currentPackage.version,
      version: remotePackage.version,
      currentCommit,
      remoteCommit,
      branch,
      needsRelaunch: false
    }
  };
}

export async function checkSourceUpdate(options) {
  return (await inspect(options)).result;
}

async function sameFile(left, right) {
  try {
    return (await readFile(left)).equals(await readFile(right));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function copyDependencies(source, destination) {
  // Copy-on-write where supported. No hard links: install/build must never mutate the live tree.
  await cp(source, destination, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true
  });
}

/** Build in isolation, then publish a fast-forward and reversible generated-output swaps. */
export async function updateSource(options) {
  const target = options.target ?? "cli";
  if (!["cli", "desktop"].includes(target)) throw updateError("UPDATE_TARGET", "无效的源码更新目标。");
  if (options.check) return checkSourceUpdate(options);
  const { root, git, run, result, cliMarker } = await inspect({ ...options, target });
  if (!result.available) return result;
  const gitDirectory = resolve(root, await git("rev-parse", "--git-dir"));
  const lock = join(gitDirectory, "atria-update.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw updateError(
        "UPDATE_BUSY",
        "另一次源码更新正在运行；若进程已退出，请检查并移除 Git 目录中的 atria-update.lock 后重试。"
      );
    throw error;
  }
  let transaction,
    promotionAttempted = false,
    preserve = false;
  const swaps = [];
  try {
    await cleanCheckout(root, git);
    if (
      (await git("rev-parse", "HEAD")) !== result.currentCommit ||
      (await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== result.branch
    )
      throw updateError("SOURCE_CHANGED", "检查后源码提交已改变，未执行更新，请重新检查。");
    const temporaryRoot = join(root, ".tmp", "atria-updates");
    await mkdir(temporaryRoot, { recursive: true });
    if ((await git("check-ignore", temporaryRoot)) !== temporaryRoot)
      throw updateError("SOURCE_TEMP_NOT_IGNORED", "源码更新的临时目录必须被 Git 忽略，未执行更新。");
    transaction = await mkdtemp(join(temporaryRoot, ".update-"));
    const candidate = join(transaction, "candidate");
    await mkdir(candidate);
    const archive = join(transaction, "source.tar");
    options.onProgress?.("准备独立构建目录，保留正在使用的版本…");
    await git("archive", "--format=tar", "--output", archive, result.remoteCommit);
    await run("tar", ["-xf", archive, "-C", candidate]);
    const dependenciesChanged =
      !(await exists(join(root, "node_modules"))) ||
      !(await sameFile(join(root, "package-lock.json"), join(candidate, "package-lock.json"))) ||
      !(await sameFile(join(root, "package.json"), join(candidate, "package.json")));
    const npm = options.toolchain?.npmCli
      ? { command: options.toolchain.nodeExecutable ?? process.execPath, args: [options.toolchain.npmCli] }
      : { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
    if (dependenciesChanged) {
      options.onProgress?.("安装新版锁定依赖…");
      try {
        await run(npm.command, [...npm.args, "ci", "--no-audit", "--no-fund"], candidate);
      } catch {
        throw updateError(
          "UPDATE_INSTALL_FAILED",
          "新版依赖安装失败；当前源码、依赖和构建未修改。可在仓库手动运行 npm ci 检查安装环境。"
        );
      }
    } else {
      options.onProgress?.("复用未改变的依赖，创建独立副本…");
      await copyDependencies(join(root, "node_modules"), join(candidate, "node_modules"));
    }
    options.onProgress?.(target === "desktop" ? "构建新版 App…" : "构建新版 CLI…");
    try {
      await run(npm.command, [...npm.args, "run", target === "desktop" ? "build" : "build:cli"], candidate);
    } catch {
      throw updateError(
        "UPDATE_BUILD_FAILED",
        "新版构建失败；当前源码、依赖和构建未修改。可在仓库手动运行相应 build 命令检查构建环境。"
      );
    }
    if (!(await exists(join(candidate, "dist/src/runtime/config.js"))))
      throw updateError("UPDATE_BUILD_INCOMPLETE", "新版构建缺少 CLI 运行文件；当前版本未修改。");
    await cleanCheckout(root, git);
    if (
      (await git("rev-parse", "HEAD")) !== result.currentCommit ||
      (await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== result.branch
    )
      throw updateError("SOURCE_CHANGED", "构建期间源码提交已改变，未执行更新。当前修改已保留，请重新检查。");
    const added = (
      await git(
        "diff",
        "--no-renames",
        "--name-only",
        "--diff-filter=A",
        "-z",
        result.currentCommit,
        result.remoteCommit
      )
    )
      .split("\0")
      .filter(Boolean);
    for (const file of added) {
      if (await exists(join(root, file)))
        throw updateError(
          "SOURCE_FILE_COLLISION",
          "上游新增文件与本地文件冲突，未执行更新；请自行处理后重试。"
        );
    }
    options.onProgress?.("发布已验证的新版本…");
    const emptyHooks = join(transaction, "empty-hooks");
    await mkdir(emptyHooks);
    if (result.currentCommit !== result.remoteCommit) {
      promotionAttempted = true;
      await git(
        "-c",
        `core.hooksPath=${emptyHooks}`,
        "merge",
        "--ff-only",
        "--no-edit",
        "--no-stat",
        result.remoteCommit
      );
    }
    const managed = [
      ...(dependenciesChanged ? ["node_modules"] : []),
      ...outputs,
      ...(target === "desktop" ? desktopOutputs : [])
    ];
    for (const relative of managed) {
      const prepared = join(candidate, relative);
      if (!(await exists(prepared))) continue;
      const live = join(root, relative);
      const previous = join(transaction, "previous", relative);
      await mkdir(dirname(previous), { recursive: true });
      await mkdir(dirname(live), { recursive: true });
      const swap = { live, previous, moved: false, published: false };
      swaps.push(swap);
      if (await exists(live)) {
        await rename(live, previous);
        swap.moved = true;
      }
      await rename(prepared, live);
      swap.published = true;
      options.onProgress?.(`更新构建产物：${relative}`);
    }
    if (target === "cli") {
      const preparedMarker = join(lock, "cli-build-commit");
      await writeFile(preparedMarker, `${result.remoteCommit}\n`, { flag: "wx", mode: 0o600 });
      await rename(preparedMarker, cliMarker);
    } else await rm(cliMarker, { force: true });
    return { ...result, updated: true, needsRelaunch: target === "desktop" };
  } catch (error) {
    for (const swap of [...swaps].reverse()) {
      try {
        if (swap.published) await rm(swap.live, { recursive: true, force: true });
        if (swap.moved) await rename(swap.previous, swap.live);
        // eslint-disable-next-line no-restricted-syntax -- 回滚失败会把 preserve 置位并升级为“需要人工恢复”错误，这里不能吞掉该结论
      } catch {
        preserve = true;
      }
    }
    if (promotionAttempted) {
      try {
        const actualCommit = await git("rev-parse", "HEAD");
        if (
          ![result.currentCommit, result.remoteCommit].includes(actualCommit) ||
          (await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== result.branch
        )
          throw new Error("Source changed");
        await idleGitOperation(root, git);
        if (actualCommit === result.remoteCommit) {
          await cleanCheckout(root, git);
          // Two-tree merge refuses changed files; compare-and-swap refuses a changed branch.
          await git("read-tree", "-u", "-m", result.remoteCommit, result.currentCommit);
          await git("update-ref", "HEAD", result.currentCommit, result.remoteCommit);
        } else await cleanCheckout(root, git);
        // eslint-disable-next-line no-restricted-syntax -- 恢复 Git 状态失败同样置 preserve，最终抛出需人工恢复错误而不是原始异常
      } catch {
        preserve = true;
      }
    }
    if (preserve)
      throw updateError(
        "UPDATE_RECOVERY_REQUIRED",
        "发布新版本失败，无法安全恢复。已保留当前修改和 .tmp/atria-updates 中的恢复副本。请检查仓库状态后手动恢复，不要删除该目录。"
      );
    throw error;
  } finally {
    if (transaction && !preserve) await rm(transaction, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, target = "cli", flag] = process.argv.slice(2);
  try {
    if (!root || ![undefined, "--check"].includes(flag))
      throw new Error("Usage: node scripts/update-source.mjs ROOT [cli|desktop] [--check]");
    const result = await updateSource({
      root,
      target,
      check: flag === "--check",
      toolchain: process.env.ATRIA_UPDATE_NPM_CLI
        ? { nodeExecutable: process.execPath, npmCli: process.env.ATRIA_UPDATE_NPM_CLI }
        : undefined,
      onProgress: (message) => console.log(JSON.stringify({ progress: message }))
    });
    console.log(JSON.stringify({ result }));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, code: error.code }));
    process.exitCode = 1;
  }
}
