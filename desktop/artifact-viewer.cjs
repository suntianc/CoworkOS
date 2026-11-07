/** Only object URLs made by the currently trusted local page may open here. */
function isArtifactViewerUrl(value, selectedUrl) {
  if (typeof value !== "string" || value.length > 256 || typeof selectedUrl !== "string") return false;
  try {
    const origin = new URL(selectedUrl).origin;
    const prefix = `blob:${origin}/`;
    if (!value.startsWith(prefix)) return false;
    const id = value.slice(prefix.length);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  } catch {
    return false;
  }
}

const MAX_PDF_BYTES = 64 * 1024 * 1024;
const PDF_VIEWER_URL = "https://artifact.invalid/document.pdf";

function validatePdfPayload(payload) {
  if (!payload || payload.mime !== "application/pdf" || !(payload.bytes instanceof ArrayBuffer))
    throw new Error("无效的 PDF 产出物");
  const bytes = new Uint8Array(payload.bytes);
  if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF 产出物超过 64 MiB，请下载文件后打开");
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-")
    throw new Error("无效的 PDF 产出物");
  return bytes;
}

/** A fresh, non-persistent session serves exactly one in-memory PDF. */
function installPdfSession(session, input) {
  let bytes = new Uint8Array(input);
  let cleanup;
  const denyDownload = (event) => event.preventDefault();
  const release = () => {
    if (cleanup) return cleanup;
    bytes = null;
    let resolveCleanup, rejectCleanup;
    cleanup = new Promise((resolve, reject) => {
      resolveCleanup = resolve;
      rejectCleanup = reject;
    });
    // Attempt every step even when an Electron API throws synchronously. All
    // callers observe the same result, including a partial cleanup failure.
    const steps = [
      () => session.protocol.unhandle("https"),
      () => session.removeListener("will-download", denyDownload),
      () => session.clearStorageData(),
      () => session.clearCache()
    ];
    const results = steps.map((step) => {
      try {
        return Promise.resolve(step());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    Promise.allSettled(results)
      .then((settled) => {
        const errors = settled
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length)
          throw new AggregateError(errors, `PDF session cleanup failed: ${errors.map(String).join("; ")}`);
      })
      .then(resolveCleanup, rejectCleanup);
    return cleanup;
  };
  try {
    session.protocol.handle("https", (request) => {
      if (!bytes || request.url !== PDF_VIEWER_URL) return new Response(null, { status: 410 });
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'"
        }
      });
    });
    session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "file://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"] },
      (request, callback) => callback({ cancel: !bytes || request.url !== PDF_VIEWER_URL })
    );
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.on("will-download", denyDownload);
    return release;
  } catch (error) {
    void release().catch((cleanupError) => console.error("清理 PDF 预览失败", cleanupError.message));
    throw error;
  }
}

module.exports = {
  isArtifactViewerUrl,
  validatePdfPayload,
  installPdfSession,
  PDF_VIEWER_URL,
  MAX_PDF_BYTES
};
