import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactParentPath,
  artifactRequestUrls,
  artifactVersion,
  formatArtifactSize,
  invalidateArtifactCache,
  normalizeArtifactPreview,
  renderArtifactMedia
} from "../web/assets/artifacts.js";

test("artifact URLs preserve Chinese, spaces, and punctuation and version every representation", () => {
  const path = "研究 材料/最终结果 #1 & 修订?.pptx";
  const first = artifactRequestUrls("task_1", path, "revision 1");
  for (const [kind, value] of Object.entries(first)) {
    const url = new URL(value, "http://localhost");
    assert.equal(url.pathname, "/api/tasks/task_1/artifact");
    assert.equal(url.searchParams.get("path"), path);
    assert.equal(url.searchParams.get("v"), "revision 1");
    assert.equal(url.searchParams.get("raw"), kind === "rawUrl" ? "1" : null);
    assert.equal(url.searchParams.get("download"), kind === "downloadUrl" ? "1" : null);
    assert.equal(url.hash, "");
  }
  const second = artifactRequestUrls("task_1", path, "revision 2", first);
  assert.notEqual(second.rawUrl, first.rawUrl);
  assert.notEqual(second.downloadUrl, first.downloadUrl);
  assert.equal(artifactParentPath(path), "研究 材料");
  assert.notEqual(artifactParentPath("版本一/报告.md"), artifactParentPath("版本二/报告.md"));
});

test("preview links stay on the selected task and file", () => {
  const urls = artifactRequestUrls("task_1", "报告.pdf", "v1", {
    rawUrl: "javascript:alert(1)",
    downloadUrl: "/api/tasks/task_2/artifact?path=other.pdf&download=1"
  });
  for (const value of Object.values(urls)) {
    const url = new URL(value, "http://localhost");
    assert.equal(url.pathname, "/api/tasks/task_1/artifact");
    assert.equal(url.searchParams.get("path"), "报告.pdf");
  }
});

test("same-path edits invalidate previews, while unchanged task polling preserves them", () => {
  const artifact = { relativePath: "报告.md", sha256: "sha-first", size: 512, mtimeMs: 123 };
  const entry = { signature: artifactVersion(artifact), status: "ready", content: "first" };
  const cache = new Map([
    [artifact.relativePath, entry],
    ["removed.txt", { signature: "old" }]
  ]);
  invalidateArtifactCache(cache, [artifact]);
  assert.equal(cache.get(artifact.relativePath), entry);
  assert.equal(cache.has("removed.txt"), false);
  for (const patch of [{ sha256: "sha-second" }, { mtimeMs: 124 }, { size: 600 }, { version: "v2" }]) {
    cache.set(artifact.relativePath, entry);
    invalidateArtifactCache(cache, [{ ...artifact, ...patch }]);
    assert.equal(cache.has(artifact.relativePath), false);
  }
  const pending = { signature: artifactVersion(artifact), status: "loading" };
  cache.set(artifact.relativePath, pending);
  invalidateArtifactCache(cache, [{ ...artifact, mtimeMs: 125 }]);
  // The old request can no longer own this slot when its response arrives.
  assert.notEqual(cache.get(artifact.relativePath), pending);
});

test("only explicit text previews expose text and truncation to the viewer", () => {
  const preview = normalizeArtifactPreview({
    previewKind: "text",
    content: "# Partial report",
    truncated: true
  });
  assert.equal(preview.content, "# Partial report");
  assert.equal(preview.truncated, true);
  for (const previewKind of ["pdf", "image", "download", "unknown", undefined]) {
    const binary = normalizeArtifactPreview({
      previewKind,
      content: "PK\u0003\u0004binary",
      truncated: true
    });
    assert.equal(binary.content, undefined);
    assert.equal(binary.truncated, false);
  }
});

test("PDF opens in the authorized viewer; images preview and other files offer downloads", () => {
  const options = {
    name: "报告 中文.pdf",
    typeLabel: "PDF",
    rawUrl: "/api/file?raw=1",
    downloadUrl: "/api/file?download=1"
  };
  const pdf = renderArtifactMedia({ previewKind: "pdf" }, options);
  assert.match(pdf, /点击“打开 ↗”查看 PDF/);
  assert.doesNotMatch(pdf, /<iframe|\/api\/file\?raw=1/);
  assert.match(renderArtifactMedia({ previewKind: "image" }, options), /<img[^>]+src="\/api\/file\?raw=1"/);
  assert.equal(renderArtifactMedia({ previewKind: "text" }, options), null);
  for (const extension of ["pptx", "xlsx", "docx", "bin"]) {
    const markup = renderArtifactMedia(
      { previewKind: "download", size: 2048, content: "PK\u0003\u0004binary" },
      { ...options, name: `报告.${extension}`, typeLabel: extension.toUpperCase() }
    );
    assert.match(markup, /artifact-download-card/);
    assert.match(markup, /download="报告\./);
    assert.match(markup, /2 KB/);
    assert.doesNotMatch(markup, /<code|<iframe|PK\u0003\u0004/);
  }
});

test("media filenames and labels are escaped, and file sizes are readable", () => {
  const markup = renderArtifactMedia(
    { previewKind: "download", size: 1536 },
    {
      name: '<img src=x onerror="oops">.pptx',
      typeLabel: "PPTX",
      rawUrl: "/file",
      downloadUrl: "/file?download=1&a=2"
    }
  );
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /download=1&amp;a=2/);
  assert.equal(formatArtifactSize(0), "0 B");
  assert.equal(formatArtifactSize(1536), "1.5 KB");
  assert.equal(formatArtifactSize(1024 ** 2), "1 MB");
  assert.equal(formatArtifactSize(1.68 * 1024 ** 3), "1.7 GB");
  assert.equal(formatArtifactSize(undefined), "—");
  assert.equal(formatArtifactSize(null), "—");
});
