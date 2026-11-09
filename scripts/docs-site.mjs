import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { navigation, userGuideFiles } from "../docs/site/navigation.mjs";
import { decorateArticle } from "../docs/site/components.mjs";
import { writeBundleLicenses } from "./docs-site-licenses.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "docs/site");
const output = resolve(root, ".tmp/docs-site");
await rm(output, { recursive: true, force: true });
const require = createRequire(resolve(source, "package.json"));
const { marked } = await import(require.resolve("marked"));
const { build } = require("esbuild");
const sanitize = require("sanitize-html");
const files = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8"
  })
    .split("\0")
    .filter((file) => file && existsSync(resolve(root, file)))
);
const pages = new Map();
const copies = new Map();
const published = new Set();
const searchIndex = [];
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const repository = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
const posix = (value) => value.split(sep).join("/");
const htmlPath = (file) => (file === "LICENSE" ? "LICENSE.html" : file.replace(/\.md$/, ".html"));
const relativeUrl = (from, to) => posix(relative(dirname(from), to)) || "./";
const pageUrl = (from, file) => relativeUrl(htmlPath(from), htmlPath(file));
const plain = (html) =>
  sanitize(html, { allowedTags: [], allowedAttributes: {} }).replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity]
  );
const isEnglish = (file) =>
  file === "README.md" ||
  file.includes("/en/") ||
  file.endsWith(".en.md") ||
  file === "docs/monitoring-pause-contract.md";
const isDocument = (file) => file.endsWith(".md") || file === "LICENSE";
const safeSource = (file) =>
  files.has(file) && !/^(?:config\.json|\.tmp\/|\.cowork\/|applications\/|workspace\/|task-)/.test(file);

function translated(file, english) {
  if (file === "README.md" || file === "README.zh-CN.md") return english ? "README.md" : "README.zh-CN.md";
  if (english) {
    const candidate = file.startsWith("docs/")
      ? file.replace(/^docs\//, "docs/en/")
      : file.replace(/\.md$/, ".en.md");
    return files.has(candidate) ? candidate : file;
  }
  return file.replace(/^docs\/en\//, "docs/").replace(/\.en\.md$/, ".md");
}

// Render Markdown once, then reuse it for the shell, search and navigation.
async function readPage(file) {
  if (pages.has(file)) return pages.get(file);
  if (!safeSource(file) || !isDocument(file)) throw new Error(`Not a source document: ${file}`);
  const markdown = await readFile(resolve(root, file), "utf8");
  const headings = [];
  const used = new Map();
  const renderer = new marked.Renderer();
  renderer.heading = function (token) {
    const html = this.parser.parseInline(token.tokens);
    const text = plain(html);
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    const count = used.get(slug) || 0;
    used.set(slug, count + 1);
    const id = slug + (count ? `-${count}` : "");
    headings.push({ text, id, depth: token.depth });
    return `<h${token.depth} id="${escape(id)}">${html}</h${token.depth}>\n`;
  };
  const code = renderer.code;
  renderer.code = function (token) {
    if ((token.lang || "").trim() === "mermaid") return `<pre class="mermaid">${escape(token.text)}</pre>`;
    return code.call(this, token);
  };
  const html =
    file === "LICENSE"
      ? `<h1>MIT License</h1><pre><code>${escape(markdown)}</code></pre>`
      : marked.parse(markdown, { renderer, gfm: true });
  const title =
    headings.find((item) => item.depth === 1)?.text ||
    plain(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] || file);
  const page = { file, markdown, html, title, headings, english: isEnglish(file) };
  pages.set(file, page);
  return page;
}

function destination(page, href, image = false) {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href;
  const url = new URL(href, `https://docs.invalid/${page.file}`);
  const file = decodeURIComponent(url.pathname).replace(/^\//, "");
  if (
    !files.has(file) &&
    [...files].some((candidate) => candidate.startsWith(`${file.replace(/\/$/, "")}/`))
  ) {
    return `${repository}/tree/main/${url.pathname.slice(1)}` + url.hash;
  }
  if (!safeSource(file)) return href;
  if (!image && isDocument(file)) {
    // Referenced guides outside docs/ are included without crawling unrelated source.
    pending.add(file);
    return pageUrl(page.file, file) + url.search + url.hash;
  }
  const asset = /\.(?:svg|gif|png|jpe?g|webp|pdf)$/i.test(file);
  const target = asset ? file : `_source/${file}.txt`;
  copies.set(target, file);
  return relativeUrl(htmlPath(page.file), target) + url.search + url.hash;
}

function article(page) {
  let body = page.html.replace(/<p>([\s\S]*?)<\/p>/, (match, contents) =>
    /^(?:简体中文|中文|English)\s*\|\s*(?:简体中文|中文|English)$/.test(plain(contents).trim()) ? "" : match
  );
  body = body.replace(/<p>((?:\s*<a id="[^"]+"><\/a>\s*)+)<\/p>/g, "$1");
  if (page.file === "docs/README.md" || page.file === "docs/en/README.md")
    body = body.replace("<ul>", '<ul class="start-options">');
  if (/^docs\/(?:en\/)?(?:getting-started|cli-quickstart)\.md$/.test(page.file))
    body = body.replace(/<p>(<a href="[^"]+">[^<]+<\/a>)<\/p>/, '<p class="download-action">$1</p>');
  const sanitized = sanitize(body, {
    allowedTags: [...sanitize.defaults.allowedTags, "img", "picture", "source", "details", "summary"],
    allowedAttributes: {
      ...sanitize.defaults.allowedAttributes,
      "*": ["id", "class", "align", "title"],
      a: ["href", "name", "target", "rel", "title"],
      img: ["src", "alt", "width", "height", "loading"],
      source: ["srcset", "media", "type"],
      details: ["open"]
    },
    transformTags: {
      "*": (tagName, attribs) => {
        if (attribs.href) attribs.href = destination(page, attribs.href);
        if (attribs.src) attribs.src = destination(page, attribs.src, true);
        if (attribs.srcset)
          attribs.srcset = attribs.srcset
            .split(",")
            .map((part) => {
              const [url, ...descriptor] = part.trim().split(/\s+/);
              return [destination(page, url, true), ...descriptor].join(" ");
            })
            .join(", ");
        if (tagName === "a" && /^https?:/i.test(attribs.href || "")) attribs.rel = "noreferrer noopener";
        return { tagName, attribs };
      }
    }
  });
  return decorateArticle(page, sanitized);
}

const searchIcon =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const menuIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14M5 16h14"/></svg>';
const closeIcon =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
const sourceIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/></svg>';

function shell(page, body) {
  const en = page.english;
  const t = (zh, english) => (en ? english : zh);
  const home = en ? "docs/en/README.md" : "docs/README.md";
  const readme = en ? "README.md" : "README.zh-CN.md";
  const asset = (name) => relativeUrl(htmlPath(page.file), `_site/${name}`);
  const nav = navigation.map((group) => ({
    ...group,
    pages: group.pages.map(([file, zh, english]) => {
      const target = translated(file, en);
      return { file: target, title: en ? english : zh, untranslated: en && !isEnglish(target) };
    })
  }));
  const flat = nav.flatMap((group) => group.pages);
  const position = flat.findIndex((item) => item.file === page.file);
  const isHome = page.file === home;
  const counterpart = en ? translated(page.file, false) : translated(page.file, true);
  const hasTranslation = counterpart !== page.file && files.has(counterpart);
  const langTarget = hasTranslation ? counterpart : en ? "docs/README.md" : "docs/en/README.md";
  const isApplication = page.file === translated("docs/applications.md", en);
  const toc = page.headings.filter(
    (heading) => heading.depth === 2 || (!isApplication && heading.depth === 3)
  );
  const pager = (item, previous) =>
    item
      ? `<a class="${previous ? "pager-prev" : "pager-next"}" href="${escape(pageUrl(page.file, item.file))}">${previous ? '<span aria-hidden="true">←</span>' : ""}<strong>${escape(item.title)}</strong>${previous ? "" : '<span aria-hidden="true">→</span>'}</a>`
      : "<span></span>";
  const journeys = [
    ["docs/getting-started.md", "docs/configuration.md"],
    ["docs/cli-quickstart.md", "docs/configuration.md"]
  ].map((journey) => journey.map((file) => translated(file, en)));
  const journey = journeys.find((items) => items.slice(0, 2).includes(page.file));
  const step = journey?.indexOf(page.file);
  const previous = journey ? flat.find((item) => item.file === journey[step - 1]) : flat[position - 1];
  const next = journey
    ? flat.find((item) => item.file === journey[step + 1])
    : userGuideFiles.has(page.file) && flat[position + 1] && !userGuideFiles.has(flat[position + 1].file)
      ? undefined
      : flat[position + 1];
  const sectionHtml = (section) => {
    const links = section.pages
      .map(
        (item) =>
          `<a href="${escape(pageUrl(page.file, item.file))}" ${item.file === page.file ? 'aria-current="page"' : ""}>${escape(item.title)}${item.untranslated ? '<small lang="zh-CN">中文</small>' : ""}</a>`
      )
      .join("");
    const title = escape(en ? section.en : section.zh);
    if (section.collapsed)
      return `<details class="sidebar-disclosure" ${section.pages.some((item) => item.file === page.file) ? "open" : ""}><summary>${title}</summary><div class="sidebar-group">${links}</div></details>`;
    return `<section class="sidebar-group"><h2>${title}</h2>${links}</section>`;
  };
  return `<!doctype html>
<html lang="${en ? "en" : "zh-CN"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="CoworkOS Docs ${escape(manifest.version)}">
<meta name="description" content="${escape(t("CoworkOS 使用文档：从安装与模型配置，到多智能体协作、应用工作台与开发扩展。", "CoworkOS documentation: installation, configuration, multi-agent workflows, applications and development."))}">
<meta name="theme-color" content="#ffffff"><title>${escape(isHome ? page.title : `${page.title} · CoworkOS Docs`)}</title>
<link rel="icon" type="image/png" href="${asset("atria-logo.png")}"><link rel="stylesheet" href="${asset("theme.css")}">
<link rel="stylesheet" href="${asset("components.css")}">
<script type="module" src="${asset("client.js")}"></script></head>
<body data-page="${page.file === home ? "home" : "guide"}">
<a class="skip-link" href="#main-content">${t("跳到正文", "Skip to content")}</a>
<header class="site-header">
<a class="brand" href="${pageUrl(page.file, home)}"><img src="${asset("atria-logo.png")}" alt="" width="35" height="30"><span>CoworkOS <span class="brand-label">Docs</span></span></a>
<div class="header-links"><a href="${pageUrl(page.file, readme)}">${t("项目", "Project")}</a><a class="language-switch" href="${pageUrl(page.file, langTarget)}" lang="${en ? "zh-CN" : "en"}" title="${hasTranslation ? t("Read this page in English", "阅读本页中文") : t("English documentation home", "中文文档首页")}">${en ? "简体中文" : "English"}</a><button class="header-search" type="button" data-search aria-label="${t("搜索", "Search")}">${searchIcon}</button><button class="mobile-menu" type="button" aria-label="${t("导航", "Navigation")}" aria-controls="site-sidebar" aria-expanded="false">${menuIcon}</button></div>
</header>
<div class="sidebar-backdrop"></div><div class="docs-layout">
<aside class="sidebar" id="site-sidebar" aria-label="${t("文档导航", "Documentation navigation")}">
<div class="sidebar-search"><button class="search-button" type="button" data-search>${searchIcon}<span>${t("搜索", "Search")}</span><kbd>⌘ K</kbd></button></div>
<nav>${nav.map(sectionHtml).join("")}</nav>
</aside>
<main class="content" id="main-content">${isHome ? "" : `<div class="article-tools"><a class="source-link icon-button" href="${relativeUrl(htmlPath(page.file), `_source/${page.file}`)}" aria-label="Markdown">${sourceIcon}<span class="tooltip" role="tooltip">Markdown</span></a></div>`}
<article class="article markdown-body">${body}</article>
${position >= 0 && !isHome ? `<nav class="pager" aria-label="${t("相邻文档", "Adjacent guides")}">${pager(previous, true)}${pager(next, false)}</nav>` : ""}
<footer class="docs-footer"><a href="${asset("licenses/index.html")}">${t("第三方许可", "Third-party licenses")}</a></footer></main>
${isHome ? "" : `<aside class="toc" aria-label="${t("本页目录", "On this page")}"><nav class="toc-links">${toc.map((heading) => `<a class="${heading.depth === 3 ? "toc-h3" : ""}" href="#${encodeURIComponent(heading.id)}">${escape(heading.text)}</a>`).join("")}</nav></aside>`}
</div>
<dialog class="search-dialog" aria-label="${t("搜索", "Search")}"><div class="search-input-row">${searchIcon}<input class="search-input" type="search" placeholder="${t("搜索", "Search")}" aria-label="${t("搜索关键词", "Search terms")}" autocomplete="off"><button type="button" data-close-search aria-label="${t("关闭搜索", "Close search")}">${closeIcon}</button></div><div class="search-results" aria-live="polite"></div><div class="search-hint"><label class="search-scope"><input type="checkbox" data-search-all> ${t("全部文档", "All docs")}</label></div></dialog>
</body></html>`;
}

function indexPage(page) {
  const sections = page.html.split(/(?=<h[1-3]\b)/);
  for (const section of sections) {
    const match = /^<h([1-3]) id="([^"]+)">([\s\S]*?)<\/h\1>/.exec(section);
    const text = plain(section).replace(/\s+/g, " ").trim();
    if (!text) continue;
    searchIndex.push({
      file: page.file,
      title: page.title,
      heading: match ? plain(match[3]) : page.title,
      text,
      lang: page.english ? "en" : "zh",
      audience: userGuideFiles.has(page.file) ? "user" : "reference",
      url:
        relativeUrl("_site/search-index.json", htmlPath(page.file)) +
        (match ? `#${encodeURIComponent(match[2])}` : "")
    });
  }
}

async function save(file, data) {
  await mkdir(dirname(resolve(output, file)), { recursive: true });
  await writeFile(resolve(output, file), data);
  published.add(file);
}

const pending = new Set(
  [...files].filter((file) => /^(?:[^/]+\.md|docs\/(?:en\/|releases\/)?[^/]+\.md)$/.test(file))
);
pending.add("LICENSE");
for (const file of pending) {
  const page = await readPage(file);
  const body = article(page);
  await save(htmlPath(file), shell(page, body));
  await save(`_source/${file}`, page.markdown);
  indexPage(page);
}
await save(
  "index.html",
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=docs/README.html"><title>CoworkOS Docs</title><a href="docs/README.html">打开 CoworkOS 文档 · Open CoworkOS Docs</a></html>'
);
for (const [target, original] of copies) {
  const metadata = await lstat(resolve(root, original));
  if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
  await mkdir(dirname(resolve(output, target)), { recursive: true });
  await copyFile(resolve(root, original), resolve(output, target));
  published.add(target);
}
await save("_site/search-index.json", JSON.stringify(searchIndex));
await save("_site/theme.css", await readFile(resolve(source, "theme.css")));
await save("_site/components.css", await readFile(resolve(source, "components.css")));
await save("_site/atria-logo.png", await readFile(resolve(root, "docs/assets/atria-logo.png")));
const bundle = await build({
  absWorkingDir: source,
  entryPoints: ["client.js"],
  outdir: resolve(output, "_site"),
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  metafile: true,
  legalComments: "linked"
});
for (const file of Object.keys(bundle.metafile.outputs))
  published.add(posix(relative(output, resolve(source, file))));
for (const file of await readdir(resolve(output, "_site"))) published.add(`_site/${file}`);
const licenses = await writeBundleLicenses({ source, output, metafile: bundle.metafile });
for (const file of licenses.files) published.add(file);
if (licenses.missing.length) throw new Error(`Missing bundled license terms: ${licenses.missing.join(", ")}`);
console.log(`Docs built: ${pages.size} pages, ${searchIndex.length} searchable sections → .tmp/docs-site/`);

if (process.argv.includes("--serve")) {
  const option = process.argv.find((arg) => arg.startsWith("--port="));
  const port = option ? Number(option.split("=")[1]) : 18743;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Expected --port=1..65535");
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".pdf": "application/pdf"
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      let file = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      if (file.endsWith("/") && published.has(`${file}README.html`)) file += "README.html";
      if (!file.startsWith("_source/") && file.endsWith(".md")) {
        response.writeHead(302, { Location: url.pathname.replace(/\.md$/, ".html") + url.search }).end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      if (!published.has(file)) {
        response
          .writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found · CoworkOS Docs</title><h1>Page not found</h1><p><a href="/">Return to CoworkOS Docs</a></p>'
          );
        return;
      }
      response.writeHead(200, {
        "Content-Type": mime[extname(file)] || "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : await readFile(resolve(output, file)));
      // eslint-disable-next-line no-restricted-syntax -- 单个请求读取文件失败改用 400 响应返回，静态服务器不能因一个请求退出
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end("Request unavailable");
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`CoworkOS Docs: http://127.0.0.1:${port}/`));
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
