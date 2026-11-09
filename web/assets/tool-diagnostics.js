const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const parse = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
    // eslint-disable-next-line no-restricted-syntax -- 工具输出不保证是 JSON 文本，解析失败时按原始字符串继续展示
  } catch {
    return value;
  }
};
const textContent = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
      : "";

export function technicalText(value) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = parse(value);
  if (typeof parsed === "string") return parsed;
  return JSON.stringify(
    parsed,
    function (key, entry) {
      // Keep binary metadata without adding megabytes of base64 to a text node.
      return key === "data" && ["image", "audio"].includes(this?.type) && typeof entry === "string"
        ? `[${this.type === "image" ? "图片" : "音频"}二进制内容，${entry.length} 个编码字符]`
        : entry;
    },
    2
  );
}

export function unpackToolResult(value) {
  const raw = parse(value);
  const content = record(raw) ? textContent(raw.content) : typeof raw === "string" ? raw : "";
  const fromContent = parse(content);
  const details = record(raw?.details) ? raw.details : undefined;
  const data =
    details || record(fromContent)
      ? {
          ...(record(fromContent) ? fromContent : {}),
          ...Object.fromEntries(
            Object.entries(details || {}).filter(
              ([, entry]) => entry !== undefined && entry !== null && entry !== ""
            )
          )
        }
      : record(raw)
        ? raw
        : {};
  return { raw, data, text: record(fromContent) ? "" : content, technicalText: technicalText(raw) };
}

const clip = (value, limit = 180) => {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).length > limit
    ? `${Array.from(text)
        .slice(0, limit - 1)
        .join("")}…`
    : text;
};

/** Explain a known failed execution only. Business error/failed fields in a
 * successful result and requested timeout budgets are not failure evidence. */
export function explainToolFailure(result, { failed = false, command = false } = {}) {
  if (!failed) return "";
  const { data, text } = result;
  if (command && data.timedOut === true) {
    const seconds =
      typeof data.timeoutMs === "number" && Number.isFinite(data.timeoutMs) && data.timeoutMs > 0
        ? data.timeoutMs / 1000
        : undefined;
    return `命令执行超时${seconds === undefined ? "" : `（${seconds} 秒）`}`;
  }
  const error =
    typeof data.error === "string"
      ? data.error
      : record(data.error) && typeof data.error.message === "string"
        ? data.error.message
        : "";
  const evidence = [data.stderr, error, text]
    .filter((entry) => typeof entry === "string" && entry.trim())
    .join("\n");
  const module = /ModuleNotFoundError:\s*No module named ['"]([^'"\r\n]+)['"]/.exec(evidence);
  if (module) return `缺少 Python 模块：${clip(module[1], 100)}`;
  if (/\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|Error:\s*Cannot find module\b/.test(evidence))
    return "Node.js 脚本或模块不存在";
  if (command && /\bcommand not found\b/.test(evidence)) return "找不到可执行命令";
  if (command && /\bspawn\s+[^\r\n]+\s+ENOENT\b/.test(evidence)) return "无法启动命令（ENOENT）";
  if (/can't open file[^\r\n]*\[Errno 2\]|FileNotFoundError:/.test(evidence)) return "文件或目录不存在";
  if (/\b(?:ENOENT|No such file or directory)\b/.test(evidence)) return "文件或目录不存在";
  if (/\b(?:PermissionError|EACCES|EPERM|Permission denied|permission denied)\b/.test(evidence))
    return "没有访问权限";
  const syntax = /(?:^|\n)\s*((?:SyntaxError|IndentationError|TabError):[^\r\n]*)/.exec(evidence);
  if (syntax) {
    const locations = [
      ...evidence.slice(0, syntax.index).matchAll(/\bFile\s+(["'])[^\r\n]+?\1,\s*line\s+(\d+)\b/g)
    ];
    const line = Number(locations.at(-1)?.[2]);
    const prefix = Number.isSafeInteger(line) && line > 0 ? `Python 第 ${line} 行` : "Python ";
    return `${prefix}语法错误：${clip(syntax[1].replace(/^\w+Error:\s*/, ""), 130)}`;
  }
  if (command && /(?:Command|command) (?:timed out|timeout)/.test(evidence)) return "命令执行超时";
  if (command && /\bconnect\s+ETIMEDOUT\b/.test(evidence)) return "连接超时";
  const meaningful = evidence
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exception = meaningful.findLast((line) => /(?:^|\b)[A-Za-z]+(?:Error|Exception):/.test(line));
  if (exception) return clip(exception);
  if (meaningful.length && !command) {
    if (/File does not exist/i.test(meaningful[0])) return "文件不存在";
    return clip(meaningful[0]);
  }
  if (command && typeof data.exitCode === "number" && Number.isFinite(data.exitCode))
    return `命令退出码 ${data.exitCode}`;
  const exit = /Command exited with code (\d+)/.exec(evidence);
  return exit
    ? `命令退出码 ${exit[1]}`
    : meaningful.length
      ? clip(meaningful[0])
      : "执行未成功，请展开查看详细记录";
}
