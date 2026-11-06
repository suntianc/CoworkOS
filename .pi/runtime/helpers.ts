import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readHostCoworkConfig, type CoworkConfig } from "../../dist/src/runtime/config.js";
export type RuntimeToolResult = AgentToolResult<unknown> & { isError?: boolean };

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Bound a model-supplied count to a usable range, falling back when absent or invalid. */
export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

/**
 * Model work is unlimited by default. A non-zero value is still available
 * for deployments that need a hard budget; zero deliberately disables the
 * PiSession wall-clock abort rather than meaning "one millisecond".
 */
export function textFromMessage(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join(" ");
}

export function loadConfig(): CoworkConfig {
  return readHostCoworkConfig(
    process.env.COWORK_CONFIG_ROOT ?? process.env.COWORK_HARNESS_ROOT ?? process.cwd()
  );
}
