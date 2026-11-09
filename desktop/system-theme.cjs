// Appearance owns Electron's selected theme; keep the window's first paint in sync.
const DARK_BACKGROUND = "#0e0e0f";
const LIGHT_BACKGROUND = "#f4f4f8";

function windowBackground(nativeTheme, platform = process.platform) {
  // macOS renders the window material itself, so the window canvas stays clear.
  if (platform === "darwin") return "#00000000";
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}
function followNativeTheme(window, nativeTheme, { transparent = false } = {}) {
  if (transparent) return;
  const update = () => {
    if (!window.isDestroyed())
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND);
  };
  nativeTheme.on("updated", update);
  window.once("closed", () => nativeTheme.removeListener("updated", update));
  update();
}
module.exports = { DARK_BACKGROUND, LIGHT_BACKGROUND, windowBackground, followNativeTheme };
