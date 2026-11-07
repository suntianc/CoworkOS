#!/usr/bin/env node
// One-time removal of identified CoworkOS data in one explicitly selected data root.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WorkbenchTabStore } from "../dist/src/applications/tab-store.js";
import { readTemporaryWorkspace } from "../dist/src/workspace/temporary-workspaces.js";

const safeId = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
async function statOrMissing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function checkedPath(root, path) {
  const target = resolve(path);
  if (!inside(root, target)) throw new Error("path escapes the selected data root");
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = await statOrMissing(current);
    if (entry?.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${current}`);
    if (!entry) break;
  }
  return target;
}
async function json(root, path) {
  await checkedPath(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2_000_000) throw new Error(`invalid metadata file: ${path}`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
async function maybeJson(root, path) {
  try {
    return await json(root, path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function entries(root, path) {
  await checkedPath(root, path);
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function bytes(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
  let total = info.size;
  for (const entry of await readdir(path)) total += await bytes(join(path, entry));
  return total;
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function item(kind, id, path, size, action, source, activity, reason) {
  return { kind, id, path, bytes: size, action, source, activity, reason };
}

async function hasLiveJob(root, directory) {
  for (const entry of await entries(root, directory)) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink()) return true;
    const record = await json(root, join(directory, entry.name));
    if (!record.finishedAt && (!Number.isInteger(record.pid) || record.pid < 1 || pidAlive(record.pid)))
      return true;
  }
  return false;
}

async function activityReason(root, path) {
  for (const name of ["sleep.json", "heartbeat.json", "project-execution.json"]) {
    if (await statOrMissing(await checkedPath(root, join(path, "agents", "main", name))))
      return "task has a retained lifecycle marker";
  }
  const privateAgents = join(path, "agents", "subagents");
  for (const agent of await entries(root, privateAgents)) {
    if (agent.isSymbolicLink()) return "subagent path is a symbolic link";
    if (agent.isDirectory() && (await hasLiveJob(root, join(privateAgents, agent.name, "logs", "jobs"))))
      return "task has a live or unidentified background job";
  }
  const runs = join(path, "runs");
  for (const run of await entries(root, runs)) {
    if (run.isSymbolicLink()) return "run path is a symbolic link";
    if (!run.isDirectory()) continue;
    const runPath = join(runs, run.name);
    const queue = await statOrMissing(await checkedPath(root, join(runPath, "queue.json")));
    if (queue && queue.size > 5) return "task has retained coordination records";
    const agents = join(runPath, "agents");
    if (await hasLiveJob(root, join(agents, "main", "jobs")))
      return "task has a live or unidentified background job";
    const subagents = join(agents, "subagents");
    for (const agent of await entries(root, subagents)) {
      if (agent.isSymbolicLink()) return "subagent path is a symbolic link";
      if (agent.isDirectory() && (await hasLiveJob(root, join(subagents, agent.name, "jobs"))))
        return "task has a live or unidentified background job";
    }
  }
  return "";
}

async function makePlan(root, selectedTask) {
  const workspace = join(root, "workspace");
  const runtime = join(root, "runtime");
  const temporary = join(runtime, "temporary-workspaces");
  const backendPresent = Boolean(
    (await statOrMissing(await checkedPath(root, join(runtime, "backend-instance.json")))) ||
    (await statOrMissing(await checkedPath(root, join(runtime, "backend-starting.json"))))
  );
  const found = [];
  const taskStates = new Map();
  const taskEntries = await entries(root, workspace);
  if (selectedTask) {
    if (!safeId(selectedTask)) throw new Error("unsafe task id");
    await checkedPath(root, join(workspace, selectedTask));
  }
  for (const entry of taskEntries) {
    if (!safeId(entry.name) || (selectedTask && entry.name !== selectedTask)) continue;
    const path = join(workspace, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(
        item(
          "task",
          entry.name,
          path,
          (await lstat(path)).size,
          "retain",
          "symbolic link",
          "unknown",
          "symbolic link refused"
        )
      );
      continue;
    }
    if (!entry.isDirectory()) continue;
    const metadata = await maybeJson(root, join(path, "task.json"));
    if (!metadata) continue;
    const valid =
      metadata.taskId === entry.name &&
      [2, 3].includes(metadata.layoutVersion) &&
      ["created", "running", "waiting", "completed", "failed", "cancelled"].includes(metadata.status);
    let reason = valid ? "" : "task identity or state is invalid";
    if (valid && metadata.projectCatalogPath) {
      const catalog = resolve(metadata.projectCatalogPath);
      if (!inside(root, catalog)) reason = "project catalog is outside the data root";
      else await checkedPath(root, catalog);
    }
    if (valid && metadata.temporaryWorkspaceRoot) {
      const temp = resolve(metadata.temporaryWorkspaceRoot);
      if (!inside(temporary, temp) || temp === temporary)
        reason = "temporary workspace is outside its managed root";
      else {
        await checkedPath(root, temp);
        const record = await readTemporaryWorkspace(temp);
        if (!record || record.holdingTaskId !== entry.name || resolve(record.taskStorageRoot) !== workspace)
          reason = "temporary workspace identity does not match";
      }
    }
    if (backendPresent) reason = "backend instance or startup record is present";
    else if (["running", "waiting"].includes(metadata.status)) reason = "task is active";
    else if (!reason) reason = await activityReason(root, path);
    const action = reason ? "retain" : "remove";
    taskStates.set(entry.name, action);
    found.push(
      item(
        "task",
        entry.name,
        path,
        await bytes(path),
        action,
        "task.json identity and layout",
        metadata.status,
        reason || "owned inactive task"
      )
    );
  }
  if (!selectedTask) {
    for (const entry of await entries(root, temporary)) {
      const path = join(temporary, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory() || !uuid.test(entry.name)) continue;
      await checkedPath(root, path);
      const record = await readTemporaryWorkspace(path);
      if (!record || resolve(record.taskStorageRoot) !== workspace) continue;
      const holding = taskStates.get(record.holdingTaskId);
      const taskExists = Boolean(await statOrMissing(join(workspace, record.holdingTaskId)));
      const reason = backendPresent
        ? "backend instance or startup record is present"
        : holding === "retain" || (taskExists && holding !== "remove")
          ? "holding task is protected"
          : "";
      found.push(
        item(
          "temporary",
          entry.name,
          path,
          await bytes(path),
          reason ? "retain" : "remove",
          "temporary workspace ownership record",
          holding ?? "orphan",
          reason || "owned temporary workspace"
        )
      );
    }
    for (const name of ["cadquery", "blender", "pptist"]) {
      const path = join(root, "components", name);
      const info = await statOrMissing(path);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        found.push(
          item(
            "component",
            name,
            path,
            info.size,
            "retain",
            "symbolic link",
            "unknown",
            "symbolic link refused"
          )
        );
        continue;
      }
      await checkedPath(root, path);
      const progress = await maybeJson(root, join(path, "install.json"));
      const current = await maybeJson(root, join(path, "current.json"));
      const children = await entries(root, path);
      const known = children.every(
        (entry) =>
          ["install.json", "current.json", "cancel", "versions", "blender-download"].includes(entry.name) &&
          !entry.isSymbolicLink()
      );
      const versioned = children.some((entry) => entry.name === "versions");
      const identity = progress && ["ready", "failed", "cancelled", "missing"].includes(progress.phase);
      const currentValid = !versioned || (current?.apiVersion === 1 && safeId(current.version ?? ""));
      const reason = backendPresent
        ? "backend instance or startup record is present"
        : !identity || !known || !currentValid
          ? "component ownership or activity is uncertain"
          : "";
      found.push(
        item(
          "component",
          name,
          path,
          await bytes(path),
          reason ? "retain" : "remove",
          "legacy component installation metadata",
          progress?.phase ?? "unknown",
          reason || "owned inactive component"
        )
      );
    }
    for (const name of ["general", "chemistry"]) {
      const path = join(root, "science-environments", name);
      const info = await statOrMissing(path);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        found.push(
          item(
            "science-environment",
            name,
            path,
            info.size,
            "retain",
            "symbolic link",
            "unknown",
            "symbolic link refused"
          )
        );
        continue;
      }
      await checkedPath(root, path);
      const operation = await maybeJson(root, join(path, "operation.json"));
      const ready = await maybeJson(root, join(path, "ready.json"));
      const spec = `atria-science-${name}-v1`;
      const owned =
        (operation?.version === 1 &&
          operation.target === name &&
          operation.specVersion === spec &&
          uuid.test(operation.operationId ?? "")) ||
        (ready?.version === 1 && ready.specVersion === spec && uuid.test(ready.generation ?? ""));
      const installing = operation?.state === "installing";
      const active =
        installing &&
        (!operation.owner ||
          operation.owner.host !== hostname() ||
          !Number.isInteger(operation.owner.pid) ||
          pidAlive(operation.owner.pid));
      const reason = backendPresent
        ? "backend instance or startup record is present"
        : !owned || active
          ? "environment ownership or activity is uncertain"
          : "";
      found.push(
        item(
          "science-environment",
          name,
          path,
          await bytes(path),
          reason ? "retain" : "remove",
          "science installation metadata",
          operation?.state ?? "ready",
          reason || "owned inactive environment"
        )
      );
    }
  }
  return { root, workspace, runtime, backendPresent, items: found };
}

async function pruneTabs(plan, removedTasks, pruneOrphans, dryRun = false) {
  if (plan.backendPresent) return [];
  const indexPath = join(plan.runtime, "workspaces.json");
  const tabPath = join(plan.runtime, "workbench-tabs.json");
  const catalog = await maybeJson(plan.root, indexPath);
  const complete =
    catalog?.version === 1 &&
    Array.isArray(catalog.workspaces) &&
    catalog.workspaces.length > 0 &&
    catalog.workspaces.every(
      (entry) =>
        entry && typeof entry.workspaceRoot === "string" && resolve(entry.workspaceRoot) === plan.workspace
    );
  await checkedPath(plan.root, tabPath);
  if (!(await statOrMissing(tabPath))) return [];
  const tabs = new WorkbenchTabStore(tabPath);
  const snapshot = await tabs.read();
  const names = new Set((await entries(plan.root, plan.workspace)).map((entry) => entry.name));
  const instances =
    pruneOrphans && complete
      ? await maybeJson(plan.root, join(plan.workspace, "applications", "instances", "index.json"))
      : undefined;
  const validInstances =
    instances?.version === 1 &&
    Array.isArray(instances.instances) &&
    instances.instances.every((entry) => entry && typeof entry.appInstanceId === "string") &&
    instances.aliases &&
    typeof instances.aliases === "object" &&
    !Array.isArray(instances.aliases);
  const instanceIds = new Set(validInstances ? instances.instances.map((entry) => entry.appInstanceId) : []);
  if (validInstances)
    for (const [alias, target] of Object.entries(instances.aliases))
      if (instanceIds.has(target)) instanceIds.add(alias);
  const removed = snapshot.tabs.filter(
    (tab) =>
      (tab.kind === "conversation" &&
        tab.taskId &&
        (removedTasks.has(tab.taskId) || (pruneOrphans && complete && !names.has(tab.taskId)))) ||
      (tab.kind === "application" &&
        tab.appInstanceId &&
        validInstances &&
        !instanceIds.has(tab.appInstanceId))
  );
  const ids = new Set(removed.map((tab) => tab.tabId));
  if (!dryRun) await tabs.prune((tab) => !ids.has(tab.tabId), snapshot.tabs);
  return removed.map((tab) => tab.tabId);
}

async function main() {
  const args = process.argv.slice(2);
  let root, mode, selectedTask;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--root") root = args.shift();
    else if (arg === "--task") selectedTask = args.shift();
    else if (arg === "--preview" || arg === "--apply") {
      if (mode) throw new Error("choose exactly one cleanup mode");
      mode = arg;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!root || !isAbsolute(root) || !mode)
    throw new Error("Usage: prune-legacy-data --root ABSOLUTE --preview|--apply [--task ID]");
  root = resolve(root);
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
    throw new Error("data root must be an existing non-symlink directory");
  const plan = await makePlan(root, selectedTask);
  const plannedTasks = new Set(
    plan.items.filter((entry) => entry.kind === "task" && entry.action === "remove").map((entry) => entry.id)
  );
  plan.tabsToRemove = await pruneTabs(plan, plannedTasks, !selectedTask, true);
  if (mode === "--apply") {
    const removedTasks = new Set();
    for (const entry of plan.items) {
      if (entry.action !== "remove") continue;
      await checkedPath(root, entry.path);
      if (entry.kind === "task") {
        await new LocalWorkspaceStore(plan.workspace).deleteTask(entry.id);
        removedTasks.add(entry.id);
      } else await rm(entry.path, { recursive: true, force: false });
      entry.result = "removed";
    }
    plan.removedTabs = await pruneTabs(plan, removedTasks, !selectedTask);
  }
  console.log(JSON.stringify(plan, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
