/** Remove legacy host cookies before loading the selected backend's bundled UI. */
async function connectRenderer(backend, cookies, getWindow) {
  await cookies.remove(backend.url, "atria-session");
  const window = getWindow();
  if (window && !window.isDestroyed()) await window.loadURL(backend.url);
}

module.exports = { connectRenderer };
