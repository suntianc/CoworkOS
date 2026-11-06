import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Accounting for a desktop process and any separately owned backend processes. */
export function splitByRole(table, rootPid, backendRoots = []) {
  const byParent = new Map();
  for (const entry of table) {
    const children = byParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    byParent.set(entry.ppid, children);
  }
  const collect = (roots) => {
    const result = new Set();
    const pending = [...roots];
    while (pending.length) {
      const pid = pending.shift();
      if (result.has(pid)) continue;
      result.add(pid);
      pending.push(...(byParent.get(pid) ?? []));
    }
    return result;
  };
  const backendSet = collect(backendRoots);
  const clientSet = collect([rootPid]);
  const backend = table.filter((entry) => backendSet.has(entry.pid));
  const client = table.filter((entry) => clientSet.has(entry.pid) && !backendSet.has(entry.pid));
  const role = (entries) => ({
    processes: entries.length,
    rssKb: entries.reduce((sum, entry) => sum + entry.rssKb, 0)
  });
  return {
    client: role(client),
    backend: role(backend),
    pids: { client: client.map((entry) => entry.pid), backend: backend.map((entry) => entry.pid) }
  };
}

export function cpuPercent(first, second, pids, elapsedMs) {
  const seconds = (value) => {
    const parts = value.split(":").map(Number);
    return parts.some((part) => !Number.isFinite(part))
      ? Number.NaN
      : parts.reduce((total, part) => total * 60 + part, 0);
  };
  const before = new Map(first.map((entry) => [entry.pid, seconds(entry.time)]));
  const after = new Map(second.map((entry) => [entry.pid, seconds(entry.time)]));
  if (!(elapsedMs > 0) || pids.some((pid) => !before.has(pid) || !after.has(pid))) return null;
  const delta = pids.reduce((sum, pid) => sum + after.get(pid) - before.get(pid), 0);
  return Number.isFinite(delta) && delta >= 0 ? Number(((delta / elapsedMs) * 100_000).toFixed(2)) : null;
}

export async function logOffsets(logsDir) {
  const sizes = new Map();
  try {
    for (const name of await readdir(logsDir)) {
      if (name.endsWith(".log")) sizes.set(name, (await stat(join(logsDir, name))).size);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return sizes;
}

export async function backendListening(logsDir, offsets) {
  try {
    for (const name of await readdir(logsDir)) {
      if (!name.endsWith(".log")) continue;
      const data = await readFile(join(logsDir, name));
      const text = data.subarray(offsets.get(name) ?? 0).toString("utf8");
      const matches = [...text.matchAll(/listening on (http:\/\/127\.0\.0\.1:\d+)/g)];
      if (matches.length) return matches.at(-1)[1];
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return undefined;
}
