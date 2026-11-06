import { existsSync } from "node:fs";
import { mkdir, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { coworkConfigPath, readCoworkConfig, type CoworkConfig } from "../runtime/config.js";
import { publicWebSearchStatus, saveWebSearchConfig } from "../runtime/web-search-config.js";
import { withFileLock } from "../storage/file-lock.js";
import {
  applyHostCredentials,
  hasHostCredentials,
  HostCredentialStore,
  hostCredentialsPath,
  mergeHostCredentials,
  takeHostCredentials,
  unavailableWebSearchCredential
} from "../security/host-credentials.js";

/** The host stores the optional search key privately and never returns it. */
export function createWebSearchSettings(
  root: string,
  config: CoworkConfig,
  active: () => boolean,
  options: { credentialsPath?: string } = {}
) {
  const path = coworkConfigPath(root);
  const store = new HostCredentialStore(options.credentialsPath ?? hostCredentialsPath(path));
  if (!store.error) applyHostCredentials(config, store.value);
  const credentialError = () => store.error ?? unavailableWebSearchCredential(config);
  const status = () => {
    const error = credentialError();
    return {
      ...publicWebSearchStatus(config),
      secretUnavailable: Boolean(unavailableWebSearchCredential(config)),
      ...(error ? { credentialError: error } : {})
    };
  };
  return {
    status,
    async save(input: Record<string, unknown>) {
      if (active()) throw new Error("请先停止运行中的任务，再修改联网搜索设置");
      if (status().managedByEnvironment) throw new Error("联网搜索由启动环境管理，请在启动配置中修改");
      await withFileLock(path, async () => {
        store.reload();
        if (store.error) throw new Error(store.error);
        const previous = existsSync(path) ? readCoworkConfig(root, { COWORK_CONFIG: path }) : config;
        applyHostCredentials(previous, store.value);
        const next = saveWebSearchConfig(previous, input);
        const persisted = structuredClone(next);
        const extracted = takeHostCredentials(persisted);
        // Only a submitted (or explicitly cleared) key supersedes old desktop ciphertext.
        const replaced =
          input.clearExaApiKey === true ||
          (typeof input.exaApiKey === "string" && Boolean(input.exaApiKey.trim()));
        if (replaced) delete persisted.webSearch?.encryptedExaApiKey;
        const merged = mergeHostCredentials(store.value, extracted);
        // An explicit clear removes the stored key instead of retaining it for a later re-enable.
        const credentials =
          input.clearExaApiKey === true
            ? { version: 1 as const, modelConnections: merged.modelConnections }
            : merged;
        if (hasHostCredentials(credentials) || (input.clearExaApiKey === true && existsSync(store.path)))
          await store.write(credentials);
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.tmp-${randomUUID()}`;
        await writeFile(temp, JSON.stringify(persisted, null, 2) + "\n", { mode: 0o600 });
        await rename(temp, path);
        await chmod(path, 0o600);
        Object.assign(config, persisted);
        applyHostCredentials(config, credentials);
      });
      return status();
    }
  };
}
