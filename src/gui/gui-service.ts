import type { ExecutionPermissions } from "../security/execution-permissions.js";
import type { GuiAction, GuiProvider } from "./contracts.js";
export interface GuiAudit {
  taskId: string;
  providerId: string;
  target: string;
  operation: string;
  outcome: "completed" | "failed";
}
/** One action queue per shared desktop. Authorization is checked when work executes. */
export class GuiService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly provider: GuiProvider,
    private readonly permissions: ExecutionPermissions,
    private readonly audit: (event: GuiAudit) => Promise<void>
  ) {}
  private enqueue<T>(
    taskId: string,
    target: string,
    operation: string,
    control: boolean,
    work: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const result = this.tail
      // eslint-disable-next-line no-restricted-syntax -- 上一个操作已把自身的失败返回给它的调用方，这里只需让共享桌面队列继续执行下一次操作
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted();
        await this.permissions.assert({
          taskId,
          target,
          capability: control ? "gui.control" : "gui.observe"
        });
        try {
          const value = await work();
          await this.audit({ taskId, providerId: this.provider.id, target, operation, outcome: "completed" });
          return value;
        } catch (error) {
          await this.audit({ taskId, providerId: this.provider.id, target, operation, outcome: "failed" });
          throw error;
        }
      });
    this.tail = result;
    return result;
  }
  observe(taskId: string, target: string, signal?: AbortSignal) {
    return this.enqueue(
      taskId,
      target,
      "observe",
      false,
      () => this.provider.observe(target, signal),
      signal
    );
  }
  act(taskId: string, target: string, action: GuiAction, signal?: AbortSignal): Promise<void> {
    if (
      action.type === "click" &&
      (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.y < 0)
    )
      return Promise.reject(new Error("Invalid coordinates"));
    return this.enqueue(
      taskId,
      target,
      action.type,
      true,
      () => this.provider.act(target, action, signal),
      signal
    );
  }
}
