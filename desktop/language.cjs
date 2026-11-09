const fs = require("node:fs/promises");
const path = require("node:path");
const { assertTrustedSender } = require("./trusted-content.cjs");
const valid = (value) => value === "zh-CN" || value === "en";

/** The backend origin changes on restart; desktop language belongs to the profile. */
function createLanguageHost({ userData, ipcMain, getWindow, getDashboardUrl, onChange = () => {} }) {
  const file = path.join(userData, "language.json");
  let language = "zh-CN";
  let writes = Promise.resolve();
  const trust = (event) => assertTrustedSender(event, getWindow(), getDashboardUrl());
  return {
    get: () => language,
    async load() {
      try {
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        if (valid(saved.language)) language = saved.language;
        // eslint-disable-next-line no-restricted-syntax -- language.json may be missing or hold unparsable JSON, and the product keeps its zh-CN default
      } catch {
        // Missing or invalid preferences preserve the product's Chinese default.
      }
    },
    register() {
      ipcMain.on("bookman:language", (event) => {
        try {
          trust(event);
          event.returnValue = language;
          // eslint-disable-next-line no-restricted-syntax -- trust() throws deliberately for untrusted senders; the synchronous reply is null for them
        } catch {
          event.returnValue = null;
        }
      });
      ipcMain.handle("bookman:set-language", (event, value) => {
        trust(event);
        if (!valid(value)) throw new Error("Invalid language preference");
        const save = writes
          // eslint-disable-next-line no-restricted-syntax -- writes holds the previous save whose rejection was already returned to its caller; the chain only waits for it to settle
          .catch(() => {})
          .then(async () => {
            try {
              await fs.mkdir(userData, { recursive: true });
              await fs.writeFile(`${file}.tmp`, JSON.stringify({ language: value }) + "\n", { mode: 0o600 });
              await fs.rename(`${file}.tmp`, file);
              language = value;
              onChange(value);
            } catch {
              throw new Error("Could not save language preference");
            }
          });
        writes = save;
        return save;
      });
    }
  };
}
module.exports = { createLanguageHost };
