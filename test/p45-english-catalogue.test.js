import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import ts from "typescript";

/**
 * Every visible string the Web client hands to `ui()` must have an English
 * entry, and so must the static shell that `localizeShell` rewrites in place.
 *
 * The test asks the same functions the page asks, so a source string counts as
 * covered only when it really renders without Han characters; a missing entry
 * leaves its Chinese text in place and is listed with the file and line that
 * produced it.
 */
globalThis.localStorage = { getItem: (key) => (key === "atria.language" ? "en" : null) };
const { ui, localizeShell } = await import("../web/assets/ui/language.js");

const han = /\p{Script=Han}/u;
const SHELL_ATTRIBUTES = ["aria-label", "title", "placeholder", "data-prompt"];

async function javaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await javaScriptFiles(path)));
    else if (entry.name.endsWith(".js") && entry.name !== "language-en.js") files.push(path);
  }
  return files;
}

/** String literals inside an argument, without descending into calls or closures. */
function literalsOf(node, found) {
  if (ts.isStringLiteralLike(node)) {
    found.push(node.text);
    return found;
  }
  if (ts.isTemplateExpression(node)) {
    found.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    return found;
  }
  if (
    ts.isBinaryExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isPropertyAssignment(node)
  ) {
    ts.forEachChild(node, (child) => literalsOf(child, found));
  }
  return found;
}

/** Source strings passed to `ui()` in one module, with the line that holds them. */
function uiSources(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const sources = [];
  const record = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const value of literalsOf(node, [])) if (han.test(value)) sources.push({ file, line, value });
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ui") {
      if (node.arguments[0]) record(node.arguments[0]);
    } else if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "ui") {
      record(node.template);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sources;
}

test("every ui() string in the Web client has an English catalogue entry", async () => {
  const sources = [];
  for (const file of await javaScriptFiles("web")) {
    sources.push(...uiSources(file, await readFile(file, "utf8")));
  }
  assert.ok(sources.length > 0, "the scan found no ui() strings; the extractor no longer matches the source");
  const missing = sources
    .map(({ file, line, value }) => ({ file, line, value, translated: ui(value) }))
    .filter(({ translated }) => han.test(translated))
    .map(
      ({ file, line, value, translated }) =>
        `${file}:${line}  ${JSON.stringify(value)} → ${JSON.stringify(translated)}`
    );
  assert.deepEqual(missing, [], `ui() strings without an English catalogue entry:\n${missing.join("\n")}`);
});

test("the static shell translates every visible string and accessible name", async () => {
  const { document } = parseHTML(await readFile("web/index.html", "utf8"));
  localizeShell(document.body);
  const untranslated = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      if (han.test(node.textContent)) untranslated.push(`text  ${JSON.stringify(node.textContent.trim())}`);
      return;
    }
    if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "SVG"].includes(node.tagName)) return;
    for (const name of SHELL_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value && han.test(value)) untranslated.push(`${name}  ${JSON.stringify(value)}`);
    }
    if (node.tagName !== "TEXTAREA") for (const child of node.childNodes) walk(child);
  };
  walk(document.body);
  assert.deepEqual(
    untranslated,
    [],
    `static shell strings without an English catalogue entry:\n${untranslated.join("\n")}`
  );
});
