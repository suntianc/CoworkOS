import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSessionExportMetadata, writeSessionExport } from "../../dist/src/storage/session-export.js";
import { recordingProducer, sanitizeRecording } from "../../dist/src/storage/model-request-recorder.js";

const repository = "https://github.com/RUC-NLPIR/CoworkOS";
const ownedCommands = new Set(["export", "share", "bug", "changelog", "help"]);
export function atriaCommandInput(text: string) {
  const trimmed = text.trim();
  const command = trimmed.match(/^\/([a-z-]+)(\s+|$)/);
  if (!command || !ownedCommands.has(command[1])) return text;
  return `/coworkos-${command[1]}${command[2] ? " " : ""}${trimmed.slice(command[0].length)}`;
}

export function registerCliCommands(
  pi: ExtensionAPI,
  options: {
    workspaceRoot: string;
    taskId: string;
    runId: string;
    projectDirectory: string;
    secrets: readonly string[];
  }
) {
  const descriptions = new Map<string, string>();
  const exportCurrent = async (args: string, ctx: ExtensionContext) => {
    const match = args.trim().match(/^(json|html)(?:\s+|$)/);
    const path = (match ? args.trim().slice(match[0].length) : args).trim();
    const format = match?.[1] === "json" || (!match && path.endsWith(".json")) ? "json" : "html";
    const metadata = await readSessionExportMetadata(options.workspaceRoot, options.taskId);
    const result = await writeSessionExport({
      sessionId: ctx.sessionManager.getSessionId(),
      name: ctx.sessionManager.getSessionName(),
      projectDirectory: options.projectDirectory,
      taskId: options.taskId,
      ...metadata,
      runId: options.runId,
      entries: ctx.sessionManager.getEntries(),
      branchEntryIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
      format,
      outputPath: path || undefined,
      secrets: options.secrets
    });
    ctx.ui.notify(`CoworkOS 会话已导出：${result.outputPath}`, "info");
  };
  const register = (
    name: string,
    description: string,
    handler: (args: string, ctx: ExtensionContext) => Promise<void>
  ) => {
    descriptions.set(name, description);
    for (const prefix of ["coworkos", "atria"])
      pi.registerCommand(`${prefix}-${name}`, {
        description,
        handler: async (args, ctx) => {
          try {
            await handler(args, ctx);
          } catch (error) {
            ctx.ui.notify(
              `CoworkOS 命令失败：${sanitizeRecording(error instanceof Error ? error.message : String(error), options.secrets)}`,
              "error"
            );
          }
        }
      });
  };
  register("export", "Export the current CoworkOS session locally: [json|html] [file]", exportCurrent);
  register("share", "Save a local CoworkOS session export", async (args, ctx) => {
    await exportCurrent(args, ctx);
    ctx.ui.notify("CoworkOS 暂无云端分享服务；已保存本地文件，未上传会话。", "info");
  });
  register("bug", "Save a local CoworkOS feedback report: [description]", async (args, ctx) => {
    const output = resolve(options.projectDirectory, `coworkos-feedback-${randomUUID()}.json`);
    const report = sanitizeRecording(
      {
        schemaVersion: 1,
        format: "atria.feedback",
        producer: await recordingProducer(),
        createdAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        sessionId: ctx.sessionManager.getSessionId(),
        taskId: options.taskId,
        runId: options.runId,
        description: args.trim(),
        issuesUrl: `${repository}/issues`
      },
      options.secrets
    );
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    ctx.ui.notify(
      `CoworkOS 反馈报告已保存：${output}\n提交入口：${repository}/issues\n报告未自动上传。`,
      "info"
    );
  });
  register("changelog", "Show CoworkOS changes and update command", async (_args, ctx) => {
    ctx.ui.notify(
      `CoworkOS 更新记录：${repository}/commits/main/\n检查更新：coworkos update --check`,
      "info"
    );
  });
  register("help", "Show CoworkOS commands", async (_args, ctx) => {
    ctx.ui.notify(
      "CoworkOS 命令\n/export [json|html] [file]：本地导出\n/share [file]：本地分享副本\n/bug [描述]：本地反馈报告\n/changelog：更新记录\n/model、/thinking、/settings：运行设置\n/coworkos-debug：诊断\n退出后用 coworkos --continue 或 coworkos --session ID 继续。",
      "info"
    );
  });
  return {
    configure(ctx: ExtensionContext) {
      if (ctx.mode !== "tui") return;
      ctx.ui.addAutocompleteProvider((current) => ({
        triggerCharacters: current.triggerCharacters,
        async getSuggestions(...args) {
          const suggestions = await current.getSuggestions(...args);
          if (!suggestions?.prefix.startsWith("/")) return suggestions;
          return {
            ...suggestions,
            items: suggestions.items.map((item) => {
              const description = descriptions.get(item.value.replace(/^\//, ""));
              return description ? { ...item, description } : item;
            })
          };
        },
        applyCompletion: current.applyCompletion.bind(current),
        shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current)
      }));
      const previous = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor = previous
          ? previous(tui, theme, keybindings)
          : new CustomEditor(tui, theme, keybindings);
        const getText = editor.getText.bind(editor);
        const getExpandedText = editor.getExpandedText?.bind(editor);
        // Follow-up and compaction submissions read directly from the editor
        // without onSubmit. Project those public reads before command dispatch.
        editor.getText = () => atriaCommandInput(getText());
        if (getExpandedText) editor.getExpandedText = () => atriaCommandInput(getExpandedText());
        let submit = editor.onSubmit;
        // The SDK assigns onSubmit after the factory returns. Intercept the common
        // submission boundary instead of one key sequence.
        Object.defineProperty(editor, "onSubmit", {
          configurable: true,
          get: () => (submit ? (text: string) => submit?.call(editor, atriaCommandInput(text)) : undefined),
          set: (value) => {
            submit = value;
          }
        });
        return editor;
      });
    }
  };
}
