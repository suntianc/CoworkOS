import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { renderMarkdown } from "../web/assets/markdown.js";
import { resolveArtifactLink } from "../web/assets/artifacts.js";
import { createConversationView } from "../web/assets/controllers/conversation-view.js";
import { assistantDisplayContent, normalizeReasoningDisplay } from "../web/assets/activity.js";

const documentFor = (source, options) =>
  parseHTML(`<main>${renderMarkdown(source, options)}</main>`).document;

test("activity linkification preserves URLs and trims surrounding punctuation", () => {
  const urls = [
    "https://example.invalid/a_b?x=a_b&next=c_d",
    "https://example.invalid/wiki/Topic_(version)",
    "https://x.com/thsottiaux/status/2106131810921136451"
  ];
  const source = `**${urls[0]}**\n(${urls[1]}).\n原帖：${urls[2]}，这是历史回放。`;
  const document = documentFor(source, { linkify: true });
  assert.deepEqual(
    [...document.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    urls
  );
  assert.equal(document.querySelector("strong a").textContent, urls[0]);
  for (const link of document.querySelectorAll("a")) {
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  }
  assert.equal(documentFor(urls[0]).querySelector("a"), null);
});

test("activity linkification keeps code literal, explicit links single and raw HTML inert", () => {
  const url = "https://example.invalid/a_b";
  const document = documentFor(
    `[${url}](${url})\n\n\`${url}\`\n\n\`\`\`\n${url}\n\`\`\`\n\n<img src=x onerror=fail()> [unsafe](javascript:alert(1)) https://user:secret@example.invalid/private`,
    { linkify: true }
  );
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.equal(document.querySelector("a").textContent, url);
  assert.equal(document.querySelector("code a"), null);
  assert.equal(document.querySelectorAll("code").length, 2);
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector("script"), null);
});

test("goal activity linkification coexists with math and keeps dollar signs inside bare URLs literal", () => {
  const url = "https://example.invalid/$folder$/source_a?x=$value$";
  const document = documentFor(`公式 $x_1^2$，证据：${url}，以及 \\(a*b\\)。`, { linkify: true });
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.equal(document.querySelector("a").getAttribute("href"), url);
  assert.equal(document.querySelector("a").textContent, url);
  assert.deepEqual(
    [...document.querySelectorAll("annotation")].map((node) => node.textContent),
    ["x_1^2", "a*b"]
  );
  assert.equal(document.querySelector("a .katex"), null);
});

test("linkification never inserts an external link inside a registered artifact link label", () => {
  const label = "https://example.invalid/source_a";
  const document = documentFor(`[${label}](/registered.txt)`, {
    linkify: true,
    resolveLocalLink: () => ({ href: "/api/artifact", artifactPath: "registered.txt", taskId: "fixture" })
  });
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.equal(document.querySelector("a").textContent, label);
  assert.equal(document.querySelector("a").dataset.messageArtifact, "registered.txt");
});

test("HTTP link destinations never pass through emphasis formatting", () => {
  const path = "https://example.invalid/sample_project/res_scene/file__final**.glb?x=a_b&next=c_d";
  const document = documentFor(`[**下载**](${path})`);
  const link = document.querySelector("a");
  assert.equal(link.getAttribute("href"), path);
  assert.equal(link.textContent, "下载");
  assert.equal(link.querySelector("strong").textContent, "下载");
  assert.equal(link.hasAttribute("onclick"), false);
});

test("unregistered absolute local links remain complete literal paths", () => {
  for (const source of [
    "[工程](/Users/fixture/sample_project/res_scene/scene.glb)",
    "[工程](</Users/fixture/sample_project/res_scene/光影 场景.glb>)"
  ]) {
    const document = documentFor(source);
    assert.equal(document.querySelector("main").textContent, source);
    assert.equal(document.querySelector("a"), null);
    assert.equal(document.querySelector("em"), null);
  }
});

test("inline code stays literal and link labels cannot introduce HTML elements", () => {
  const document = documentFor(
    '`[code](https://example.invalid/a_b_c)` [<img src=x onerror="fail()">](https://example.invalid/a_b_c)'
  );
  assert.equal(document.querySelector("code").textContent, "[code](https://example.invalid/a_b_c)");
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector("a").textContent, '<img src=x onerror="fail()">');
});

test("executable and protocol-relative destinations never become anchors", () => {
  for (const destination of [
    "javascript:alert(1)",
    "data:text/html,<svg/onload=alert(1)>",
    "file:///tmp/private_scene.blend",
    "//example.invalid/scene.glb",
    "/\\example.invalid/scene.glb"
  ]) {
    const document = documentFor(`[unsafe](${destination})`);
    assert.equal(document.querySelector("a"), null);
    assert.equal(document.querySelector("svg"), null);
  }
});

const artifactDetail = () => ({
  workspaceRoot: "/Users/fixture/sample_project",
  task: { taskId: "task_scene" },
  artifacts: [
    {
      artifactId: "artifact_scene",
      taskId: "task_scene",
      relativePath: "exports/res_scene/光影 场景_01 & #?.blend",
      sha256: "sha_scene"
    }
  ]
});

test("registered local paths resolve to the existing Task artifact endpoint without changing filenames", () => {
  const detail = artifactDetail();
  const path = `${detail.workspaceRoot}/${detail.task.taskId}/artifacts/${detail.artifacts[0].relativePath}`;
  const document = documentFor(`[sample_project/res_scene](<${path}>)`, {
    resolveLocalLink: (value) => resolveArtifactLink(detail, value)
  });
  const link = document.querySelector("a");
  const url = new URL(link.getAttribute("href"), "http://fixture.invalid");
  assert.equal(url.pathname, "/api/tasks/task_scene/artifact");
  assert.equal(url.searchParams.get("path"), detail.artifacts[0].relativePath);
  assert.equal(url.searchParams.get("download"), "1");
  assert.equal(url.hash, "");
  assert.equal(link.dataset.messageArtifact, detail.artifacts[0].relativePath);
  assert.equal(link.dataset.messageTask, "task_scene");
  assert.equal(link.textContent, "sample_project/res_scene");
  assert.deepEqual(resolveArtifactLink(detail, encodeURI(path)), resolveArtifactLink(detail, path));
});

test("artifact links use the Task storage root when the project directory is separate", () => {
  const detail = artifactDetail();
  detail.storageRoot = "/fixture/app-data/workspace";
  detail.artifacts.push({ taskId: detail.task.taskId, relativePath: "Harness-Introduction.pptx" });
  for (const artifact of detail.artifacts) {
    const path = `${detail.storageRoot}/${detail.task.taskId}/artifacts/${artifact.relativePath}`;
    const destination = path.includes(" ") ? `<${path}>` : path;
    const document = documentFor(`[可编辑 PPTX](${destination})`, {
      resolveLocalLink: (value) => resolveArtifactLink(detail, value)
    });
    const link = document.querySelector("a");
    assert.ok(link, "an indexed artifact in Task storage must render as a link");
    assert.equal(link.dataset.messageArtifact, artifact.relativePath);
    assert.equal(link.dataset.messageTask, detail.task.taskId);
    assert.equal(link.textContent, "可编辑 PPTX");
  }
  assert.equal(
    resolveArtifactLink(
      detail,
      `${detail.workspaceRoot}/${detail.task.taskId}/artifacts/${detail.artifacts[0].relativePath}`
    ),
    undefined,
    "the project root cannot stand in for Task storage"
  );
  delete detail.workspaceRoot;
  const path = `${detail.storageRoot}/${detail.task.taskId}/artifacts/${detail.artifacts[0].relativePath}`;
  assert.equal(resolveArtifactLink(detail, path)?.artifactPath, detail.artifacts[0].relativePath);
});

test("registered artifact links allow surrounding destination whitespace", () => {
  const detail = artifactDetail();
  const path = "Harness-Introduction.pptx";
  detail.artifacts.push({ taskId: detail.task.taskId, relativePath: path });
  const absolute = `${detail.workspaceRoot}/${detail.task.taskId}/artifacts/${path}`;
  for (const destination of [` ${absolute}`, `\t${absolute} `, ` <${absolute}> `]) {
    const document = documentFor(`[打开 PPT](${destination})`, {
      resolveLocalLink: (value) => resolveArtifactLink(detail, value)
    });
    assert.equal(document.querySelector("a")?.dataset.messageArtifact, path);
  }
  const source = "[私有文件]( /unregistered/private.pptx )";
  const document = documentFor(source, {
    resolveLocalLink: (value) => resolveArtifactLink(detail, value)
  });
  assert.equal(document.querySelector("a"), null);
  assert.equal(document.querySelector("main").textContent, source);
});

test("separate Task storage still refuses other Tasks, traversal and unindexed files", () => {
  const detail = artifactDetail();
  detail.storageRoot = "/fixture/app-data/workspace";
  const root = `${detail.storageRoot}/${detail.task.taskId}/artifacts/`;
  for (const path of [
    `${detail.storageRoot}/another_task/artifacts/${detail.artifacts[0].relativePath}`,
    `${root}../${detail.artifacts[0].relativePath}`,
    `${root}%2e%2e/${detail.artifacts[0].relativePath}`,
    `${root}unregistered_scene.blend`
  ])
    assert.equal(resolveArtifactLink(detail, path), undefined);
});

test("artifact resolution refuses unrelated paths, owners and traversal rather than using a basename", () => {
  const detail = artifactDetail();
  const root = `${detail.workspaceRoot}/${detail.task.taskId}/artifacts/`;
  for (const path of [
    `/elsewhere/${detail.artifacts[0].relativePath}`,
    `${detail.workspaceRoot}/another_task/artifacts/${detail.artifacts[0].relativePath}`,
    `${root}../${detail.artifacts[0].relativePath}`,
    `${root}%2e%2e/${detail.artifacts[0].relativePath}`,
    `${root}%252e%252e/${detail.artifacts[0].relativePath}`,
    `${root}unregistered_scene.blend`
  ])
    assert.equal(resolveArtifactLink(detail, path), undefined);
  detail.artifacts[0].taskId = "another_task";
  assert.equal(resolveArtifactLink(detail, root + detail.artifacts[0].relativePath), undefined);
  detail.artifacts = [{ taskId: "task_scene", relativePath: "../private.txt" }];
  assert.equal(resolveArtifactLink(detail, root + "../private.txt"), undefined);
});

test("quoted HTTP destinations stay within one escaped href attribute", () => {
  const destination = 'https://example.invalid/scene_a_b?x=" onmouseover="globalThis.injected=1';
  const document = documentFor(`[safe](<${destination}>)`);
  const link = document.querySelector("a");
  assert.equal(link.getAttribute("href"), destination);
  assert.equal(link.hasAttribute("onmouseover"), false);
  assert.equal(link.hasAttribute("onclick"), false);
  assert.equal(document.querySelectorAll("a").length, 1);
});

test("literal percent filenames take priority over URL-decoded alternatives in either index order", () => {
  const detail = artifactDetail();
  const paths = ["exports/report A.blend", "exports/report%20A.blend"];
  for (const order of [paths, [...paths].reverse()]) {
    detail.artifacts = order.map((relativePath) => ({ taskId: "task_scene", relativePath }));
    for (const path of paths)
      assert.equal(
        resolveArtifactLink(detail, `${detail.workspaceRoot}/task_scene/artifacts/${path}`).artifactPath,
        path
      );
    assert.equal(
      resolveArtifactLink(detail, `${detail.workspaceRoot}/task_scene/artifacts/exports/report%2520A.blend`)
        .artifactPath,
      "exports/report%20A.blend"
    );
  }
});

test("a rendered artifact click rechecks the current Task and current index before opening", () => {
  const detail = artifactDetail();
  detail.task.status = "completed";
  detail.runtime = { active: false };
  const state = { selected: "task_scene", detail, localMessages: [], executionHistoryOpen: new Map() };
  const { document } = parseHTML('<main id="conversation"></main>');
  const opened = [];
  const view = createConversationView({
    state,
    $: (selector) => document.querySelector(selector),
    bindStarterPrompts() {},
    textContent: (content) =>
      typeof content === "string" ? content : content.map((part) => part.text || "").join(""),
    openArtifact: (path) => opened.push(path)
  });
  const path = detail.artifacts[0].relativePath;
  view.renderConversation(
    [
      { role: "user", content: "合成链接", timestamp: 1 },
      {
        role: "assistant",
        content: `[工程](<${detail.workspaceRoot}/task_scene/artifacts/${path}>)`,
        timestamp: 2,
        stopReason: "stop"
      }
    ],
    detail.task
  );
  const link = document.querySelector("[data-message-artifact]");
  link.click();
  assert.deepEqual(opened, [path]);
  state.selected = "other_task";
  link.click();
  assert.deepEqual(opened, [path]);
  state.selected = "task_scene";
  detail.artifacts = [];
  link.click();
  assert.deepEqual(opened, [path]);
});

test("provider thinking headings render as three distinct paragraphs without wrapper or empty emphasis", () => {
  const source =
    "<thinking>**Planning PPTX creation****Creating script to build deck****Writing script now**\n****\n</thinking>";
  const document = documentFor(normalizeReasoningDisplay(source));
  assert.deepEqual(
    [...document.querySelectorAll("p")].map((node) => node.textContent),
    ["Planning PPTX creation", "Creating script to build deck", "Writing script now"]
  );
  assert.equal(document.querySelectorAll("strong").length, 3);
  assert.doesNotMatch(document.querySelector("main").textContent, /<thinking>|\*{4}/);
});

test("assistant Markdown renders math stars alongside prose and literal code", () => {
  const source = "**Formula**: $a*b*c$ and \\(x**2\\). Use `**kwargs`. $$u**2*v$$";
  const { document } = parseHTML(`<main>${renderMarkdown(source, { preserveMath: true })}</main>`);
  assert.equal(document.querySelector("strong").textContent, "Formula");
  assert.equal(document.querySelectorAll("strong").length, 1);
  assert.equal(document.querySelector("em"), null);
  assert.deepEqual(
    [...document.querySelectorAll("annotation")].map((node) => node.textContent),
    ["a*b*c", "x**2", "u**2*v"]
  );
  assert.equal(document.querySelector("code").textContent, "**kwargs");
  const escaped = parseHTML(
    `<main>${renderMarkdown("$<img src=x onerror=fail()>*y$", { preserveMath: true })}</main>`
  ).document;
  assert.equal(escaped.querySelector("img"), null);
  assert.equal(escaped.querySelector("annotation").textContent, "<img src=x onerror=fail()>*y");
});

test("assistant display normalization leaves fenced HTML and star operators readable", () => {
  const source =
    "<thinking>Read the sample.\n\n```html\n<thinking>literal</thinking>\n****\n```\n\nUse `**kwargs`, `a**2**2` and $a*b*c$.</thinking>\n\n**File created**.";
  const display = assistantDisplayContent(source);
  const document = documentFor(display[0].thinking);
  assert.equal(document.querySelector("pre code").textContent, "<thinking>literal</thinking>\n****");
  assert.deepEqual(
    [...document.querySelectorAll("p code")].map((node) => node.textContent),
    ["**kwargs", "a**2**2"]
  );
  const answer = documentFor(display[1].text);
  assert.equal(answer.querySelector("strong").textContent, "File created");
  assert.equal(answer.querySelector("main").textContent.trim(), "File created.");
  assert.equal(document.querySelector("thinking"), null);
});

test("a remembered thought layout still depends on whether it is being written", () => {
  const source = "<think> is a tag";
  for (let round = 0; round < 2; round += 1) {
    assert.equal(normalizeReasoningDisplay(source, { streaming: true }), "is a tag");
    assert.equal(normalizeReasoningDisplay(source), "<think> is a tag");
  }
  // A long thought with code, math and fences lays out in one pass per text.
  const long = Array.from(
    { length: 2000 },
    (_, index) => `**第 ${index} 步**\n看看 \`a.js\` 和 $x$。\n\`\`\`\ncode ${index}\n\`\`\`\n`
  ).join("");
  const started = performance.now();
  const laid = normalizeReasoningDisplay(long);
  assert.ok(performance.now() - started < 2000);
  assert.match(laid, /第 1999 步/);
});
