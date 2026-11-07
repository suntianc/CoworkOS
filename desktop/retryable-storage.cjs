const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { workerFlag, maxMessage } = require("./keychain-worker.cjs");

const storageError = () =>
  new Error("系统密钥存储访问失败，密钥尚未保存。请再次点击保存重试；如系统显示授权请求，请完成授权。");

/** Keep OS failures outside the UI process; only explicit saves reset a failed attempt. */
function createRetryableStorage({ executable, args = [], env = process.env, timeout = 120000, appName }) {
  let current;
  let closed = false;
  let sequence = 0;
  let queue = Promise.resolve();
  const serial = (operation) => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };
  async function stop() {
    const worker = current;
    current = undefined;
    if (!worker) return;
    worker.reject?.(storageError());
    worker.lines.close();
    worker.child.stdin.destroy();
    // This is exclusively our private helper, never a main/user application process.
    worker.child.kill("SIGKILL");
    await worker.exited;
    await rm(worker.data, { recursive: true, force: true });
  }
  async function start() {
    const data = await mkdtemp(join(tmpdir(), "atria-keychain-"));
    if (closed) {
      await rm(data, { recursive: true, force: true });
      throw storageError();
    }
    const cleanEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !/^(?:ATRIA_|COWORK_|PI_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/.test(key) &&
          !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)
      )
    );
    const child = spawn(executable, [...args, workerFlag], {
      env: {
        ...cleanEnv,
        ATRIA_KEYCHAIN_WORKER_DATA: data,
        ...(appName ? { ATRIA_KEYCHAIN_WORKER_NAME: appName } : {})
      },
      stdio: ["pipe", "pipe", "ignore"]
    });
    const worker = { child, data, failed: false };
    worker.exited = new Promise((resolve) => {
      child.once("error", resolve);
      child.once("exit", resolve);
    });
    worker.lines = createInterface({ input: child.stdout });
    worker.lines.on("line", (line) => {
      if (!line.startsWith("atria-keychain:")) return;
      try {
        if (line.length > maxMessage) throw new Error();
        const message = JSON.parse(line.slice("atria-keychain:".length));
        if (message.id !== worker.id) throw new Error();
        worker.finish?.(message);
      } catch {
        worker.reject?.(storageError());
      }
    });
    child.on("error", () => worker.reject?.(storageError()));
    child.on("exit", () => {
      worker.failed = true;
      worker.reject?.(storageError());
    });
    child.stdin.on("error", () => worker.reject?.(storageError()));
    current = worker;
    return worker;
  }
  const request = (operation, value) =>
    serial(async () => {
      if (closed) throw storageError();
      const worker = current ?? (await start());
      if (worker.failed) throw storageError();
      return new Promise((resolve, reject) => {
        const finish = (error, value, brokenWorker = true) => {
          clearTimeout(timer);
          worker.finish = undefined;
          worker.reject = undefined;
          if (error) {
            if (brokenWorker) worker.failed = true;
            reject(storageError());
          } else resolve(value);
        };
        const timer = setTimeout(() => finish(storageError()), timeout);
        worker.id = ++sequence;
        worker.finish = (message) =>
          message.ok === true ? finish(null, message.value) : finish(storageError(), undefined, false);
        worker.reject = (error) => finish(error);
        worker.child.stdin.write(JSON.stringify({ id: worker.id, operation, value }) + "\n");
      });
    });
  return {
    retry: () => serial(stop),
    close() {
      closed = true;
      return stop();
    },
    async isEncryptionAvailable() {
      return (await request("available")) === true;
    },
    async encryptString(value) {
      const encrypted = await request("encrypt", value);
      if (typeof encrypted !== "string") throw storageError();
      return Buffer.from(encrypted, "base64");
    },
    async decryptString(value) {
      const decrypted = await request("decrypt", value.toString("base64"));
      if (typeof decrypted !== "string") throw storageError();
      return decrypted;
    }
  };
}

module.exports = { createRetryableStorage };
