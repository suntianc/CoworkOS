/**
 * macOS renders the window material; Windows and Linux keep a painted background.
 * The renderer reads the returned name to replace its painted gradient.
 */
const NATIVE_MATERIAL = "under-window";

function windowMaterial(platform = process.platform) {
  if (platform !== "darwin") return { material: "none", options: {} };
  return {
    material: NATIVE_MATERIAL,
    options: {
      vibrancy: NATIVE_MATERIAL,
      visualEffectState: "active",
      transparent: true,
      backgroundColor: "#00000000"
    }
  };
}

module.exports = { NATIVE_MATERIAL, windowMaterial };
