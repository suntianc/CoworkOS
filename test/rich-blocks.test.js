import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { renderMarkdown } from "../web/assets/markdown.js";
import {
  ansiToHtml,
  fileReference,
  linkedFileReference,
  parseDiffText,
  sourceKey,
  stripAnsi
} from "../web/assets/rich-blocks.js";

const dom = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

test("file references name a path with a known extension and an optional line", () => {
  assert.deepEqual(fileReference("useChangeStages.ts:222"), { path: "useChangeStages.ts", line: 222 });
  assert.deepEqual(fileReference("web/app.js"), { path: "web/app.js", line: undefined });
  assert.deepEqual(fileReference("useChangeStages.ts (line 222)"), { path: "useChangeStages.ts", line: 222 });
  assert.deepEqual(fileReference("stages.json"), { path: "stages.json", line: undefined });
  for (const text of ["console.log", "npm test", "obj.method", "v1.2", "x = 1", "foo()"])
    assert.equal(fileReference(text), undefined, text);
  assert.deepEqual(linkedFileReference("/repo/web/app.js#L12"), { path: "/repo/web/app.js", line: 12 });
  assert.equal(linkedFileReference("/repo/README"), undefined);
});

test("inline file references become chips; only resolvable ones are buttons", () => {
  const html = renderMarkdown("改在 `web/app.js:12` 和 `stages.json`，调用 `console.log`。", {
    resolveFile: (path) => path === "web/app.js"
  });
  const document = dom(html);
  const button = document.querySelector("button.file-chip");
  assert.equal(button.dataset.fileRef, "web/app.js");
  assert.equal(button.dataset.fileLine, "12");
  assert.equal(button.querySelector(".file-chip-line").textContent, ":12");
  assert.equal(document.querySelector("span.file-chip .file-chip-name").textContent, "stages.json");
  assert.equal(document.querySelector("code").textContent, "console.log");
  // An unresolved local link reads as a file, not as raw Markdown.
  const link = dom(renderMarkdown("见 [app.js](/repo/web/app.js#L3)"));
  assert.equal(link.querySelector(".file-chip").title, "/repo/web/app.js:3");
  assert.ok(!link.body.textContent.includes("]("));
});

test("a unified diff without git headers still numbers its lines", () => {
  const diff = parseDiffText("@@ -218,3 +218,2 @@\n ctx\n-old one\n-old two\n+new\n", "web/a.ts");
  assert.equal(diff.path, "web/a.ts");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 2);
  assert.deepEqual(
    diff.rows.map((row) => [row.kind, row.oldNumber, row.newNumber]),
    [
      ["hunk", undefined, undefined],
      ["context", 218, 218],
      ["remove", 219, undefined],
      ["remove", 220, undefined],
      ["add", undefined, 219]
    ]
  );
  assert.equal(parseDiffText("--- a/x.ts\n+++ b/y.ts\n-a\n+b").path, "y.ts");
  const document = dom(renderMarkdown("```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```"));
  const block = document.querySelector(".diff-block");
  assert.equal(block.dataset.diffView, "inline");
  assert.equal(block.querySelector(".diff-path").textContent, "x.ts");
  assert.equal(block.querySelector(".diff-count.is-add").textContent, "+1");
  assert.ok(block.querySelector(".diff-split").hasAttribute("hidden"));
  assert.equal(block.querySelectorAll(".diff-split .diff-pair").length, 2, "hunk row and one paired change");
});

test("terminal output keeps colours, drops other escapes and folds long output", () => {
  assert.equal(
    ansiToHtml("\u001b[32m✔ ok\u001b[0m \u001b[1;31mfail\u001b[0m\u001b[2K"),
    '<span class="ansi-green">✔ ok</span> <span class="ansi-red ansi-bold">fail</span>'
  );
  assert.equal(stripAnsi("\u001b[32mok\u001b[0m"), "ok");
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const document = dom(renderMarkdown(`\`\`\`terminal npm test exit=1\n${lines}\n\`\`\``));
  const block = document.querySelector(".terminal-block");
  assert.equal(block.querySelector(".terminal-command").textContent, "npm test");
  assert.equal(block.querySelector(".terminal-exit").textContent, "退出码 1");
  assert.ok(block.querySelector(".terminal-exit").classList.contains("is-failed"));
  assert.equal(block.querySelectorAll(":scope pre > code > .terminal-line").length, 12);
  assert.equal(block.querySelectorAll("[data-terminal-rest] .terminal-line").length, 8);
  assert.equal(block.querySelector("[data-terminal-more]").textContent, "展开其余 8 行");
  assert.equal(block.querySelector("[data-copy-text]").dataset.copyText, lines);
  // ANSI in an ordinary fence is still terminal output.
  assert.ok(dom(renderMarkdown("```\n\u001b[31mred\u001b[0m\n```")).querySelector(".terminal-block"));
});

test("tables, task lists, callouts and diagrams render as their own blocks", () => {
  const document = dom(
    renderMarkdown(
      [
        "| 阶段 | 来源 |",
        "|---|---|",
        "| 开发 | 记录 |",
        "| 审查 | 状态 |",
        "",
        "- [x] 推导阶段",
        "- [ ] 补测试",
        "",
        "> [!WARNING]",
        "> 格式变了，**需要**升级。",
        "",
        "> 普通引用",
        "> 第二行",
        "",
        "```mermaid",
        "graph LR; A-->B",
        "```"
      ].join("\n")
    )
  );
  assert.equal(document.querySelector(".table-block .code-block-language").textContent, "2 行 × 2 列");
  assert.equal(document.querySelectorAll(".table-block tbody tr").length, 2);
  const tasks = document.querySelectorAll(".task-list .task-item input");
  assert.deepEqual(
    [...tasks].map((box) => box.hasAttribute("checked")),
    [true, false]
  );
  const warning = document.querySelector(".callout.is-warning");
  assert.equal(warning.querySelector(".callout-title").textContent, "警告");
  assert.equal(warning.querySelector("strong").textContent, "需要");
  assert.equal(document.querySelectorAll("blockquote").length, 1, "consecutive quoted lines are one quote");
  assert.equal(document.querySelector("blockquote").querySelectorAll("p").length, 1);
  const diagram = document.querySelector(".diagram-block");
  assert.ok(diagram.querySelector("[data-diagram-canvas]"));
  assert.equal(diagram.querySelector("[data-copy-text]").dataset.copyText, "graph LR; A-->B");
});

test("a block's ownership key follows its source only", () => {
  const first = dom(renderMarkdown("```js\nconst a = 1;\n```")).querySelector(".code-block");
  const again = dom(renderMarkdown("前言\n\n```js\nconst a = 1;\n```")).querySelector(".code-block");
  const changed = dom(renderMarkdown("```js\nconst a = 2;\n```")).querySelector(".code-block");
  assert.equal(first.dataset.uiOwned, again.dataset.uiOwned);
  assert.notEqual(first.dataset.uiOwned, changed.dataset.uiOwned);
  assert.notEqual(sourceKey("a"), sourceKey("b"));
});
