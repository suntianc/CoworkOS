const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

/** Long-lived client sessions are encrypted by the desktop host, never returned to the renderer. */
function createSessionCredentialStore({ userData, storage }) {
  const file = path.join(userData, "client-sessions.json");
  let queue = Promise.resolve();
  const serial = (action) => {
    const next = queue.catch(() => {}).then(action);
    queue = next;
    return next;
  };
  const keyFor = (id) => {
    if (typeof id !== "string" || !id || id.length > 256) throw new Error("无效的后端身份");
    return createHash("sha256").update(id).digest("hex");
  };
  async function document() {
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, credentials: {} };
      throw new Error("客户端凭据存储无法读取");
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("客户端凭据存储已损坏，请恢复备份");
    }
    if (
      value?.version !== 1 ||
      !value.credentials ||
      typeof value.credentials !== "object" ||
      Array.isArray(value.credentials)
    )
      throw new Error("客户端凭据存储格式无效");
    return value;
  }
  return {
    read(backendId) {
      return serial(async () => {
        const entry = (await document()).credentials[keyFor(backendId)];
        if (!entry) return undefined;
        if (typeof entry.sessionId !== "string" || typeof entry.ciphertext !== "string")
          throw new Error("客户端凭据存储格式无效");
        try {
          if (!(await storage.isEncryptionAvailable())) throw new Error();
          const token = await storage.decryptString(Buffer.from(entry.ciphertext, "base64"));
          if (typeof token !== "string" || !token) throw new Error();
          await storage.release?.();
          return { sessionId: entry.sessionId, token };
        } catch {
          throw new Error("系统密钥存储无法读取客户端凭据，请检查系统授权后重试");
        }
      });
    },
    write(backendId, session) {
      return serial(async () => {
        const key = keyFor(backendId);
        if (
          !session ||
          typeof session.sessionId !== "string" ||
          !session.sessionId ||
          typeof session.token !== "string" ||
          !session.token ||
          session.token.length > 4096
        )
          throw new Error("无效的客户端会话");
        const value = await document();
        let ciphertext;
        try {
          if (!(await storage.isEncryptionAvailable())) throw new Error();
          ciphertext = (await storage.encryptString(session.token)).toString("base64");
          await storage.release?.();
        } catch {
          throw new Error("系统密钥存储无法保存客户端凭据，请检查系统授权后重试");
        }
        value.credentials[key] = { sessionId: session.sessionId, ciphertext };
        await fs.mkdir(userData, { recursive: true, mode: 0o700 });
        const temporary = `${file}.tmp-${randomUUID()}`;
        try {
          await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
          await fs.rename(temporary, file);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });
    }
  };
}
module.exports = { createSessionCredentialStore };
