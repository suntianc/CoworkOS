/** Load the selected backend's bundled UI into the main window. */
async function connectRenderer(backend, getWindow) {
  const window = getWindow();
  if (window && !window.isDestroyed()) await window.loadURL(backend.url);
}

module.exports = { connectRenderer };
