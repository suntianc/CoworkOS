import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { agentDisplayName } from "../../web/assets/agent-names.js";
export { agentDisplayName } from "../../web/assets/agent-names.js";

/** Reserve a private directory atomically so follow-ups cannot reuse an agent. */
export async function reserveSubagentIdentity(
  taskWorkspace: string
): Promise<{ agentId: string; name: string }> {
  const directory = join(taskWorkspace, "agents", "subagents");
  await mkdir(directory, { recursive: true });
  let next = 1;
  for (const entry of await readdir(directory)) {
    const number = /^subagent_(\d+)$/.exec(entry)?.[1];
    if (number && Number.isSafeInteger(Number(number) + 1)) next = Math.max(next, Number(number) + 1);
  }
  for (;;) {
    const agentId = `subagent_${next++}`;
    try {
      await mkdir(join(directory, agentId));
      return { agentId, name: agentDisplayName(agentId) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
