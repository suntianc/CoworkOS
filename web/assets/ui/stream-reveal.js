import { antMarkSvg } from "./thinking-mark.js";

/**
 * Close what a half-arrived reply leaves open and hold back what cannot render
 * yet, so streaming never shows raw markdown: an open code fence or inline
 * code, an unpaired `**`, a list or heading marker with nothing after it, and
 * a table before its separator row or with a half-written last row.
 */
export function completeMarkdown(text) {
  let lines = String(text).split("\n");
  const fences = lines.filter((line) => /^\s*(```|~~~)/.test(line)).length;
  if (fences % 2) return `${text}\n\`\`\``;
  let last = lines.at(-1);
  if (/^\s*(#{1,6}|[-*+]|\d+[.)]?|>|`{1,2}|\*{1,2})\s*$/.test(last) && lines.length > 1) {
    lines.pop();
    last = lines.at(-1);
  }
  if (/^\s*\|/.test(last)) {
    let start = lines.length - 1;
    while (start > 0 && /^\s*\|/.test(lines[start - 1])) start -= 1;
    const rows = lines.slice(start);
    if (rows.length < 2 || !/^\s*\|[\s|:-]+\|?\s*$/.test(rows[1])) lines = lines.slice(0, start);
    else if (!/\|\s*$/.test(last)) lines.pop();
  }
  let out = lines.join("\n");
  const tail = lines.at(-1) || "";
  if ((tail.match(/`/g) || []).length % 2) out += "`";
  if ((tail.match(/\*\*/g) || []).length % 2) out += "**";
  return out;
}

const FADE_MS = 220;
const segmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

function textNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement.closest(".stream-trail")) nodes.push(node);
  }
  return nodes;
}

function segments(text) {
  if (!segmenter) return text.match(/\s+|[^\s]{1,4}/g) || [];
  return [...segmenter.segment(text)].map((part) => part.segment);
}

/**
 * Streamed text arrives in network-sized pieces. Each piece is revealed word
 * by word over a short span that grows with its size, every word fading in;
 * the timing lives in `batches`, so it carries across the DOM patch each new
 * piece triggers. Code blocks appear whole.
 */
function reveal(body, batches, now) {
  let offset = 0;
  for (const node of textNodes(body)) {
    const from = offset;
    const to = offset + node.data.length;
    offset = to;
    if (node.parentElement.closest("pre, .katex, svg")) continue;
    const hits = batches.filter((batch) => batch.to > from && batch.from < to);
    if (!hits.length) continue;
    const fragment = node.ownerDocument.createDocumentFragment();
    let cursor = from;
    for (const batch of hits) {
      const start = Math.max(batch.from, from);
      const end = Math.min(batch.to, to);
      if (start > cursor) fragment.append(node.data.slice(cursor - from, start - from));
      let at = start;
      for (const part of segments(node.data.slice(start - from, end - from))) {
        const span = node.ownerDocument.createElement("span");
        span.className = "stream-fade";
        const shownAt = batch.at + ((at - batch.from) / Math.max(1, batch.to - batch.from)) * batch.span;
        span.style.animationDelay = `${Math.round(shownAt - now)}ms`;
        span.textContent = part;
        fragment.append(span);
        at += part.length;
      }
      cursor = end;
    }
    if (cursor < to) fragment.append(node.data.slice(cursor - from));
    node.replaceWith(fragment);
  }
}

/** Put the working ant after the last word, inside the block that holds it. */
function trail(body) {
  let host = body.lastElementChild;
  while (host && /^(OL|UL|BLOCKQUOTE)$/.test(host.tagName) && host.lastElementChild)
    host = host.lastElementChild;
  if (host && /^(PRE|TABLE|DIV|HR)$/.test(host.tagName)) host = null;
  const mark = body.ownerDocument.createElement("span");
  mark.className = "ant-mark stream-trail";
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = antMarkSvg;
  (host || body).append(mark);
  // A fresh node on every patch would restart the walk; keep it on the page clock.
  for (const animation of mark.getAnimations?.({ subtree: true }) || []) animation.startTime = 0;
}

/**
 * Decorate the answer that is streaming after each conversation patch. Text
 * already on screen when a reply is first seen (opening a conversation mid
 * reply) appears as is; only text that arrives afterwards fades in.
 */
export function createStreamReveal({ reducedMotion = () => false } = {}) {
  const answers = new Map();
  return {
    apply(root) {
      const now = performance.now();
      const seen = new Set();
      for (const answer of root.querySelectorAll("[data-streaming-answer]")) {
        const body = answer.querySelector(".markdown-body");
        if (!body) continue;
        const key = answer.getAttribute("data-activity-key") || "";
        seen.add(key);
        const length = textNodes(body).reduce((sum, node) => sum + node.data.length, 0);
        let record = answers.get(key);
        if (!record) answers.set(key, (record = { length, batches: [] }));
        else if (length > record.length) {
          const size = length - record.length;
          record.batches.push({ from: record.length, to: length, at: now, span: Math.min(360, size * 12) });
          record.length = length;
        } else record.length = length;
        record.batches = record.batches.filter((batch) => now - batch.at < batch.span + FADE_MS);
        if (!reducedMotion()) reveal(body, record.batches, now);
        trail(body);
      }
      for (const key of answers.keys()) if (!seen.has(key)) answers.delete(key);
    }
  };
}
