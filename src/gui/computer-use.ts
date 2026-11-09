import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { GuiAction } from "./contracts.js";
import {
  accessibilityObservation,
  computerWaitCondition,
  driverAccessibility,
  waitConditionMet,
  type DriverAccessibility
} from "./accessibility.js";

export interface ComputerWindow {
  pid: number;
  windowId: number;
  bundleId: string;
  application: string;
  title: string;
}
export interface ComputerStatus {
  available: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  controlAvailable?: boolean;
  secureInput?: boolean;
  postEventAccess?: boolean;
  reason?: string;
  windows: ComputerWindow[];
}
export interface ComputerFrame {
  width: number;
  height: number;
  image: string;
  frame: { x: number; y: number; width: number; height: number };
  accessibilityText?: string;
  accessibility?: DriverAccessibility;
}
export interface ComputerDriver {
  status(signal?: AbortSignal): Promise<ComputerStatus>;
  requestPermissions?(permission: "screenRecording" | "accessibility"): Promise<unknown>;
  observe(target: ComputerWindow, signal: AbortSignal): Promise<ComputerFrame>;
  act(target: ComputerWindow, action: GuiAction, frame: ComputerFrame, signal: AbortSignal): Promise<void>;
}
export class ComputerUseError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errorCode = status === 400
      ? "invalid_argument"
      : status === 403
        ? "access_denied"
        : status === 409
          ? "target_changed"
          : status === 502
            ? "invalid_driver_response"
            : "driver_failed",
    readonly dispatchStatus: "not_sent" | "sent" | "unknown" = "not_sent",
    readonly requiresObservation = dispatchStatus !== "not_sent"
  ) {
    super(message);
  }
}
export const COMPUTER_KEYS = [
  "Meta",
  "Control",
  "Alt",
  "Shift",
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split("")
];
export function computerAction(value: unknown): GuiAction {
  if (!value || typeof value !== "object") throw new ComputerUseError(400, "操作必须是对象");
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "activate":
      return { type: "activate" };
    case "click":
      if (
        typeof action.x !== "number" ||
        typeof action.y !== "number" ||
        !Number.isFinite(action.x) ||
        !Number.isFinite(action.y) ||
        action.x < 0 ||
        action.y < 0 ||
        !["left", "right"].includes(String(action.button))
      )
        break;
      return { type: "click", x: action.x, y: action.y, button: action.button as "left" | "right" };
    case "type":
      if (
        typeof action.text !== "string" ||
        !action.text ||
        action.text.includes("\0") ||
        Buffer.byteLength(action.text) > 16_384
      )
        break;
      return { type: "type", text: action.text };
    case "key": {
      const keys = action.keys;
      if (
        !Array.isArray(keys) ||
        keys.length < 1 ||
        keys.length > 5 ||
        keys.some((key) => typeof key !== "string" || !COMPUTER_KEYS.includes(key)) ||
        new Set(keys).size !== keys.length ||
        keys.filter((key) => !["Meta", "Control", "Alt", "Shift"].includes(key)).length !== 1
      )
        break;
      return { type: "key", keys };
    }
    case "press":
    case "set_value": {
      if (
        typeof action.elementId !== "string" ||
        !action.elementId ||
        action.elementId.length > 256 ||
        action.elementId.includes("\0")
      )
        break;
      if (action.type === "press") return { type: "press", elementId: action.elementId };
      if (
        typeof action.value !== "string" ||
        action.value.includes("\0") ||
        Buffer.byteLength(action.value) > 16_384
      )
        break;
      return { type: "set_value", elementId: action.elementId, value: action.value };
    }
  }
  throw new ComputerUseError(400, "不支持的操作或参数；使用 activate/click/type/key/press/set_value");
}
export interface ComputerPolicy {
  enabled: boolean;
  mode: "observe" | "control";
}
export interface ComputerRequestEpoch {
  host: number;
  task: number;
}
interface Session {
  source: "task" | "global";
  sessionId: string;
  taskId: string;
  target: ComputerWindow;
  mode: "observe" | "control";
  state: "active" | "paused" | "ended";
  expiresAt: number;
  abort: AbortController;
  observation?: ComputerFrame & { observationId: string; capturedAt: string; at: number };
  preview?: ComputerFrame & { capturedAt: string };
  activity: Array<{ at: string; operation: string; outcome: string }>;
}
interface SelectionRequest {
  taskId: string;
  abort: AbortController;
  signal: AbortSignal;
}

/** One desktop owner. Trusted IPC grants policy; consumers select only within that policy. */
export class ComputerUse {
  private session?: Session;
  private tail: Promise<unknown> = Promise.resolve();
  private intentVersion = 0;
  private pendingTaskId?: string;
  private policy: ComputerPolicy = { enabled: false, mode: "observe" };
  private paused = false;
  private cancelledTasks = new Set<string>();
  private taskVersions = new Map<string, number>();
  private pendingSelections = new Set<SelectionRequest>();
  private selecting?: SelectionRequest;
  private changed = new Set<() => void>();
  constructor(
    private readonly driver: ComputerDriver,
    private readonly clock = Date.now,
    private readonly authorizeTask: (taskId: string) => Promise<unknown> = async () => {}
  ) {}
  status() {
    return this.driver.status();
  }
  requestEpoch(taskId: string): ComputerRequestEpoch {
    return { host: this.intentVersion, task: this.taskVersions.get(taskId) ?? 0 };
  }
  assertRequestEpoch(taskId: string, epoch: ComputerRequestEpoch) {
    const current = this.requestEpoch(taskId);
    if (epoch.host !== current.host || epoch.task !== current.task)
      throw new ComputerUseError(403, "窗口请求已取消，请重新读取当前状态");
  }
  /** Read-only policy metadata never grants access or exposes another Task's image. */
  access(taskId?: string) {
    return {
      policy: { ...this.policy },
      paused: this.paused,
      taskBlocked: Boolean(taskId && this.cancelledTasks.has(taskId)),
      owner:
        this.session && this.session.state !== "ended"
          ? {
              taskId: this.session.taskId,
              target: this.session.target,
              state: this.session.state,
              mode: this.session.mode
            }
          : null,
      waitingTaskIds: [...new Set([...this.pendingSelections].map((request) => request.taskId))]
    };
  }
  /** This method is called only through the trusted host channel, never HTTP. */
  configurePolicy(value: ComputerPolicy) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 策略值来自受信宿主 IPC，旧渲染进程可能缺字段或传错类型
    if (!value || typeof value.enabled !== "boolean" || !["observe", "control"].includes(value.mode))
      throw new ComputerUseError(400, "全局策略不合法");
    if (!value.enabled || value.enabled !== this.policy.enabled || value.mode !== this.policy.mode) {
      this.invalidateSelections();
      this.intentVersion++;
      if (this.session) this.endSession(this.session, "ended");
      if (value.enabled && !this.policy.enabled) {
        this.paused = false;
        this.cancelledTasks.clear();
      }
    }
    this.policy = { enabled: value.enabled, mode: value.mode };
    return this.access();
  }
  private notify() {
    for (const wake of this.changed) wake();
    this.changed.clear();
  }
  private invalidateSelections(taskId?: string) {
    for (const request of this.pendingSelections)
      if (!taskId || request.taskId === taskId) request.abort.abort();
    this.notify();
  }
  private endSession(session: Session, state: "paused" | "ended") {
    session.state = state;
    session.abort.abort();
    session.observation = undefined;
    session.preview = undefined;
    this.notify();
  }
  private assertPolicy(taskId: string, mode: "observe" | "control") {
    if (!this.policy.enabled) throw new ComputerUseError(403, "全局窗口访问尚未开启，请使用桌面设置");
    if (this.paused) throw new ComputerUseError(403, "窗口访问已暂停，请用户显式恢复");
    if (this.cancelledTasks.has(taskId))
      throw new ComputerUseError(403, "任务窗口访问已取消，请用户显式恢复");
    if (mode === "control" && this.policy.mode !== "control")
      throw new ComputerUseError(403, "全局策略仅观察");
  }
  async discover(taskId: string, signal?: AbortSignal) {
    this.assertPolicy(taskId, "observe");
    const version = this.intentVersion;
    const status = await this.driver.status(signal);
    signal?.throwIfAborted();
    this.assertPolicy(taskId, "observe");
    if (version !== this.intentVersion) throw new ComputerUseError(403, "窗口发现已取消");
    return status;
  }
  private async validateTarget(
    pid: number,
    windowId: number,
    mode: "observe" | "control",
    signal?: AbortSignal
  ) {
    const status = await this.driver.status(signal);
    signal?.throwIfAborted();
    if (!status.available || !status.screenRecording || (mode === "control" && !status.accessibility))
      throw new ComputerUseError(403, status.reason || "请先在系统设置中开启屏幕录制及辅助功能权限");
    if (
      mode === "control" &&
      (status.controlAvailable === false || status.secureInput === true || status.postEventAccess === false)
    )
      throw new ComputerUseError(403, status.reason || "当前没有可操作的前台桌面，请解锁屏幕后重试");
    const target = status.windows.find((window) => window.pid === pid && window.windowId === windowId);
    if (!target) throw new ComputerUseError(409, "目标窗口已关闭或不可见，请重新选择");
    return target;
  }
  /** FIFO acquisition holds the desktop across the complete observe/action workflow. */
  select(taskId: string, pid: number, windowId: number, mode: "observe" | "control", signal?: AbortSignal) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mode 由 HTTP/IPC 请求传入，声明为联合类型但运行期可能是任意字符串
    if (mode !== "observe" && mode !== "control")
      return Promise.reject(new ComputerUseError(400, "授权模式不合法"));
    try {
      this.assertPolicy(taskId, mode);
    } catch (error) {
      return Promise.reject(error);
    }
    const abort = new AbortController();
    const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
    const request = { taskId, abort, signal: combined };
    this.pendingSelections.add(request);
    const execute = async () => {
      const check = () => {
        if (combined.aborted) throw new ComputerUseError(403, "窗口选择已暂停或取消");
        this.assertPolicy(taskId, mode);
      };
      check();
      await this.authorizeTask(taskId);
      check();
      const eligible = () => {
        if (this.selecting) return false;
        const owner =
          this.session && this.current(this.session.taskId)?.state === "active" ? this.session : undefined;
        const next = [...this.pendingSelections].find(
          (candidate) => !candidate.signal.aborted && (!owner || candidate.taskId === owner.taskId)
        );
        return next === request;
      };
      while (!eligible()) {
        await new Promise<void>((resolve) => {
          let expiry: ReturnType<typeof setTimeout> | undefined;
          const wake = () => {
            clearTimeout(expiry);
            combined.removeEventListener("abort", wake);
            this.changed.delete(wake);
            resolve();
          };
          this.changed.add(wake);
          combined.addEventListener("abort", wake, { once: true });
          if (this.session?.source === "task" && this.session.state === "active")
            expiry = setTimeout(wake, Math.max(1, this.session.expiresAt - this.clock()));
          if (combined.aborted) wake();
        });
        check();
      }
      this.selecting = request;
      const owned =
        this.session?.taskId === taskId && this.session.state === "active" ? this.session : undefined;
      const target = await this.validateTarget(pid, windowId, mode, combined);
      check();
      if (owned && this.session !== owned) throw new ComputerUseError(409, "控制会话已改变，请重新选择窗口");
      const current = this.session;
      if (
        current?.source === "global" &&
        current.taskId === taskId &&
        current.state === "active" &&
        current.mode === mode &&
        current.target.pid === pid &&
        current.target.windowId === windowId &&
        current.target.bundleId === target.bundleId
      )
        return this.current(taskId);
      if (current) this.endSession(current, "ended");
      this.session = {
        source: "global",
        sessionId: randomUUID(),
        taskId,
        target,
        mode,
        state: "active",
        expiresAt: this.clock() + 5 * 60_000,
        abort: new AbortController(),
        activity: []
      };
      return this.current(taskId);
    };
    return execute().finally(() => {
      if (this.selecting === request) this.selecting = undefined;
      this.pendingSelections.delete(request);
      this.notify();
    });
  }
  release(taskId: string, sessionId: string) {
    if (!this.session || this.session.taskId !== taskId || this.session.sessionId !== sessionId)
      throw new ComputerUseError(403, "Computer Use 会话未授权");
    this.taskVersions.set(taskId, (this.taskVersions.get(taskId) ?? 0) + 1);
    this.invalidateSelections(taskId);
    this.endSession(this.session, "ended");
    return this.current(taskId);
  }
  finishTask(taskId: string) {
    this.taskVersions.set(taskId, (this.taskVersions.get(taskId) ?? 0) + 1);
    this.invalidateSelections(taskId);
    if (this.session?.taskId === taskId && this.session.source === "global")
      this.endSession(this.session, "ended");
  }
  /** Explicit human resume clears the takeover gate; old IDs are always discarded. */
  async resume() {
    this.intentVersion++;
    this.invalidateSelections();
    this.paused = false;
    this.cancelledTasks.clear();
    const session = this.session;
    if (!session || session.state !== "paused") return this.access();
    if (session.source === "global") {
      this.endSession(session, "ended");
      await this.select(session.taskId, session.target.pid, session.target.windowId, session.mode);
    } else {
      await this.authorize(session.taskId, session.target.pid, session.target.windowId, session.mode);
    }
    return this.access();
  }
  current(taskId: string) {
    const session = this.session;
    if (!session || session.taskId !== taskId) return null;
    if (session.expiresAt <= this.clock() && session.state !== "ended") {
      if (
        session.source === "global" &&
        this.policy.enabled &&
        !this.paused &&
        !this.cancelledTasks.has(taskId)
      ) {
        session.expiresAt = this.clock() + 5 * 60_000;
        session.observation = undefined;
      } else this.endSession(session, "ended");
    }
    return {
      source: session.source,
      sessionId: session.sessionId,
      taskId: session.taskId,
      target: session.target,
      mode: session.mode,
      state: session.state,
      expiresAt: session.expiresAt,
      activity: [...session.activity],
      previewCapturedAt: session.state === "active" ? session.preview?.capturedAt : undefined
    };
  }
  async authorize(taskId: string, pid: number, windowId: number, mode: "observe" | "control") {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mode 由 HTTP/IPC 请求传入，声明为联合类型但运行期可能是任意字符串
    if (mode !== "observe" && mode !== "control") throw new ComputerUseError(400, "授权模式不合法");
    this.paused = false;
    this.cancelledTasks.delete(taskId);
    this.invalidateSelections();
    const version = ++this.intentVersion;
    this.pendingTaskId = taskId;
    await this.authorizeTask(taskId);
    const status = await this.status();
    if (version !== this.intentVersion) throw new ComputerUseError(403, "授权请求已取消，请重新开启会话");
    if (!status.available || !status.screenRecording || (mode === "control" && !status.accessibility))
      throw new ComputerUseError(403, status.reason || "请先在系统设置中开启屏幕录制及辅助功能权限");
    const target = status.windows.find((window) => window.pid === pid && window.windowId === windowId);
    if (mode === "control" && status.controlAvailable === false)
      throw new ComputerUseError(403, status.reason || "当前没有可操作的前台桌面，请解锁屏幕后重试");
    if (!target) throw new ComputerUseError(409, "目标窗口已关闭或不可见，请重新选择");
    this.pendingTaskId = undefined;
    if (this.session) {
      this.session.state = "ended";
      this.session.abort.abort();
      this.session.observation = undefined;
    }
    this.session = {
      source: "task",
      sessionId: randomUUID(),
      taskId,
      target,
      mode,
      state: "active",
      expiresAt: this.clock() + 5 * 60_000,
      abort: new AbortController(),
      activity: []
    };
    return this.current(taskId);
  }
  stop(taskId: string, state: "paused" | "ended" = "paused") {
    this.taskVersions.set(taskId, (this.taskVersions.get(taskId) ?? 0) + 1);
    if (this.pendingTaskId === taskId || this.session?.taskId === taskId) this.intentVersion++;
    this.invalidateSelections(taskId);
    this.cancelledTasks.add(taskId);
    const session = this.session;
    if (session?.taskId === taskId) this.endSession(session, state);
    return this.current(taskId);
  }
  takeOver() {
    this.intentVersion++;
    this.paused = true;
    this.invalidateSelections();
    return this.session ? this.stop(this.session.taskId, "paused") : null;
  }
  /** Renderer lifecycle cleanup invalidates credentials without changing human access intent. */
  releaseSessions() {
    this.intentVersion++;
    this.invalidateSelections();
    if (this.session) this.endSession(this.session, "ended");
  }
  close() {
    this.paused = true;
    this.releaseSessions();
  }
  private enqueue<T>(
    taskId: string,
    sessionId: string,
    operation: string,
    work: (session: Session, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    timeoutMs = 15_000
  ): Promise<T> {
    const result = this.tail
      // eslint-disable-next-line no-restricted-syntax -- 上一个操作已把自身的失败返回给它的调用方，这里只需让队列继续执行下一次操作
      .catch(() => {})
      .then(async () => {
        this.current(taskId);
        const session = this.session;
        const now = this.clock();
        if (
          !session ||
          session.taskId !== taskId ||
          session.sessionId !== sessionId ||
          session.state !== "active" ||
          session.expiresAt <= now
        )
          throw new ComputerUseError(403, "Computer Use 会话未授权、已暂停或已过期", "session_unavailable");
        const combined = AbortSignal.any([
          session.abort.signal,
          AbortSignal.timeout(
            session.source === "global" ? timeoutMs : Math.min(timeoutMs, session.expiresAt - now)
          ),
          ...(signal ? [signal] : [])
        ]);
        combined.throwIfAborted();
        try {
          if (session.source === "global") {
            this.assertPolicy(taskId, session.mode);
            const target = await this.validateTarget(
              session.target.pid,
              session.target.windowId,
              session.mode,
              combined
            );
            if (target.bundleId !== session.target.bundleId) {
              this.endSession(session, "ended");
              throw new ComputerUseError(409, "目标窗口身份已改变，请重新选择");
            }
            combined.throwIfAborted();
          }
          const value = await work(session, combined);
          if (
            combined.aborted &&
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- work 的泛型返回值 T 没有约束，运行期可能为 null，而 typeof null === "object" 会让后面的 in 抛 TypeError
            value &&
            typeof value === "object" &&
            "dispatchStatus" in value &&
            value.dispatchStatus === "sent"
          ) {
            Object.assign(combined.reason as Error, {
              errorCode: combined.reason?.name === "TimeoutError" ? "driver_timeout" : "cancelled",
              dispatchStatus: "sent",
              requiresObservation: true
            });
          }
          combined.throwIfAborted();
          if (operation === "observe") this.record(session, operation, "completed");
          return value;
        } catch (error) {
          this.record(session, operation, "failed");
          throw error;
        }
      });
    this.tail = result;
    return result;
  }
  private record(session: Session, operation: string, outcome: string) {
    session.activity.push({ at: new Date(this.clock()).toISOString(), operation, outcome });
    session.activity = session.activity.slice(-30);
  }
  /** Read the last captured image without consuming or replacing the agent's observation. */
  preview(taskId: string) {
    const current = this.current(taskId);
    if (current?.state !== "active" || !this.session?.preview) return null;
    const { frame: _frame, accessibility, ...preview } = this.session.preview;
    return {
      ...preview,
      accessibility: accessibilityObservation(accessibility),
      target: current.target,
      sessionId: current.sessionId,
      mimeType: "image/png" as const
    };
  }
  private async captureFrame(session: Session, signal: AbortSignal) {
    const frame = await this.driver.observe(session.target, signal);
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 原生屏幕驱动可能返回空帧，声明类型比运行期窄
      !frame ||
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.width > 2048 ||
      frame.height > 2048 ||
      typeof frame.image !== "string" ||
      frame.image.length > 12 * 1024 * 1024 ||
      !Buffer.from(frame.image, "base64")
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new ComputerUseError(502, "屏幕驱动返回了无效图像");
    if (frame.accessibility !== undefined) {
      try {
        frame.accessibility = driverAccessibility(frame.accessibility);
      } catch {
        throw new ComputerUseError(502, "屏幕驱动返回了无效辅助功能树");
      }
    }
    signal.throwIfAborted();
    const capturedAt = new Date(this.clock()).toISOString();
    const captured = { ...frame, capturedAt };
    session.preview = captured;
    return captured;
  }
  private async capture(session: Session, signal: AbortSignal) {
    // A failed replacement observation must not leave an older action credential usable.
    session.observation = undefined;
    const captured = await this.captureFrame(session, signal);
    session.observation = { ...captured, observationId: randomUUID(), at: this.clock() };
    const { at: _at, frame: _frame, accessibility, ...observation } = session.observation;
    return {
      ...observation,
      accessibility: accessibilityObservation(accessibility, observation.observationId),
      target: session.target,
      mimeType: "image/png" as const
    };
  }
  /** A human preview shares the desktop queue without changing the agent's action credential. */
  refreshPreview(taskId: string, sessionId: string, signal?: AbortSignal) {
    return this.enqueue(
      taskId,
      sessionId,
      "observe",
      async (session, combined) => {
        const { frame: _frame, accessibility, ...preview } = await this.captureFrame(session, combined);
        return {
          ...preview,
          accessibility: accessibilityObservation(accessibility),
          target: session.target,
          sessionId,
          mimeType: "image/png" as const
        };
      },
      signal
    );
  }
  observe(taskId: string, sessionId: string, signal?: AbortSignal) {
    return this.enqueue(
      taskId,
      sessionId,
      "observe",
      async (session, combined) => {
        return this.capture(session, combined);
      },
      signal
    );
  }
  wait(taskId: string, sessionId: string, input: unknown, timeoutMs = 5_000, signal?: AbortSignal) {
    let condition;
    try {
      condition = computerWaitCondition(input);
    } catch (error) {
      throw new ComputerUseError(400, error instanceof Error ? error.message : "等待条件不合法");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw new ComputerUseError(400, "timeoutMs 必须是 1 至 30000 的整数");
    return this.enqueue(
      taskId,
      sessionId,
      "wait",
      async (session, combined) => {
        const started = performance.now();
        const deadline = AbortSignal.timeout(timeoutMs);
        const polling = AbortSignal.any([combined, deadline]);
        // Replace old credentials before waiting, including on cancellation or capture failure.
        session.observation = undefined;
        let observation: Awaited<ReturnType<ComputerUse["capture"]>> | undefined;
        const timedOut = () => {
          if (!observation)
            throw new ComputerUseError(408, "等待期限内未取得窗口观察", "wait_capture_timeout");
          this.record(session, "wait", "timeout");
          return {
            status: "timeout" as const,
            waitedMs: Math.round(performance.now() - started),
            observation
          };
        };
        for (;;) {
          combined.throwIfAborted();
          const previous = session.observation;
          try {
            observation = await this.capture(session, polling);
          } catch (error) {
            combined.throwIfAborted();
            if (!deadline.aborted) throw error;
            session.observation = previous;
            return timedOut();
          }
          if (waitConditionMet(session.observation!, condition)) {
            this.record(session, "wait", "condition_met");
            return {
              status: "condition_met" as const,
              waitedMs: Math.round(performance.now() - started),
              observation
            };
          }
          const remaining = timeoutMs - (performance.now() - started);
          if (remaining <= 0) return timedOut();
          await delay(Math.min(250, remaining), undefined, { signal: combined });
          if (deadline.aborted) return timedOut();
        }
      },
      signal,
      timeoutMs + 15_000
    );
  }
  act(
    taskId: string,
    sessionId: string,
    observationId: string,
    input: unknown,
    signal?: AbortSignal,
    observeAfter = false
  ) {
    const action = computerAction(input);
    return this.enqueue(
      taskId,
      sessionId,
      action.type,
      async (session, combined) => {
        if (session.mode !== "control") throw new ComputerUseError(403, "当前会话只允许观察");
        const observed = session.observation;
        if (!observed || observed.observationId !== observationId || this.clock() - observed.at > 30_000)
          throw new ComputerUseError(
            409,
            "观察结果已过期，请重新观察窗口后再操作",
            "stale_observation",
            "not_sent",
            true
          );
        if (action.type === "click" && (action.x >= observed.width || action.y >= observed.height))
          throw new ComputerUseError(400, "点击坐标超出观察图像");
        let nativeAction = action;
        if (action.type === "press" || action.type === "set_value") {
          const prefix = `${observationId}:`;
          const element =
            action.elementId.startsWith(prefix) &&
            observed.accessibility?.elements.find(
              (value) => `${prefix}${value.elementId}` === action.elementId
            );
          if (!element)
            throw new ComputerUseError(
              409,
              "控件 ID 不属于最近观察，请重新观察",
              "stale_element",
              "not_sent",
              true
            );
          if (!element.enabled || !element.actions.includes(action.type))
            throw new ComputerUseError(
              409,
              "控件未启用或不支持此辅助功能动作",
              "element_unavailable",
              "not_sent",
              true
            );
          nativeAction = { ...action, elementId: element.elementId };
        }
        // Every input consumes its observation, even when delivery fails: retrying
        // an uncertain click or keystroke must never duplicate a physical effect.
        session.observation = undefined;
        try {
          await this.driver.act(session.target, nativeAction, observed, combined);
        } catch (error) {
          if (error instanceof ComputerUseError) throw error;
          if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
            Object.assign(error, {
              errorCode: error.name === "AbortError" ? "cancelled" : "driver_timeout",
              dispatchStatus: "unknown",
              requiresObservation: true
            });
            throw error;
          }
          throw new ComputerUseError(
            502,
            error instanceof Error ? error.message : "输入投递状态未知",
            "driver_failed",
            "unknown",
            true
          );
        }
        this.record(session, action.type, "dispatched");
        if (combined.aborted) {
          const error = combined.reason as Error;
          Object.assign(error, {
            errorCode: error.name === "TimeoutError" ? "driver_timeout" : "cancelled",
            dispatchStatus: "sent",
            requiresObservation: true
          });
          throw error;
        }
        // completed is retained for existing HTTP consumers; it only acknowledges dispatch.
        const result = {
          completed: true,
          dispatched: true,
          dispatchStatus: "sent" as const,
          effectVerified: false
        };
        if (!observeAfter) return { ...result, requiresObservation: true };
        try {
          // Let the target's event loop and compositor present the dispatched input.
          // This is bounded settling time, not evidence of semantic completion.
          await delay(100, undefined, { signal: combined });
          const observation = await this.capture(session, combined);
          this.record(session, "observe", "completed");
          return { ...result, requiresObservation: false, observation };
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 上面的 throw 分支让 TS 把 combined.aborted 收窄为 false，但 delay 等待期间中止时 catch 仍会带着已中止的 signal 到达这里
          if (combined.aborted) {
            const aborted = combined.reason as Error;
            Object.assign(aborted, {
              errorCode: aborted.name === "TimeoutError" ? "driver_timeout" : "cancelled",
              dispatchStatus: "sent",
              requiresObservation: true
            });
            throw aborted;
          }
          this.record(session, "observe", "failed");
          // The action was already sent. A capture failure must not invite a retry of it.
          return {
            ...result,
            requiresObservation: true,
            observationErrorCode: error instanceof ComputerUseError ? error.errorCode : "observation_failed",
            observationError: error instanceof Error ? error.message : "操作后观察失败"
          };
        }
      },
      signal
    );
  }
}
