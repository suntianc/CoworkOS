import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RuntimeToolResult } from "./helpers.ts";

export interface CliDiagnostics {
  workspaceRoot: string;
  taskId: string;
  mainRunId: string;
  modelId: string;
  supervisor: string;
  tools: string[];
  guessedProtection: boolean;
  protectedPaths: readonly string[];
}

function clean(value: string): string {
  return stripTerminalSequences(value);
}

function versionAt(root: string): string {
  try {
    const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    return typeof value === "string" ? value : "";
    // eslint-disable-next-line no-restricted-syntax -- harnessRoot 可能不是这个产品的根目录（缺少 package.json 或内容不是 JSON），版本号只用于页眉展示，缺失时显示空串
  } catch {
    return "";
  }
}

/** Presentation only: no changes to model messages, tool data or RPC state. */
export function createCliPresentation(
  pi: ExtensionAPI,
  options: { harnessRoot: string; projectDirectory: string }
) {
  let debug = ["1", "true"].includes(process.env.ATRIA_DEBUG ?? "");
  let diagnostics: CliDiagnostics | undefined;
  const renderDiagnostics = (ctx: ExtensionContext) => {
    if (!diagnostics) return;
    ctx.ui.notify(
      [
        "CoworkOS diagnostics",
        `workspace=${diagnostics.workspaceRoot}`,
        `task=${diagnostics.taskId}; run=${diagnostics.mainRunId}; model=${diagnostics.modelId}`,
        diagnostics.supervisor,
        `active tools: ${diagnostics.tools.join(", ")}`,
        ...(diagnostics.guessedProtection
          ? [
              `Evaluation paths use defaults (${diagnostics.protectedPaths.join(", ")}). Set COWORK_EVAL_PATHS for other evaluation files.`
            ]
          : [])
      ]
        .map(clean)
        .join("\n"),
      "info"
    );
  };
  for (const name of ["coworkos-debug", "atria-debug"])
    pi.registerCommand(name, {
      description: "Show CoworkOS runtime diagnostics; on/off controls detailed tool output",
      handler: async (args, ctx) => {
        const choice = args.trim();
        if (!["", "on", "off"].includes(choice)) {
          ctx.ui.notify("用法：/coworkos-debug [on|off]", "warning");
          return;
        }
        if (choice === "off") {
          debug = false;
          ctx.ui.notify("CoworkOS 详细诊断已关闭；Ctrl+O 仍可展开单次工具结果。", "info");
          return;
        }
        debug = true;
        renderDiagnostics(ctx);
      }
    });
  return {
    debug: () => debug,
    configure(ctx: ExtensionContext) {
      if (ctx.mode !== "tui") return;
      const version = versionAt(options.harnessRoot);
      ctx.ui.setHeader(
        (_tui, theme) =>
          new Text(
            [
              `${theme.bold(theme.fg("accent", "CoworkOS"))}${version ? theme.fg("dim", ` v${clean(version)}`) : ""}`,
              theme.fg("muted", `项目：${clean(options.projectDirectory)}`),
              theme.fg("dim", "输入任务开始 · /help 查看命令 · Ctrl+D 退出 · Ctrl+O 展开详情")
            ].join("\n"),
            0,
            0
          )
      );
      ctx.ui.setTitle(`CoworkOS — ${clean(basename(options.projectDirectory))}`);
    },
    startup(ctx: ExtensionContext, value: CliDiagnostics) {
      diagnostics = value;
      if (ctx.mode !== "tui") return false;
      if (debug) renderDiagnostics(ctx);
      return true;
    }
  };
}

function detailRecord(result: RuntimeToolResult): Record<string, unknown> {
  if (result.details && typeof result.details === "object" && !Array.isArray(result.details))
    return result.details as Record<string, unknown>;
  try {
    const text = result.content.find((part) => part.type === "text");
    const value = text?.type === "text" ? JSON.parse(text.text) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    // eslint-disable-next-line no-restricted-syntax -- 工具正文是模型可读的自由文本，子任务失败时通常是纯文本而非 JSON；解析失败只表示没有结构化详情
  } catch {
    return {};
  }
}

function userResponse(details: Record<string, unknown>): string {
  if (typeof details.response !== "string") return "";
  const response = details.response;
  const diagnostics = details.diagnostics;
  if (
    !diagnostics ||
    typeof diagnostics !== "object" ||
    Array.isArray(diagnostics) ||
    typeof details.status !== "string"
  )
    return response;
  const paths = diagnostics as Record<string, unknown>;
  if (typeof paths.tracePath !== "string" || typeof paths.resultPath !== "string") return response;
  const files: string[] =
    Array.isArray(details.outputFiles) && details.outputFiles.every((file) => typeof file === "string")
      ? details.outputFiles
      : [];
  const metadata = [`[Coordinator] status=${details.status}`];
  if (files.length)
    metadata.push(
      `Candidate outputs (Task-relative paths for browse_workspace; review before copying accepted final files into Task artifacts/):\n${files.map((path) => `- ${path}`).join("\n")}`
    );
  metadata.push(`Diagnostics (Task-relative): trace=${paths.tracePath}; result=${paths.resultPath}`);
  if (typeof details.error === "string" && details.error) metadata.push(`error=${details.error}`);
  const suffix = `\n\n${metadata.join("\n")}`;
  // Only a complete runtime-generated suffix matching the structured result
  // is presentation metadata. Similar text in the agent's answer stays intact.
  return response.endsWith(suffix) ? response.slice(0, -suffix.length) : response;
}

export function delegationResultText(
  result: RuntimeToolResult,
  options: ToolRenderResultOptions,
  debug = false
): string {
  if (options.isPartial) return "子任务处理中…";
  if (options.expanded || debug)
    return clean(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    );
  const details = detailRecord(result);
  if (details.accepted === true)
    return `${typeof details.name === "string" ? `${clean(details.name)} · ` : ""}子任务已接受，完成后返回结果。`;
  const states: Record<string, string> = {
    succeeded: "子任务完成",
    failed: "子任务失败",
    timed_out: "子任务超时",
    cancelled: "子任务已取消",
    aborted: "子任务中断"
  };
  const state =
    typeof details.status === "string"
      ? (states[details.status] ?? clean(details.status))
      : details.ok === false || result.isError
        ? "子任务失败"
        : "子任务返回";
  const response = clean(userResponse(details)).trim();
  const error = typeof details.error === "string" ? clean(details.error).trim() : "";
  const nativeError =
    result.isError && !response && !error
      ? clean(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        ).trim()
      : "";
  const lines = [
    state,
    ...(response ? [response] : []),
    ...(error ? [error] : []),
    ...(nativeError ? [nativeError] : [])
  ];
  const files = Array.isArray(details.outputFiles)
    ? details.outputFiles.length
    : Array.isArray(details.artifacts)
      ? details.artifacts.length
      : 0;
  if (files) lines.push(`产出文件：${files} 个`);
  return lines.join("\n");
}

export function delegationRenderers(debug: () => boolean) {
  return {
    renderCall(args: { task: string; mode: string }, theme: Theme) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- renderCall 在流式渲染时会收到尚未解析完整的参数对象（argsComplete 之前），task 此时可能还没有出现
      const task = clean(args.task ?? "")
        .replaceAll(/\s+/g, " ")
        .trim();
      const summary = task.length > 160 ? `${task.slice(0, 157)}…` : task;
      return new Text(
        `${theme.bold(theme.fg("toolTitle", "委派子任务"))} ${theme.fg("accent", summary || "…")}`,
        0,
        0
      );
    },
    renderResult(
      result: RuntimeToolResult,
      options: ToolRenderResultOptions,
      theme: Theme,
      context?: { isError?: boolean }
    ) {
      const displayResult = context?.isError ? { ...result, isError: true } : result;
      const details = detailRecord(displayResult);
      const failed = details.ok === false || details.status === "failed" || displayResult.isError;
      return new Text(
        theme.fg(failed ? "error" : "toolOutput", delegationResultText(displayResult, options, debug())),
        0,
        0
      );
    }
  };
}
