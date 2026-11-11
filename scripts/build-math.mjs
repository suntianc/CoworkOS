import { buildDocumentMarkdown } from "./build-document-markdown.mjs";
import { copyFile, cp, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

/** Keep the renderer, styles, fonts and upstream license together for offline Web/App use. */
export async function buildMath() {
  await buildDocumentMarkdown();
  const source = new URL("../node_modules/katex/", import.meta.url);
  const target = new URL("../web/assets/math/generated/", import.meta.url);
  await mkdir(target, { recursive: true });
  for (const [from, to] of [
    ["dist/katex.mjs", "katex.js"],
    ["dist/katex.min.css", "katex.min.css"],
    ["LICENSE", "LICENSE.txt"]
  ])
    await copyFile(new URL(from, source), new URL(to, target));
  await cp(new URL("dist/fonts/", source), new URL("fonts/", target), { recursive: true });
  console.log(`Math assets prepared: ${fileURLToPath(target)}`);
  await buildMermaid();
}

/** Mermaid ships as one script the page loads only when a diagram appears. */
export async function buildMermaid() {
  const source = new URL("../node_modules/mermaid/", import.meta.url);
  const target = new URL("../web/assets/mermaid/generated/", import.meta.url);
  await mkdir(target, { recursive: true });
  for (const [from, to] of [
    ["dist/mermaid.min.js", "mermaid.min.js"],
    ["LICENSE", "LICENSE.txt"]
  ])
    await copyFile(new URL(from, source), new URL(to, target));
  console.log(`Diagram assets prepared: ${fileURLToPath(target)}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildMath();
