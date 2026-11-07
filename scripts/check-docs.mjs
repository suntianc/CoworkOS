import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./test.mjs";

// Current user and developer contracts; register maintained guides here.
export const maintainedDocumentation = [
  "docs/user-memory.md",
  "docs/builtin-capabilities.md",
  "docs/en/builtin-capabilities.md",
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  "AGENTS.en.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.en.md",
  "docs/README.md",
  "docs/getting-started.md",
  "docs/cli-quickstart.md",
  "docs/installation-reference.md",
  "docs/configuration.md",
  "docs/configuration-reference.md",
  "docs/runtime-reference.md",
  "docs/applications.md",
  "docs/creative-workflows.md",
  "docs/visual-observation.md",
  "docs/browser-use.md",
  "docs/cua-scripting.md",
  "docs/cua-progress.md",
  "docs/cua-live-validation.md",
  "docs/long-term-goals-architecture.md",
  "docs/long-term-goals-ux.md",
  "docs/monitoring-pause-contract.md",
  "docs/watcher-task-taxonomy.md",
  "docs/watcher-template-verification.md",
  "docs/watcher-template-review-2026-10-11.md",
  "docs/watcher-runtime-report-2026-10-12.md",
  "docs/cli-ui-adapter.md",
  "docs/development.md",
  "docs/p1-retrospective.md",
  "docs/p2-retrospective.md",
  "docs/core-pruning-retrospective.md",
  "docs/retrospectives.md",
  "docs/development-handoffs.md",
  "docs/pitfalls/README.md",
  "docs/pitfalls/testing.md",
  "docs/pitfalls/evidence/os-p2-electron/retro.md",
  "docs/pitfalls/evidence/os-p2-electron/dependency-receipt.md",
  "docs/pitfalls/evidence/os-core-pruning/retro.md",
  "docs/pitfalls/evidence/os-core-pruning/checks.md",
  "docs/code-map.md",
  "docs/architecture.md",
  "docs/module-ownership.md",
  "docs/documentation.md",
  "docs/software-integration.md",
  "docs/task-workspace-layout.md",
  "docs/product-api.md",
  "docs/mac-release.md",
  "docs/beta-release-process.md",
  "docs/releases/0.1.2-beta.1.md",
  "docs/releases/0.1.2-beta.2.md",
  "docs/releases/0.1.2-beta.3.md",
  "docs/releases/0.1.2-beta.4.md",
  "docs/releases/0.1.2-beta.5.md",
  "docs/releases/0.1.2-beta.6.md",
  "docs/releases/0.1.2-beta.7.md",
  "docs/releases/0.1.2-beta.12.md",
  "docs/testing-local-run.md",
  "docs/AGENTS.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/en/getting-started.md",
  "docs/en/configuration.md",
  "docs/en/testing-local-run.md"
];

export function proseOnly(markdown) {
  let fence;
  return markdown
    .split("\n")
    .map((line) => {
      const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (match && !fence) {
        fence = match[1];
        return "";
      }
      if (fence) {
        if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
        return "";
      }
      return line;
    })
    .join("\n");
}

export function markdownLinks(markdown) {
  const text = proseOnly(markdown).replace(/(`+)[^\n]*?\1/g, (value) => " ".repeat(value.length));
  const references = new Map();
  const normalize = (label) => label.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of text.matchAll(/^\s{0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/gm))
    references.set(normalize(match[1]), match[2] ?? match[3]);
  const links = [];
  // Destinations may contain balanced parentheses; optional titles follow whitespace.
  for (const match of text.matchAll(/!?\[([^\]\n]*)\](\(|\[([^\]\n]*)\])/g)) {
    const line = text.slice(0, match.index).split("\n").length;
    if (match[2] !== "(") {
      links.push({ destination: references.get(normalize(match[3] || match[1])), line });
      continue;
    }
    const start = match.index + match[0].length;
    let index = start;
    while (/\s/.test(text[index] ?? "") && index < text.length) index++;
    let destination = "";
    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      if (end === -1) continue;
      destination = text.slice(index + 1, end);
    } else {
      let depth = 0;
      for (; index < text.length; index++) {
        const character = text[index];
        if (character === "\\" && index + 1 < text.length) {
          destination += text[++index];
          continue;
        }
        if (character === "(") depth++;
        if (character === ")") {
          if (depth === 0) break;
          depth--;
        }
        if (/\s/.test(character) && depth === 0) break;
        destination += character;
      }
    }
    links.push({ destination, line });
  }
  // Reference definitions are destinations even if a later shortcut reference is used.
  for (const [label, destination] of references) links.push({ destination, line: 1, label });
  return links;
}

export function markdownAnchors(markdown) {
  const text = proseOnly(markdown);
  const anchors = new Set();
  const duplicates = new Map();
  for (const match of text.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1].replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "");
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    const count = duplicates.get(slug) ?? 0;
    anchors.add(count ? `${slug}-${count}` : slug);
    duplicates.set(slug, count + 1);
  }
  for (const match of text.matchAll(/<(?:a|[a-z][\w-]*)\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi))
    anchors.add(match[1]);
  return anchors;
}

export async function documentationFiles(root) {
  const files = [...maintainedDocumentation];
  // English translations mirror maintained docs; other English files may be added without changing the gate.
  const english = await readdir(resolve(root, "docs/en"), { withFileTypes: true }).catch(() => []);
  files.push(
    ...english
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => `docs/en/${entry.name}`)
  );
  async function agents(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "node_modules" || entry.name === "generated" || entry.name === "fixtures") continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await agents(file);
      else if (entry.isFile() && entry.name === "AGENTS.md") files.push(file);
    }
  }
  for (const directory of ["src", ".pi", "web", "desktop", "scripts", "test", "e2e"]) await agents(directory);
  return [...new Set(files)].sort();
}

export async function checkDocumentation(root, files = undefined) {
  const errors = [];
  const sources = files ?? (await documentationFiles(root));
  const anchorCache = new Map();
  let checkedLinks = 0;
  for (const file of sources) {
    let markdown;
    try {
      markdown = await readFile(resolve(root, file), "utf8");
    } catch (error) {
      errors.push(`${file}: cannot read maintained documentation (${error.code ?? error.message})`);
      continue;
    }
    for (const link of markdownLinks(markdown)) {
      const prefix = `${file}:${link.line}`;
      if (link.destination === undefined) {
        errors.push(`${prefix}: undefined reference link`);
        continue;
      }
      const destination = link.destination;
      if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) continue;
      checkedLinks++;
      let decoded;
      try {
        decoded = decodeURIComponent(destination);
      } catch {
        errors.push(`${prefix}: malformed URL encoding: ${destination}`);
        continue;
      }
      const [pathPart, fragment] = decoded.split("#", 2);
      const path = pathPart.split("?", 1)[0];
      const target = path ? resolve(dirname(resolve(root, file)), path) : resolve(root, file);
      const fromRoot = relative(root, target);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        errors.push(`${prefix}: link escapes repository: ${destination}`);
        continue;
      }
      try {
        await stat(target);
      } catch {
        errors.push(`${prefix}: missing local target: ${destination}`);
        continue;
      }
      if (fragment && target.endsWith(".md")) {
        if (!anchorCache.has(target))
          anchorCache.set(target, markdownAnchors(await readFile(target, "utf8")));
        if (!anchorCache.get(target).has(fragment))
          errors.push(`${prefix}: missing Markdown anchor: ${destination}`);
      }
    }
  }
  return { files: sources, checkedLinks, errors };
}

async function main(args) {
  if (args.some((argument) => argument !== "--list" && argument !== "--help" && argument !== "-h"))
    throw new Error("check:docs accepts --list or --help");
  if (args.includes("--list")) {
    for (const file of await documentationFiles(repositoryRoot)) console.log(file);
    return;
  }
  if (args.length) {
    console.log(
      "Check maintained Markdown local file links and heading anchors. External URLs and code examples are not checked. --list prints the scope."
    );
    return;
  }
  const result = await checkDocumentation(repositoryRoot);
  for (const error of result.errors) console.error(error);
  console.log(
    `Docs: ${result.files.length} files, ${result.checkedLinks} local links, ${result.errors.length} errors.`
  );
  if (result.errors.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
