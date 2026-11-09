import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../workbench/html.js";

/** Local previews share the shell's keyboard and focus behavior. */
export function installAttachmentPreview({ api, mediaUrl } = {}) {
  /** Every request belongs to the page's bound backend; the fallback is same-origin. */
  const readPreview =
    api ||
    (async (path, options) => {
      const response = await fetch(path, options);
      const preview = await response.json();
      if (!response.ok) throw new Error(preview.error || "预览失败");
      return preview;
    });
  const panel = document.createElement("div");
  panel.className = "modal-overlay attachment-preview";
  panel.hidden = true;
  panel.innerHTML = `<section class="attachment-preview-card" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title"><header><strong id="attachment-preview-title">附件预览</strong><a class="app-button is-secondary" data-preview-download download>下载原文件</a><button type="button" class="app-button is-icon" data-preview-close aria-label="关闭附件预览">${icon("close")}</button></header><div data-preview-content></div><footer data-preview-pages hidden></footer></section>`;
  document.body.append(panel);
  const body = panel.querySelector("[data-preview-content]"),
    pages = panel.querySelector("[data-preview-pages]");
  let request,
    previewId,
    sequence = 0;
  const modal = createModal(panel, panel.querySelector("[data-preview-close]"), {
    onClose() {
      sequence++;
      request?.abort();
    }
  });
  async function open(id, page = 1) {
    request?.abort();
    request = new AbortController();
    const current = ++sequence;
    const opening = panel.hidden || previewId !== id;
    previewId = id;
    body.innerHTML = '<p class="attachment-preview-message" role="status">正在生成预览…</p>';
    pages.hidden = true;
    const download = panel.querySelector("[data-preview-download]");
    download.href = `/api/uploads/${encodeURIComponent(id)}`;
    if (opening) {
      panel.querySelector("#attachment-preview-title").textContent = "附件预览";
      download.download = "";
    }
    modal.open();
    try {
      const preview = await readPreview(`/api/uploads/${encodeURIComponent(id)}/preview?page=${page}`, {
        signal: request.signal
      });
      if (current !== sequence) return;
      panel.querySelector("#attachment-preview-title").textContent = preview.file.name;
      download.download = preview.file.name;
      if (preview.file.kind === "image") {
        const source = `/api/uploads/${encodeURIComponent(id)}`;
        body.innerHTML = mediaUrl
          ? `<img alt="${esc(preview.file.name)}" />`
          : `<img src="${source}" alt="${esc(preview.file.name)}" />`;
        if (mediaUrl)
          void mediaUrl(source)
            .then((href) => {
              if (current !== sequence) return;
              const image = body.querySelector("img");
              if (image) image.src = href;
            })
            // eslint-disable-next-line no-restricted-syntax -- when the image bytes cannot be read the preview keeps its text and download link
            .catch(() => undefined);
      } else if (preview.image && preview.mimeType === "image/png")
        body.innerHTML = `<img src="data:image/png;base64,${preview.image.replace(/[^A-Za-z0-9+/=]/g, "")}" alt="第 ${page} 页" />`;
      else
        body.innerHTML = `<pre>${esc(preview.text || "此文件没有可提取文字。请下载原文件查看。")}</pre>${preview.nextOffset !== null && preview.nextOffset !== undefined ? '<p class="preview-caption">显示前 12,000 个字符，完整内容保留在原文件中。</p>' : ""}`;
      if (preview.pages > 1) {
        pages.hidden = false;
        pages.innerHTML = `<button type="button" class="app-button is-secondary" data-previous-page ${page === 1 ? "disabled" : ""}>上一页</button><span>${page} / ${preview.pages}</span><button type="button" class="app-button is-secondary" data-next-page ${page === preview.pages ? "disabled" : ""}>下一页</button>`;
        pages.querySelector("[data-previous-page]").onclick = () => open(id, page - 1);
        pages.querySelector("[data-next-page]").onclick = () => open(id, page + 1);
      }
    } catch (error) {
      if (current === sequence && !request.signal.aborted)
        body.innerHTML = `<p class="attachment-preview-message" role="alert">${esc(error.message)}。可下载原文件查看。</p>`;
    }
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-upload-preview]");
    if (button && /^upload-[a-f0-9-]{36}$/.test(button.dataset.uploadPreview))
      void open(button.dataset.uploadPreview);
  });
  return { close: modal.close };
}
