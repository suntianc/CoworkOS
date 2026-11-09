const fs = require("node:fs/promises");
const sync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const os = require("node:os");
const execute = promisify(execFile);
const requestFlag = "--atria-update-request";
const bundleId = "org.atria.cowork";
const launchEnvironment = () => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: os.homedir(),
  TMPDIR: os.tmpdir(),
  LC_ALL: "C"
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = (s) => ({ dev: s.dev, ino: s.ino });
const sameIdentity = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
function fail(message) {
  throw new Error(message);
}
function applicationPath(executable) {
  if (!path.isAbsolute(executable) || executable.includes("\0")) fail("当前应用路径无效，无法更新");
  const app = path.resolve(executable, "../../..");
  if (!app.endsWith(".app") || path.dirname(executable) !== path.join(app, "Contents/MacOS"))
    fail("只能更新当前安装的 CoworkOS App");
  return app;
}
async function actualDirectory(directory) {
  const s = await fs.lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
    fail("更新路径包含符号链接或已改变");
  return s;
}
async function actualFile(file) {
  const s = await fs.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || (await fs.realpath(file)) !== file) fail("更新文件不是实际文件");
  return s;
}
async function absent(file) {
  try {
    await fs.lstat(file);
    fail("更新目标已存在，未覆盖已有文件");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function json(file) {
  await actualFile(file);
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function atomicJson(file, value) {
  await actualDirectory(path.dirname(file));
  try {
    const s = await fs.lstat(file);
    if (!s.isFile() || s.isSymbolicLink()) fail("更新状态文件路径无效");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = file + ".tmp-" + crypto.randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function digest(file, signal) {
  const initial = await actualFile(file);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of sync.createReadStream(file, { signal })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const final = await actualFile(file);
  if (!sameIdentity(initial, final) || initial.size !== final.size || initial.mtimeMs !== final.mtimeMs)
    fail("更新安装包在校验期间发生改变");
  return { sha256: hash.digest("hex"), bytes };
}
async function containedLinks(app) {
  const boundary = app + path.sep;
  async function visit(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        const real = await fs.realpath(file);
        if (!real.startsWith(boundary)) fail("更新应用含有指向外部的符号链接");
      } else if (item.isDirectory()) await visit(file);
    }
  }
  await visit(app);
}
async function verifyApplication(app, { expectedId, version, arch, runner = execute, signal }) {
  const before = await actualDirectory(app);
  const plist = path.join(app, "Contents/Info.plist");
  await actualFile(plist);
  const read = async (key) =>
    (
      await runner("/usr/libexec/PlistBuddy", ["-c", "Print :" + key, plist], { signal, timeout: 30_000 })
    ).stdout.trim();
  const [id, short, build, executable] = await Promise.all(
    ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "CFBundleExecutable"].map(read)
  );
  if (
    id !== expectedId ||
    short !== version ||
    build !== version ||
    !/^[A-Za-z0-9._ -]+$/.test(executable) ||
    executable === "." ||
    executable === ".."
  )
    fail("更新应用的标识或版本不匹配");
  const metadata = await json(path.join(app, "Contents/Resources/app/package.json"));
  if (metadata.version !== version) fail("更新应用的运行版本不匹配");
  const binary = path.join(app, "Contents/MacOS", executable);
  await actualFile(binary);
  const architectures = (
    await runner("/usr/bin/lipo", ["-archs", binary], { signal, timeout: 30_000 })
  ).stdout
    .trim()
    .split(/\s+/);
  if (!architectures.includes(arch)) fail("更新应用不支持当前处理器");
  await containedLinks(app);
  await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    signal,
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  if (!sameIdentity(before, await actualDirectory(app))) fail("更新应用在校验期间发生改变");
  return { ...identity(before), executable };
}
function lockFor(target) {
  return path.join(
    path.dirname(target),
    ".atria-update-lock-" + crypto.createHash("sha256").update(target).digest("hex").slice(0, 20)
  );
}
async function claimLock(lock, request) {
  let created = false;
  try {
    await fs.mkdir(lock, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const directory = await actualDirectory(lock);
    // eslint-disable-next-line no-restricted-syntax -- a lock directory that was created but not yet populated has no owner.json, which is handled as a corrupt lock
    const owner = await json(path.join(lock, "owner.json")).catch(() => undefined);
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || !/^[a-f0-9]{32}$/.test(owner?.requestId)) {
      if (Date.now() - directory.mtimeMs < 10 * 60_000)
        fail("更新安装锁尚未就绪或损坏，请稍后重试；退出全部 CoworkOS 后可移除 " + lock);
      const abandoned = lock + ".abandoned-" + crypto.randomUUID();
      await fs.rename(lock, abandoned);
      await fs.rm(abandoned, { recursive: true });
      return claimLock(lock, request);
    }
    if (alive(owner.pid) && (owner.pid !== process.pid || owner.requestId !== request.requestId))
      fail("另一个应用更新正在进行");
  }
  try {
    await atomicJson(path.join(lock, "owner.json"), { pid: process.pid, requestId: request.requestId });
  } catch (error) {
    if (created) await fs.rm(lock, { recursive: true, force: true });
    throw error;
  }
}
async function releaseLock(config) {
  try {
    const owner = await json(path.join(config.lock, "owner.json"));
    if (owner.requestId === config.requestId && owner.pid === process.pid)
      await fs.rm(config.lock, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function validateRequest(c, file) {
  if (
    !c ||
    c.schemaVersion !== 1 ||
    !/^[a-f0-9]{32}$/.test(c.requestId) ||
    !Number.isInteger(c.ownerPid) ||
    c.ownerPid <= 0 ||
    !["arm64", "x64"].includes(c.arch) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(c.version) ||
    !/^[A-Za-z0-9.-]+$/.test(c.expectedId)
  )
    fail("更新安装请求无效");
  for (const key of ["target", "stage", "candidate", "backup", "userData", "result", "lock"])
    if (!path.isAbsolute(c[key]) || path.resolve(c[key]) !== c[key] || c[key].includes("\0"))
      fail("更新安装请求路径无效");
  if (
    !c.target.endsWith(".app") ||
    path.dirname(c.stage) !== path.dirname(c.target) ||
    !/^\.atria-update-[A-Za-z0-9]+$/.test(path.basename(c.stage)) ||
    file !== path.join(c.stage, "request.json") ||
    c.candidate !== path.join(c.stage, "candidate.app") ||
    c.backup !== path.join(c.stage, "previous.app") ||
    c.result !== path.join(c.userData, "updates/install-result.json") ||
    c.lock !== lockFor(c.target) ||
    !Number.isInteger(c.exitTimeout) ||
    c.exitTimeout < 500 ||
    c.exitTimeout > 120_000 ||
    !Number.isInteger(c.readyTimeout) ||
    c.readyTimeout < 500 ||
    c.readyTimeout > 180_000
  )
    fail("更新安装请求越过了允许的目录");
  for (const key of ["originalIdentity", "candidateIdentity"])
    if (!Number.isSafeInteger(c[key]?.dev) || !Number.isSafeInteger(c[key]?.ino)) fail("更新安装身份无效");
  return c;
}
async function requestFile(file) {
  const c = validateRequest(await json(file), file);
  const stage = await actualDirectory(c.stage);
  if (typeof process.getuid === "function" && stage.uid !== process.getuid())
    fail("更新暂存目录属于其他用户");
  if (stage.mode & 0o077) fail("更新暂存目录权限无效");
  await actualDirectory(path.dirname(c.target));
  await actualDirectory(c.userData);
  await actualDirectory(path.dirname(c.result));
  return c;
}
async function writeResult(c, phase, message) {
  await atomicJson(c.result, {
    schemaVersion: 1,
    requestId: c.requestId,
    version: c.version,
    phase,
    message,
    target: c.target,
    backup: c.backup,
    updatedAt: new Date().toISOString()
  });
}
async function verifyRequest(c) {
  if (!sameIdentity(await actualDirectory(c.target), c.originalIdentity))
    fail("当前应用已被另一安装操作替换");
  if (!sameIdentity(await actualDirectory(c.candidate), c.candidateIdentity)) fail("暂存应用已被替换");
  await fs.access(path.dirname(c.target), sync.constants.W_OK | sync.constants.X_OK);
  await verifyApplication(c.candidate, { expectedId: c.expectedId, version: c.version, arch: c.arch });
  await absent(c.backup);
}
async function readResult(userData) {
  try {
    const value = await json(path.join(await fs.realpath(userData), "updates/install-result.json"));
    return value.schemaVersion === 1 &&
      ["installed", "rolled-back", "failed", "waiting", "starting"].includes(value.phase)
      ? value
      : undefined;
    // eslint-disable-next-line no-restricted-syntax -- install-result.json is written by the installer process and may be absent or half-written
  } catch {
    return undefined;
  }
}
function createManagedUpdateInstaller({
  executable = process.execPath,
  userData,
  expectedId = bundleId,
  arch = process.arch,
  platform = process.platform,
  runner = execute,
  helperExecutable = process.execPath,
  exitTimeout = 120_000,
  readyTimeout = 120_000
} = {}) {
  let staged,
    cleaning,
    verifiedArchive,
    working,
    controller,
    handedOff = false,
    disposed = false;
  async function cleanup() {
    if (cleaning) return cleaning;
    if (handedOff || !staged) return;
    const request = staged;
    staged = undefined;
    verifiedArchive = undefined;
    cleaning = (async () => {
      try {
        await releaseLock(request);
      } finally {
        await fs.rm(request.stage, { recursive: true, force: true });
      }
    })();
    try {
      await cleaning;
    } finally {
      cleaning = undefined;
    }
  }
  async function stage({ archive, check }) {
    if (disposed || working || handedOff || staged) fail("应用更新正在进行或已经准备就绪");
    controller = new AbortController();
    working = (async () => {
      if (platform !== "darwin" || arch !== "arm64") fail("当前平台不支持应用内安装更新");
      if (
        !/^[a-f0-9]{64}$/.test(check?.asset?.sha256) ||
        !Number.isSafeInteger(check?.asset?.size) ||
        check.asset.size <= 0
      )
        fail("更新缺少可信的完整性信息");
      const target = applicationPath(executable),
        parent = path.dirname(target);
      await actualDirectory(target);
      await actualDirectory(parent);
      await actualFile(executable);
      try {
        await fs.access(parent, sync.constants.W_OK | sync.constants.X_OK);
        // eslint-disable-next-line no-restricted-syntax -- the access check fails with EACCES/EPERM, and the message below tells the user the actionable install location
      } catch {
        fail("当前应用所在位置不可写，请将 CoworkOS 安装到个人 Applications 文件夹，或使用系统安装器");
      }
      await verifyApplication(target, {
        expectedId,
        version: JSON.parse(
          await fs.readFile(path.join(target, "Contents/Resources/app/package.json"), "utf8")
        ).version,
        arch,
        runner,
        signal: controller.signal
      });
      const archiveInfo = await digest(archive, controller.signal);
      verifiedArchive = { file: archive, sha256: check.asset.sha256, bytes: check.asset.size };
      if (archiveInfo.sha256 !== check.asset.sha256 || archiveInfo.bytes !== check.asset.size)
        fail("更新安装包校验失败，未修改当前应用");
      const home = await fs.realpath(userData);
      await actualDirectory(home);
      const resultDirectory = path.join(home, "updates");
      await fs.mkdir(resultDirectory, { recursive: true, mode: 0o700 });
      await actualDirectory(resultDirectory);
      const directory = await fs.mkdtemp(path.join(parent, ".atria-update-"));
      staged = {
        schemaVersion: 1,
        requestId: crypto.randomBytes(16).toString("hex"),
        ownerPid: process.pid,
        target,
        stage: directory,
        candidate: path.join(directory, "candidate.app"),
        backup: path.join(directory, "previous.app"),
        userData: home,
        result: path.join(resultDirectory, "install-result.json"),
        lock: lockFor(target),
        version: check.version,
        expectedId,
        arch,
        exitTimeout,
        readyTimeout,
        originalIdentity: identity(await actualDirectory(target))
      };
      let mounted = false;
      const mount = path.join(directory, "volume");
      try {
        await claimLock(staged.lock, staged);
        await fs.mkdir(mount, { mode: 0o700 });
        mounted = true;
        await runner(
          "/usr/bin/hdiutil",
          ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive],
          { signal: controller.signal, timeout: 120_000, maxBuffer: 1024 * 1024 }
        );
        const apps = (await fs.readdir(mount, { withFileTypes: true })).filter((item) =>
          item.name.endsWith(".app")
        );
        if (
          apps.length !== 1 ||
          !["CoworkOS.app", "Atria.app"].includes(apps[0].name) ||
          !apps[0].isDirectory()
        )
          fail("更新安装包须包含唯一的 CoworkOS.app");
        const source = path.join(mount, apps[0].name);
        await verifyApplication(source, {
          expectedId,
          version: check.version,
          arch,
          runner,
          signal: controller.signal
        });
        // ditto preserves signed resources, framework symlinks and quarantine attributes.
        await runner("/usr/bin/ditto", [source, staged.candidate], {
          signal: controller.signal,
          timeout: 180_000,
          maxBuffer: 1024 * 1024
        });
        staged.candidateIdentity = await verifyApplication(staged.candidate, {
          expectedId,
          version: check.version,
          arch,
          runner,
          signal: controller.signal
        });
        controller.signal.throwIfAborted();
        await fs.copyFile(__filename, path.join(directory, "installer.cjs"), sync.constants.COPYFILE_EXCL);
        await fs.chmod(path.join(directory, "installer.cjs"), 0o600);
        validateRequest(staged, path.join(directory, "request.json"));
        await atomicJson(path.join(directory, "request.json"), staged);
      } finally {
        if (mounted) await detachVolume();
      }
      return { version: check.version };
      async function detachVolume() {
        try {
          await runner("/usr/bin/hdiutil", ["detach", mount], { timeout: 120_000, maxBuffer: 1024 * 1024 });
        } catch (error) {
          // eslint-disable-next-line no-restricted-syntax -- the volume may already be detached, so stat fails and the device comparison is skipped
          const volume = await fs.stat(mount).catch(() => undefined),
            parent = await fs.stat(directory);
          if (volume && volume.dev !== parent.dev) {
            await releaseLock(staged);
            staged = undefined;
            fail("更新卷无法卸载，暂存目录已保留：" + mount);
          }
          if (!controller.signal.aborted) throw error;
        }
      }
    })();
    try {
      return await working;
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- the original stage error must stay the one reported, so a cleanup failure cannot replace it
      await cleanup().catch(() => {});
      throw error;
    } finally {
      working = undefined;
    }
  }
  async function schedule() {
    if (disposed || working || handedOff || !staged) fail("尚无可安装的已验证更新");
    working = (async () => {
      const archiveInfo = await digest(verifiedArchive.file, controller.signal);
      if (archiveInfo.sha256 !== verifiedArchive.sha256 || archiveInfo.bytes !== verifiedArchive.bytes)
        fail("更新安装包已发生改变，请重新下载");
      await claimLock(staged.lock, staged);
      await verifyRequest(staged);
      const file = path.join(staged.stage, "request.json");
      const child = spawn(helperExecutable, [path.join(staged.stage, "installer.cjs"), "--apply", file], {
        detached: true,
        env: { ...launchEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"]
      });
      let timer;
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("更新安装器未能准备就绪，请重试")), 30_000);
          child.once("error", reject);
          child.once("exit", () => reject(new Error("更新安装器提前退出，当前应用未更改")));
          child.on("message", (message) => {
            if (message?.requestId === staged.requestId)
              message.ready === true ? resolve() : reject(new Error(message.error || "更新安装器校验失败"));
          });
        });
        handedOff = true;
        child.disconnect();
        child.unref();
        return { resultPath: staged.result };
      } catch (error) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const limit = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(limit);
            resolve();
          });
        });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await working;
    } finally {
      working = undefined;
    }
  }
  return {
    stage,
    schedule,
    readResult: () => readResult(userData),
    discard: cleanup,
    async dispose() {
      disposed = true;
      controller?.abort();
      // eslint-disable-next-line no-restricted-syntax -- dispose only waits for the aborted stage to settle, and its rejection already went to the stage() caller
      await working?.catch(() => {});
      await cleanup();
    }
  };
}
function managedUpdateLaunch({ executable = process.execPath, args = process.argv } = {}) {
  const offset = args.indexOf(requestFlag);
  if (offset < 0) return undefined;
  if (args.indexOf(requestFlag, offset + 1) >= 0 || !args[offset + 1]) fail("更新启动参数无效");
  const file = args[offset + 1];
  const stat = sync.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || sync.realpathSync(file) !== file)
    fail("更新启动请求路径无效");
  const c = validateRequest(JSON.parse(sync.readFileSync(file, "utf8")), file);
  const app = applicationPath(executable),
    stage = sync.lstatSync(c.stage),
    target = sync.lstatSync(app);
  if (
    app !== c.target ||
    !stage.isDirectory() ||
    stage.isSymbolicLink() ||
    sync.realpathSync(c.stage) !== c.stage ||
    stage.mode & 0o077 ||
    (typeof process.getuid === "function" && stage.uid !== process.getuid()) ||
    !sameIdentity(target, c.candidateIdentity)
  )
    fail("更新启动身份不匹配");
  const version = JSON.parse(
    sync.readFileSync(path.join(app, "Contents/Resources/app/package.json"), "utf8")
  ).version;
  if (version !== c.version) fail("更新启动版本不匹配");
  return c;
}
function recordManagedUpdateLaunch(c) {
  if (c)
    sync.writeFileSync(
      path.join(c.stage, "launch.json"),
      JSON.stringify({
        requestId: c.requestId,
        pid: process.pid,
        version: c.version,
        start: execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
          env: launchEnvironment(),
          encoding: "utf8",
          timeout: 5000
        }).trim()
      }) + "\n",
      { mode: 0o600, flag: "wx" }
    );
}
async function confirmManagedUpdateLaunch(c) {
  if (c) {
    const launch = await json(path.join(c.stage, "launch.json"));
    if (launch.requestId !== c.requestId || launch.pid !== process.pid || launch.version !== c.version)
      fail("更新启动回执不匹配");
    await atomicJson(path.join(c.stage, "ready.json"), launch);
  }
}
async function processMatches(c, launch, file) {
  if (
    launch?.requestId !== c.requestId ||
    launch.version !== c.version ||
    !Number.isInteger(launch.pid) ||
    launch.pid <= 0 ||
    typeof launch.start !== "string" ||
    !alive(launch.pid)
  )
    return false;
  const values = await Promise.all(
    ["lstart=", "comm=", "args="].map((format) =>
      execute("/bin/ps", ["-p", String(launch.pid), "-o", format], {
        timeout: 5000,
        env: launchEnvironment()
      })
        .then((result) => result.stdout.trim())
        .catch((error) => {
          if (error.code === 1 && !alive(launch.pid)) return "";
          throw error;
        })
    )
  );
  const executable = (
    await execute(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleExecutable", path.join(c.target, "Contents/Info.plist")],
      { timeout: 5000 }
    )
  ).stdout.trim();
  return (
    values[0] === launch.start &&
    values[1] === path.join(c.target, "Contents/MacOS", executable) &&
    values[2].startsWith(values[1] + " ") &&
    values[2].includes(requestFlag + " " + file)
  );
}
async function runInstaller(file) {
  let c,
    moved = false,
    promoted = false,
    opened = false,
    cancelled = false;
  process.on("SIGTERM", () => {
    cancelled = true;
  });
  process.on("SIGINT", () => {
    cancelled = true;
  });
  try {
    c = await requestFile(file);
    if (process.ppid !== c.ownerPid || !alive(c.ownerPid)) fail("更新请求不属于当前应用进程");
    const owner = await json(path.join(c.lock, "owner.json"));
    if (owner.pid !== c.ownerPid || owner.requestId !== c.requestId) fail("更新安装锁不匹配");
    await verifyRequest(c);
    await atomicJson(path.join(c.lock, "owner.json"), { pid: process.pid, requestId: c.requestId });
    await writeResult(c, "waiting", "更新安装器已准备，等待 CoworkOS 退出");
    if (process.connected) process.send({ requestId: c.requestId, ready: true }, () => {});
    const start = Date.now();
    while (alive(c.ownerPid)) {
      if (cancelled) fail("更新已取消");
      if (Date.now() - start > c.exitTimeout) fail("CoworkOS 未能退出，已取消安装");
      await sleep(100);
    }
    if (cancelled) fail("更新已取消");
    await verifyRequest(c);
    await fs.rename(c.target, c.backup);
    moved = true;
    if (cancelled) fail("更新已取消");
    await fs.rename(c.candidate, c.target);
    promoted = true;
    await writeResult(c, "starting", "新版本已安装，正在启动");
    opened = true;
    await execute(
      "/usr/bin/open",
      ["--env", "COWORK_DESKTOP_DATA=" + c.userData, "-n", "-a", c.target, "--args", requestFlag, file],
      {
        timeout: 30_000,
        env: launchEnvironment()
      }
    );
    const readyStart = Date.now();
    let ready;
    while (Date.now() - readyStart < c.readyTimeout) {
      if (cancelled) fail("更新已取消");
      // eslint-disable-next-line no-restricted-syntax -- ready.json is polled while the new version boots and does not exist until that process confirms the launch
      ready = await json(path.join(c.stage, "ready.json")).catch(() => undefined);
      // eslint-disable-next-line no-restricted-syntax -- launch.json is polled alongside ready.json and does not exist until the new version records its launch
      const launch = await json(path.join(c.stage, "launch.json")).catch(() => undefined);
      if (
        ready?.requestId === c.requestId &&
        ready.version === c.version &&
        Number.isInteger(ready.pid) &&
        ready.pid > 0 &&
        launch?.requestId === c.requestId &&
        launch.version === c.version &&
        launch.pid === ready.pid &&
        ready.start === launch.start &&
        (await processMatches(c, launch, file))
      )
        break;
      ready = undefined;
      await sleep(100);
    }
    if (
      !ready ||
      ready.requestId !== c.requestId ||
      ready.version !== c.version ||
      !Number.isInteger(ready.pid) ||
      ready.pid <= 0
    )
      fail("新版本未能完成启动");
    if (!sameIdentity(await actualDirectory(c.target), c.candidateIdentity)) fail("安装后的应用已发生改变");
    await writeResult(c, "installed", "CoworkOS 已更新并完成启动");
  } catch (error) {
    if (c) {
      let rolledBack = false;
      try {
        if (promoted) {
          // eslint-disable-next-line no-restricted-syntax -- the launch receipt may be missing when the new version never started
          const launch = await json(path.join(c.stage, "launch.json")).catch(() => undefined);
          if (
            opened &&
            (!launch ||
              launch.requestId !== c.requestId ||
              launch.version !== c.version ||
              !Number.isInteger(launch.pid))
          ) {
            const processes = (await execute("/bin/ps", ["-axo", "pid=,command="], { timeout: 5000 })).stdout;
            const binary = path.join(
              c.target,
              "Contents/MacOS",
              (
                await execute("/usr/libexec/PlistBuddy", [
                  "-c",
                  "Print :CFBundleExecutable",
                  path.join(c.target, "Contents/Info.plist")
                ])
              ).stdout.trim()
            );
            if (
              processes.split("\n").some((line) => {
                const match = /^\s*(\d+)\s+(.*)$/.exec(line);
                return (
                  match &&
                  Number(match[1]) !== process.pid &&
                  match[2].startsWith(binary + " ") &&
                  match[2].includes(requestFlag + " " + file)
                );
              })
            )
              fail("新版本启动状态不明，备份已保留，未覆盖正在运行的应用");
          }
          if (
            launch?.requestId === c.requestId &&
            Number.isInteger(launch.pid) &&
            launch.pid > 0 &&
            launch.pid !== process.pid &&
            alive(launch.pid)
          ) {
            if (await processMatches(c, launch, file)) {
              process.kill(launch.pid, "SIGTERM");
              const stop = Date.now();
              while (alive(launch.pid) && Date.now() - stop < 10_000) await sleep(100);
              if (alive(launch.pid)) fail("新版本仍在运行，未覆盖应用");
            } else if (alive(launch.pid)) fail("无法确认新版本进程身份，备份已保留");
          }
          if (!sameIdentity(await actualDirectory(c.target), c.candidateIdentity))
            fail("目标应用已被其他操作改变");
          await fs.rename(c.target, c.candidate);
        }
        if (moved) {
          await absent(c.target);
          if (!sameIdentity(await actualDirectory(c.backup), c.originalIdentity)) fail("备份身份已改变");
          await fs.rename(c.backup, c.target);
          rolledBack = true;
        }
        await writeResult(
          c,
          rolledBack ? "rolled-back" : "failed",
          rolledBack ? "更新未完成，已恢复原版本" : error.message
        );
        if (rolledBack)
          await execute(
            "/usr/bin/open",
            ["--env", "COWORK_DESKTOP_DATA=" + c.userData, "-n", "-a", c.target],
            {
              timeout: 30_000,
              env: launchEnvironment()
            }
            // eslint-disable-next-line no-restricted-syntax -- relaunching the rolled-back app is best effort, and the recovery already records its own result
          ).catch(() => {});
        // eslint-disable-next-line no-restricted-syntax -- the rollback itself failed, so the failure result naming the backup path is the only recovery record left
      } catch {
        // eslint-disable-next-line no-restricted-syntax -- recording the failure must not throw over the failure that is already being handled
        await writeResult(c, "failed", "更新恢复未完成，请从备份恢复原应用：" + c.backup).catch(() => {});
      }
      if (process.connected)
        process.send({ requestId: c.requestId, ready: false, error: error.message }, () => {});
    }
    process.exitCode = 1;
  } finally {
    // eslint-disable-next-line no-restricted-syntax -- the installer is exiting, so a lock release failure must not change the exit code or hide the recorded result
    if (c) await releaseLock(c).catch(() => {});
    if (process.connected) process.disconnect();
  }
}
module.exports = {
  createManagedUpdateInstaller,
  managedUpdateLaunch,
  recordManagedUpdateLaunch,
  confirmManagedUpdateLaunch,
  verifyApplication,
  runInstaller,
  applicationPath,
  validateRequest
};
if (require.main === module && process.argv[2] === "--apply") void runInstaller(process.argv[3]);
