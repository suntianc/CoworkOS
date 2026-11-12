/**
 * Syntax colouring for code blocks in replies (#26).
 *
 * A small tokenizer per language family, not a parser: comments, strings,
 * numbers, keywords, types and calls get a class, everything else stays plain
 * text. Colours come from the theme's `--code-*` tokens. Results are cached per
 * block so a streaming reply re-renders only the block that changed, and very
 * large blocks are left plain so a long paste never slows the page down.
 */

const escape = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const words = (list) => new Set(list.split(" "));

const C_COMMENTS = [/\/\/[^\n]*/y, /\/\*[\s\S]*?(?:\*\/|$)/y];
const QUOTED = [/"(?:\\[\s\S]|[^"\\\n])*"?/y, /'(?:\\[\s\S]|[^'\\\n])*'?/y];
const NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
const IDENT = /[A-Za-z_$][\w$]*/y;

const LANGUAGES = {
  clike: {
    comments: C_COMMENTS,
    strings: [...QUOTED, /`(?:\\[\s\S]|[^`\\])*`?/y],
    keywords: words(
      "abstract as async await break case catch class const continue debugger default defer delete do else enum export extends final finally fn for from func function go goto if impl implements import in instanceof interface let loop match mod move mut namespace new of override package private protected pub public readonly return select static struct super switch this throw throws trait try type typeof use var void where while with yield"
    ),
    literals: words("true false null undefined nil None self Self NaN Infinity"),
    types: words(
      "string number boolean bigint symbol any unknown never object int long short byte char float double bool void i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 usize isize f32 f64 str String Vec Option Result error rune uint8 uint16 uint32 uint64 int8 int16 int32 int64 float32 float64 map chan"
    )
  },
  python: {
    comments: [/#[^\n]*/y],
    strings: [
      /[rRbBfFuU]{0,2}"""[\s\S]*?(?:"""|$)/y,
      /[rRbBfFuU]{0,2}'''[\s\S]*?(?:'''|$)/y,
      /[rRbBfFuU]{0,2}"(?:\\[\s\S]|[^"\\\n])*"?/y,
      /[rRbBfFuU]{0,2}'(?:\\[\s\S]|[^'\\\n])*'?/y
    ],
    extra: [[/@[\w.]+/y, "function"]],
    keywords: words(
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield"
    ),
    literals: words("True False None self cls"),
    types: words("int float str bytes bool list dict set tuple object type Exception")
  },
  ruby: {
    comments: [/#[^\n]*/y],
    strings: QUOTED,
    extra: [[/:[A-Za-z_]\w*/y, "number"]],
    keywords: words(
      "alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require"
    ),
    literals: words("true false nil"),
    types: new Set()
  },
  shell: {
    comments: [/(?<![^\s;|&(])#[^\n]*/y],
    strings: [/"(?:\\[\s\S]|[^"\\])*"?/y, /'[^']*'?/y],
    extra: [
      [/\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[\d@#?$!*-]/y, "type"],
      [/(?<=\s|^)--?[A-Za-z][\w-]*/y, "punct"]
    ],
    keywords: words(
      "if then else elif fi for while until do done case esac in function return local export readonly declare unset set source alias exit break continue"
    ),
    literals: words("true false"),
    types: new Set(),
    noNumbersInWords: true
  },
  json: {
    comments: C_COMMENTS,
    strings: [],
    extra: [
      [/"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y, "type"],
      [/"(?:\\[\s\S]|[^"\\\n])*"?/y, "string"]
    ],
    keywords: new Set(),
    literals: words("true false null"),
    types: new Set()
  },
  yaml: {
    comments: [/(?<![^\s])#[^\n]*/y],
    strings: QUOTED,
    extra: [[/[\w.-]+(?=[ \t]*:(?:\s|$))/y, "type"]],
    keywords: new Set(),
    literals: words("true false null yes no on off ~"),
    types: new Set()
  },
  toml: {
    comments: [/#[^\n]*/y],
    strings: [/"""[\s\S]*?(?:"""|$)/y, ...QUOTED],
    extra: [
      [/^\s*\[\[?[^\]\n]*\]\]?/my, "keyword"],
      [/[\w.-]+(?=\s*=)/y, "type"]
    ],
    keywords: new Set(),
    literals: words("true false"),
    types: new Set()
  },
  css: {
    comments: [/\/\*[\s\S]*?(?:\*\/|$)/y],
    strings: QUOTED,
    extra: [
      [/@[\w-]+/y, "keyword"],
      [/#[\da-fA-F]{3,8}\b/y, "number"],
      [/--?[A-Za-z][\w-]*(?=\s*:)/y, "type"],
      [/[A-Za-z][\w-]*(?=\s*:[^:])/y, "type"],
      [/[A-Za-z-][\w-]*(?=\()/y, "function"]
    ],
    keywords: words("!important"),
    literals: new Set(),
    types: new Set(),
    identifier: /[A-Za-z_-][\w-]*/y
  },
  markup: {
    comments: [/<!--[\s\S]*?(?:-->|$)/y],
    strings: [],
    extra: [
      [/<\/?[A-Za-z][\w:.-]*|\/?>/y, "keyword"],
      [/[A-Za-z_:][\w:.-]*(?==)/y, "type"],
      [/"[^"]*"?|'[^']*'?/y, "string"],
      [/&[#\w]+;/y, "number"]
    ],
    keywords: new Set(),
    literals: new Set(),
    types: new Set(),
    noNumbers: true,
    noWords: true
  },
  sql: {
    comments: [/--[^\n]*/y, /\/\*[\s\S]*?(?:\*\/|$)/y],
    strings: [/'(?:''|[^'])*'?/y, /"[^"\n]*"?/y],
    keywords: words(
      "select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer full cross on group by order having limit offset as distinct union all case when then else end in is like between exists with returning begin commit rollback transaction default unique check constraint if replace asc desc"
    ),
    literals: words("null true false"),
    types: words(
      "int integer bigint smallint text varchar char boolean bool date timestamp timestamptz numeric decimal real float double serial json jsonb uuid blob"
    ),
    caseInsensitive: true
  }
};

const ALIASES = {
  js: "clike",
  jsx: "clike",
  mjs: "clike",
  cjs: "clike",
  javascript: "clike",
  ts: "clike",
  tsx: "clike",
  typescript: "clike",
  java: "clike",
  kotlin: "clike",
  kt: "clike",
  scala: "clike",
  swift: "clike",
  c: "clike",
  h: "clike",
  cpp: "clike",
  "c++": "clike",
  cc: "clike",
  hpp: "clike",
  cs: "clike",
  csharp: "clike",
  go: "clike",
  golang: "clike",
  rust: "clike",
  rs: "clike",
  php: "clike",
  dart: "clike",
  zig: "clike",
  python: "python",
  py: "python",
  ruby: "ruby",
  rb: "ruby",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  powershell: "shell",
  ps1: "shell",
  dockerfile: "shell",
  makefile: "shell",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "toml",
  css: "css",
  scss: "css",
  less: "css",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  sql: "sql",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql"
};

/** Blocks longer than this stay plain: colouring is a reading aid, not worth a stall. */
export const HIGHLIGHT_LIMIT = 40_000;
const CACHE_SIZE = 200;
const cache = new Map();

/** The language family a fence label belongs to, or undefined when none fits. */
export function languageFamily(language) {
  return ALIASES[String(language || "").toLowerCase()];
}

function tokenize(spec, code) {
  const identifier = spec.identifier || IDENT;
  const pieces = [];
  let plain = "";
  const flush = () => {
    if (plain) pieces.push(escape(plain));
    plain = "";
  };
  const take = (pattern, at) => {
    pattern.lastIndex = at;
    const match = pattern.exec(code);
    return match && match[0] ? match[0] : undefined;
  };
  const emit = (kind, text) => {
    flush();
    pieces.push(`<span class="tok-${kind}">${escape(text)}</span>`);
  };
  let at = 0;
  outer: while (at < code.length) {
    for (const pattern of spec.comments) {
      const text = take(pattern, at);
      if (text) {
        emit("comment", text);
        at += text.length;
        continue outer;
      }
    }
    for (const [pattern, kind] of spec.extra || []) {
      const text = take(pattern, at);
      if (text) {
        emit(kind, text);
        at += text.length;
        continue outer;
      }
    }
    for (const pattern of spec.strings) {
      const text = take(pattern, at);
      if (text) {
        emit("string", text);
        at += text.length;
        continue outer;
      }
    }
    const previous = code[at - 1] || "";
    if (!spec.noNumbers && !/[\w$]/.test(previous)) {
      const text = take(NUMBER, at);
      if (text && !(spec.noNumbersInWords && /[A-Za-z]/.test(text.slice(-1)))) {
        emit("number", text);
        at += text.length;
        continue;
      }
    }
    if (!spec.noWords) {
      const word = take(identifier, at);
      if (word) {
        const key = spec.caseInsensitive ? word.toLowerCase() : word;
        if (spec.keywords.has(key)) emit("keyword", word);
        else if (spec.literals.has(key)) emit("number", word);
        else if (spec.types.has(key) || (/^[A-Z][a-z]\w*$/.test(word) && !spec.caseInsensitive))
          emit("type", word);
        else if (/^\s*\(/.test(code.slice(at + word.length, at + word.length + 8))) emit("function", word);
        else plain += word;
        at += word.length;
        continue;
      }
    }
    plain += code[at];
    at += 1;
  }
  flush();
  return pieces.join("");
}

/**
 * Escaped HTML for `code`, coloured when its language is known; plain escaped
 * text otherwise. Safe to insert as innerHTML: every piece of source is escaped.
 */
export function highlightCode(language, code) {
  const family = languageFamily(language);
  if (!family || !code || code.length > HIGHLIGHT_LIMIT) return escape(code || "");
  const key = `${family}\n${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const html = tokenize(LANGUAGES[family], code);
  cache.set(key, html);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return html;
}
