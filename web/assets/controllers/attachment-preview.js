import { createModal } from "../ui/modal.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../ui/html.js";

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
  panel.innerHTML = `<section class="attachment-preview-card" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title"><header><strong id="attachment-preview-title">附件预览</strong><a class="app-button is-secondary" data-preview-download download>下载原文件</a><button type="button" class="app-button is-icon" data-preview-close aria-label="关闭附件预览">${icon("close")}</button></header><div data-preview-content></div><footer data-preview-pages hidden></footer><div class="preview-tools" data-preview-tools role="toolbar" aria-label="图片查看"><button type="button" data-zoom="out" aria-label="缩小" title="缩小">${icon("zoom-out")}</button><button type="button" class="preview-zoom-level" data-zoom="fit" aria-label="适应窗口" title="适应窗口">100%</button><button type="button" data-zoom="in" aria-label="放大" title="放大">${icon("zoom-in")}</button><span class="preview-tools-divider" aria-hidden="true"></span><button type="button" data-preview-image-close aria-label="关闭图片预览" title="关闭">${icon("close")}</button></div></section>`;
  document.body.append(panel);
  const body = panel.querySelector("[data-preview-content]"),
    pages = panel.querySelector("[data-preview-pages]");
  let request,
    previewId,
    sequence = 0;
  const viewer = createImageViewer(panel);
  // An image is looked at, not dismissed by a stray click: the backdrop does
  // not close it (capture runs before the dialog's own backdrop listener).
  panel.addEventListener(
    "click",
    (event) => {
      if (panel.dataset.kind === "image" && event.target === panel) event.stopImmediatePropagation();
    },
    true
  );
  panel.querySelector("[data-preview-image-close]").addEventListener("click", () => modal.close());
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
    // Until the file says what it is, the preview shows only a quiet line; an
    // image then fills the screen on its own, anything else gets the card.
    panel.dataset.kind = "loading";
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
      panel.dataset.kind = preview.file.kind === "image" ? "image" : "file";
      if (preview.file.kind === "image") {
        const source = `/api/uploads/${encodeURIComponent(id)}`;
        body.innerHTML = mediaUrl
          ? `<img alt="${esc(preview.file.name)}" draggable="false" />`
          : `<img src="${source}" alt="${esc(preview.file.name)}" draggable="false" />`;
        viewer.reset();
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
      if (current === sequence && !request.signal.aborted) panel.dataset.kind = "file";
      if (current === sequence && !request.signal.aborted)
        body.innerHTML = `<p class="attachment-preview-message" role="alert">${esc(error.message)}。可下载原文件查看。</p>`;
    }
  }
  // The whole attachment chip opens it, not only its name; its remove key
  // stays a remove key. The name remains the button keyboards reach.
  document.addEventListener("click", (event) => {
    const chip = event.target.closest?.(".attachment-chip");
    const button =
      event.target.closest?.("[data-upload-preview]") ??
      (chip && !event.target.closest("[data-remove-attachment]")
        ? chip.querySelector("[data-upload-preview]")
        : null);
    if (button && /^upload-[a-f0-9-]{36}$/.test(button.dataset.uploadPreview))
      void open(button.dataset.uploadPreview);
  });
  return { close: modal.close };
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const STEP = 1.25;

/**
 * Zoom and pan for an image preview. Scale 1 is the image fitted to the
 * window; the wheel (or a pinch) zooms around the pointer, the toolbar and
 * + / - / 0 zoom around the centre, a double click toggles fit and 2x, and a
 * zoomed image is dragged to look around.
 */
function createImageViewer(panel) {
  const area = panel.querySelector("[data-preview-content]");
  const level = panel.querySelector(".preview-zoom-level");
  let scale = 1,
    x = 0,
    y = 0;
  const image = () => area.querySelector("img");
  const paint = ({ animate = false } = {}) => {
    const node = image();
    level.textContent = `${Math.round(scale * 100)}%`;
    panel.dataset.zoomed = String(scale > 1);
    if (!node) return;
    node.classList.toggle("is-easing", animate);
    node.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  /** Zoom to `next`, keeping the screen point (px, py) over the same spot of the image. */
  const zoomTo = (next, px, py, options) => {
    const box = area.getBoundingClientRect();
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    const cx = (px ?? box.left + box.width / 2) - (box.left + box.width / 2);
    const cy = (py ?? box.top + box.height / 2) - (box.top + box.height / 2);
    x = cx - (target / scale) * (cx - x);
    y = cy - (target / scale) * (cy - y);
    scale = target;
    if (scale <= 1) x = y = 0;
    paint(options);
  };
  const reset = () => {
    scale = 1;
    x = y = 0;
    paint();
  };
  const isImage = () => panel.dataset.kind === "image" && !panel.hidden;

  panel.querySelector("[data-preview-tools]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-zoom]");
    if (!button) return;
    const action = button.dataset.zoom;
    if (action === "fit") {
      scale = 1;
      x = y = 0;
      paint({ animate: true });
    } else zoomTo(action === "in" ? scale * STEP : scale / STEP, undefined, undefined, { animate: true });
  });
  area.addEventListener(
    "wheel",
    (event) => {
      if (!isImage()) return;
      event.preventDefault();
      // A trackpad pinch arrives as a wheel with ctrlKey and small deltas.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      zoomTo(scale * factor, event.clientX, event.clientY);
    },
    { passive: false }
  );
  area.addEventListener("dblclick", (event) => {
    if (!isImage() || !event.target.closest("img")) return;
    if (scale > 1) {
      scale = 1;
      x = y = 0;
      paint({ animate: true });
    } else zoomTo(2, event.clientX, event.clientY, { animate: true });
  });
  area.addEventListener("pointerdown", (event) => {
    if (!isImage() || scale <= 1 || event.button !== 0 || !event.target.closest("img")) return;
    event.preventDefault();
    const start = { px: event.clientX, py: event.clientY, x, y };
    area.setPointerCapture(event.pointerId);
    panel.dataset.panning = "true";
    const move = (next) => {
      x = start.x + next.clientX - start.px;
      y = start.y + next.clientY - start.py;
      paint();
    };
    const done = () => {
      area.removeEventListener("pointermove", move);
      delete panel.dataset.panning;
    };
    area.addEventListener("pointermove", move);
    area.addEventListener("lostpointercapture", done, { once: true });
  });
  // Keys work wherever focus is while the image is open: a click on the
  // picture does not move focus into the toolbar.
  panel.ownerDocument.addEventListener("keydown", (event) => {
    if (!isImage() || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const action = { "+": "in", "=": "in", "-": "out", _: "out", 0: "fit" }[event.key];
    if (!action) return;
    event.preventDefault();
    panel.querySelector(`[data-zoom="${action}"]`).click();
  });
  return { reset };
}
