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
module.exports = { isArtifactViewerUrl };
