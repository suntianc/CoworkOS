import { StringDecoder } from "node:string_decoder";
import type { ConversationMessage } from "../runtime/conversation-view.js";
import { modelErrorCode } from "../runtime/model-error.js";

const MAX_EVENT_CHARS = 8 * 1024 * 1024;

/** Observe this process's terminal messages without rereading an older Pi snapshot. */
export class MainRunOutput {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private discarding = false;
  message?: ConversationMessage;

  write(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  finish(): void {
    this.consume(this.decoder.end());
    if (!this.discarding && this.pending) this.readLine(this.pending);
    this.pending = "";
  }

  private consume(text: string): void {
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      if (!this.discarding) {
        if (this.pending.length + part.length > MAX_EVENT_CHARS) {
          // Preserve all bytes in runtime-output.log. An oversized/malformed
          // event cannot be evidence that an earlier response completed this run.
          this.pending = "";
          this.discarding = true;
          this.message = undefined;
        } else this.pending += part;
      }
      if (part.endsWith("\n")) {
        if (!this.discarding) this.readLine(this.pending);
        this.pending = "";
        this.discarding = false;
      }
    }
  }

  private readLine(line: string): void {
    let event: { type?: unknown; message?: Record<string, unknown> };
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      event = value;
      // eslint-disable-next-line no-restricted-syntax -- Main 进程 stdout 会夹带非 JSON 的日志或半行输出，解析失败只说明该行不是事件，不能据此判定 Run 结束
    } catch {
      return;
    }
    if (event.type === "agent_start") {
      this.message = undefined;
      return;
    }
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (event.type === "message_start" && message.role === "assistant") this.message = undefined;
    if (event.type !== "message_end") return;
    if (message.role === "user") this.message = undefined;
    else if (message.role === "assistant")
      this.message = {
        role: "assistant",
        content: message.content,
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined
      };
  }
}

export interface MainRunFailure {
  kind: "model_request" | "main_process";
  stopReason?: string;
  /** Only present when Pi's actual model error has an explicit HTTP error prefix. */
  httpStatus?: number;
  providerCode?: "model_not_found";
}

export function mainRunFailure(
  message: ConversationMessage | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
  spawnError?: Error
): { error: string; failure: MainRunFailure } {
  if (!spawnError && message?.role === "assistant" && message.stopReason === "error") {
    const error = message.errorMessage || "模型请求失败";
    const status =
      /^(?:HTTP(?: status(?: code)?)?\s*[:=]?\s*)?([45]\d{2})(?=\b|:)/i.exec(error) ??
      /^[\w.-]+ API error \(([45]\d{2})\):/i.exec(error);
    const providerCode = status?.[1] === "404" ? modelErrorCode(error) : undefined;
    return {
      error,
      failure: {
        kind: "model_request",
        stopReason: "error",
        ...(status ? { httpStatus: Number(status[1]) } : {}),
        ...(providerCode ? { providerCode } : {})
      }
    };
  }
  return {
    error: spawnError?.message ?? `Main process exited with code=${code ?? ""} signal=${signal ?? ""}`,
    failure: { kind: "main_process" }
  };
}
