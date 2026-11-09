import katex from "./math/generated/katex.js";
import { escapeHtml as esc } from "./workbench/html.js";

function escaped(source, index) {
  let slashes = 0;
  while (index > 0 && source[--index] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

function closingDelimiter(source, start, open, close) {
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    if (open === "$" && source[index] === "\n") return -1;
    // An incomplete streamed formula must not consume a later block or code fence.
    if (source[index - 1] === "\n" && /^[\t ]*(?:`{3,}|~{3,})/.test(source.slice(index))) return -1;
    if (braces === 0 && source.startsWith(close, index)) {
      if (
        open === "$" &&
        (/\s/.test(source[index - 1]) || source[index - 1] === "$" || /[\d$]/.test(source[index + 1] || ""))
      )
        return -1;
      return index;
    }
    if (braces === 0 && open !== close && source.startsWith(open, index)) return -1;
    if (source[index] === "\\") index += 1;
    else if (source[index] === "{") braces += 1;
    else if (source[index] === "}") braces = Math.max(0, braces - 1);
  }
  return -1;
}

function renderMath(latex, original, displayMode) {
  try {
    if (latex.length > 16_000) throw new Error("Formula exceeds the rendering limit");
    return katex.renderToString(latex, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 20
    });
    // eslint-disable-next-line no-restricted-syntax -- 非法公式或超出 maxSize/maxExpand 时 KaTeX 抛出，回退为转义原文
  } catch {
    return `<span class="math-fallback">${esc(original)}</span>`;
  }
}

/** Protect complete math before Markdown splits lines or interprets underscores/stars. */
export function protectMath(source) {
  const fragments = [];
  const parts = [];
  // Bare evidence URLs can contain dollar signs; preserve them as one token
  // before scanning formula delimiters, just like explicit Markdown links.
  const tokens =
    /(^[\t ]*(`{3,}|~{3,})[^\n]*(?:\n|$))|(`+)|(!?\[[^\]\n]+\]\([ \t]*(?:<[^<>\r\n]+>|[^\s)]+)[ \t]*\))|(https?:\/\/[^\s<>"'`*，。；：！？、（）【】]+)|(\\[([]|\${1,2})/gm;
  let cursor = 0;
  for (let match; (match = tokens.exec(source));) {
    const [token, fence, marker, code, link, bareUrl, open] = match;
    if (fence) {
      const closing = new RegExp(`^[\\t ]*${marker[0]}{${marker.length},}[\\t ]*$`, "gm");
      closing.lastIndex = tokens.lastIndex;
      const end = closing.exec(source);
      tokens.lastIndex = end ? closing.lastIndex : source.length;
      continue;
    }
    if (code) {
      const closing = /`+/g;
      closing.lastIndex = tokens.lastIndex;
      for (let end; (end = closing.exec(source));)
        if (end[0].length === code.length) {
          tokens.lastIndex = closing.lastIndex;
          break;
        }
      continue;
    }
    if (link || bareUrl || escaped(source, match.index)) continue;
    if (open === "$" && (!source[tokens.lastIndex] || /[\s$]/.test(source[tokens.lastIndex]))) continue;
    const close = open === "\\[" ? "\\]" : open === "\\(" ? "\\)" : open;
    const end = closingDelimiter(source, tokens.lastIndex, open, close);
    if (end < 0) continue;
    const original = source.slice(match.index, end + close.length);
    const latex = source.slice(tokens.lastIndex, end);
    parts.push(source.slice(cursor, match.index), `\u0000math${fragments.length}\u0000`);
    fragments.push(renderMath(latex, original, open === "\\[" || open === "$$"));
    cursor = tokens.lastIndex = end + close.length;
  }
  parts.push(source.slice(cursor));
  return { source: parts.join(""), fragments };
}
