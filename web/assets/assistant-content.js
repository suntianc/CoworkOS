// Display-only projection of assistant messages. Callers must keep user
// messages and the persisted provider content unchanged.

// Sticky patterns match at one position without copying the rest of the
// text; the scan visits every character, so a copy there grows with the
// square of a long streamed thought.
const fenceAt = /[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)/y;
const indentedAt = /(?: {4}|\t)[^\n]*(?:\n|$)/y;
const backticksAt = /`+/y;
const matchAt = (pattern, source, index) => {
  pattern.lastIndex = index;
  return pattern.exec(source);
};

function protectedRanges(source) {
  const ranges = [];
  for (let index = 0; index < source.length; index += 1) {
    const lineStart = index === 0 || source[index - 1] === "\n";
    const fence = lineStart && matchAt(fenceAt, source, index);
    if (fence) {
      const delimiter = fence[1];
      const closing = new RegExp(`^[ \\t]*${delimiter[0]}{${delimiter.length},}[ \\t]*(?:\\n|$)`, "gm");
      closing.lastIndex = index + fence[0].length;
      const match = closing.exec(source);
      const end = match ? match.index + match[0].length : source.length;
      ranges.push([index, end]);
      index = end - 1;
      continue;
    }
    const indented = lineStart && matchAt(indentedAt, source, index);
    if (indented) {
      const end = index + indented[0].length;
      ranges.push([index, end]);
      index = end - 1;
      continue;
    }
    const escaped = index > 0 && source[index - 1] === "\\";
    const backticks = !escaped && source[index] === "`" && matchAt(backticksAt, source, index)[0];
    if (backticks) {
      let end = source.indexOf(backticks, index + backticks.length);
      end = end < 0 ? source.length : end + backticks.length;
      ranges.push([index, end]);
      index = end - 1;
      continue;
    }
    const math =
      !escaped && source.startsWith("$$", index)
        ? ["$$", "$$"]
        : !escaped && source[index] === "$"
          ? ["$", "$"]
          : source.startsWith("\\(", index)
            ? ["\\(", "\\)"]
            : source.startsWith("\\[", index)
              ? ["\\[", "\\]"]
              : undefined;
    if (math) {
      const closing = source.indexOf(math[1], index + math[0].length);
      if (closing >= 0) {
        const end = closing + math[1].length;
        ranges.push([index, end]);
        index = end - 1;
      }
    }
  }
  return ranges;
}

const protectedAt = (index, ranges) => ranges.some(([start, end]) => index >= start && index < end);
const envelopeBoundary = (source, cursor, index) => {
  const before = source.slice(cursor, index);
  return !before.trim() || /\n[ \t]*\n[ \t]*$/.test(before);
};
const tagPrefix = (value) =>
  ["<thinking>", "<think>", "</thinking>", "</think>"].some((tag) => tag.startsWith(value.toLowerCase()));

function splitEnvelopes(source, { streaming = false } = {}) {
  const parts = [];
  const ranges = protectedRanges(source);
  const opening = /<(thinking|think)>/gi;
  let cursor = 0;
  let match;
  while ((match = opening.exec(source))) {
    if (protectedAt(match.index, ranges) || !envelopeBoundary(source, cursor, match.index)) continue;
    const bodyStart = opening.lastIndex;
    const closing = new RegExp(`</${match[1]}>`, "gi");
    closing.lastIndex = bodyStart;
    let end;
    while ((end = closing.exec(source))) if (!protectedAt(end.index, ranges)) break;
    const body = source.slice(bodyStart, end?.index ?? source.length);
    // Completed unclosed prose such as "<thinking> is an HTML element" is
    // ambiguous. Only provider-like compact/heading/newline envelopes or an
    // active stream establish ownership without a matching closing tag.
    if (!end && !streaming && !/^(?:\S|[ \t]*\n)/.test(body)) continue;
    if (source.slice(cursor, match.index).trim())
      parts.push({ type: "text", text: source.slice(cursor, match.index) });
    const rawStart = source.slice(cursor, match.index).trim() ? match.index : cursor;
    const rawEnd = end && source.slice(closing.lastIndex).trim() ? closing.lastIndex : source.length;
    let thinking = body;
    const pending = /<\/?[a-z]*$/i.exec(thinking);
    if (
      pending &&
      (pending[0].startsWith("</") || (streaming && pending[0] === "<")) &&
      tagPrefix(pending[0]) &&
      !protectedAt(bodyStart + pending.index, ranges)
    )
      thinking = thinking.slice(0, pending.index);
    parts.push({
      type: "thinking",
      thinking: thinking.trim(),
      closed: Boolean(end),
      rawText: source.slice(rawStart, rawEnd)
    });
    cursor = end ? closing.lastIndex : source.length;
    opening.lastIndex = cursor;
    if (!end) break;
  }
  const rest = source.slice(cursor);
  const pending = /<[a-z]*$/i.exec(rest);
  if (
    (streaming || (pending && pending[0].length >= 4)) &&
    pending &&
    tagPrefix(pending[0]) &&
    !protectedAt(cursor + pending.index, ranges) &&
    envelopeBoundary(source, cursor, cursor + pending.index)
  ) {
    if (rest.slice(0, pending.index).trim()) parts.push({ type: "text", text: rest.slice(0, pending.index) });
    parts.push({ type: "thinking", thinking: "", closed: false, rawText: rest });
  } else if (rest || !parts.length) parts.push({ type: "text", text: rest });
  return parts;
}

function normalizeProse(source, removeEmptyMarkers) {
  const ranges = protectedRanges(source);
  let result = source.replace(/^[ \t]*(?:\*\*|__)[^\n]*$/gm, (line, offset) => {
    if (ranges.some(([start, end]) => offset < end && offset + line.length > start)) return line;
    const value = line.trim();
    const headings = [];
    let cursor = 0;
    while (value.startsWith("**", cursor) || value.startsWith("__", cursor)) {
      const marker = value.slice(cursor, cursor + 2);
      const end = value.indexOf(marker, cursor + 2);
      const body = value.slice(cursor + 2, end < 0 ? value.length : end);
      if (end < 0) {
        // A complete heading followed immediately by a new opening marker
        // already establishes a paragraph, even before its streamed end.
        if (headings.length && /^[^*_]*[*_]?$/.test(body)) {
          const text = body.replace(/[*_]$/, "");
          return [...headings, ...(text ? [text] : [])].join("\n\n");
        }
        break;
      }
      if (!body || /[*_]/.test(body)) break;
      headings.push(value.slice(cursor, end + 2));
      cursor = end + 2;
    }
    if (headings.length && /^(?:\*{1,2}|_{1,2})$/.test(value.slice(cursor))) return headings.join("\n\n");
    return headings.length > 1 && cursor === value.length ? headings.join("\n\n") : line;
  });
  if (removeEmptyMarkers) {
    const updatedRanges = protectedRanges(result);
    result = result.replace(/(^|\n)([ \t]*\*{4,}[ \t]*)(?=\n|$)/g, (line, before, markers, offset) =>
      protectedAt(offset + before.length, updatedRanges) ? line : before
    );
  }
  return result;
}

// A streamed conversation redraws every frame, and each frame lays out the
// same thoughts several times; only the one being written changes.
const recentReasoning = [new Map(), new Map()];
const rememberedLimit = 200;

/** Readable Markdown for a known thinking block; never writes its original. */
export function normalizeReasoningDisplay(reasoning, options = {}) {
  const source = String(reasoning ?? "");
  const remembered = recentReasoning[options.streaming ? 1 : 0];
  const known = remembered.get(source);
  if (known !== undefined) return known;
  const display = layoutReasoning(source, options);
  if (remembered.size >= rememberedLimit) remembered.delete(remembered.keys().next().value);
  remembered.set(source, display);
  return display;
}

function layoutReasoning(source, options) {
  const parts = splitEnvelopes(source, options);
  const hasEnvelope = parts.some((part) => part.type === "thinking");
  const display = hasEnvelope
    ? parts
        .map((part) => part.thinking ?? part.text)
        .filter((text) => text.trim())
        .join("\n\n")
    : source;
  const normalized = normalizeProse(display, true);
  return hasEnvelope ? normalized.trim() : normalized;
}

const completeHeading = (source) =>
  /^(?:\*\*[^*\n]+\*\*|__[^_\n]+__|#{1,6}[ \t]+[^\n]+)$/.test(source.trim());
function joinTextParts(parts) {
  return parts.reduce((text, part, index) => {
    const next = String(part.text ?? "");
    const previous = String(parts[index - 1]?.text ?? "");
    return text + (index && completeHeading(previous) && completeHeading(next) ? "\n\n" : "") + next;
  }, "");
}

/**
 * Returns fresh Pi-shaped display parts (thinking/text/toolCall/etc). Text
 * fragments are joined before recognizing tags or Markdown, so a split token
 * remains one token. Only complete independent heading blocks gain a boundary.
 * includeRaw retains source bytes for optional nested diagnostics. This
 * function is exclusively for assistant content, never user content.
 */
export function assistantDisplayContent(content, options = {}) {
  const input = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(input)) return [];
  const result = [];
  for (let index = 0; index < input.length; index += 1) {
    const part = input[index];
    if (part?.type === "thinking") {
      result.push({
        ...part,
        ...(options.includeRaw ? { rawText: part.rawText ?? part.thinking } : {}),
        thinking: normalizeReasoningDisplay(part.thinking, options)
      });
      continue;
    }
    if (part?.type !== "text") {
      if (part && typeof part === "object") result.push({ ...part });
      continue;
    }
    const group = [part];
    while (input[index + 1]?.type === "text") group.push(input[++index]);
    const joined = joinTextParts(group);
    const rawGroup = group.map((entry) => String(entry.text ?? "")).join("");
    const segments = splitEnvelopes(joined, options);
    const hasEnvelope = segments.some((segment) => segment.type === "thinking");
    const counters = { thinking: 0, text: 0 };
    for (const segment of segments) {
      const display = { ...part, type: segment.type };
      if (part.key !== undefined && hasEnvelope)
        display.key = `${part.key}:${segment.type}:${counters[segment.type]++}`;
      if ("complete" in part || group.some((entry) => "complete" in entry))
        display.complete = segment.closed || group.every((entry) => entry.complete);
      delete display.text;
      delete display.thinking;
      if (segment.type === "thinking") {
        display.thinking = normalizeProse(segment.thinking, true).trim();
        if (options.includeRaw) display.rawText = joined === rawGroup ? segment.rawText : rawGroup;
      } else display.text = normalizeProse(segment.text, false);
      result.push(display);
    }
  }
  return result;
}
