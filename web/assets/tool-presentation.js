import { ui } from "./ui/language.js";
import { describeCommand } from "./tool-command.js";
import { explainToolFailure, technicalText, unpackToolResult } from "./tool-diagnostics.js";
import { toolLifecycle } from "./tool-lifecycle.js";
import { toolExecutionFailed } from "./tool-result.js";

const titles = {
  list_applications: ui("查看可用应用"),
  list_resources: ui("查看应用文档"),
  list_resource_changes: ui("查看文档变化"),
  create_resource: ui("创建文档"),
  accept_resource_candidate: ui("采用文档版本"),
  open_resource: ui("打开文档"),
  export_resource: ui("导出文档"),
  apply_resource_operation: ui("修改应用文档"),
  computer_status: ui("查看电脑操作状态"),
  computer_observe: ui("观察授权窗口"),
  computer_act: ui("操作授权窗口"),
  call_subagent: ui("委派任务"),
  get_task_status: ui("查看任务状态"),
  get_subagent_status: ui("查看团队进度"),
  wait_for_subagents: ui("等待协作结果"),
  send_subagent_message: ui("补充任务说明"),
  cancel_subagent: ui("取消协作任务"),
  finish_task: ui("确认任务完成"),
  askhuman: ui("询问你的意见"),
  clear_context: ui("整理工作上下文"),
  enable_tools: ui("启用所需工具"),
  grant_capabilities: ui("授权执行能力"),
  activate_virtual_agent: ui("启用持续关注"),
  sleep_until: ui("等待新的进展"),
  create_watcher: ui("创建持续监控"),
  browse_workspace: ui("查看任务文件"),
  read_attachment: ui("读取附件"),
  read: ui("读取文件"),
  read_file: ui("读取文件"),
  write: ui("写入文件"),
  write_file: ui("写入文件"),
  edit: ui("编辑文件"),
  apply_patch: ui("修改文件"),
  bash: ui("运行命令"),
  run_command: ui("运行命令"),
  exec_command: ui("运行命令"),
  run_tests: ui("运行测试"),
  start_job: ui("启动后台任务"),
  check_job: ui("查看后台任务"),
  kill_job: ui("结束后台任务"),
  grep: ui("搜索文件内容"),
  search: ui("搜索资料"),
  search_files: ui("搜索文件内容"),
  find: ui("查找文件"),
  ls: ui("查看文件列表"),
  list_files: ui("查看文件列表"),
  web_search: ui("搜索资料"),
  web_fetch: ui("读取网页"),
  fetch: ui("读取网页"),
  publish_artifact: ui("发布产出物"),
  load_skill: ui("读取操作指南")
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const commands = new Set(["bash", "run_command", "exec_command", "run_tests", "start_job"]);
const reads = new Set(["read", "read_file"]);
const searches = new Set(["grep", "search", "search_files", "web_search", "find"]);
const parse = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const concise = (value, limit = 150) => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, Math.max(0, limit - 1)).join("")}…` : text;
};
const firstString = (...values) => values.find((value) => typeof value === "string" && value.trim()) || "";

export function friendlyToolName(name) {
  if (Object.hasOwn(titles, name)) return titles[name];
  const identity = concise(name, 100);
  return identity ? ui`调用 ${identity}` : ui("准备调用工具");
}

export function toolPathLabel(path, options = {}) {
  if (typeof path !== "string") return "";
  const normalized = path.replace(/\\/g, "/");
  const root = String(options.workspaceRoot || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (root) {
    for (const prefix of [options.taskId ? `${root}/${options.taskId}/` : "", `${root}/`]) {
      if (prefix && normalized.startsWith(prefix)) return normalized.slice(prefix.length);
    }
  }
  if (/^(?:\/|[A-Za-z]:\/)/.test(normalized)) {
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? `…/${parts.slice(-2).join("/")}` : ui("根目录");
  }
  return path;
}

function failurePreview(reason) {
  const syntax = /^(Python (?:第 \d+ 行)?语法错误)(?:：.*)?$/.exec(reason);
  if (syntax) return syntax[1];
  if (
    [
      ui("Node.js 脚本或模块不存在"),
      ui("找不到可执行命令"),
      ui("无法启动命令（ENOENT）"),
      ui("文件或目录不存在"),
      ui("文件不存在"),
      ui("没有访问权限"),
      ui("命令执行超时"),
      ui("连接超时")
    ].includes(reason) ||
    /^(?:缺少 Python 模块：[\p{L}\p{N}_.-]+|命令退出码 \d+|命令执行超时（[\d.]+ 秒）)$/u.test(reason)
  )
    return reason;
  return ui("执行未成功，展开查看详情");
}

function argumentSubject(args, options, limit = 150) {
  const path = firstString(
    args.path,
    args.filePath,
    args.file_path,
    args.filename,
    args.file,
    args.sourcePath
  );
  if (path) return concise(toolPathLabel(path, options), limit);
  if (typeof args.command === "string") return concise(describeCommand(args).subject, limit);
  return concise(
    firstString(
      args.query,
      args.pattern,
      args.task,
      args.question,
      args.summary,
      args.message,
      args.url,
      args.name,
      args.resourceId,
      args.jobId,
      args.agentId,
      args.callId
    ),
    limit
  );
}

/** Legacy callers still receive a string. Show meaningful task objects rather
 * than execution budgets or a raw key=value dump in the compact preview. */
export function toolArgumentSummary(value, limit = 150) {
  const parsed = parse(value);
  if (record(parsed)) return argumentSubject(parsed, {}, limit);
  if (Array.isArray(parsed))
    return concise(parsed.filter((entry) => typeof entry === "string").join(" · "), limit);
  const raw = typeof parsed === "string" ? parsed.trim() : "";
  return raw.startsWith("{") || raw.startsWith("[") ? "" : concise(raw, limit);
}

const timestamp = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value
      ? Date.parse(value)
      : NaN;
function measuredDuration(call, options) {
  for (const value of [call.durationMs, options.durationMs])
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const start = timestamp(call.startedAt ?? options.startedAt);
  const end = timestamp(call.endedAt ?? options.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}
function durationText(duration) {
  if (duration === undefined) return "";
  if (duration < 1000) return ui`${Math.round(duration)} 毫秒`;
  if (duration < 60_000) return ui`${(duration / 1000).toFixed(1)} 秒`;
  return ui`${Math.floor(duration / 60_000)} 分 ${Math.floor((duration % 60_000) / 1000)} 秒`;
}

function resultSummary(name, data, completed, failed) {
  if (!completed || failed) return "";
  if (commands.has(name))
    return name === "start_job" && data.jobId ? ui("后台任务已启动") : ui("命令执行完成");
  if (searches.has(name)) {
    const results = [data.matches, data.results, data.files].find(Array.isArray);
    if (results) return ui`返回 ${results.length} 项结果`;
  }
  if (reads.has(name) && typeof data.path === "string" && typeof data.content === "string")
    return ui`返回 ${data.content ? data.content.split(/\r?\n/).length : 0} 行内容`;
  if (["write", "write_file", "edit", "apply_patch"].includes(name)) {
    if (data.changed === false) return ui("文件没有变化");
    if (typeof data.bytes === "number" && Number.isFinite(data.bytes) && data.bytes >= 0)
      return ui`已写入 ${data.bytes} 字节`;
  }
  return "";
}

/** Every returned field is plain text and must be escaped before HTML
 * insertion. No file/credential/network access occurs. A script's name never
 * proves its intended output exists. Optional timing requires actual evidence. */
export function presentToolCall(call = {}, options = {}) {
  const name = firstString(call.name, call.toolName);
  const arguments_ = call.arguments ?? call.args ?? "";
  const parsed = parse(arguments_);
  const args = record(parsed) ? parsed : {};
  const result = unpackToolResult(call.rawResult ?? call.result);
  const command = commands.has(name);
  const completed = call.completed === true || options.completed === true;
  const failed =
    call.failed === true ||
    toolExecutionFailed({ isError: call.isError, result: result.raw }) ||
    (command && typeof result.data.exitCode === "number" && result.data.exitCode !== 0);
  const waiting =
    result.raw?.details?.completed === false || (name === "finish_task" && result.data.completed === false);
  const stopped = !completed && options.active === false;
  const lifecycle =
    !failed && !waiting
      ? toolLifecycle(name, args, result.data, { completed, active: options.active, detail: options.detail })
      : undefined;
  const status =
    lifecycle?.status ||
    (waiting ? "waiting" : failed ? "failed" : stopped ? "interrupted" : completed ? "completed" : "running");
  const statusLabel =
    lifecycle?.statusLabel ||
    (waiting
      ? ui("等待中")
      : failed
        ? ui("调用失败")
        : stopped
          ? ui("已停止")
          : completed
            ? ui("调用完成")
            : call.statusLabel || ui("调用中"));
  const description = command && typeof args.command === "string" ? describeCommand(args) : undefined;
  const title = name === "run_tests" ? friendlyToolName(name) : description?.title || friendlyToolName(name);
  let subject = description ? toolPathLabel(description.subject, options) : argumentSubject(args, options);
  let summary = description?.summary || "";
  if (summary.startsWith("范围：")) summary = ui`范围：${toolPathLabel(summary.slice(3), options)}`;
  summary = concise(summary);
  if (name === "call_subagent") {
    subject =
      firstString(args.agentName, args.name, result.data.name, result.data.agentName) || ui("协作任务");
    summary = concise(args.task);
  } else if (searches.has(name) || (name === "browse_workspace" && args.mode === "search")) {
    const query = concise(firstString(args.query, args.pattern));
    if (query && query !== subject) summary = query;
  }
  if (name === "browse_workspace" && args.mode === "search") subject ||= ui("任务文件");
  if (name === "wait_for_subagents" && !subject) subject = ui("已委派的任务");
  if (name === "computer_act" && record(args.action))
    subject =
      {
        activate: ui("激活窗口"),
        click: ui("点击窗口"),
        type: ui("输入文字"),
        key: ui("发送按键"),
        scroll: ui("滚动窗口")
      }[args.action.type] || ui("授权窗口");
  const failureReason =
    status === "failed" ? failurePreview(explainToolFailure(result, { failed: true, command })) : "";
  const asyncWork =
    name === "start_job" ||
    (name === "call_subagent" && (args.mode === "async" || result.data.accepted === true));
  const durationMs = asyncWork
    ? undefined
    : lifecycle && ["running", "waiting", "recorded"].includes(lifecycle.status)
      ? undefined
      : measuredDuration(call, options);
  const durationLabel = durationText(durationMs);
  const detailSections = [
    { label: ui("参数"), text: technicalText(arguments_) },
    ...(command
      ? [
          { label: ui("标准输出"), text: typeof result.data.stdout === "string" ? result.data.stdout : "" },
          { label: ui("标准错误"), text: typeof result.data.stderr === "string" ? result.data.stderr : "" }
        ]
      : []),
    { label: ui("返回结果"), text: result.technicalText }
  ].filter((section) => section.text);
  return {
    title,
    subject: concise(subject),
    summary,
    status,
    statusLabel,
    resultSummary: resultSummary(name, result.data, completed, status !== "completed"),
    failureReason,
    durationMs,
    durationLabel,
    details: detailSections.map((section) => `${section.label}\n${section.text}`).join("\n\n"),
    detailSections
  };
}
