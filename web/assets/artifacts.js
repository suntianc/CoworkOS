export function formatArtifactSize(value) {
  if (value === null || value === undefined || value === "") return "—";
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length);
  const amount = size / 1024 ** exponent;
  return `${amount.toFixed(amount < 10 ? 1 : 0).replace(/\.0$/, "")} ${units[exponent - 1]}`;
}

export function artifactParentPath(path) {
  return String(path || "")
    .split("/")
    .slice(0, -1)
    .join("/");
}

// Keep every available revision field in the signature: a file may be written
// directly into artifacts/ or published with a content hash by the runtime.
export function artifactVersion(artifact = {}) {
  return JSON.stringify([
    artifact.sha256,
    artifact.version,
    artifact.mtimeMs,
    artifact.mtime,
    artifact.modifiedAt,
    artifact.updatedAt,
    artifact.size,
    artifact.createdAt
  ]);
}

export function invalidateArtifactCache(cache, artifacts) {
  const current = new Map(artifacts.map((artifact) => [artifact.relativePath, artifactVersion(artifact)]));
  for (const [path, entry] of cache) {
    if (!current.has(path) || current.get(path) !== entry.signature) cache.delete(path);
  }
}

export function artifactRequestUrls(taskId, path, version, result = {}) {
  const endpoint = `/api/tasks/${encodeURIComponent(taskId)}/artifact`;
  const base = `${endpoint}?path=${encodeURIComponent(path)}`;
  const versioned = (value, mode) => {
    // The API only serves task-local files. Keep links local even if malformed
    // metadata reaches the viewer, and version media URLs as well as text.
    const fallback = new URL(base, "http://artifact.local");
    let url = fallback;
    try {
      const candidate = new URL(value || base, fallback);
      if (
        candidate.origin === fallback.origin &&
        candidate.pathname === endpoint &&
        candidate.searchParams.get("path") === path
      )
        url = candidate;
      // eslint-disable-next-line no-restricted-syntax -- artifact metadata comes from the backend and may hold a malformed URL; the task-local endpoint stays as the fallback
    } catch {
      /* use the task-local endpoint */
    }
    url.searchParams.delete("raw");
    url.searchParams.delete("download");
    if (mode) url.searchParams.set(mode, "1");
    if (version) url.searchParams.set("v", String(version));
    return `${url.pathname}${url.search}`;
  };
  return {
    previewUrl: versioned(null, null),
    rawUrl: versioned(result.rawUrl, "raw"),
    downloadUrl: versioned(result.downloadUrl, "download")
  };
}

/** Resolve only files already indexed for this Task, never arbitrary local paths. */
export function resolveArtifactLink(detail, absolutePath) {
  const taskId = detail?.task?.taskId;
  // Project files and Task storage can live in different directories. Older
  // detail responses exposed only workspaceRoot; current ones name storageRoot.
  const storageRoot = detail?.storageRoot ?? detail?.workspaceRoot;
  if (typeof storageRoot !== "string" || !storageRoot.startsWith("/") || !taskId) return;
  const root = `${storageRoot.replace(/\/+$/, "")}/${taskId}/artifacts/`;
  const candidates = [absolutePath];
  try {
    candidates.push(decodeURIComponent(absolutePath));
    // eslint-disable-next-line no-restricted-syntax -- a clicked href may carry a malformed %-escape and throw URIError; the literal path is still a registered filename
  } catch {
    /* A malformed URL can still name a literal, registered filename. */
  }
  const indexed = (detail.artifacts || []).filter((entry) => {
    const path = entry.relativePath;
    return (
      entry.taskId === taskId &&
      typeof path === "string" &&
      // eslint-disable-next-line no-control-regex
      !/[\\\x00-\x1f\x7f]/.test(path) &&
      path.split("/").every((part) => part && part !== "." && part !== "..")
    );
  });
  // A literal '%' can be part of a real filename. Prefer the original exact
  // path before trying one URL decode, regardless of index ordering.
  const artifact = candidates
    .map((candidate) => indexed.find((entry) => root + entry.relativePath === candidate))
    .find(Boolean);
  if (!artifact) return;
  return {
    taskId,
    artifactPath: artifact.relativePath,
    href: artifactRequestUrls(taskId, artifact.relativePath, artifactVersion(artifact)).downloadUrl
  };
}

export function normalizeArtifactPreview(result = {}) {
  const previewKind = ["text", "pdf", "image", "download"].includes(result.previewKind)
    ? result.previewKind
    : "download";
  return {
    ...result,
    previewKind,
    // Binary payloads must never reach the text editor or clipboard.
    content: previewKind === "text" ? String(result.content ?? "") : undefined,
    truncated: previewKind === "text" && Boolean(result.truncated)
  };
}

export function renderArtifactMedia(preview, { name, typeLabel, rawUrl, downloadUrl }) {
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
    );
  if (preview.previewKind === "text") return null;
  if ((preview.previewKind === "pdf" || preview.previewKind === "image") && !rawUrl)
    return '<div class="drawer-state"><span class="editor-spinner"></span><strong>正在读取文件…</strong></div>';
  if (preview.previewKind === "pdf")
    return `<div class="drawer-state"><strong>${esc(name)}</strong><p>点击“打开 ↗”查看 PDF。</p></div>`;
  if (preview.previewKind === "image")
    return `<div class="artifact-image"><img src="${esc(rawUrl)}" alt="${esc(name)}" /></div>`;
  return `<div class="drawer-state artifact-download-card"><span class="artifact-format-badge">${esc(typeLabel)}</span><strong>${esc(name)}</strong><p>此格式可下载后使用相应应用打开。</p><a class="drawer-action is-primary" href="${esc(downloadUrl)}" download="${esc(name)}">下载文件 · ${esc(formatArtifactSize(preview.size))}</a></div>`;
}
