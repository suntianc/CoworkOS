/** Only the task-local raw artifact endpoint may create a viewer. */
export function isArtifactRawPath(value) {
  if (typeof value !== "string" || !value.startsWith("/api/")) return false;
  try {
    const url = new URL(value, "http://artifact.local");
    return (
      url.origin === "http://artifact.local" &&
      /^\/api\/tasks\/[^/]+\/artifact$/.test(url.pathname) &&
      !url.hash &&
      url.searchParams.getAll("path").length === 1 &&
      Boolean(url.searchParams.get("path")) &&
      url.searchParams.getAll("raw").length === 1 &&
      url.searchParams.get("raw") === "1" &&
      !url.searchParams.has("download")
    );
  } catch {
    return false;
  }
}

/**
 * Open session-authorized bytes, retaining each object URL only for its viewer.
 * The native host accepts only a trusted main frame; browser popups have their
 * opener removed and active document formats are presented as plain text.
 */
export function createArtifactViewer({
  read,
  identity,
  host,
  openWindow = () => window.open("", "_blank"),
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  setTimer = (callback) => setInterval(callback, 1000),
  clearTimer = (timer) => clearInterval(timer)
}) {
  const active = new Map();
  const pending = new Set();
  let generation = 0;
  let disposed = false;
  const release = (url) => {
    if (!active.has(url)) return;
    const { timer, urls } = active.get(url);
    active.delete(url);
    if (timer !== null) clearTimer(timer);
    for (const item of urls) revokeObjectURL(item);
  };
  const unsubscribe = host?.onClosed(release);
  const key = (state) => JSON.stringify([state?.status, state?.backendId, state?.baseUrl, state?.sessionId]);

  async function open(path) {
    if (disposed || !isArtifactRawPath(path)) throw new Error("无效的产出物地址");
    const initial = identity();
    if (initial?.status !== "connected" || !initial.backendId) throw new Error("后端尚未连接");
    const at = generation;
    // A browser reserves its popup synchronously while the click is trusted.
    // Electron instead creates a sandboxed viewer through trusted host IPC.
    const popup = host ? undefined : openWindow();
    if (!host && !popup) throw new Error("无法打开产出物窗口，请允许弹出窗口");
    if (popup) {
      popup.opener = null;
      pending.add(popup);
    }
    let url;
    const allocated = [];
    try {
      const { blob } = await read(path);
      if (disposed || at !== generation || key(identity()) !== key(initial))
        throw new Error("已切换后端，产出物打开操作已取消");
      if (popup?.closed) throw new Error("产出物窗口已关闭");
      if (!(blob instanceof Blob)) throw new Error("无法读取产出物内容");
      const mime = blob.type.toLowerCase().split(";")[0];
      const safe =
        mime.startsWith("text/") ||
        ["application/xml", "application/xhtml+xml", "application/javascript", "application/json"].includes(
          mime
        )
          ? new Blob([blob], { type: "text/plain" })
          : blob;
      url = createObjectURL(safe);
      allocated.push(url);
      if (!host && mime === "image/svg+xml") {
        // Browsers execute scripts in a top-level SVG document. Display the
        // same SVG as an image in an inert wrapper instead.
        const imageUrl = url.replace(
          /[&<>"]/g,
          (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]
        );
        const wrapper = new Blob(
          [
            `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'"><title>产出物</title><img src="${imageUrl}" alt="产出物">`
          ],
          { type: "text/html" }
        );
        url = createObjectURL(wrapper);
        allocated.push(url);
      }
      active.set(url, { timer: null, urls: allocated, popup });
      if (host) await host.open(url);
      else {
        popup.location.replace(url);
        pending.delete(popup);
        const timer = setTimer(() => {
          if (popup.closed) release(url);
        });
        active.set(url, { timer, urls: allocated, popup });
      }
    } catch (error) {
      if (url && active.has(url)) release(url);
      else for (const item of allocated) revokeObjectURL(item);
      if (popup) {
        pending.delete(popup);
        if (!popup.closed) popup.close();
      }
      throw error;
    }
  }

  function reset() {
    generation += 1;
    for (const popup of pending) if (!popup.closed) popup.close();
    pending.clear();
    for (const [url, { popup }] of [...active]) {
      if (popup && !popup.closed) popup.close();
      release(url);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    unsubscribe?.();
  }
  return { open, reset, dispose };
}
