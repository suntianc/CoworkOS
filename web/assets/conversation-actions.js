import { isMachineTurn } from "./conversation.js";
import { splitUploadedFiles } from "./uploaded-files.js";

const unreadKey = "atria.conversations.unread.v1";
const validTaskId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) && !value.includes("..");

/** Read markers belong to this browser, independently of the task's execution state. */
export function createConversationReadState(storage) {
  let unread = new Set();
  const pending = new Map();
  const apply = (taskId, value) => (value ? unread.add(taskId) : unread.delete(taskId));
  function reload() {
    try {
      if (storage) {
        const saved = JSON.parse(storage.getItem(unreadKey) || "null");
        unread = new Set(
          saved?.version === 1 && Array.isArray(saved.unread) ? saved.unread.filter(validTaskId) : []
        );
      }
      // eslint-disable-next-line no-restricted-syntax -- 存储被浏览器禁用时 getItem 与 JSON.parse 都会抛出，此时沿用本窗口内存里的未读标记
    } catch {
      // A blocked store keeps the current window's markers usable.
    }
    for (const [taskId, value] of pending) apply(taskId, value);
  }
  reload();
  return {
    isUnread: (taskId) => validTaskId(taskId) && unread.has(taskId),
    setUnread(taskId, value) {
      if (!validTaskId(taskId) || typeof value !== "boolean") return false;
      reload();
      apply(taskId, value);
      pending.set(taskId, value);
      try {
        if (!storage) return false;
        storage.setItem(unreadKey, JSON.stringify({ version: 1, unread: [...unread].sort() }));
        pending.clear();
        return true;
        // eslint-disable-next-line no-restricted-syntax -- 配额耗尽或存储被禁用时 setItem 抛出，返回 false 让调用方保留待写标记
      } catch {
        return false;
      }
    },
    reload
  };
}

const inlineText = (value) =>
  Array.from(String(value || ""), (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/ +/g, " ")
    .trim();
const escapeInline = (value) => inlineText(value).replace(/([\\`*_{}[\]()#+.!<>|])/g, "\\$1");
const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            typeof part === "string"
              ? part
              : part?.type === "text" && typeof part.text === "string"
                ? part.text
                : ""
          )
          .join("")
      : "";

function readableContent(content, user) {
  let text = contentText(content);
  const files = [];
  if (user) {
    const uploaded = splitUploadedFiles(text);
    text = uploaded.text;
    files.push(...uploaded.files.map((file) => file.name));
    const marker = "\n\nAttached files:\n";
    const boundary = text.indexOf(marker);
    if (boundary >= 0) {
      const source = text.slice(boundary + marker.length);
      const names = [...source.matchAll(/^--- ([^\r\n]+) ---\r?$/gm)].map((match) => match[1]);
      files.push(...(names.length ? names : ["附件（内容未包含）"]));
      text = text.slice(0, boundary);
    }
  }
  if (Array.isArray(content))
    for (const part of content) {
      if (part?.type === "image") files.push(part.name || part.filename || "图片");
    }
  const attachments = [...new Set(files.filter((name) => typeof name === "string" && name.trim()))];
  return [
    text.trim(),
    attachments.length ? `附件：\n${attachments.map((name) => `- ${escapeInline(name)}`).join("\n")}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Export the spoken conversation, never the detail response's runtime/configuration fields. */
export function conversationMarkdown(detail, { title } = {}) {
  const heading = title || detail?.task?.title || String(detail?.task?.goal || "会话").split(/\r?\n/)[0];
  const sections = [];
  for (const message of Array.isArray(detail?.messages) ? detail.messages : []) {
    if (
      !["user", "assistant"].includes(message?.role) ||
      (message.delivery === "followUp" && message.pending) ||
      isMachineTurn({ role: message.role, content: contentText(message.content) })
    )
      continue;
    const body = readableContent(message.content, message.role === "user");
    if (body) sections.push(`## ${message.role === "user" ? "用户" : "助手"}\n\n${body}`);
  }
  return `# ${escapeInline(heading) || "会话"}\n\n${sections.join("\n\n---\n\n") || "暂无对话内容。"}\n`;
}

/** A local deep link resolves the same task without inheriting an unrelated workspace hash. */
export function conversationUrl(baseUrl, taskId) {
  if (!validTaskId(taskId)) throw new Error("无效的会话 ID");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("无效的会话地址");
  url.searchParams.set("task", taskId);
  url.hash = "";
  return url.href;
}

export function conversationTaskId(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const taskId = url.searchParams.get("task");
    return validTaskId(taskId) ? taskId : null;
    // eslint-disable-next-line no-restricted-syntax -- 深链可能来自任意粘贴文本，不是合法 URL 时说明它不是本应用的任务链接
  } catch {
    return null;
  }
}

export function safeFilename(title) {
  let name = inlineText(title)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/\.md$/i, "");
  // Sixty Unicode code points also fit a typical 255-byte filename limit.
  name = Array.from(name)
    .slice(0, 60)
    .join("")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!name || /^\.+$/.test(name)) name = "会话";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return `${name}.md`;
}
