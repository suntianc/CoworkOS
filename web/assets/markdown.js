import { escapeHtml as esc } from "./workbench/html.js";
import { protectMath } from "./math.js";

export function renderMarkdown(source, options = {}) {
  // Input cannot forge the internal fragment sentinels.
  const math = protectMath(
    String(source ?? "")
      .replaceAll("\u0000", "")
      .replace(/\r\n?/g, "\n")
  );
  const lines = math.source.split("\n");
  const output = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let codeLines = null;
  let codeLanguage = "";
  let codeFence = "";
  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${paragraph.map((line) => inlineMarkdown(line, options)).join("<br />")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (!listType) return;
    output.push(
      `<${listType}>${listItems.map((item) => `<li>${inlineMarkdown(item, options)}</li>`).join("")}</${listType}>`
    );
    listType = null;
    listItems = [];
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (codeLines) {
      if (fence && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !fence[2].trim()) {
        output.push(
          `<pre><code class="language-${esc(codeLanguage)}">${esc(codeLines.join("\n"))}</code></pre>`
        );
        codeLines = null;
        codeLanguage = codeFence = "";
      } else codeLines.push(line);
      continue;
    }
    if (fence) {
      flushParagraph();
      flushList();
      codeLines = [];
      codeFence = fence[1];
      codeLanguage = /^\s*([\w-]+)/.exec(fence[2])?.[1] || "";
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (
      /^\s*\|/.test(line) &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[lineIndex + 1] || "")
    ) {
      flushParagraph();
      flushList();
      const header = splitTableRow(line);
      const rows = [];
      lineIndex += 2;
      while (
        lineIndex < lines.length &&
        /^\s*\|/.test(lines[lineIndex]) &&
        lines[lineIndex].trim().endsWith("|")
      ) {
        rows.push(splitTableRow(lines[lineIndex]));
        lineIndex += 1;
      }
      lineIndex -= 1;
      output.push(
        `<table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell, options)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_cell, index) => `<td>${inlineMarkdown(row[index] || "", options)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      );
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2], options)}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      output.push("<hr />");
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }
    if (listType) flushList();
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      output.push(`<blockquote>${inlineMarkdown(quote[1], options)}</blockquote>`);
      continue;
    }
    paragraph.push(line);
  }
  if (codeLines)
    output.push(`<pre><code class="language-${esc(codeLanguage)}">${esc(codeLines.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  // Restore only after Markdown parsing so generated markup is never reinterpreted.
  // eslint-disable-next-line no-control-regex
  const mathToken = /\u0000math(\d+)\u0000/g;
  return output.join("").replace(mathToken, (_match, index) => math.fragments[Number(index)] || "");
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function inlineMarkdown(value, options) {
  const fragments = [];
  const protect = (html) => {
    const token = `\u0000${fragments.length}\u0000`;
    fragments.push(html);
    return token;
  };
  let text = String(value).replace(
    /(`+)(.+?)\1(?!`)|!?\[([^\]]+)\]\([ \t]*(?:<([^<>\r\n]+)>|([^\s)]+))[ \t]*\)/g,
    (match, ticks, code, label, wrappedUrl, plainUrl) => {
      if (code !== undefined) return protect(`<code>${esc(code)}</code>`);
      const url = wrappedUrl || plainUrl;
      // A model-supplied filesystem path is not a browser route or a native
      // open-file grant. Only the caller can resolve a registered artifact.
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(url)) return protect(esc(match));
      if (/^https?:\/\//i.test(url))
        return protect(
          `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(label, { ...options, linkify: false })}</a>`
        );
      const local = /^\/(?![/\\])/.test(url) ? options.resolveLocalLink?.(url) : undefined;
      if (local)
        return protect(
          `<a href="${esc(local.href)}" data-message-artifact="${esc(local.artifactPath)}" data-message-task="${esc(local.taskId)}">${inlineMarkdown(label, { ...options, linkify: false })}</a>`
        );
      return protect(esc(match));
    }
  );
  if (options.linkify) {
    // Explicit links and inline code are already protected. Keep URL spelling
    // intact before emphasis processing, including underscores and query strings.
    // eslint-disable-next-line no-control-regex
    text = text.replace(/https?:\/\/[^\s<>"'`*\u0000，。；：！？、（）【】]+/gi, (match) => {
      let url = match.replace(/[.,;:!?。，；：！？、]+$/, "");
      for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
        ["（", "）"],
        ["【", "】"]
      ]) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length)
          url = url.slice(0, -close.length);
      }
      try {
        const parsed = new URL(url);
        if (!parsed.hostname || parsed.username || parsed.password) return match;
        // eslint-disable-next-line no-restricted-syntax -- 链接化文本取自消息内容，可能不是合法 URL，此时保留原文不生成链接
      } catch {
        return match;
      }
      return (
        protect(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`) +
        match.slice(url.length)
      );
    });
  }
  text = esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, "<em>$1</em>");
  // NUL sentinels protect inline code and complete links, including attributes,
  // from emphasis substitutions. Text and attributes are escaped exactly once.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => fragments[Number(index)] || "");
}
