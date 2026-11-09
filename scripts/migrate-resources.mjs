#!/usr/bin/env node
/**
 * Move resources out of Task directories and into their application's.
 *
 * The old layout put a resource under `<taskId>/resources/` and
 * `<taskId>/applications/resources/<id>/`, which made a resource one Task's
 * property — and made "reference it from another conversation" impossible
 * without moving the file. Resources now live under
 * `applications/<appType>/`, and each Task keeps a `mapping.json` naming what
 * it references.
 *
 * Written as a one-off rather than a compatibility layer: the layout is not a
 * published format, and carrying both shapes forever would keep the ambiguity
 * this change exists to remove. The Task that owned a resource becomes its
 * first reference, so nothing a person can see changes.
 *
 * Safe to re-run: a resource already moved is left alone.
 *
 *   node scripts/migrate-resources.mjs [workspaceRoot] [--dry-run]
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const workspaceRoot = resolve(args.find((value) => !value.startsWith("--")) ?? ".tmp");

const plan = [];
const problems = [];

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
    // eslint-disable-next-line no-restricted-syntax -- 目标路径不存在就是“不是目录”，迁移脚本按未迁移处理
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
    // eslint-disable-next-line no-restricted-syntax -- 旧布局的 metadata/mapping 可能缺失或未写完，读不到时按没有数据处理
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line no-restricted-syntax -- 工作区根目录可能还没创建，此时没有任务目录可迁移
const taskEntries = await readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);
for (const entry of taskEntries) {
  if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "applications") continue;
  const taskId = entry.name;
  const legacyMeta = join(workspaceRoot, taskId, "applications", "resources");
  if (!(await isDirectory(legacyMeta))) continue;

  const references = [];
  for (const resourceEntry of await readdir(legacyMeta, { withFileTypes: true })) {
    if (!resourceEntry.isDirectory()) continue;
    const resourceId = resourceEntry.name;
    const from = join(legacyMeta, resourceId);
    const metadata = await readJson(join(from, "metadata.json"));
    if (!metadata?.appType) {
      problems.push(`${taskId}/${resourceId}: metadata.json 缺少 appType，跳过`);
      continue;
    }
    const appType = metadata.appType;
    const to = join(workspaceRoot, "applications", appType, "resources", resourceId);
    // The file body moves too, from `<task>/resources/<path>`.
    const fileFrom = metadata.path ? join(workspaceRoot, taskId, "resources", metadata.path) : undefined;
    const fileTo = metadata.path
      ? join(workspaceRoot, "applications", appType, "files", metadata.path)
      : undefined;

    plan.push({ taskId, resourceId, appType, from, to, fileFrom, fileTo, metadata });
    references.push({ resourceId, appType, addedAt: metadata.createdAt ?? new Date().toISOString() });
  }
  if (references.length) plan.push({ taskId, mapping: references });
}

const moves = plan.filter((step) => step.resourceId);
const mappings = plan.filter((step) => step.mapping);

console.log(`工作区: ${workspaceRoot}`);
console.log(`要迁移的资源: ${moves.length}`);
for (const step of moves) {
  console.log(`  ${step.taskId}/${step.resourceId} → applications/${step.appType}/`);
}
console.log(`要写入的引用表: ${mappings.length}`);
for (const problem of problems) console.log(`  ! ${problem}`);

if (dryRun) {
  console.log("\n--dry-run：什么都没有改动。");
  process.exit(0);
}
if (!moves.length) {
  console.log("\n没有需要迁移的旧布局资源。");
  process.exit(0);
}

let moved = 0;
for (const step of moves) {
  // Already migrated by an earlier run: leave it alone rather than overwriting
  // whatever is there now.
  if (await isDirectory(step.to)) {
    console.log(`  跳过 ${step.resourceId}：目标已存在`);
    continue;
  }
  const next = { ...step.metadata };
  delete next.taskId;
  await mkdir(join(step.to, ".."), { recursive: true });
  await rename(step.from, step.to);
  // Rewrite metadata without the taskId field, which no longer means anything.
  await writeFile(join(step.to, "metadata.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (step.fileFrom && step.fileTo && !(await isDirectory(step.fileTo))) {
    await mkdir(join(step.fileTo, ".."), { recursive: true });
    await rename(step.fileFrom, step.fileTo).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      problems.push(`${step.resourceId}: 文件本体 ${step.fileFrom} 不存在`);
    });
  }
  moved += 1;
}

for (const step of mappings) {
  const path = join(workspaceRoot, step.taskId, "applications", "mapping.json");
  const existing = await readJson(path);
  const known = new Set((existing?.resources ?? []).map((entry) => entry.resourceId));
  const merged = [
    ...(existing?.resources ?? []),
    ...step.mapping.filter((entry) => !known.has(entry.resourceId))
  ];
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, resources: merged, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

// The emptied `<task>/resources` directories, and the per-Task transaction
// directories that moved to the workspace root.
for (const taskId of new Set(moves.map((step) => step.taskId))) {
  // eslint-disable-next-line no-restricted-syntax -- 删除已搬空的旧资源目录是收尾清理，残留空目录不影响迁移结果
  await rm(join(workspaceRoot, taskId, "resources"), { recursive: true, force: true }).catch(() => {});
  await rm(join(workspaceRoot, taskId, "applications", "resources"), { recursive: true, force: true }).catch(
    // eslint-disable-next-line no-restricted-syntax -- 逐任务旧应用资源目录同样属于收尾清理，删除失败只会留下空目录
    () => {}
  );
}

console.log(`\n已迁移 ${moved} 份资源，写入 ${mappings.length} 份引用表。`);
for (const problem of problems) console.log(`  ! ${problem}`);
