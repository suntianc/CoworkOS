import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { startDashboard } from "../test/dashboard-fixture.mjs";

let server;
let base;
test.beforeAll(async () => {
  const web = resolve("web");
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://fixture").pathname;
      if (pathname === "/") {
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><html><head><style>
          main { display: flex; width: 100%; height: 700px; }
          #conversation { width: 40%; } #workbench { position: relative; flex: 1; }
          .workbench-app { position: absolute; inset: 0; }
          [hidden] { display: none !important; }
        </style></head><body><button id="apps-nav">应用</button><aside id="apps-panel" hidden></aside>
          <main><section id="conversation"></section><section id="workbench"></section></main></body></html>`);
        return;
      }
      const path = resolve(web, `.${pathname}`);
      if (!path.startsWith(web + sep)) throw new Error("outside fixture");
      response.setHeader("content-type", extname(path) === ".js" ? "text/javascript" : "text/plain");
      response.end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  if (server) await new Promise((done) => server.close(done));
});

test("document Markdown supports HTML blocks, GFM and math without executable HTML", async ({ page }) => {
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { renderDocumentMarkdown } = await import("/assets/document-markdown.js");
    const source = [
      '<div align="center"><h2>HTML heading</h2><br><mark>Highlighted</mark></div>',
      "",
      "<details open><summary>Details</summary><table><tr><td>HTML cell</td></tr></table></details>",
      "",
      "Text with <sub>subscript</sub> and <sup>superscript</sup>.",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "- parent",
      "  - child",
      "",
      "![Picture](https://example.invalid/picture.png)",
      "",
      "$x^2$",
      "",
      "```html",
      "<div>literal</div>",
      "```",
      "",
      "<script>window.previewExecuted = true</script>",
      '<img src="x" onerror="window.previewExecuted = true">',
      '<a href="javascript:alert(1)">bad</a>',
      '<iframe srcdoc="bad"></iframe><style>body { display:none }</style>'
    ].join("\n");
    const host = document.createElement("div");
    host.innerHTML = renderDocumentMarkdown(source);
    return {
      heading: host.querySelector('div[align="center"] h2')?.textContent,
      details: host.querySelector("details[open] summary")?.textContent,
      tables: host.querySelectorAll("table").length,
      sub: host.querySelector("sub")?.textContent,
      nested: host.querySelector("ul ul li")?.textContent,
      image: host.querySelector('img[alt="Picture"]')?.getAttribute("src"),
      math: !!host.querySelector(".katex"),
      code: host.querySelector("pre code")?.textContent,
      unsafe: host.querySelectorAll('script,iframe,style,[onerror],a[href^="javascript:"]').length
    };
  });
  expect(result).toEqual({
    heading: "HTML heading",
    details: "Details",
    tables: 2,
    sub: "subscript",
    nested: "child",
    image: "https://example.invalid/picture.png",
    math: true,
    code: "<div>literal</div>\n",
    unsafe: 0
  });
});
