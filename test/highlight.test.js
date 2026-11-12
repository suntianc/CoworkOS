import test from "node:test";
import assert from "node:assert/strict";
import { HIGHLIGHT_LIMIT, highlightCode, languageFamily } from "../web/assets/ui/highlight.js";

/** Code blocks are coloured by language (#26); the text itself never changes. */

const text = (html) =>
  html
    .replace(/<span class="tok-[a-z]+">|<\/span>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
const tokens = (html, kind) =>
  [...html.matchAll(new RegExp(`<span class="tok-${kind}">([^<]*)</span>`, "g"))].map(([, value]) =>
    text(value)
  );

const samples = {
  ts: `// load the user\nexport async function load(id: string): Promise<User> {\n  const url = \`/api/\${id}\`; /* note */\n  return fetch(url, { retries: 3, ok: true });\n}`,
  python: `@cache\ndef area(r: float) -> float:\n    """Circle area."""\n    return 3.14 * r ** 2  # approx\nprint(f"{area(2)}", None)`,
  bash: `# build\nexport NODE_ENV=production\nif [ -n "$CI" ]; then npm run build --silent; fi\necho 'done' $HOME # ok`,
  json: `{"name": "atria", "version": 2, "private": true, "tags": ["a", null]}`,
  css: `.card:hover { color: #fff; --gap: 4px; margin: calc(2px + 1rem); } @media (x) {}`,
  html: `<!-- top --><a href="/x" data-id='1'>Hi &amp; bye</a>`,
  sql: `SELECT id, name FROM users WHERE age > 18 -- adults\nORDER BY name;`,
  yaml: `name: build # ci\non:\n  push: true\nversion: "1.2"`,
  rust: `fn main() { let v: Vec<u32> = vec![1, 2]; println!("{}", v.len()); }`,
  go: `func main() { x := map[string]int{"a": 1}; fmt.Println(x) }`
};

test("highlighting keeps every character and escapes markup", () => {
  for (const [language, code] of Object.entries(samples)) {
    const html = highlightCode(language, code);
    assert.equal(text(html), code, `${language} round-trips`);
    assert.doesNotMatch(
      html.replace(/<span class="tok-[a-z]+">|<\/span>/g, ""),
      /[<>]/,
      `${language} escaped`
    );
  }
  const hostile = `const x = "<img src=x onerror=alert(1)>"; // </span><script>`;
  const html = highlightCode("js", hostile);
  assert.equal(text(html), hostile);
  assert.doesNotMatch(html, /<img|<script|<\/span><script/);
});

test("each family colours its own constructs", () => {
  const ts = highlightCode("ts", samples.ts);
  assert.deepEqual(tokens(ts, "comment"), ["// load the user", "/* note */"]);
  assert.ok(tokens(ts, "keyword").includes("async"));
  assert.ok(tokens(ts, "keyword").includes("function"));
  assert.ok(tokens(ts, "type").includes("Promise"));
  assert.ok(tokens(ts, "function").includes("fetch"));
  assert.ok(tokens(ts, "number").includes("3"));
  assert.ok(tokens(ts, "string").includes("`/api/${id}`"));

  const py = highlightCode("py", samples.python);
  assert.deepEqual(tokens(py, "function").slice(0, 1), ["@cache"]);
  assert.ok(tokens(py, "string").includes('"""Circle area."""'));
  assert.ok(tokens(py, "comment").includes("# approx"));
  assert.ok(tokens(py, "number").includes("None"));

  const sh = highlightCode("bash", samples.bash);
  assert.ok(tokens(sh, "type").includes("$HOME"));
  assert.ok(tokens(sh, "string").includes('"$CI"'));
  assert.ok(tokens(sh, "comment").includes("# ok"));
  assert.ok(tokens(sh, "punct").includes("--silent"));

  const json = highlightCode("json", samples.json);
  assert.deepEqual(tokens(json, "type"), ['"name"', '"version"', '"private"', '"tags"']);
  assert.ok(tokens(json, "string").includes('"atria"'));

  const sql = highlightCode("sql", samples.sql);
  assert.ok(tokens(sql, "keyword").includes("SELECT"));
  assert.ok(tokens(sql, "comment").includes("-- adults"));

  const html = highlightCode("html", samples.html);
  assert.ok(tokens(html, "keyword").includes("<a"));
  assert.ok(tokens(html, "type").includes("href"));
  assert.ok(tokens(html, "comment").includes("<!-- top -->"));
});

test("unknown languages and very large blocks stay plain, escaped", () => {
  assert.equal(languageFamily("brainfuck"), undefined);
  assert.equal(highlightCode("text", "a < b"), "a &#60; b");
  assert.equal(highlightCode("", "x"), "x");
  const big = "let a = 1;\n".repeat(Math.ceil(HIGHLIGHT_LIMIT / 11) + 1);
  assert.doesNotMatch(highlightCode("js", big), /tok-/);
});

test("a long block is coloured quickly and served from the cache when unchanged", () => {
  const code = samples.ts.repeat(100);
  const started = performance.now();
  const first = highlightCode("ts", code);
  const firstMs = performance.now() - started;
  assert.ok(firstMs < 200, `took ${firstMs.toFixed(1)}ms`);
  const again = performance.now();
  assert.equal(highlightCode("ts", code), first);
  assert.ok(performance.now() - again < 5);
});
