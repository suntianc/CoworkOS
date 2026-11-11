import { agentName } from "../agent-names.js";
import {
  artifactRequestUrls,
  artifactVersion,
  formatArtifactSize,
  normalizeArtifactPreview,
  renderArtifactMedia
} from "../artifacts.js";
import { filePatchText, parseUnifiedDiff } from "../diff-view.js";
import { renderMarkdown } from "../markdown.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../workbench/html.js";

/** Owns artifact loading, preview and editor handoff. It never writes a published artifact. */
export function createArtifactController({
  state,
  $,
  api,
  showToast,
  renderRightPanel,
  getWorkbench,
  mediaUrl,
  openArtifactViewer,
  getDelivery = () => undefined
}) {
  function fileBaseName(path) {
    const parts = String(path || "")
      .split(/[\\/]/)
      .filter(Boolean);
    return parts.at(-1) || String(path || ui("未命名文件"));
  }

  function fileLanguage(path) {
    const extension = fileBaseName(path).split(".").at(-1)?.toLowerCase() || "text";
    return (
      {
        md: "Markdown",
        markdown: "Markdown",
        json: "JSON",
        js: "JavaScript",
        mjs: "JavaScript",
        cjs: "JavaScript",
        ts: "TypeScript",
        css: "CSS",
        html: "HTML",
        htm: "HTML",
        py: "Python",
        sh: "Shell",
        yaml: "YAML",
        yml: "YAML",
        diff: "Diff",
        patch: "Diff",
        txt: "Plain text",
        log: "Log"
      }[extension] || extension.toUpperCase()
    );
  }

  function artifactSource(artifact) {
    if (artifact.producerAgentId === "main") return "Formicand";
    const agents = state.detail?.progress?.agents || state.detail?.coordination?.calls || [];
    const agent = agents.find((entry) => entry.agentId === artifact.producerAgentId);
    if (!agent) return "";
    return agentName(agent);
  }

  function openArtifact(path) {
    if (!path) return;
    const artifact = state.detail?.artifacts?.find((entry) => entry.relativePath === path);
    if (!artifact) return;
    if (canEditArtifact(artifact)) return editArtifact(path);
    // A new preview is a navigation choice too: an older import must not
    // replace it when conversion finishes.
    getWorkbench().captureNavigation();
    if (!state.openFiles.includes(path)) state.openFiles.push(path);
    state.previewPath = path;
    state.drawerTab = { kind: "attachment", path };
    rememberDrawerTrigger();
    state.artifactDrawerOpen = true;
    renderRightPanel();
    ensureArtifactLoaded(path);
  }

  /**
   * Open the side preview on one of the change's tabs.
   *
   * The drawer is the work entry's own preview, so opening it never navigates
   * away from the conversation and closing it returns to the same reading
   * position.
   */
  function openPreview({ tab, path } = {}) {
    if (!state.selected) return;
    rememberDrawerTrigger();
    state.artifactDrawerOpen = true;
    if (tab === "diff") state.drawerTab = { kind: "diff" };
    else if (tab === "file") {
      if (path) state.drawerFile = path;
      state.drawerTab = { kind: "file" };
    } else if (tab === "attachment" && path) {
      state.previewPath = path;
      state.drawerTab = { kind: "attachment", path };
      ensureArtifactLoaded(path);
    }
    renderRightPanel();
  }

  /** Closing the preview returns the reader to the control that opened it. */
  function rememberDrawerTrigger() {
    // Switching tabs inside an open drawer keeps the original trigger.
    if (state.artifactDrawerOpen) return;
    const active = document.activeElement;
    state.drawerTrigger = active && active !== document.body ? active : null;
  }

  function canEditArtifact(artifact) {
    return (
      state.detail?.applications?.deliverables?.some(
        (row) =>
          row.editable &&
          (row.relativePath === artifact.relativePath ||
            row.files?.some((file) => file.relativePath === artifact.relativePath))
      ) || getWorkbench().editableKinds?.has(artifact.mimeType)
    );
  }

  function appDisplayName(appType) {
    return (
      getWorkbench().catalog.find((entry) => entry.appType === appType)?.displayName || appType || "应用"
    );
  }

  /** Open a resource as a tab in the global strip. */
  async function openResourceInEditor(resourceId, taskId = state.selected) {
    if (!resourceId || !taskId) return;
    const navigation = getWorkbench().captureNavigation();
    try {
      const result = await getWorkbench().api.openResource(taskId, resourceId);
      if (result.appInstance?.resourceIds?.[0]) {
        await getWorkbench().api.openTab({
          kind: "application",
          resourceId: result.appInstance.resourceIds[0],
          activate: false
        });
      }
      await getWorkbench().refreshTabs();
      if (navigation.current() && result.appInstance?.resourceIds?.[0]) {
        await getWorkbench().host?.activate(`resource:${result.appInstance.resourceIds[0]}`, {
          navigation: navigation.navigation
        });
      }
      return true;
    } catch (error) {
      showToast(`打开失败：${error.message}`);
      return false;
    }
  }

  /**
   * Open an export in its original editor; unrelated files are imported as copies.
   * Published artifact bytes remain unchanged in either case.
   */
  const importing = new Map();
  function editArtifact(relativePath) {
    if (!relativePath || !state.selected) return;
    const taskId = state.selected;
    const key = `${taskId}:${relativePath}`;
    const existing = importing.get(key);
    if (existing) {
      existing.navigation = getWorkbench().captureNavigation();
      return existing.promise;
    }
    const artifact = state.detail?.artifacts?.find((entry) => entry.relativePath === relativePath);
    if (!artifact) return;
    const opening = { navigation: getWorkbench().captureNavigation() };
    importing.set(key, opening);
    opening.promise = openEditableArtifact(taskId, artifact, opening).finally(() => importing.delete(key));
    return opening.promise;
  }

  async function openEditableArtifact(taskId, artifact, opening) {
    try {
      showToast(ui("正在打开文件…"));
      const created = await getWorkbench().importArtifact(taskId, artifact);
      if (created.resource?.resourceId) {
        await getWorkbench().api.openTab({
          kind: "application",
          resourceId: created.resource.resourceId,
          activate: false
        });
      }
      await getWorkbench().refreshTabs();
      // A click can return to this file while the shared import or editor
      // mount is pending. Keep one import and honor the latest navigation.
      for (;;) {
        const navigation = opening.navigation;
        if (navigation.current() && created.resource?.resourceId)
          await getWorkbench().host?.activate(`resource:${created.resource.resourceId}`, {
            navigation: navigation.navigation
          });
        if (navigation === opening.navigation) break;
      }
      if (opening.navigation.current()) closeArtifactDrawer();
      showToast(`${ui("已打开文档：")}${created.resource.title}`);
    } catch (error) {
      showToast(`${ui("无法在编辑器中打开：")}${error.message}`);
    }
  }

  function closeArtifactDrawer(restoreFocus = false) {
    state.artifactDrawerOpen = false;
    renderArtifactDrawer();
    if (!restoreFocus) return;
    const trigger = state.drawerTrigger;
    state.drawerTrigger = null;
    if (trigger?.isConnected) trigger.focus();
  }

  function closeArtifact(path) {
    state.openFiles = state.openFiles.filter((entry) => entry !== path);
    state.artifactCache.delete(path);
    if (state.previewPath === path) state.previewPath = state.openFiles.at(-1) || null;
    renderRightPanel();
  }

  /**
   * Binary previews are fetched through the bound backend, which may be another
   * local origin the page's own URL cannot reach. The bytes become one object
   * URL per versioned request; a version change asks for a new URL.
   */
  const mediaUrls = new Map();
  function cachedMediaUrl(path) {
    const existing = mediaUrls.get(path);
    if (existing) return existing;
    const pending = mediaUrl(path)
      .then((href) => {
        if (href && mediaUrls.get(path) === pending) mediaUrls.set(path, Promise.resolve(href));
        return href;
      })
      // eslint-disable-next-line no-restricted-syntax -- a failed media read drops the cached entry, so the drawer falls back to the plain artifact link
      .catch(() => {
        if (mediaUrls.get(path) === pending) mediaUrls.delete(path);
        return undefined;
      });
    mediaUrls.set(path, pending);
    return pending;
  }

  function loadArtifactMedia(path, signature, urls) {
    const entry = state.artifactCache.get(path);
    if (!mediaUrl || !entry || entry.status !== "ready" || entry.signature !== signature) return;
    if (entry.mediaHref || !["pdf", "image"].includes(entry.previewKind)) return;
    void cachedMediaUrl(urls.rawUrl).then((href) => {
      const current = state.artifactCache.get(path);
      if (!href || !current || current.status !== "ready" || current.signature !== signature) return;
      state.artifactCache.set(path, { ...current, mediaHref: href });
      if (state.previewPath === path) renderArtifactDrawer();
    });
  }

  function ensureArtifactLoaded(path) {
    const artifact = state.detail?.artifacts?.find((entry) => entry.relativePath === path);
    if (!artifact) return;
    const signature = artifactVersion(artifact);
    const cached = state.artifactCache.get(path);
    if (cached?.signature === signature) return;
    const taskId = state.selected;
    const pending = { status: "loading", signature };
    state.artifactCache.set(path, pending);
    api(artifactRequestUrls(taskId, path, signature).previewUrl, { cache: "no-store" })
      .then((result) => {
        if (state.selected !== taskId || state.artifactCache.get(path) !== pending) return;
        state.artifactCache.set(path, { ...normalizeArtifactPreview(result), status: "ready", signature });
        loadArtifactMedia(path, signature, artifactRequestUrls(taskId, path, signature));
        if (state.previewPath === path) renderArtifactDrawer();
      })
      .catch((error) => {
        if (state.selected !== taskId || state.artifactCache.get(path) !== pending) return;
        state.artifactCache.set(path, { status: "error", signature, error: error.message });
        if (state.previewPath === path) renderArtifactDrawer();
      });
  }

  function changedFiles() {
    return getDelivery()?.view?.diff?.files || [];
  }

  function selectedFile() {
    const files = changedFiles();
    return files.find((file) => file.path === state.drawerFile)?.path ?? files[0]?.path;
  }

  function drawerTabs(attachments) {
    const tabs = [];
    if (changedFiles().length) {
      tabs.push({ id: "diff", kind: "diff", label: "diff" });
      tabs.push({ id: "file", kind: "file", label: ui("文件"), path: selectedFile() });
    }
    for (const entry of attachments)
      tabs.push({
        id: `attachment:${entry.relativePath}`,
        kind: "attachment",
        path: entry.relativePath,
        label: entry.displayName || fileBaseName(entry.relativePath)
      });
    return tabs;
  }

  function currentTab(tabs) {
    // An attachment picked without naming a tab opens its own preview.
    const tab =
      state.drawerTab ?? (state.previewPath ? { kind: "attachment", path: state.previewPath } : undefined);
    if (!tab) return undefined;
    if (tab.kind === "attachment") return tabs.find((entry) => entry.id === `attachment:${tab.path}`);
    return tabs.find((entry) => entry.kind === tab.kind);
  }

  /** The committed change behind the panel's diff; fetched once per candidate. */
  function ensureDiffLoaded() {
    const view = getDelivery()?.view;
    const development = view?.development;
    if (!development || !view?.diff) return;
    const key = `${state.selected}:${development.developmentId}:${view.diff.candidateCommit}`;
    if (state.drawerDiff?.key === key) return;
    const pending = { key, status: "loading" };
    state.drawerDiff = pending;
    api(`/api/tasks/${encodeURIComponent(state.selected)}/deliveries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "diff", developmentId: development.developmentId })
    })
      .then((result) => {
        if (state.drawerDiff !== pending) return;
        state.drawerDiff = {
          key,
          status: "ready",
          files: parseUnifiedDiff(result.diff.patch),
          contents: new Map((result.diff.contents || []).map((entry) => [entry.path, entry.content])),
          patch: result.diff.patch,
          truncated: Boolean(result.diff.truncated)
        };
        renderArtifactDrawer();
      })
      .catch((error) => {
        if (state.drawerDiff !== pending) return;
        state.drawerDiff = { key, status: "error", error: error.message };
        renderArtifactDrawer();
      });
  }

  function renderDiffLines(files) {
    return files
      .map(
        (file) =>
          `<section class="drawer-diff-file" data-diff-file="${esc(file.path)}"><header>${esc(
            file.path
          )}</header>${file.lines
            .map(
              (hunk) =>
                `${file.lines.length > 1 ? `<div class="drawer-hunk">${esc(hunk.header)}</div>` : ""}${hunk.lines
                  .map(
                    (line) =>
                      `<div class="drawer-line" data-kind="${line.kind}"><span class="drawer-line-number">${line.number}</span><span class="drawer-line-sign">${
                        line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""
                      }</span><code>${esc(line.text) || " "}</code></div>`
                  )
                  .join("")}`
            )
            .join("")}</section>`
      )
      .join("");
  }

  function downloadText(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.dataset.managedDownload = "local";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function renderDiffBody(tab, files) {
    if (state.drawerDiff?.status === "error")
      return `<div class="drawer-state is-error"><strong>${ui("无法显示改动")}</strong><p>${esc(
        state.drawerDiff.error
      )}</p></div>`;
    if (!state.drawerDiff || state.drawerDiff.status === "loading") {
      ensureDiffLoaded();
      return `<div class="drawer-state"><span class="editor-spinner"></span><strong>${ui(
        "正在读取改动"
      )}</strong></div>`;
    }
    if (tab.kind === "file") {
      const file = files.find((entry) => entry.path === tab.path) || files[0];
      const list =
        files.length > 1
          ? `<nav class="drawer-file-picker" aria-label="${ui("改动文件")}">${files
              .map(
                (entry) =>
                  `<button type="button" class="drawer-file${
                    entry.path === file?.path ? " active" : ""
                  }" data-diff-select="${esc(entry.path)}" aria-current="${
                    entry.path === file?.path ? "true" : "false"
                  }">${esc(entry.path)}</button>`
              )
              .join("")}</nav>`
          : "";
      const content = file ? state.drawerDiff.contents?.get(file.path) : undefined;
      if (content === undefined)
        return `${list}<div class="drawer-state"><strong>${ui("这个文件以二进制保存")}</strong><p>${ui(
          "请用 diff 或下载查看。"
        )}</p></div>`;
      const lines = content
        .split("\n")
        .map(
          (line, index) =>
            `<div class="drawer-file-line"><span class="drawer-line-number">${index + 1}</span><code>${
              esc(line) || " "
            }</code></div>`
        );
      return `${list}<div class="drawer-lines">${lines.join("")}</div>`;
    }
    return `<div class="drawer-lines">${renderDiffLines(state.drawerDiff.files)}</div>`;
  }

  function renderArtifactDrawer() {
    const drawer = $("#artifact-drawer");
    if (!drawer) return;
    const attachments = state.detail?.artifacts || [];
    const tabs = drawerTabs(attachments);
    const tab = currentTab(tabs);
    if (!state.artifactDrawerOpen || !tabs.length || !tab) {
      drawer.hidden = true;
      drawer.innerHTML = "";
      delete drawer.dataset.signature;
      delete drawer.dataset.tab;
      return;
    }
    const artifact = attachments.find((entry) => entry.relativePath === tab.path) || {};
    const cached = tab.kind === "attachment" ? state.artifactCache.get(tab.path) : undefined;
    const signature = JSON.stringify([
      state.selected,
      tab.id,
      tab.path,
      selectedFile(),
      attachments.map((entry) => [entry.relativePath, entry.displayName, artifactVersion(entry)]),
      cached?.status,
      cached?.version,
      cached?.mediaHref,
      cached?.error,
      state.drawerDiff?.key,
      state.drawerDiff?.status
    ]);
    // Polling task status must not reload a PDF or reset the reader every 3.5 s.
    if (drawer.dataset.signature === signature) return;
    const scrollTop =
      drawer.dataset.tab === tab.id ? drawer.querySelector(".drawer-content")?.scrollTop || 0 : 0;
    drawer.dataset.signature = signature;
    drawer.dataset.tab = tab.id;
    const files = changedFiles();
    const change = files.find((entry) => entry.path === tab.path);
    const totalAdds = files.reduce((sum, entry) => sum + Number(entry.additions || 0), 0);
    const totalDels = files.reduce((sum, entry) => sum + Number(entry.deletions || 0), 0);
    const commit = String(getDelivery()?.view?.diff?.candidateCommit || "").slice(0, 8);
    const changeMeta = commit
      ? ui`候选 ${commit} · +${totalAdds} −${totalDels}`
      : ui`+${totalAdds} −${totalDels}`;
    const isChange = tab.kind !== "attachment";
    const title = isChange
      ? tab.kind === "diff"
        ? ui("改动")
        : fileBaseName(tab.path)
      : artifact.displayName || fileBaseName(tab.path);
    const meta = isChange
      ? `${changeMeta}${change ? ` · +${change.additions} −${change.deletions}` : ""}`
      : `${fileLanguage(tab.path)} · ${formatArtifactSize(cached?.size ?? artifact.size)}`;
    const urls = isChange
      ? { previewUrl: "", rawUrl: "", downloadUrl: "" }
      : artifactRequestUrls(state.selected, tab.path, cached?.version || artifactVersion(artifact), cached);
    const downloadHref =
      cached?.previewKind === "pdf" && cached.mediaHref ? cached.mediaHref : urls.downloadUrl;
    const canCopy = !isChange && cached?.status === "ready" && cached.previewKind === "text";
    const copyAction = canCopy
      ? `<button type="button" class="drawer-action is-icon" data-copy-drawer aria-label="${ui(
          "复制内容"
        )}" title="${ui("复制内容")}">${icon("copy")}</button>`
      : "";
    const canEdit = !isChange && canEditArtifact(artifact);
    const editAction = canEdit
      ? `<button type="button" class="drawer-action is-icon" data-edit-drawer aria-label="${ui(
          "在应用中打开"
        )}" title="${ui("在应用中打开")}">${icon("pencil")}</button>`
      : "";
    const openAction = isChange
      ? ""
      : `<a class="drawer-action is-icon" data-open-artifact-viewer href="${esc(
          urls.rawUrl
        )}" target="_blank" rel="noopener noreferrer" aria-label="${ui("打开 ↗")}" title="${ui(
          "打开 ↗"
        )}">${icon("external")}</a>`;
    const downloadAction = isChange
      ? `<button type="button" class="drawer-action is-icon" data-download-diff aria-label="${ui(
          "下载"
        )}" title="${ui("下载")}">${icon("download")}</button>`
      : `<a class="drawer-action is-icon" href="${esc(downloadHref)}" download="${esc(
          fileBaseName(tab.path)
        )}" aria-label="${ui("下载")}" title="${ui("下载")}">${icon("download")}</a>`;
    let content;
    if (isChange) content = renderDiffBody(tab, files);
    else if (!cached || cached.status === "loading")
      content = `<div class="drawer-state"><span class="editor-spinner"></span><strong>${ui`正在打开 ${esc(
        title
      )}`}</strong></div>`;
    else if (cached.status === "error")
      content = `<div class="drawer-state is-error"><strong>${ui("文件读取失败")}</strong><p>${esc(
        cached.error || ui("未知错误")
      )}</p><button class="drawer-action" data-retry-artifact>${ui("重新加载")}</button></div>`;
    else
      content = renderArtifactDocument(cached, tab.path, {
        ...urls,
        rawUrl: cached.mediaHref || (mediaUrl ? "" : urls.rawUrl)
      });
    const previewNote = isChange
      ? state.drawerDiff?.truncated
        ? `<div class="artifact-preview-note" role="status">${ui("改动较大，仅显示前部分内容。下载可查看完整改动。")}</div>`
        : ""
      : cached?.truncated
        ? `<div class="artifact-preview-note" role="status">${ui(
            "文件较大，仅显示前部分内容。下载可查看完整文件。"
          )}</div>`
        : "";
    drawer.hidden = false;
    drawer.innerHTML = `<header class="artifact-drawer-head">${icon(
      isChange ? "git-commit" : "file"
    )}<div class="artifact-drawer-title"><strong>${esc(title)}</strong><span>${esc(
      meta
    )}</span></div><span class="rp-spacer"></span><div class="drawer-actions">${editAction}${copyAction}${openAction}${downloadAction}<button type="button" class="drawer-close" data-close-drawer aria-label="${ui(
      "关闭预览"
    )}" title="${ui("关闭预览")}">${icon("close")}</button></div></header><nav class="drawer-tabs" role="tablist" aria-label="${ui(
      "预览内容"
    )}">${tabs
      .map(
        (entry) =>
          `<button type="button" role="tab" class="drawer-tab${
            entry.id === tab.id ? " active" : ""
          }" aria-selected="${entry.id === tab.id}" data-drawer-tab="${esc(entry.id)}" ${
            entry.kind === "attachment" ? `data-drawer-file="${esc(entry.path)}"` : ""
          } title="${esc(entry.label)}">${esc(entry.label)}</button>`
      )
      .join("")}</nav><div class="artifact-drawer-body"><div class="drawer-content ${
      cached?.previewKind === "pdf" ? "is-pdf" : ""
    }">${previewNote}${content}</div></div>`;
    drawer.querySelector(".drawer-content").scrollTop = scrollTop;
    for (const node of drawer.querySelectorAll("[data-drawer-tab]"))
      node.addEventListener("click", () => {
        const id = node.dataset.drawerTab;
        if (id === "diff") openPreview({ tab: "diff" });
        else if (id === "file") openPreview({ tab: "file" });
        else openPreview({ tab: "attachment", path: id.slice("attachment:".length) });
      });
    for (const node of drawer.querySelectorAll("[data-diff-select]"))
      node.addEventListener("click", () => openPreview({ tab: "file", path: node.dataset.diffSelect }));
    drawer.querySelector("[data-download-diff]")?.addEventListener("click", () => {
      const data = state.drawerDiff;
      if (data?.status !== "ready") return;
      const selected = tab.kind === "file" ? tab.path : undefined;
      const text = selected ? filePatchText(data.files, selected) : data.patch;
      downloadText(text, selected ? `${fileBaseName(selected)}.diff` : "changes.diff");
    });
    drawer.querySelector("[data-edit-drawer]")?.addEventListener("click", () => void editArtifact(tab.path));
    drawer.querySelector("[data-close-drawer]")?.addEventListener("click", () => closeArtifactDrawer(true));
    drawer.querySelector("[data-open-artifact-viewer]")?.addEventListener("click", (event) => {
      event.preventDefault();
      void openArtifactViewer(urls.rawUrl).catch((error) => showToast(error.message));
    });
    drawer.querySelector("[data-retry-artifact]")?.addEventListener("click", () => {
      state.artifactCache.delete(tab.path);
      renderArtifactDrawer();
    });
    drawer.querySelector("[data-copy-drawer]")?.addEventListener("click", async () => {
      const preview = state.artifactCache.get(tab.path);
      if (preview?.previewKind !== "text") return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(preview.content);
        showToast(preview.truncated ? ui("已复制当前预览内容") : ui("产出物内容已复制"));
        // eslint-disable-next-line no-restricted-syntax -- the browser refuses clipboard writes outside a secure context or without permission; the toast reports that copy is unavailable
      } catch {
        showToast(ui("当前环境不支持复制"));
      }
    });
    if (!isChange && !cached) ensureArtifactLoaded(tab.path);
  }

  function renderArtifactDocument(preview, path, urls) {
    const media = renderArtifactMedia(preview, {
      name: fileBaseName(path),
      typeLabel: fileLanguage(path),
      ...urls
    });
    if (media !== null) return media;
    const text = preview.content;
    const language = fileLanguage(path);
    if (language === "Markdown")
      return `<article class="artifact-markdown markdown-body">${renderMarkdown(text)}</article>`;
    let normalized = text;
    if (language === "JSON") {
      try {
        normalized = JSON.stringify(JSON.parse(text), null, 2);
        // eslint-disable-next-line no-restricted-syntax -- artifact content is user data and may not be valid JSON; the raw text is rendered instead
      } catch {
        /* keep malformed JSON readable */
      }
    }
    return `<div class="artifact-code-wrap">${renderCodeEditor(normalized, path)}</div>`;
  }

  function renderCodeEditor(content, path) {
    const text = String(content ?? "");
    const lines = text.split("\n");
    const lineMarkup = lines
      .map(
        (line, index) =>
          `<div class="code-line"><span class="line-number">${index + 1}</span><code>${esc(line) || " "}</code></div>`
      )
      .join("");
    return `<div class="code-editor" data-language="${esc(fileLanguage(path))}">${lineMarkup}</div>`;
  }

  return {
    fileBaseName,
    artifactSource,
    openArtifact,
    appDisplayName,
    openResourceInEditor,
    editArtifact,
    closeArtifactDrawer,
    closeArtifact,
    ensureArtifactLoaded,
    renderArtifactDrawer,
    openPreview,
    resetMedia() {
      mediaUrls.clear();
    }
  };
}
