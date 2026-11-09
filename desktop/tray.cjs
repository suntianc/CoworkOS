/** Install one native tray for the application lifetime. */
function createDesktopTray({ Tray, Menu, nativeImage, icon, platform, language, show, quit }) {
  if (!icon || !Tray || !nativeImage) return { supported: false, setLanguage() {}, dispose() {} };
  let tray;
  try {
    const image = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
    if (image.isEmpty?.()) throw new Error("empty icon");
    if (platform === "darwin") image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip("CoworkOS");
    const setLanguage = (value) => {
      const english = value === "en";
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: english ? "Show CoworkOS" : "显示 CoworkOS", click: show },
          { type: "separator" },
          { label: english ? "Quit CoworkOS" : "退出 CoworkOS", click: quit }
        ])
      );
    };
    tray.on("click", show);
    setLanguage(language);
    return { supported: true, setLanguage, dispose: () => tray.destroy() };
    // eslint-disable-next-line no-restricted-syntax -- a nativeImage/Tray construction failure leaves the app without a tray, which is exactly what the supported flag reports
  } catch {
    tray?.destroy();
    return { supported: false, setLanguage() {}, dispose() {} };
  }
}
module.exports = { createDesktopTray };
