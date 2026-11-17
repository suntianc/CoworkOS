const fs = require("node:fs/promises");
const crypto = require("node:crypto");

async function decryptedWebSearch(settings, safeStorage, allowUnavailableSecret = false) {
  if (!settings.webSearch?.encryptedExaApiKey) return settings;
  let exaApiKey;
  try {
    if (!(await safeStorage.isEncryptionAvailable())) throw new Error();
    exaApiKey = await safeStorage.decryptString(Buffer.from(settings.webSearch.encryptedExaApiKey, "base64"));
  } catch {
    if (!allowUnavailableSecret) throw new Error("Exa 密钥无法解密，请在联网搜索设置中重新配置或清除密钥");
  }
  return { ...settings, webSearch: { ...settings.webSearch, exaApiKey } };
}
function createWebSearchSettings(paths, safeStorage) {
  async function read() {
    try {
      const settings = JSON.parse(await fs.readFile(paths.configPath, "utf8"));
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
      return settings;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error("搜索配置无法读取");
    }
  }
  return {
    async status() {
      const { publicWebSearchStatus } = await import("../dist/src/runtime/web-search-config.js");
      const config = await read();
      return publicWebSearchStatus(await decryptedWebSearch(config, safeStorage, true));
    },
    async save(input) {
      const { saveWebSearchConfig } = await import("../dist/src/runtime/web-search-config.js");
      if ((await this.status()).managedByEnvironment)
        throw new Error("联网搜索由启动环境管理，请在启动配置中修改");
      const { withFileLock } = await import("../dist/src/storage/file-lock.js");
      await withFileLock(paths.configPath, async () => {
        await safeStorage.retry?.();
        const existing = await read();
        // Retaining an old encrypted key never needs to decrypt it.
        const next = saveWebSearchConfig(existing, input || {});
        // Clearing removes this host's ciphertext too, so an unrelated save cannot restore it.
        if (input?.clearExaApiKey === true && next.webSearch) delete next.webSearch.encryptedExaApiKey;
        if (next.webSearch.exaApiKey) {
          if (!(await safeStorage.isEncryptionAvailable()))
            throw new Error("系统密钥存储访问失败，Exa API Key 尚未保存。请再次点击保存重试。");
          next.webSearch.encryptedExaApiKey = (
            await safeStorage.encryptString(next.webSearch.exaApiKey)
          ).toString("base64");
        }
        delete next.webSearch.exaApiKey;
        const temp = `${paths.configPath}.tmp-${crypto.randomUUID()}`;
        await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        await fs.rename(temp, paths.configPath);
      });
      return this.status();
    }
  };
}
module.exports = { createWebSearchSettings, decryptedWebSearch };
