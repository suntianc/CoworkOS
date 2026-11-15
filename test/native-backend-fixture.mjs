import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { endAgentProcesses } from "./dashboard-fixture.mjs";

/**
 * Stop only the backend recorded in this test's isolated desktop data root.
 *
 * A resident Main outlives the backend that started it, so the fixture owns it
 * too: without this, a desktop test that ran a Main leaves the process the
 * runner reports as a leaked backend.
 */
export async function stopNativeBackend(root) {
  let instance;
  try {
    instance = JSON.parse(await readFile(join(root, "runtime", "backend-instance.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const { stopBackend } = await import("../dist/src/cli/backend.js");
  const result = await stopBackend({ ATRIA_HOME: root }, instance);
  if (result.state !== "stopped") throw new Error(`Isolated backend cleanup: ${result.state}`);
  await endAgentProcesses(join(root, "workspace"));
}
