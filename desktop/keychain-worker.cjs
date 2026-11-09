const { createInterface } = require("node:readline");

const workerFlag = "--atria-keychain-worker";
const maxMessage = 128 * 1024;

/** A fresh Electron process gets a fresh OSCrypt attempt, with the same signed app identity. */
async function runKeychainWorker({ app, BrowserWindow, safeStorage }) {
  // Retain the historical Safe Storage key so existing encrypted connections remain readable.
  app.setName(process.env.ATRIA_KEYCHAIN_WORKER_NAME || "Atria");
  app.setPath("userData", process.env.ATRIA_KEYCHAIN_WORKER_DATA);
  await app.whenReady();
  app.dock?.hide();
  // Initialize Chromium's application identity before accessing Safe Storage.
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const lines = createInterface({ input: process.stdin });
  const reply = (value) => process.stdout.write(`atria-keychain:${JSON.stringify(value)}\n`);
  lines.on("line", (line) => {
    let request;
    try {
      if (line.length > maxMessage) throw new Error();
      request = JSON.parse(line);
      if (!Number.isSafeInteger(request.id)) throw new Error();
      let value;
      switch (request.operation) {
        case "available":
          value = safeStorage.isEncryptionAvailable();
          break;
        case "encrypt":
          if (typeof request.value !== "string" || request.value.length > 16384) throw new Error();
          value = safeStorage.encryptString(request.value).toString("base64");
          break;
        case "decrypt":
          if (typeof request.value !== "string" || request.value.length > 65536) throw new Error();
          value = safeStorage.decryptString(Buffer.from(request.value, "base64"));
          break;
        default:
          throw new Error();
      }
      reply({ id: request.id, ok: true, value });
      // eslint-disable-next-line no-restricted-syntax -- the reply carries only ok:false because native Safe Storage errors can embed the secret being decrypted or encrypted
    } catch {
      // Never echo request values or provider/native diagnostics containing a secret.
      reply({ id: request?.id, ok: false });
    }
  });
  lines.on("close", () => {
    window.destroy();
    app.quit();
  });
}

module.exports = { workerFlag, maxMessage, runKeychainWorker };
