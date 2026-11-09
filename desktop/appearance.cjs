const fs = require("node:fs/promises");
const path = require("node:path");
const { assertTrustedSender } = require("./trusted-content.cjs");
const valid = (value) => ["system", "light", "dark"].includes(value);
function createAppearanceHost({ userData, nativeTheme, ipcMain, getWindow, getDashboardUrl }) {
  const file = path.join(userData, "appearance.json");
  let warning;
  let preference = "system",
    writes = Promise.resolve();
  const snapshot = () => ({
    preference,
    effective: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    ...(warning ? { warning } : {})
  });
  const publish = () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("bookman:appearance-changed", snapshot());
  };
  const trust = (event) => assertTrustedSender(event, getWindow(), getDashboardUrl());
  return {
    async load() {
      try {
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        if (valid(saved?.preference)) preference = saved.preference;
        else warning = "外观偏好无法读取，已跟随系统。";
      } catch (error) {
        if (error.code !== "ENOENT") warning = "外观偏好无法读取，已跟随系统。";
      }
      nativeTheme.themeSource = preference;
    },
    register() {
      nativeTheme.on("updated", publish);
      ipcMain.on("bookman:appearance", (event) => {
        try {
          trust(event);
          event.returnValue = snapshot();
          // eslint-disable-next-line no-restricted-syntax -- trust() throws deliberately for untrusted senders; the synchronous reply is null and the rejection has nothing else to report
        } catch {
          event.returnValue = null;
        }
      });
      ipcMain.handle("bookman:set-appearance", (event, value) => {
        trust(event);
        if (!valid(value)) throw new Error("Invalid appearance preference");
        const save = writes
          // eslint-disable-next-line no-restricted-syntax -- writes holds the previous save whose rejection was already returned to its caller; the chain only waits for it to settle
          .catch(() => {})
          .then(async () => {
            await fs.mkdir(userData, { recursive: true });
            await fs.writeFile(`${file}.tmp`, JSON.stringify({ preference: value }) + "\n", { mode: 0o600 });
            await fs.rename(`${file}.tmp`, file);
            warning = undefined;
            preference = value;
            nativeTheme.themeSource = value;
            publish();
            return snapshot();
          });
        writes = save;
        return save;
      });
    }
  };
}
module.exports = { createAppearanceHost };
