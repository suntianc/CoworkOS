import { agentName } from "../agent-names.js";
import {
  artifactParentPath,
  artifactRequestUrls,
  artifactVersion,
  formatArtifactSize,
  normalizeArtifactPreview,
  renderArtifactMedia
} from "../artifacts.js";
import { renderMarkdown } from "../markdown.js";
import { icon } from "../ui/icons.js";
import { createMenu } from "../ui/menu.js";
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
  openArtifactViewer
}) {
  function fileBaseName(path) {
    const parts = String(path || "")
      .split(/[\\/]/)
      .filter(Boolean);
    return parts.at(-1) || String(path || "未命名文件");
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

  let outputMenu;

  function outputMenuSignature(kind, resourceId, entries) {
    return JSON.stringify([state.selected, kind, resourceId, entries]);
  }

  function outputDownloadLink(file, className = "output-download") {
    const artifact =
      state.detail?.artifacts?.find((entry) => entry.relativePath === file.relativePath) || file;
    const { downloadUrl } = artifactRequestUrls(state.selected, file.relativePath, artifactVersion(artifact));
    const name = file.displayName || fileBaseName(file.relativePath);
    const menuItem = className === "app-button";
    return `<a class="${className}" data-output-download data-download-artifact="${esc(file.relativePath)}" href="${esc(downloadUrl)}" download="${esc(name)}" ${menuItem ? 'role="menuitem"' : `aria-label="下载 ${esc(name)}"`} title="下载 ${esc(name)}">${icon("download")}<span>${menuItem ? esc(name) : "下载"}</span></a>`;
  }

  function outputVersionItem(version) {
    const date = new Date(version.updatedAt);
    const time = Number.isNaN(date.getTime())
      ? version.name
      : new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        }).format(date);
    return `<button class="app-button" type="button" role="menuitem" data-output-version="${esc(version.resourceId)}" title="${esc(version.name)} · r${esc(version.revision)}">${icon("history")}<span>${esc(time)} · r${esc(version.revision)}</span></button>`;
  }

  function openOutputMenu(trigger, resourceId, entries, kind) {
    if (outputMenu?.resourceId === resourceId && outputMenu.kind === kind) {
      outputMenu.menu.close(true);
      return;
    }
    outputMenu?.menu.close();
    const taskId = state.selected;
    const versions = kind === "versions";
    const panel = document.createElement("div");
    panel.className = `ui-menu output-download-menu${versions ? " output-version-menu" : ""}`;
    panel.hidden = true;
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", versions ? "较早版本" : "下载产出物文件");
    panel.innerHTML = versions
      ? entries.map(outputVersionItem).join("")
      : entries.map((file) => outputDownloadLink(file, "app-button")).join("");
    if (versions)
      panel.addEventListener("click", (event) => {
        const id = event.target.closest("[data-output-version]")?.dataset.outputVersion;
        if (state.selected === taskId && entries.some((entry) => entry.resourceId === id))
          void openResourceInEditor(id);
      });
    document.body.append(panel);
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 16);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
      const below = window.innerHeight - anchor.bottom - 16;
      const above = anchor.top - 16;
      const down = below >= Math.min(panel.scrollHeight, 260) || below >= above;
      panel.style.maxHeight = `${Math.max(60, Math.min(320, down ? below : above))}px`;
      panel.style.top = down ? `${anchor.bottom + 6}px` : "auto";
      panel.style.bottom = down ? "auto" : `${window.innerHeight - anchor.top + 6}px`;
    };
    const menu = createMenu(trigger, panel, {
      toggleOnClick: false,
      onOpen: place,
      onClose() {
        menu.dispose();
        window.removeEventListener("resize", place);
        panel.remove();
        if (outputMenu?.menu === menu) outputMenu = undefined;
      }
    });
    outputMenu = {
      kind,
      resourceId,
      signature: outputMenuSignature(kind, resourceId, entries),
      menu,
      setTrigger(next) {
        trigger = next;
        menu.setTrigger(next);
        place();
      }
    };
    window.addEventListener("resize", place);
    menu.open();
  }

  function renderOutputActions(row) {
    const files = row.kind === "resource" && Array.isArray(row.files) ? row.files : [];
    const history =
      row.kind === "resource" && row.previousVersions?.length
        ? `<button class="output-history" type="button" data-output-version-menu="${esc(row.resourceId)}" aria-haspopup="menu" aria-expanded="false" aria-label="查看 ${esc(row.name)} 的较早版本" title="较早版本">${icon("history")}</button>`
        : "";
    const download =
      files.length === 1
        ? outputDownloadLink(files[0])
        : files.length > 1
          ? `<button class="output-download" type="button" data-output-download data-output-download-menu="${esc(row.resourceId)}" aria-haspopup="menu" aria-expanded="false" aria-label="下载 ${esc(row.name)} 的文件">${icon("download")}<span>下载</span>${icon("chevron-down")}</button>`
          : "";
    return history || download ? `<span class="output-file-actions">${history}${download}</span>` : "";
  }

  function bindOutputActions(outputList, rows) {
    outputList.querySelectorAll("[data-output-download], [data-output-version-menu]").forEach((node) => {
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        const kind = node.hasAttribute("data-output-version-menu") ? "versions" : "downloads";
        const resourceId = node.dataset.outputVersionMenu ?? node.dataset.outputDownloadMenu;
        if (!resourceId) return;
        const row = rows.find((entry) => entry.resourceId === resourceId);
        const entries = kind === "versions" ? row?.previousVersions : row?.files;
        if (entries?.length) openOutputMenu(node, resourceId, entries, kind);
      });
      node.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (
          (node.dataset.outputDownloadMenu || node.dataset.outputVersionMenu) &&
          ["ArrowDown", "ArrowUp"].includes(event.key) &&
          node.getAttribute("aria-expanded") !== "true"
        ) {
          event.preventDefault();
          node.click();
          if (event.key === "ArrowUp") $(".output-download-menu [role=menuitem]:last-child")?.focus();
        }
      });
    });
    if (outputMenu) {
      const row = rows.find((entry) => entry.resourceId === outputMenu.resourceId);
      const kind = outputMenu.kind;
      const attribute = kind === "versions" ? "data-output-version-menu" : "data-output-download-menu";
      const entries = kind === "versions" ? row?.previousVersions : row?.files;
      const trigger = [...outputList.querySelectorAll(`[${attribute}]`)].find(
        (node) => node.getAttribute(attribute) === outputMenu.resourceId
      );
      if (trigger && outputMenu.signature === outputMenuSignature(kind, row.resourceId, entries))
        outputMenu.setTrigger(trigger);
      else outputMenu.menu.close();
    }
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
    state.artifactDrawerOpen = true;
    renderRightPanel();
    ensureArtifactLoaded(path);
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
      showToast("正在打开文件…");
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
      showToast(`已打开文档：${created.resource.title}`);
    } catch (error) {
      showToast(`无法在编辑器中打开：${error.message}`);
    }
  }

  function closeArtifactDrawer() {
    state.artifactDrawerOpen = false;
    renderArtifactDrawer();
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

  function renderArtifactDrawer() {
    const drawer = $("#artifact-drawer");
    const scrim = $("#artifact-drawer-scrim");
    if (!drawer || !scrim) return;
    const artifacts = state.detail?.artifacts || [];
    const activePath = state.previewPath;
    if (
      !state.artifactDrawerOpen ||
      !activePath ||
      !artifacts.some((artifact) => artifact.relativePath === activePath)
    ) {
      drawer.hidden = true;
      scrim.hidden = true;
      drawer.innerHTML = "";
      delete drawer.dataset.signature;
      delete drawer.dataset.activePath;
      return;
    }
    const artifact = artifacts.find((entry) => entry.relativePath === activePath) || {};
    const cached = state.artifactCache.get(activePath);
    const signature = JSON.stringify([
      state.selected,
      activePath,
      artifacts.map((entry) => [entry.relativePath, entry.displayName, artifactVersion(entry)]),
      cached?.status,
      cached?.version,
      cached?.mediaHref,
      cached?.error
    ]);
    // Polling task status must not reload a PDF or reset the reader every 3.5 s.
    if (drawer.dataset.signature === signature) return;
    const scrollTop =
      drawer.dataset.activePath === activePath ? drawer.querySelector(".drawer-content")?.scrollTop || 0 : 0;
    const fileListScrollTop = drawer.querySelector(".drawer-file-list")?.scrollTop || 0;
    const urls = artifactRequestUrls(
      state.selected,
      activePath,
      cached?.version || artifactVersion(artifact),
      cached
    );
    const files = artifacts
      .map(
        (entry) =>
          `<button class="drawer-file ${entry.relativePath === activePath ? "active" : ""}" data-drawer-file="${esc(entry.relativePath)}" aria-current="${entry.relativePath === activePath ? "true" : "false"}" title="artifacts/${esc(entry.relativePath)}"><svg class="ui-icon"><use href="#i-file"/></svg><span class="drawer-file-copy"><strong>${esc(entry.displayName || fileBaseName(entry.relativePath))}</strong><small>${esc(artifactParentPath(entry.relativePath) || "artifacts/")} · ${esc(formatArtifactSize(entry.size))}</small></span></button>`
      )
      .join("");
    let content;
    if (!cached || cached.status === "loading")
      content = `<div class="drawer-state"><span class="editor-spinner"></span><strong>正在打开 ${esc(artifact.displayName || fileBaseName(activePath))}</strong><p>正在读取产出物…</p></div>`;
    else if (cached.status === "error")
      content = `<div class="drawer-state is-error"><strong>文件读取失败</strong><p>${esc(cached.error || "未知错误")}</p><button class="drawer-action" data-retry-artifact>重新加载</button></div>`;
    else
      content = renderArtifactDocument(cached, activePath, {
        ...urls,
        rawUrl: cached.mediaHref || (mediaUrl ? "" : urls.rawUrl)
      });
    const canCopy = cached?.status === "ready" && cached.previewKind === "text";
    const copyAction = canCopy
      ? `<button class="drawer-action" data-copy-drawer>${cached.truncated ? "复制已预览内容" : "复制内容"}</button>`
      : "";
    const canEdit = canEditArtifact(artifact);
    const editAction = canEdit ? '<button class="drawer-action" data-edit-drawer>在应用中打开</button>' : "";
    const downloadHref =
      cached?.previewKind === "pdf" && cached.mediaHref ? cached.mediaHref : urls.downloadUrl;
    const previewNote = cached?.truncated
      ? '<div class="artifact-preview-note" role="status">文件较大，仅显示前部分内容。下载可查看完整文件。</div>'
      : "";
    drawer.hidden = false;
    scrim.hidden = false;
    drawer.dataset.signature = signature;
    drawer.dataset.activePath = activePath;
    drawer.innerHTML = `<div class="artifact-drawer-head"><div class="artifact-drawer-title"><span class="drawer-eyebrow">产出物详情</span><h2>${esc(artifact.displayName || fileBaseName(activePath))}</h2><p title="artifacts/${esc(activePath)}">artifacts/${esc(activePath)}</p></div><button class="drawer-close" data-close-drawer aria-label="关闭产出物详情">×</button></div><div class="artifact-drawer-body"><nav class="drawer-file-list" aria-label="产出物文件"><div class="drawer-section-label">产出物 <span>${artifacts.length}</span></div>${files}</nav><section class="drawer-document"><div class="drawer-toolbar"><span class="drawer-file-type">${esc(fileLanguage(activePath))}</span><span class="drawer-file-size">${esc(formatArtifactSize(cached?.size ?? artifact.size))}</span><div class="drawer-actions">${editAction}${copyAction}<a class="drawer-action" data-open-artifact-viewer href="${esc(urls.rawUrl)}" target="_blank" rel="noopener noreferrer">打开 ↗</a><a class="drawer-action" href="${esc(downloadHref)}" download="${esc(fileBaseName(activePath))}">下载</a></div></div>${previewNote}<div class="drawer-content ${cached?.previewKind === "pdf" ? "is-pdf" : ""}">${content}</div></section></div>`;
    drawer.querySelector(".drawer-content").scrollTop = scrollTop;
    drawer.querySelector(".drawer-file-list").scrollTop = fileListScrollTop;
    drawer
      .querySelectorAll("[data-drawer-file]")
      .forEach((node) => node.addEventListener("click", () => openArtifact(node.dataset.drawerFile)));
    drawer
      .querySelector("[data-edit-drawer]")
      ?.addEventListener("click", () => void editArtifact(activePath));
    drawer.querySelector("[data-close-drawer]")?.addEventListener("click", closeArtifactDrawer);
    drawer.querySelector("[data-open-artifact-viewer]")?.addEventListener("click", (event) => {
      event.preventDefault();
      void openArtifactViewer(urls.rawUrl).catch((error) => showToast(error.message));
    });
    drawer.querySelector("[data-retry-artifact]")?.addEventListener("click", () => {
      state.artifactCache.delete(activePath);
      renderArtifactDrawer();
    });
    drawer.querySelector("[data-copy-drawer]")?.addEventListener("click", async () => {
      const preview = state.artifactCache.get(activePath);
      if (preview?.previewKind !== "text") return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(preview.content);
        showToast(preview.truncated ? "已复制当前预览内容" : "产出物内容已复制");
        // eslint-disable-next-line no-restricted-syntax -- the browser refuses clipboard writes outside a secure context or without permission; the toast reports that copy is unavailable
      } catch {
        showToast("当前环境不支持复制");
      }
    });
    if (!cached) ensureArtifactLoaded(activePath);
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
    renderOutputActions,
    bindOutputActions,
    resetMedia() {
      mediaUrls.clear();
    },
    closeOutputMenu() {
      outputMenu?.menu.close();
    }
  };
}
