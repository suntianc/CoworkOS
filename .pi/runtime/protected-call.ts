import {
  atriaInstallRoot,
  configuredProtectedPaths,
  type ProtectedPaths
} from "../../dist/src/tools/protected-paths.js";
import { protectedCallRefusal, type ProtectedCallRefusal } from "../../dist/src/tools/protected-call.js";
import { privateDataRefusal } from "../../dist/src/tools/private-data.js";
import { LocalWorkspaceStore } from "../../dist/src/workspace/workspace-store.js";

/**
 * The protected-path guard both process roles use at the tool-call boundary.
 *
 * Main and a delegated process run in different project directories but apply
 * the same rule: evaluation code, the CoworkOS runtime and version-control
 * metadata are never a write target. A live grant from the Task is read per
 * call, so a path the user protects mid-session takes effect on the next write.
 */
export async function taskProtectedPaths(
  workspaceRoot: string,
  taskId: string,
  projectDirectory: string
): Promise<ProtectedPaths> {
  const granted = await new LocalWorkspaceStore(workspaceRoot)
    .readTask(taskId)
    .then((task) => task.capabilities?.evalPaths ?? [])
    // eslint-disable-next-line no-restricted-syntax -- 任务记录读取失败时不授予任何 eval 路径，默认保护规则仍然生效
    .catch(() => [] as string[]);
  return configuredProtectedPaths(projectDirectory, process.env, [atriaInstallRoot()], granted);
}

/**
 * The refusal for one tool call, or undefined when the call neither names
 * CoworkOS's own data nor writes anything protected.
 */
export function blockedToolCall(
  toolName: string,
  input: unknown,
  guard: ProtectedPaths,
  projectDirectory: string
): ProtectedCallRefusal | undefined {
  return privateDataRefusal(input) ?? protectedCallRefusal(toolName, input, guard, projectDirectory);
}
