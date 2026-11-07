import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { coworkConfigPath, readCoworkConfig, type CoworkConfig } from "../runtime/config.js";
import { withFileLock } from "../storage/file-lock.js";
import { configuredSupportsImages } from "../runtime/runtime-settings.js";
import { testModelConnection } from "../runtime/model-connection.js";
import { publicConnections, saveConnection, selectedConnection } from "../runtime/model-connections.js";
import { connectionProfile, parseConnectionProfile } from "../runtime/model-profile.js";
import { publicModelRoles, saveRoleModelBinding } from "../runtime/role-models.js";
import {
  applyHostCredentials,
  hasHostCredentials,
  HostCredentialStore,
  hostCredentialsPath,
  mergeHostCredentials,
  takeHostCredentials,
  unavailableModelCredential
} from "../security/host-credentials.js";

/**
 * Local settings for the execution host.
 *
 * The response never carries a secret: keys are written to the host credential
 * store, the public configuration keeps only what a connection needs to be
 * described. A configuration that still holds old desktop ciphertext reports
 * that it cannot be decrypted here instead of claiming a usable connection.
 */
export function createModelSettings(
  root: string,
  config: CoworkConfig,
  active: () => boolean,
  options: { credentialsPath?: string } = {}
) {
  const path = coworkConfigPath(root);
  const store = new HostCredentialStore(options.credentialsPath ?? hostCredentialsPath(path));
  if (!store.error) applyHostCredentials(config, store.value);
  const legacyCredential = () =>
    !config.modelConnections && !config.apiKey && existsSync(join(dirname(path), "model-secret.bin"))
      ? "已保存的模型密钥由旧版桌面宿主加密；请重新填写 API Key，或先运行桌面配置迁移工具"
      : undefined;
  const credentialError = () => store.error ?? unavailableModelCredential(config) ?? legacyCredential();
  const status = (projectId?: string) => {
    const error = credentialError();
    return {
      ...connectionProfile(config),
      ...publicConnections(config),
      baseUrl: process.env.COWORK_API_BASE || config.baseUrl || config.apiBase || "",
      model: process.env.COWORK_MODEL || config.model || "",
      configured: Boolean(
        (process.env.COWORK_API_BASE || config.baseUrl || config.apiBase) &&
        (process.env.COWORK_API_KEY || config.apiKey)
      ),
      supportsImages:
        process.env.COWORK_SUPPORTS_IMAGES !== undefined ||
        [
          "COWORK_REASONING_EFFORT",
          "COWORK_SUPPORTS_REASONING_EFFORT",
          "COWORK_MAIN_MAX_TOKENS",
          "COWORK_MAX_TOKENS"
        ].some((key) => process.env[key] !== undefined)
          ? configuredSupportsImages()
          : config.supportsImages === true,
      managedByEnvironment: Boolean(
        process.env.COWORK_API_BASE ||
        process.env.COWORK_API_KEY ||
        process.env.COWORK_MODEL ||
        process.env.COWORK_SUPPORTS_IMAGES !== undefined ||
        process.env.COWORK_MODEL_API !== undefined ||
        process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY !== undefined ||
        process.env.COWORK_THINKING_FORMAT !== undefined ||
        process.env.COWORK_CONTEXT_WINDOW !== undefined
      ),
      credentialUnavailable: Boolean(unavailableModelCredential(config) || legacyCredential()),
      ...(error ? { credentialError: error } : {}),
      modelRoles: publicModelRoles(config, projectId)
    };
  };
  /**
   * One atomic private write for the public configuration.
   *
   * Keys are moved to the host store before the file is written, so a settings
   * response and the file on disk can never disagree about where a secret lives.
   */
  const persist = async (next: CoworkConfig) => {
    const persisted = structuredClone(next);
    const extracted = takeHostCredentials(persisted);
    const credentials = mergeHostCredentials(store.value, extracted);
    if (hasHostCredentials(credentials)) await store.write(credentials);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(persisted, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    Object.assign(config, persisted);
    if (persisted.roleModels) config.roleModels = persisted.roleModels;
    else delete config.roleModels;
    applyHostCredentials(config, credentials);
  };
  return {
    status,
    async test(value: Record<string, unknown>) {
      const current = status();
      const managed = current.managedByEnvironment;
      const selected = managed ? config : selectedConnection(config, value) || {};
      if (value.supportsImages !== undefined && typeof value.supportsImages !== "boolean")
        throw new Error("图像能力设置必须为布尔值");
      const supplied = typeof value.apiKey === "string" && Boolean(value.apiKey.trim());
      const unavailable = credentialError();
      if (!managed && !supplied && unavailable) throw new Error(unavailable);
      return testModelConnection({
        ...parseConnectionProfile(managed ? {} : value, connectionProfile(selected)),
        baseUrl: managed
          ? current.baseUrl
          : typeof value.baseUrl === "string"
            ? value.baseUrl.trim()
            : selected.baseUrl || "",
        model: managed
          ? current.model
          : typeof value.model === "string"
            ? value.model.trim()
            : selected.model || "",
        apiKey:
          !managed && supplied
            ? String(value.apiKey).trim()
            : (managed ? process.env.COWORK_API_KEY || config.apiKey : selected.apiKey) || "",
        supportsImages:
          managed || value.supportsImages === undefined
            ? managed
              ? current.supportsImages
              : selected.supportsImages === true
            : value.supportsImages === true
      });
    },
    async save(value: Record<string, unknown>) {
      if (active()) throw new Error("请先停止运行中的任务，再修改模型连接");
      if (status().managedByEnvironment) throw new Error("当前连接由启动环境管理，请在启动配置中修改");
      await withFileLock(path, async () => {
        store.reload();
        if (store.error) throw new Error(store.error);
        const previous = existsSync(path) ? readCoworkConfig(root, { COWORK_CONFIG: path }) : config;
        applyHostCredentials(previous, store.value);
        const next = saveConnection(previous, value);
        if (!previous.modelConnections && existsSync(path)) {
          await copyFile(path, `${path}.before-model-profiles`, 1).catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
          await chmod(`${path}.before-model-profiles`, 0o600);
        }
        // One write commits the public connection and its host-owned key together.
        await persist(next);
      });
      return status();
    },
    /**
     * Save one role binding on this execution host.
     *
     * Allowed while a Run is active on purpose: the change must apply to the
     * next Run and never rewrite the snapshot the current process was given.
     */
    async saveRole(value: Record<string, unknown>) {
      if (status().managedByEnvironment) throw new Error("当前连接由启动环境管理，请在启动配置中修改");
      await withFileLock(path, async () => {
        store.reload();
        if (store.error) throw new Error(store.error);
        const previous = existsSync(path) ? readCoworkConfig(root, { COWORK_CONFIG: path }) : config;
        applyHostCredentials(previous, store.value);
        await persist(saveRoleModelBinding(previous, value));
      });
      const projectId =
        typeof value.projectId === "string" && value.projectId.trim() ? value.projectId.trim() : undefined;
      return status(projectId);
    }
  };
}
