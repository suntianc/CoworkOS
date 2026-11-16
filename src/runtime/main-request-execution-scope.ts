import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Structured ownership of the directories a replayed Main request may touch. */
export interface MainRequestExecutionScope {
  version: 1;
  taskStorageRoot: string;
  projectDirectory: string;
}

export async function mainRequestExecutionScope(input: {
  taskStorageRoot: string;
  projectDirectory: string;
}): Promise<MainRequestExecutionScope> {
  return {
    version: 1,
    taskStorageRoot: await realpath(input.taskStorageRoot),
    projectDirectory: await realpath(input.projectDirectory)
  };
}

export function validMainRequestExecutionScope(value: unknown): value is MainRequestExecutionScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as MainRequestExecutionScope;
  return Boolean(
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- value 是重试快照里的 unknown 载荷，声明为 MainRequestExecutionScope 只是断言
    scope.version === 1 &&
    typeof scope.taskStorageRoot === "string" &&
    isAbsolute(scope.taskStorageRoot) &&
    typeof scope.projectDirectory === "string" &&
    isAbsolute(scope.projectDirectory)
  );
}

export function assertMainRequestExecutionScope(
  original: MainRequestExecutionScope,
  current: MainRequestExecutionScope
): void {
  const comparable = (scope: MainRequestExecutionScope) => ({
    version: scope.version,
    taskStorageRoot: scope.taskStorageRoot,
    projectDirectory: scope.projectDirectory
  });
  if (JSON.stringify(comparable(original)) !== JSON.stringify(comparable(current)))
    throw new Error(
      "原请求的工作目录已改变，不能重发到新目标。请恢复原目录后重试；原请求、历史和草稿已保留。"
    );
}
