import { escapeHtml as esc } from "./workbench/html.js";
import { icon } from "./ui/icons.js";
import { ui } from "./ui/language.js";
import { highlightCode } from "./ui/highlight.js";

/**
 * Markup for the richer blocks a reply can carry: code, diffs, terminal
 * output, diagrams, tables, file references and callouts.
 *
 * Everything here is a pure function of the Markdown source. Behaviour (copy,
 * wrap, view switches, expanding, zoom, drawing diagrams) comes from one
 * delegated controller, ui/code-blocks.js. A block's root carries
 * `data-ui-owned` with a hash of its source: while the source is unchanged the
 * conversation's reconciler leaves the block alone, so a reader's choices and a
 * drawn diagram survive re-renders.
 */

/** FNV-1a; only distinguishes one block's source from its next version. */
export function sourceKey(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const action = (attribute, symbol, label, title = label, extra = "") =>
  `<button type="button" class="code-block-action" ${attribute} title="${title}"${extra}>${icon(symbol)}<span>${label}</span></button>`;
const copyAction = (title) =>
  `<button type="button" class="code-block-action" data-code-copy title="${title}">${icon("copy")}<span data-code-copy-label>${ui("复制")}</span></button>`;

const TERMINAL_LANGUAGES = new Set(["terminal", "console", "ansi", "shell-session", "output"]);
const DIFF_LANGUAGES = new Set(["diff", "patch"]);
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/;

/** A fenced block, by its info string: language first, then an optional title. */
export function fencedBlock(info, code) {
  const [language = "", ...rest] = String(info || "")
    .trim()
    .split(/\s+/);
  const kind = language.toLowerCase();
  const title = rest.join(" ");
  if (DIFF_LANGUAGES.has(kind)) return diffBlock(code, title);
  if (kind === "mermaid") return mermaidBlock(code);
  if (TERMINAL_LANGUAGES.has(kind) || ANSI.test(code)) return terminalBlock(code, title);
  return codeBlock(language, code);
}

export function codeBlock(language, code) {
  return `<figure class="code-block" data-ui-owned="${sourceKey(`code:${language}\n${code}`)}"><figcaption class="code-block-head"><span class="code-block-language">${esc(language || "text")}</span>${action('data-code-wrap aria-pressed="false"', "wrap-text", ui("换行"), ui("自动换行"))}${copyAction(ui("复制代码"))}</figcaption><pre><code class="language-${esc(language)}">${highlightCode(language, code)}</code></pre></figure>`;
}

/* Terminal output -------------------------------------------------------- */

const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const TERMINAL_VISIBLE_LINES = 12;

/** Turns SGR colour and weight codes into spans; every other escape is dropped. */
export function ansiToHtml(text) {
  let open = false;
  let output = "";
  const style = { fg: "", bold: false, dim: false };
  const close = () => {
    if (open) output += "</span>";
    open = false;
  };
  const start = () => {
    const classes = [
      style.fg && `ansi-${style.fg}`,
      style.bold && "ansi-bold",
      style.dim && "ansi-dim"
    ].filter(Boolean);
    if (!classes.length) return;
    output += `<span class="${classes.join(" ")}">`;
    open = true;
  };
  // eslint-disable-next-line no-control-regex
  for (const part of String(text).split(/(\u001b\[[0-9;?]*[A-Za-z])/)) {
    // eslint-disable-next-line no-control-regex
    const escape = /^\u001b\[([0-9;?]*)([A-Za-z])$/.exec(part);
    if (!escape) {
      // eslint-disable-next-line no-control-regex
      output += esc(part.replace(/\u001b/g, ""));
      continue;
    }
    if (escape[2] !== "m") continue;
    close();
    const codes = escape[1] ? escape[1].split(";").map(Number) : [0];
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 0) Object.assign(style, { fg: "", bold: false, dim: false });
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 22) style.bold = style.dim = false;
      else if (code === 39) style.fg = "";
      else if (code >= 30 && code <= 37) style.fg = ANSI_COLORS[code - 30];
      else if (code >= 90 && code <= 97) style.fg = `bright-${ANSI_COLORS[code - 90]}`;
      else if (code === 38 || code === 48) index += codes[index + 1] === 5 ? 2 : 4;
    }
    start();
  }
  close();
  return output;
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * Monospace output with its colours. A title such as `npm test exit=1` names
 * the command and its exit code; long output shows its first lines and a
 * control for the rest.
 */
export function terminalBlock(code, title = "") {
  const exit = /(?:^|\s)exit=(-?\d+)(?=\s|$)/.exec(title);
  const command = title.replace(/(?:^|\s)exit=-?\d+(?=\s|$)/, "").trim();
  const lines = String(code).replace(/\n$/, "").split("\n");
  const hidden = Math.max(0, lines.length - TERMINAL_VISIBLE_LINES);
  const body = (from, to) =>
    lines
      .slice(from, to)
      .map((line) => `<span class="terminal-line">${ansiToHtml(line) || " "}</span>`)
      .join("");
  return `<figure class="code-block terminal-block" data-ui-owned="${sourceKey(`terminal:${title}\n${code}`)}"><figcaption class="code-block-head">${icon("terminal")}<span class="code-block-language terminal-command">${esc(command || ui("终端输出"))}</span>${
    exit
      ? `<span class="terminal-exit${exit[1] === "0" ? "" : " is-failed"}">${ui`退出码 ${exit[1]}`}</span>`
      : ""
  }${copyAction(ui("复制输出"))}</figcaption><pre class="terminal-output"><code data-copy-text="${esc(stripAnsi(code))}">${body(0, TERMINAL_VISIBLE_LINES)}${
    hidden
      ? `<span class="terminal-rest" data-terminal-rest hidden>${body(TERMINAL_VISIBLE_LINES)}</span>`
      : ""
  }</code></pre>${
    hidden
      ? `<button type="button" class="terminal-more" data-terminal-more aria-expanded="false">${icon("chevron-down")}<span>${ui`展开其余 ${hidden} 行`}</span></button>`
      : ""
  }</figure>`;
}

/* Diffs ------------------------------------------------------------------ */

/**
 * Reads a unified diff a model wrote. Unlike `git diff` output it may lack the
 * `diff --git` line, its file headers or even its hunk headers, so each part
 * is optional and lines without a hunk count from 1.
 */
export function parseDiffText(text, fallbackPath = "") {
  const rows = [];
  let path = fallbackPath;
  let oldLine = 1;
  let newLine = 1;
  for (const raw of String(text).replace(/\n$/, "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      path = /^diff --git a\/(.+) b\/(.+)$/.exec(raw)?.[2] || path;
      continue;
    }
    if (/^(index |new file mode |deleted file mode |similarity index |rename (from|to) )/.test(raw)) continue;
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      const target = raw
        .slice(4)
        .trim()
        .replace(/^[ab]\//, "");
      if (target && target !== "/dev/null" && (raw.startsWith("+++ ") || !path)) path = target;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) rows.push({ kind: "add", text: raw.slice(1), newNumber: newLine++ });
    else if (raw.startsWith("-")) rows.push({ kind: "remove", text: raw.slice(1), oldNumber: oldLine++ });
    else if (raw.startsWith("\\")) rows.push({ kind: "note", text: raw });
    else
      rows.push({
        kind: "context",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldNumber: oldLine++,
        newNumber: newLine++
      });
  }
  return {
    path,
    rows,
    added: rows.filter((row) => row.kind === "add").length,
    removed: rows.filter((row) => row.kind === "remove").length
  };
}

/** Side by side: each run of removals pairs with the additions that follow it. */
function splitRows(rows) {
  const paired = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (row.kind !== "remove" && row.kind !== "add") {
      paired.push([row, row]);
      index += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (rows[index]?.kind === "remove") removed.push(rows[index++]);
    while (rows[index]?.kind === "add") added.push(rows[index++]);
    for (let line = 0; line < Math.max(removed.length, added.length); line += 1)
      paired.push([removed[line], added[line]]);
  }
  return paired;
}

const diffCell = (row, side) => {
  if (!row) return `<span class="diff-cell is-empty"></span>`;
  if (row.kind === "hunk" || row.kind === "note")
    return `<span class="diff-cell is-${row.kind}"><span class="diff-text">${esc(row.text)}</span></span>`;
  const number = side === "old" ? row.oldNumber : row.newNumber;
  return `<span class="diff-cell is-${row.kind}"><span class="diff-number">${number ?? ""}</span><span class="diff-text">${esc(row.text) || " "}</span></span>`;
};

export function diffBlock(code, title = "") {
  const diff = parseDiffText(code, title);
  const sign = { add: "+", remove: "-", context: " " };
  const inline = diff.rows
    .map((row) =>
      row.kind === "hunk" || row.kind === "note"
        ? `<span class="diff-row is-${row.kind}"><span class="diff-text">${esc(row.text)}</span></span>`
        : `<span class="diff-row is-${row.kind}"><span class="diff-number">${row.oldNumber ?? ""}</span><span class="diff-number">${row.newNumber ?? ""}</span><span class="diff-sign">${sign[row.kind]}</span><span class="diff-text">${esc(row.text) || " "}</span></span>`
    )
    .join("");
  const split = splitRows(diff.rows)
    .map(([left, right]) =>
      left && left === right && (left.kind === "hunk" || left.kind === "note")
        ? `<span class="diff-pair is-${left.kind}">${diffCell(left, "old")}</span>`
        : `<span class="diff-pair">${diffCell(left?.kind === "add" ? undefined : left, "old")}${diffCell(right?.kind === "remove" ? undefined : right, "new")}</span>`
    )
    .join("");
  const name = diff.path || ui("改动");
  return `<figure class="code-block diff-block" data-ui-owned="${sourceKey(`diff:${title}\n${code}`)}" data-diff-view="inline"><figcaption class="code-block-head"><button type="button" class="diff-collapse" data-diff-collapse aria-expanded="true" title="${ui("折叠改动")}">${icon("chevron-down")}</button>${icon("file-code")}<span class="code-block-language diff-path" title="${esc(name)}">${esc(name)}</span><span class="diff-count is-add">+${diff.added}</span><span class="diff-count is-remove">-${diff.removed}</span><span class="diff-views" role="group" aria-label="${ui("改动视图")}"><button type="button" class="code-block-action" data-diff-view="inline" aria-pressed="true">${icon("square")}<span>${ui("内联")}</span></button><button type="button" class="code-block-action" data-diff-view="split" aria-pressed="false">${icon("panel-right")}<span>${ui("并排")}</span></button></span><button type="button" class="code-block-action is-icon" data-code-copy title="${ui("复制改动")}" aria-label="${ui("复制改动")}">${icon("copy")}</button></figcaption><div class="diff-body"><pre class="diff-inline"><code data-copy-text="${esc(code)}">${inline}</code></pre><div class="diff-split" hidden>${split}</div></div></figure>`;
}

/* Diagrams --------------------------------------------------------------- */

/** The diagram is drawn later, in the page; until then, and if it fails, the source shows. */
export function mermaidBlock(code) {
  const key = sourceKey(`mermaid\n${code}`);
  return `<figure class="code-block diagram-block" data-ui-owned="${key}"><figcaption class="code-block-head"><span class="code-block-language">mermaid</span><button type="button" class="code-block-action" data-diagram-source aria-pressed="false">${icon("code")}<span>${ui("源码")}</span></button><button type="button" class="code-block-action is-icon" data-block-zoom title="${ui("放大查看")}" aria-label="${ui("放大查看")}">${icon("fit")}</button></figcaption><div class="diagram-canvas" data-diagram-canvas role="img" aria-label="${ui("Mermaid 图")}"></div><pre class="diagram-source"><code data-copy-text="${esc(code)}">${esc(code)}</code></pre></figure>`;
}

/* Tables ----------------------------------------------------------------- */

export function tableBlock(table, rows, columns) {
  return `<figure class="table-block" data-ui-owned="${sourceKey(`table\n${table}`)}"><figcaption class="code-block-head"><span class="code-block-language">${ui`${rows} 行 × ${columns} 列`}</span>${copyAction(ui("复制表格"))}<button type="button" class="code-block-action" data-block-zoom title="${ui("放大查看")}">${icon("fit")}<span>${ui("放大")}</span></button></figcaption><div class="table-scroll">${table}</div></figure>`;
}

/* File references -------------------------------------------------------- */

const CODE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|zsh|sql|vue|svelte|css|scss|less|html|xml";
const OTHER_EXTENSIONS =
  "json|jsonc|md|mdx|yml|yaml|toml|ini|txt|lock|svg|png|jpg|jpeg|gif|pdf|csv|ipynb|pen";
const FILE_REFERENCE = new RegExp(
  `^((?:\\.{0,2}/)?(?:[\\w@.+-]+/)*[\\w@+-][\\w@.+-]*\\.(?:${CODE_EXTENSIONS}|${OTHER_EXTENSIONS}))(?::(\\d+)(?:[-:]\\d+)?|\\s*\\((?:line|行|第)\\s*(\\d+)\\s*行?\\))?$`,
  "i"
);

/** `web/app.js:12`, `stages.json` or `useChangeStages.ts (line 222)`: a path and an optional line. */
export function fileReference(text) {
  const match = FILE_REFERENCE.exec(String(text).trim());
  if (!match) return undefined;
  return { path: match[1], line: Number(match[2] || match[3]) || undefined };
}

/** A local link's path, with a `#L12` or `:12` line, when it names a file. */
export function linkedFileReference(url) {
  const [path, fragment = ""] = String(url).split("#");
  const line = /^L(\d+)/.exec(fragment)?.[1];
  const reference = fileReference(path.split("/").pop() || "");
  if (!reference) return undefined;
  return { path, line: Number(line) || reference.line };
}

export function fileChip({ path, line }, { openable = false, label } = {}) {
  const name = label || path.split("/").pop();
  const extension = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase() || "";
  const glyph =
    extension === "json" || extension === "jsonc"
      ? '<span class="file-chip-braces" aria-hidden="true">{ }</span>'
      : icon(new RegExp(`^(?:${CODE_EXTENSIONS})$`).test(extension) ? "file-code" : "file");
  const title = line ? `${path}:${line}` : path;
  const content = `${glyph}<span class="file-chip-name">${esc(name)}</span>${line ? `<span class="file-chip-line">:${line}</span>` : ""}`;
  return openable
    ? `<button type="button" class="file-chip" data-file-ref="${esc(path)}"${line ? ` data-file-line="${line}"` : ""} title="${esc(ui`打开 ${title}`)}">${content}</button>`
    : `<span class="file-chip" title="${esc(title)}">${content}</span>`;
}

/* Callouts --------------------------------------------------------------- */

const CALLOUTS = {
  note: ["info", "注意"],
  tip: ["info", "提示"],
  important: ["info", "重要"],
  warning: ["triangle-alert", "警告"],
  caution: ["triangle-alert", "当心"]
};

/** `> [!WARNING]` and its kin; returns undefined for an ordinary quote. */
export function callout(kind, body) {
  const entry = CALLOUTS[String(kind).toLowerCase()];
  if (!entry) return undefined;
  const tone = entry[0] === "info" ? "info" : "warning";
  return `<aside class="callout is-${tone}" data-callout="${esc(kind.toLowerCase())}"><p class="callout-title">${icon(entry[0])}<span>${ui(entry[1])}</span></p><div class="callout-body">${body}</div></aside>`;
}
