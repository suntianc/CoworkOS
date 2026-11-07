import { hostname } from "node:os";
import { resolve } from "node:path";
import { atriaDataPaths } from "./data-home.cjs";

const dist = (path) => import(new URL(`../dist/src/${path}`, import.meta.url).href);

/**
 * The external Main budget for a CLI process.
 *
 * The Dashboard owns the queue, but a worker or an interactive CLI can start a
 * Main without it: both ask this same local file for a slot, so one budget
 * bounds every entry point. A host without an explicit `mainCapacity` setting
 * keeps the old behavior and no process state is read at all.
 */
export async function openMainCapacityGate({ taskId, cwd = process.cwd(), env = process.env } = {}) {
  const { coworkConfigPath, readCoworkConfig } = await dist("runtime/config.js");
  let config;
  try {
    config = readCoworkConfig(cwd, env);
  } catch (error) {
    throw new Error(`外部 Main 配置无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config.mainCapacity) return undefined;
  const { MainCapacityStore, mainCapacityStatePath } = await dist("storage/main-capacity-store.js");
  const { createMainCapacityLedger } = await dist("runtime/main-capacity.js");
  const data = atriaDataPaths(env, config, cwd);
  const { dirname } = await import("node:path");
  const store = new MainCapacityStore(mainCapacityStatePath(dirname(data.globalIndex)));
  const ledger = createMainCapacityLedger({
    store,
    host: hostname(),
    settings: () => config.mainCapacity
  });
  const external = taskId ? await ledger.externalTask(taskId) : undefined;
  return {
    settings: config.mainCapacity,
    /** The local Task of an external session, when this backend owns one. */
    external,
    configPath: env.COWORK_CONFIG ? resolve(cwd, env.COWORK_CONFIG) : coworkConfigPath(cwd, env),
    admit: (request) => ledger.admit(request),
    bindProcess: (requestId, pid) => ledger.bindProcess(requestId, pid),
    release: (requestId) => ledger.release(requestId)
  };
}

/** A CLI JSON receipt the worker prints; it never starts a process when full. */
export function capacityReceipt(taskId, decision, runId) {
  if (decision.state === "duplicate")
    return {
      started: false,
      taskId,
      reason: decision.reason === "queued" ? "main_capacity_queued" : "main_already_running",
      ...(decision.runId ? { runId: decision.runId } : {}),
      ...(decision.position ? { position: decision.position } : {})
    };
  if (decision.state === "queued")
    return { started: false, taskId, reason: "main_capacity_queued", position: decision.position };
  return { started: true, taskId, runId };
}
