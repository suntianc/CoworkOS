import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Stop only the backend recorded in this test's isolated desktop data root. */
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
}
