const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { hostname } = require("node:os");
const { basename, dirname, join, relative, resolve, sep } = require("node:path");

const desktopEntries = [
  ["workspace", "workspace"],
  ["runtime", "runtime"],
  ["pi-agent", "pi"],
  ["pi", "pi"],
  ["logs", "logs"],
  ["model-config.json", "model-config.json"],
  ["model-secret.bin", "model-secret.bin"],
  ["composer-drafts.json", "composer-drafts.json"],
  ["data-version.json", "data-version.json"],
  ["update-preferences.json", "update-preferences.json"]
];
const managedEntries = [...new Set([...desktopEntries.map(([, to]) => to), "config.json", "imports"])];
const migrationEntries = new Set(desktopEntries.map(([, to]) => to));
const abandonedLockMs = 10 * 60_000;

async function exists(path) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(path, value) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, path);
}

async function withMigrationLock(home, action) {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, ".data-migration.lock");
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try {
      owner = JSON.parse(await fs.readFile(join(lock, "owner.json"), "utf8"));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid migration owner");
      process.kill(owner.pid, 0);
    } catch (stale) {
      const abandoned =
        (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) &&
        Date.now() - (await fs.stat(lock)).mtimeMs >= abandonedLockMs;
      if (stale.code === "ESRCH" || abandoned) {
        await fs.rm(lock, { recursive: true });
        return withMigrationLock(home, action);
      }
    }
    throw new Error(
      `用户数据正在迁移，请等待该进程退出后重试；若锁损坏，退出全部 CoworkOS 进程后移除 ${lock}，或等待十分钟重试`
    );
  }
  try {
    await writeJson(join(lock, "owner.json"), { pid: process.pid });
    return await action();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

function validateMigrationState(state, source, home) {
  const safeEntries = (items) =>
    Array.isArray(items) &&
    items.every((name) => typeof name === "string" && migrationEntries.has(name)) &&
    new Set(items).size === items.length;
  if (
    !state ||
    state.version !== 1 ||
    !["pending", "completed"].includes(state.status) ||
    typeof state.source !== "string" ||
    resolve(state.source) !== state.source ||
    typeof state.stage !== "string" ||
    resolve(state.stage) !== state.stage ||
    dirname(state.stage) !== home ||
    !/^\.legacy-stage-[a-zA-Z0-9-]+$/.test(basename(state.stage)) ||
    !safeEntries(state.entries) ||
    !state.entries.length ||
    !safeEntries(state.committed) ||
    state.committed.some((name) => !state.entries.includes(name)) ||
    (state.status === "completed" && state.committed.length !== state.entries.length)
  )
    throw new Error("迁移状态记录损坏，未移动或删除数据；请保留旧目录并恢复迁移标记");
  if (state.status === "pending" && state.source !== source)
    throw new Error("检测到另一份未完成迁移，请从对应旧版启动重试");
}

async function assertSourceClosed(source) {
  const lock = join(source, "SingletonLock");
  if (!(await exists(lock))) return;
  let owner;
  try {
    owner = await fs.readlink(lock);
  } catch {
    throw new Error("请先退出旧版 CoworkOS，再迁移用户数据");
  }
  const match = /^(.*)-(\d+)$/.exec(owner);
  if (match?.[1] === hostname()) {
    try {
      process.kill(Number(match[2]), 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
    }
  }
  throw new Error("请先退出旧版 CoworkOS，再迁移用户数据");
}

function relocated(path, mappings) {
  if (typeof path !== "string") return path;
  for (const [from, to] of mappings) {
    if (path === from || path.startsWith(from + sep)) return to + path.slice(from.length);
  }
  return path;
}

const pathFields = new Set([
  "workspaceRoot",
  "storageRoot",
  "root",
  "projectDirectory",
  "projectCatalogPath",
  "cwd",
  "sessionFile",
  "parentSession",
  "candidatePath",
  "sourcePath",
  "filePath",
  "path",
  "directory",
  "absolutePath",
  "workingDirectory",
  "sourceResourcePath",
  "externalPath"
]);

function relocateFields(value, mappings) {
  if (Array.isArray(value)) return value.map((child) => relocateFields(child, mappings));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      pathFields.has(key) && typeof child === "string"
        ? relocated(child, mappings)
        : relocateFields(child, mappings)
    ])
  );
}

function relocateSessionEntry(entry, mappings) {
  if (entry?.type === "session") return relocateFields(entry, mappings);
  if (entry?.type === "custom" && entry.customType === "atria-cli-task")
    return { ...entry, data: relocateFields(entry.data, mappings) };
  return entry;
}

/** Rewrite machine control paths only; user documents and message contents are unchanged. */
async function relocateControlData(directory, mappings) {
  const visit = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!["work", "deliverables", "artifacts", "inputs", "files", "snapshots"].includes(entry.name))
          await visit(file);
        continue;
      }
      const local = relative(directory, file).split(sep).join("/");
      if (entry.name === "messages.json" && local.includes("/agents/main/context/")) {
        const entries = JSON.parse(await fs.readFile(file, "utf8"));
        if (Array.isArray(entries))
          await writeJson(
            file,
            entries.map((item) => relocateSessionEntry(item, mappings))
          );
      } else if (
        entry.name.endsWith(".jsonl") &&
        /^(?:pi\/sessions\/|workspace\/[^/]+\/sessions\/main\/pi\/)/.test(local)
      ) {
        const text = await fs.readFile(file, "utf8");
        const lines = text.split("\n").map((line) => {
          if (!line.trim()) return line;
          const item = JSON.parse(line);
          const next = relocateSessionEntry(item, mappings);
          return next === item ? line : JSON.stringify(next);
        });
        await fs.writeFile(file, lines.join("\n"), { mode: 0o600 });
      } else if (
        entry.name.endsWith(".json") &&
        !["checkpoint.json", "result.json"].includes(basename(file)) &&
        (/\/runs\//.test(local) ||
          /\/\.runtime\//.test(local) ||
          local === "runtime/projects.json" ||
          entry.name === "task.json")
      ) {
        await writeJson(file, relocateFields(JSON.parse(await fs.readFile(file, "utf8")), mappings));
      }
    }
  };
  await visit(directory);
}

/** Only catalog roots are rewritten. Transcripts and external project paths stay original. */
async function relocateCatalog(directory, mappings, workspaceRoot) {
  const file = join(directory, "runtime", "workspaces.json");
  let catalog = { version: 1, workspaces: [] };
  if (await exists(file)) {
    catalog = JSON.parse(await fs.readFile(file, "utf8"));
    if (catalog.version !== 1 || !Array.isArray(catalog.workspaces))
      throw new Error("旧工作区索引格式不兼容，原始数据已保留");
    catalog.workspaces = catalog.workspaces.map((entry) => ({
      ...entry,
      workspaceRoot: relocated(entry.workspaceRoot, mappings)
    }));
  }
  const timestamp = new Date().toISOString();
  if (!catalog.workspaces.some((entry) => entry.workspaceRoot === workspaceRoot))
    catalog.workspaces.push({ workspaceRoot, firstSeenAt: timestamp, lastSeenAt: timestamp });
  await writeJson(file, catalog);
  return catalog.workspaces.map((entry) => entry.workspaceRoot).filter((root) => typeof root === "string");
}

async function copyDesktop(source, stage) {
  const selected = [];
  for (const [from, to] of desktopEntries) {
    if (!(await exists(join(source, from)))) continue;
    if ((await fs.lstat(join(source, from))).isSymbolicLink())
      throw new Error("旧数据入口是符号链接，请使用实际目录显式导入；原始数据已保留");
    if (selected.includes(to)) throw new Error(`旧数据同时包含 ${from} 和 pi-agent，请显式分开导入`);
    await fs.cp(join(source, from), join(stage, to), {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true
    });
    selected.push(to);
  }
  return selected;
}

/** First-start migration copies an empty application's old profile. Never deletes the source. */
async function migrateLegacyDesktopData({ source, home }) {
  source = resolve(source);
  home = resolve(home);
  if (source === home || !(await exists(source))) return { status: "none" };
  if (!(await fs.lstat(source)).isDirectory()) throw new Error("旧用户数据须为实际目录");
  if (home.startsWith(source + sep)) throw new Error("迁移目标不能位于原始数据目录内");
  return withMigrationLock(home, async () => {
    const manifest = join(home, ".legacy-migration.json");
    let state = (await exists(manifest)) ? JSON.parse(await fs.readFile(manifest, "utf8")) : undefined;
    if (state) validateMigrationState(state, source, home);
    if (state?.status === "completed")
      return { status: state.source === source ? "completed" : "available", source };
    if (!state) {
      for (const name of managedEntries) {
        if (await exists(join(home, name))) return { status: "available", source };
      }
      await assertSourceClosed(source);
      const stage = await fs.mkdtemp(join(home, ".legacy-stage-"));
      try {
        const entries = await copyDesktop(source, stage);
        if (!entries.length) {
          await fs.rm(stage, { recursive: true, force: true });
          return { status: "none" };
        }
        const mappings = [
          [join(source, "pi-agent"), join(home, "pi")],
          [source, home]
        ];
        await relocateControlData(stage, mappings);
        await relocateCatalog(stage, mappings, join(home, "workspace"));
        if (!entries.includes("runtime")) entries.push("runtime");
        state = { version: 1, source, stage, entries, committed: [], status: "pending" };
        await writeJson(manifest, state);
      } catch (error) {
        await fs.rm(stage, { recursive: true, force: true });
        throw error;
      }
    }
    validateMigrationState(state, source, home);
    if ((await exists(state.stage)) && !(await fs.lstat(state.stage)).isDirectory())
      throw new Error("迁移暂存目录无效，未移动或删除数据");
    await assertSourceClosed(source);
    for (const name of state.entries) {
      if (state.committed.includes(name)) continue;
      const from = join(state.stage, name),
        to = join(home, name);
      if (!(await exists(from))) {
        // A crash after committing and before saving the marker is recoverable.
        if (!(await exists(to))) throw new Error("迁移暂存文件缺失，原始数据仍在旧目录");
      } else {
        if (await exists(to)) throw new Error(`迁移目标已存在，未覆盖：${to}`);
        const metadata = await fs.lstat(from);
        if (metadata.isDirectory()) await fs.rename(from, to);
        else {
          await fs.link(from, to); // Exclusive commit: never overwrite another process's file.
          await fs.unlink(from);
        }
      }
      state.committed.push(name);
      await writeJson(manifest, state);
    }
    state.status = "completed";
    state.completedAt = new Date().toISOString();
    await writeJson(manifest, state);
    await fs.rm(state.stage, { recursive: true, force: true });
    return { status: "migrated", source, home };
  });
}

/** Explicit imports get an independent workspace; conflicts never merge or overwrite user history. */
async function importLegacyData({ source, home, kind = "desktop", name = `import-${randomUUID()}` }) {
  source = resolve(source);
  home = resolve(home);
  if (!["desktop", "workspace"].includes(kind)) throw new Error("kind 须为 desktop 或 workspace");
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith(".")) throw new Error("导入名称须为安全目录名");
  if (home === source || home.startsWith(source + sep)) throw new Error("导入目标不能位于原始数据目录内");
  if (!(await exists(source))) throw new Error("旧数据目录不存在");
  if (!(await fs.lstat(source)).isDirectory()) throw new Error("旧数据须为实际目录，请勿导入目录符号链接");
  await assertSourceClosed(source);
  return withMigrationLock(home, async () => {
    const imports = join(home, "imports");
    await fs.mkdir(imports, { recursive: true, mode: 0o700 });
    const destination = join(imports, name);
    if (await exists(destination)) throw new Error(`导入目标已存在，未覆盖：${destination}`);
    const stage = await fs.mkdtemp(join(imports, ".stage-"));
    try {
      if (kind === "desktop") {
        if (!(await copyDesktop(source, stage)).length) throw new Error("该目录不包含旧版桌面用户数据");
      } else {
        await fs.cp(source, join(stage, "workspace"), {
          recursive: true,
          dereference: false,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true
        });
        if (await exists(join(source, "pi-agent")))
          await fs.cp(join(source, "pi-agent"), join(stage, "pi"), { recursive: true, dereference: false });
        if (await exists(join(source, ".global")))
          await fs.cp(join(source, ".global"), join(stage, "runtime"), {
            recursive: true,
            dereference: false
          });
      }
      const workspaceRoot = join(destination, "workspace");
      const mappings =
        kind === "desktop"
          ? [
              [join(source, "pi-agent"), join(destination, "pi")],
              [source, destination]
            ]
          : [
              [join(source, "pi-agent"), join(destination, "pi")],
              [source, workspaceRoot]
            ];
      await relocateControlData(stage, mappings);
      const catalogRoots = await relocateCatalog(stage, mappings, workspaceRoot);
      await writeJson(join(stage, "import.json"), {
        version: 1,
        source,
        kind,
        workspaceRoot,
        importedAt: new Date().toISOString(),
        sourceRetained: true
      });
      await fs.rename(stage, destination);
      return {
        status: "imported",
        source,
        destination,
        workspaceRoot,
        piAgentDir: join(destination, "pi"),
        catalogRoots
      };
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  });
}

module.exports = { migrateLegacyDesktopData, importLegacyData };
