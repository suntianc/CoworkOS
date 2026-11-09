import { setImmediate as yieldToHost } from "node:timers/promises";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSDeferredPromise,
  type QuickJSHandle
} from "quickjs-emscripten";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { installCuaGuest } from "./cua-script-guest.js";

const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
export const CUA_SCRIPT_LIMITS = Object.freeze({
  codeBytes: 64 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  hostCalls: 64,
  outputBytes: 128 * 1024,
  metadataBytes: 512 * 1024,
  imageBytes: 10 * 1024 * 1024,
  images: 4,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 60_000,
  cpuSliceMs: 50
});
export interface CuaScriptToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
  details?: unknown;
  isError?: boolean;
}
export interface CuaScriptResult extends CuaScriptToolResult {
  details: Record<string, unknown>;
}
export type CuaScriptDispatcher = (
  name: string,
  params: Record<string, unknown>,
  signal: AbortSignal
) => Promise<CuaScriptToolResult>;
type CallSummary = {
  toolName: string;
  status: "pending" | "completed" | "error";
  dispatchStatus?: string;
  errorCode?: string;
  sessionId?: string;
  pageId?: string;
  observationId?: string;
  imageRef?: string;
};
interface Cell {
  abort: AbortController;
  signal: AbortSignal;
  deadline: number;
  cpuDeadline: number;
  accepting: boolean;
  dispatcher: CuaScriptDispatcher;
  pending: Set<QuickJSDeferredPromise>;
  deferred: Set<QuickJSDeferredPromise>;
  hostTail: Promise<unknown>;
  calls: CallSummary[];
  logs: string[];
  images: Array<{ type: "image"; mimeType: string; data: string }>;
  supersededImages: number;
  outputBytes: number;
  wake?: () => void;
}
const HOST_TOOLS = new Set([
  "computer_status",
  "computer_discover",
  "computer_select",
  "computer_release",
  "computer_observe",
  "computer_wait",
  "computer_act",
  "browser_open",
  "browser_observe",
  "browser_act",
  "browser_wait",
  "browser_close"
]);
const MUTATIONS = new Set(["computer_act", "browser_act", "browser_open"]);
const imageRefPattern = /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class ScriptFailure extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly metadata: Record<string, unknown> = {}
  ) {
    super(message);
  }
}
function clean(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new ScriptFailure("output_limit", "CUA result nesting exceeds the limit");
  if (Array.isArray(value)) return value.map((entry) => clean(entry, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["image", "data"].includes(key))
        .map(([key, entry]) => [key, clean(entry, depth + 1)])
    );
  return value;
}
function resultMetadata(result: CuaScriptToolResult): Record<string, unknown> {
  if (result.details !== undefined) {
    const value = clean(result.details);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  }
  const text = result.content.find((block) => block.type === "text");
  if (!text) return {};
  if (Buffer.byteLength(text.text) > CUA_SCRIPT_LIMITS.metadataBytes)
    throw new ScriptFailure("output_limit", "CUA tool text exceeds the limit");
  try {
    const value = clean(JSON.parse(text.text));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch (error) {
    if (error instanceof ScriptFailure) throw error;
    return { text: text.text };
  }
}
function summarize(summary: CallSummary, value: Record<string, unknown>) {
  const observed =
    value.observation && typeof value.observation === "object"
      ? (value.observation as Record<string, unknown>)
      : value;
  const session =
    value.session && typeof value.session === "object" ? (value.session as Record<string, unknown>) : value;
  for (const field of ["dispatchStatus", "errorCode"] as const)
    if (typeof value[field] === "string") summary[field] = String(value[field]).slice(0, 128);
  if (typeof session.sessionId === "string") summary.sessionId = session.sessionId.slice(0, 256);
  for (const field of ["pageId", "observationId", "imageRef"] as const)
    if (typeof observed[field] === "string") summary[field] = String(observed[field]).slice(0, 256);
}
function certainty(cell?: Cell) {
  const calls = cell?.calls.filter((call) => MUTATIONS.has(call.toolName)) || [];
  return calls.some((call) => call.dispatchStatus === "unknown")
    ? "unknown"
    : calls.some((call) => call.dispatchStatus === "sent")
      ? "sent"
      : "not_sent";
}

/** Persistent QuickJS control state with JSON-only, allowlisted calls to existing tools. */
export class CuaScriptController {
  private runtime?: QuickJSRuntime;
  private context?: QuickJSContext;
  private active?: Cell;
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private closed = false;
  private disposeVM() {
    this.context?.dispose();
    this.context = undefined;
    this.runtime?.dispose();
    this.runtime = undefined;
  }
  private initialize() {
    if (this.context) return;
    const runtime = (this.runtime = QuickJS.newRuntime());
    runtime.setMemoryLimit(CUA_SCRIPT_LIMITS.memoryBytes);
    // Keep the guest limit below the surrounding WASM/V8 stack, including JSON recursion.
    runtime.setMaxStackSize(128 * 1024);
    runtime.setInterruptHandler(() =>
      Boolean(
        this.active &&
        (this.active.signal.aborted ||
          Date.now() >= this.active.deadline ||
          Date.now() >= this.active.cpuDeadline)
      )
    );
    // No module loader, host eval, filesystem, Node objects or network are exposed.
    const context = (this.context = runtime.newContext());
    const vmError = (error: unknown) => {
      const failure = error as Error & { errorCode?: string };
      const handle = context.newError({
        name: "CuaScriptError",
        message: failure.message || "CUA bridge failed"
      });
      context
        .newString(failure.errorCode || "host_failed")
        .consume((code) => context.setProp(handle, "errorCode", code));
      return { error: handle };
    };
    context
      .newFunction("__cuaRpc", (name, params) => {
        try {
          return this.rpc(context.getString(name), context.getString(params));
        } catch (error) {
          return vmError(error);
        }
      })
      .consume((handle) => context.setProp(context.global, "__cuaRpc", handle));
    context
      .newFunction("__cuaPrint", (value) => {
        try {
          const cell = this.active;
          if (!cell?.accepting) throw new Error("No active CUA cell");
          const line = context.getString(value);
          cell.outputBytes += Buffer.byteLength(line);
          if (cell.outputBytes > CUA_SCRIPT_LIMITS.outputBytes)
            throw new ScriptFailure("output_limit", "CUA console output exceeds the limit");
          cell.logs.push(line);
        } catch (error) {
          return vmError(error);
        }
      })
      .consume((handle) => context.setProp(context.global, "__cuaPrint", handle));
    context.unwrapResult(context.evalCode(`(${installCuaGuest.toString()})();`, "cua-sdk.js")).dispose();
  }
  private rpc(name: string, body: string): QuickJSHandle {
    const cell = this.active,
      context = this.context!;
    if (!cell?.accepting || cell.signal.aborted)
      throw new ScriptFailure("cancelled", "CUA cell is no longer active");
    if (
      (!HOST_TOOLS.has(name) && name !== "__emit_image") ||
      cell.calls.length >= CUA_SCRIPT_LIMITS.hostCalls
    )
      throw new ScriptFailure(
        HOST_TOOLS.has(name) || name === "__emit_image" ? "host_call_limit" : "tool_not_allowed",
        "CUA host call is unavailable or exceeds the limit"
      );
    if (Buffer.byteLength(body) > CUA_SCRIPT_LIMITS.codeBytes)
      throw new ScriptFailure("input_limit", "CUA parameters exceed the limit");
    const params: unknown = JSON.parse(body);
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw new ScriptFailure("invalid_argument", "CUA parameters must be an object");
    if (
      name === "__emit_image" &&
      (Object.keys(params).length !== 1 ||
        !imageRefPattern.test(String((params as Record<string, unknown>).imageRef)))
    )
      throw new ScriptFailure("invalid_argument", "emitImage accepts only a Task imageRef");
    const toolName = name === "__emit_image" ? "read_image" : name;
    const deferred = context.newPromise();
    cell.pending.add(deferred);
    cell.deferred.add(deferred);
    const summary: CallSummary = {
      toolName,
      status: "pending",
      ...(MUTATIONS.has(toolName) ? { dispatchStatus: "not_sent" } : {})
    };
    cell.calls.push(summary);
    let started = false;
    let received = false;
    const execute = async () => {
      try {
        cell.signal.throwIfAborted();
        if (!cell.accepting || this.active !== cell)
          throw new ScriptFailure("cancelled", "CUA cell is no longer active");
        started = true;
        if (MUTATIONS.has(toolName)) summary.dispatchStatus = "unknown";
        const result = await cell.dispatcher(toolName, params as Record<string, unknown>, cell.signal);
        received = true;
        // Record certainty before processing images/large metadata or touching the guest.
        const direct = result.details;
        let knownDispatch = false;
        if (direct && typeof direct === "object" && "dispatchStatus" in direct)
          if (["sent", "unknown", "not_sent"].includes(String(direct.dispatchStatus))) {
            summary.dispatchStatus = String(direct.dispatchStatus);
            knownDispatch = true;
          }
        if (MUTATIONS.has(toolName) && !knownDispatch && !result.isError) summary.dispatchStatus = "sent";
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cell.accepting 会在 run 的 finally 里被置为 false，TS 看不到 await 期间的闭包写入
        if (!cell.accepting || this.active !== cell || cell.signal.aborted) return;
        const value = resultMetadata(result);
        summarize(summary, value);
        if (MUTATIONS.has(toolName) && typeof value.dispatchStatus !== "string")
          summary.dispatchStatus = result.isError ? "unknown" : "sent";
        summary.status = result.isError ? "error" : "completed";
        for (const block of result.content)
          if (block.type === "image") {
            if (
              !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) ||
              Buffer.byteLength(block.data, "base64") > CUA_SCRIPT_LIMITS.imageBytes
            )
              throw new ScriptFailure("output_limit", "CUA image exceeds the limit");
            cell.images.push({ ...block });
            if (cell.images.length > CUA_SCRIPT_LIMITS.images) {
              cell.images.shift();
              cell.supersededImages++;
            }
          }
        const json = JSON.stringify(result.isError ? { ok: false, error: value } : { ok: true, value });
        if (Buffer.byteLength(json) > CUA_SCRIPT_LIMITS.metadataBytes)
          throw new ScriptFailure("output_limit", "CUA tool metadata exceeds the limit");
        context.newString(json).consume((handle) => deferred.resolve(handle));
      } catch (error) {
        if (!cell.accepting || this.active !== cell) return;
        const failure = error as Error & {
          errorCode?: string;
          dispatchStatus?: string;
          requiresObservation?: boolean;
        };
        summary.status = "error";
        summary.errorCode = failure.errorCode || (cell.signal.aborted ? "cancelled" : "host_failed");
        if (MUTATIONS.has(toolName))
          summary.dispatchStatus =
            failure.dispatchStatus || (received ? summary.dispatchStatus : started ? "unknown" : "not_sent");
        if (!cell.signal.aborted)
          context
            .newString(
              JSON.stringify({
                ok: false,
                error: {
                  error: failure.message || "CUA host failed",
                  errorCode: summary.errorCode,
                  dispatchStatus: summary.dispatchStatus || "not_sent",
                  requiresObservation: failure.requiresObservation ?? MUTATIONS.has(toolName)
                }
              })
            )
            .consume((handle) => deferred.resolve(handle));
      } finally {
        cell.pending.delete(deferred);
        cell.wake?.();
      }
    };
    // eslint-disable-next-line no-restricted-syntax -- 上一次宿主调用的失败已通过 deferred 回给 guest，这里只维护串行队列让下一次调用继续
    cell.hostTail = cell.hostTail.catch(() => {}).then(execute);
    return deferred.handle;
  }
  private slice<T>(cell: Cell, work: () => T): T {
    cell.cpuDeadline = Math.min(cell.deadline, Date.now() + CUA_SCRIPT_LIMITS.cpuSliceMs);
    return work();
  }
  private guestError(handle: QuickJSHandle): Record<string, unknown> {
    const context = this.context!;
    // Never FFI-dump an arbitrary thrown graph: only the SDK's shallow data fields.
    const reader = context.getProp(context.global, "__cuaFailure");
    try {
      const result = context.callFunction(reader, context.undefined, handle);
      if (result.error) {
        result.error.dispose();
        return {
          message: this.active && Date.now() >= this.active.cpuDeadline ? "interrupted" : "CUA script failed"
        };
      }
      try {
        return (JSON.parse(context.getString(result.value)) as { error: Record<string, unknown> }).error;
      } finally {
        result.value.dispose();
      }
    } finally {
      reader.dispose();
      handle.dispose();
    }
  }
  execute(
    input: { code: string; timeoutMs?: number },
    dispatcher: CuaScriptDispatcher,
    signal?: AbortSignal
  ): Promise<CuaScriptResult> {
    const version = this.epoch;
    // eslint-disable-next-line no-restricted-syntax -- 上一次脚本执行的失败已返回给它的调用方，这里只需保证后续脚本仍能排队执行
    const result = this.tail.catch(() => {}).then(() => this.run(input, dispatcher, signal, version));
    this.tail = result;
    return result;
  }
  private async run(
    input: { code: string; timeoutMs?: number },
    dispatcher: CuaScriptDispatcher,
    signal: AbortSignal | undefined,
    version: number
  ): Promise<CuaScriptResult> {
    let cell: Cell | undefined, promise: QuickJSHandle | undefined;
    let succeeded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.closed || version !== this.epoch)
        throw new ScriptFailure("session_reset", "CUA script session was reset or closed");
      if (
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 脚本参数来自模型工具调用，声明类型比运行期窄，缺失 input 时不能直接读 code
        !input ||
        typeof input.code !== "string" ||
        Buffer.byteLength(input.code) > CUA_SCRIPT_LIMITS.codeBytes
      )
        throw new ScriptFailure("input_limit", "CUA code must be a string of at most 64 KiB");
      const timeoutMs = input.timeoutMs ?? CUA_SCRIPT_LIMITS.defaultTimeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CUA_SCRIPT_LIMITS.maxTimeoutMs)
        throw new ScriptFailure("invalid_argument", "CUA timeout must be 1 to 60000 ms");
      signal?.throwIfAborted();
      this.initialize();
      const abort = new AbortController();
      const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
      cell = {
        abort,
        signal: combined,
        deadline: Date.now() + timeoutMs,
        cpuDeadline: Infinity,
        accepting: true,
        dispatcher,
        pending: new Set(),
        deferred: new Set(),
        hostTail: Promise.resolve(),
        calls: [],
        logs: [],
        images: [],
        supersededImages: 0,
        outputBytes: 0
      };
      this.active = cell;
      timer = setTimeout(
        () => abort.abort(new ScriptFailure("script_timeout", "CUA cell timed out")),
        timeoutMs
      );
      const context = this.context!,
        runtime = this.runtime!;
      const evaluated = this.slice(cell, () =>
        context.evalCode(
          `(async () => { try { const value = await (async () => {\n${input.code}\n})(); return __cuaResult({ok:true,value:value === undefined ? null : value}); } catch(error) { return __cuaFailure(error); } })()`,
          "cua-cell.js"
        )
      );
      if (evaluated.error) {
        const error = this.guestError(evaluated.error);
        throw new ScriptFailure("script_error", String(error.message || "CUA evaluation failed"), error);
      }
      promise = evaluated.value;
      for (;;) {
        combined.throwIfAborted();
        const jobs = this.slice(cell, () => runtime.executePendingJobs(32));
        if (jobs.error) {
          const error = this.guestError(jobs.error);
          throw new ScriptFailure("script_error", String(error.message || "CUA promise failed"), error);
        }
        const state = context.getPromiseState(promise);
        if (state.type === "rejected") {
          const error = this.guestError(state.error);
          throw new ScriptFailure("script_error", String(error.message || "CUA script failed"), error);
        }
        if (state.type === "fulfilled") {
          if (cell.pending.size) {
            state.value.dispose();
            throw new ScriptFailure(
              "unawaited_host_call",
              "Await every CUA operation; unfinished calls were cancelled"
            );
          }
          if (runtime.hasPendingJob()) {
            state.value.dispose();
            await yieldToHost();
            continue;
          }
          const json = context.getString(state.value);
          state.value.dispose();
          const reply = JSON.parse(json) as { ok: boolean; value?: unknown; error?: Record<string, unknown> };
          if (!reply.ok)
            throw new ScriptFailure(
              "script_error",
              String(reply.error?.message || "CUA script failed"),
              reply.error
            );
          if (Buffer.byteLength(json) + cell.outputBytes > CUA_SCRIPT_LIMITS.outputBytes)
            throw new ScriptFailure("output_limit", "CUA output exceeds the limit");
          const details = {
            value: reply.value,
            logs: cell.logs,
            calls: cell.calls.map((call) => ({ ...call })),
            dispatchStatus: certainty(cell),
            vmReset: false,
            visualFeedback: { delivered: cell.images.length, superseded: cell.supersededImages }
          };
          if (Buffer.byteLength(JSON.stringify(details)) > CUA_SCRIPT_LIMITS.outputBytes)
            throw new ScriptFailure("output_limit", "CUA output exceeds the limit");
          succeeded = true;
          return { content: [{ type: "text", text: JSON.stringify(details) }, ...cell.images], details };
        }
        // Yield every batch, even pure Promise loops, so host cancellation remains responsive.
        if (runtime.hasPendingJob()) await yieldToHost();
        else
          await new Promise<void>((wake) => {
            const finish = () => {
              cell!.signal.removeEventListener("abort", finish);
              cell!.wake = undefined;
              wake();
            };
            cell!.wake = finish;
            cell!.signal.addEventListener("abort", finish, { once: true });
            if (cell!.signal.aborted) finish();
          });
      }
    } catch (error) {
      const failure = error as Error & { errorCode?: string; metadata?: Record<string, unknown> };
      const interrupted = failure.message === "interrupted";
      const errorCode = cell?.signal.aborted
        ? cell.signal.reason?.errorCode || "cancelled"
        : interrupted
          ? Date.now() >= cell!.deadline
            ? "script_timeout"
            : "cpu_budget_exceeded"
          : typeof failure.metadata?.errorCode === "string"
            ? failure.metadata.errorCode.slice(0, 128)
            : /out of memory/i.test(failure.message || "")
              ? "memory_limit"
              : failure.errorCode || "script_error";
      if (cell) {
        cell.accepting = false;
        cell.abort.abort(error);
      }
      // Allow an already-resolved dispatcher completion to record known certainty.
      // Queued work has been cancelled above; this does not wait for a held backend.
      await Promise.resolve();
      if (cell)
        for (const call of cell.calls)
          if (call.status === "pending") {
            call.status = "error";
            call.errorCode = errorCode;
            if (MUTATIONS.has(call.toolName)) call.dispatchStatus ||= "unknown";
          }
      const details = {
        error: String(failure.message || "CUA script failed").slice(0, 2048),
        ...(failure.metadata &&
          Object.fromEntries(
            Object.entries(failure.metadata)
              .filter(
                ([key, value]) =>
                  ["name", "stack", "status", "authorizationRequired", "nextStep"].includes(key) &&
                  ["string", "number", "boolean"].includes(typeof value)
              )
              .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 2048) : value])
          )),
        errorCode,
        dispatchStatus: certainty(cell),
        requiresObservation: certainty(cell) !== "not_sent",
        vmReset: true,
        logs: [...(cell?.logs || [])],
        calls: cell?.calls.map((call) => ({ ...call })) || []
      };
      // Retain action certainty even when logs alone filled the output budget.
      while (
        Buffer.byteLength(JSON.stringify(details)) > CUA_SCRIPT_LIMITS.outputBytes &&
        details.logs.length
      )
        details.logs.pop();
      return {
        content: [{ type: "text", text: JSON.stringify(details) }, ...(cell?.images || [])],
        details,
        isError: true
      };
    } finally {
      clearTimeout(timer);
      if (cell) {
        cell.accepting = false;
        cell.abort.abort();
        cell.wake?.();
      }
      promise?.dispose();
      for (const deferred of cell?.deferred || []) deferred.dispose();
      if (this.active === cell) this.active = undefined;
      // Uncaught errors, timeout or cancellation reset the whole guest, dropping pending callbacks.
      if (!succeeded || version !== this.epoch) this.disposeVM();
    }
  }
  async reset() {
    this.epoch++;
    this.active?.abort.abort(new ScriptFailure("session_reset", "CUA script state was reset"));
    // eslint-disable-next-line no-restricted-syntax -- 重置只需等待队列排空，正在运行的脚本失败已由它自己的 Promise 上报
    await this.tail.catch(() => {});
    this.disposeVM();
  }
  async dispose() {
    this.closed = true;
    await this.reset();
  }
}
