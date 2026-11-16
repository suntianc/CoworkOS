const { decryptedWebSearch } = require("./web-search-settings.cjs");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

async function replace(path, data) {
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temp, data, { mode: 0o600 });
  await fs.rename(temp, path);
}
/** Only the native process decrypts credentials. The renderer gets configuration status. */
function createModelSettings(paths, safeStorage) {
  async function read({ allowUnavailableSecret = false } = {}) {
    let settings = {};
    try {
      settings = JSON.parse(await fs.readFile(paths.configPath, "utf8"));
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("模型配置无法读取");
    }
    const decrypt = async (encrypted) => {
      try {
        if (!(await safeStorage.isEncryptionAvailable())) throw new Error();
        return await safeStorage.decryptString(encrypted);
      } catch {
        if (!allowUnavailableSecret) throw new Error("模型密钥无法解密，请重新配置");
        return undefined;
      }
    };
    settings = await decryptedWebSearch(settings, safeStorage, allowUnavailableSecret);
    if (settings.modelConnections) {
      const { modelConnections } = await import("../dist/src/runtime/model-connections.js");
      const registry = modelConnections(settings);
      for (const profile of registry.profiles)
        profile.apiKey = profile.encryptedApiKey
          ? await decrypt(Buffer.from(profile.encryptedApiKey, "base64"))
          : undefined;
      return {
        ...settings,
        modelConnections: registry,
        apiKey: registry.profiles.find((p) => p.id === registry.activeId)?.apiKey
      };
    }
    return settings;
  }
  return {
    read,
    async test(input) {
      const existing = await read({ allowUnavailableSecret: true });
      const { selectedConnection } = await import("../dist/src/runtime/model-connections.js");
      const selected = selectedConnection(existing, input || {}) || {};
      const { testModelConnection } = await import("../dist/src/runtime/model-connection.js");
      const { connectionProfile, parseConnectionProfile } =
        await import("../dist/src/runtime/model-profile.js");
      if (input?.supportsImages !== undefined && typeof input.supportsImages !== "boolean")
        throw new Error("图像能力设置必须为布尔值");
      return testModelConnection({
        ...parseConnectionProfile(input || {}, connectionProfile(selected)),
        baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : selected.baseUrl || "",
        model: typeof input?.model === "string" ? input.model.trim() : selected.model || "",
        apiKey:
          typeof input?.apiKey === "string" && input.apiKey.trim()
            ? input.apiKey.trim()
            : selected.apiKey || "",
        supportsImages: input?.supportsImages ?? selected.supportsImages ?? false
      });
    },
    async status() {
      const existing = await read({ allowUnavailableSecret: true });
      const { connectionProfile } = await import("../dist/src/runtime/model-profile.js");
      const { publicConnections } = await import("../dist/src/runtime/model-connections.js");
      return {
        ...connectionProfile(existing),
        ...publicConnections(existing),
        baseUrl: existing.baseUrl || "",
        model: existing.model || "",
        supportsImages: existing.supportsImages === true,
        configured: Boolean(existing.baseUrl && existing.apiKey)
      };
    },
    async save(input) {
      const { withFileLock } = await import("../dist/src/storage/file-lock.js");
      await withFileLock(paths.configPath, async () => {
        await safeStorage.retry?.();
        const existing = await read({
          allowUnavailableSecret: typeof input?.apiKey === "string" && Boolean(input.apiKey.trim())
        });
        const { saveConnection } = await import("../dist/src/runtime/model-connections.js");
        const next = saveConnection(existing, input || {});
        if (!(await safeStorage.isEncryptionAvailable()))
          throw new Error(
            "系统密钥存储访问失败，API Key 尚未保存。请再次点击保存重试；如系统显示授权请求，请完成授权。"
          );
        for (const profile of next.modelConnections.profiles) {
          if (profile.apiKey)
            profile.encryptedApiKey = (await safeStorage.encryptString(profile.apiKey)).toString("base64");
          delete profile.apiKey;
        }
        delete next.apiKey;
        if (next.webSearch?.encryptedExaApiKey) delete next.webSearch.exaApiKey;
        if (!existing.modelConnections) {
          await fs
            .copyFile(paths.configPath, `${paths.configPath}.before-model-profiles`, 1)
            .catch((error) => {
              if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
            });
          await fs.chmod(`${paths.configPath}.before-model-profiles`, 0o600).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        // One atomic write commits every encrypted key together with the active selection.
        await replace(paths.configPath, JSON.stringify(next, null, 2) + "\n");
      });
      return this.status();
    }
  };
}
module.exports = { createModelSettings };
