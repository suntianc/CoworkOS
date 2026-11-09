import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import {
  emptyHostCredentials,
  mergeHostCredentials,
  readHostCredentials,
  takeHostCredentials,
  writeHostCredentials,
  type HostCredentials
} from "./host-credentials.js";

/**
 * One-time conversion of credentials encrypted by the old Electron host.
 *
 * The old host is the only place that can decrypt its safeStorage ciphertext, so
 * the caller supplies that decryption step. Nothing is written until every value
 * decrypts, the public configuration is backed up before it changes, and the
 * public file keeps the same connection/profile identities. Re-running after a
 * successful conversion finds no ciphertext and reports what already happened.
 */
export interface DesktopCredentialMigration {
  status: "migrated" | "already-migrated" | "no-credentials";
  configPath: string;
  credentialsPath: string;
  backupPath?: string;
  modelConnections: number;
  webSearch: boolean;
  legacySecret: boolean;
}

export interface DesktopCredentialMigrationOptions {
  configPath: string;
  credentialsPath?: string;
  legacySecretPath?: string;
  decrypt: (ciphertext: Buffer) => Promise<string>;
}

interface EncryptedProfile {
  id: string;
  name?: string;
  encryptedApiKey: string;
}

function decryptionFailure(): Error {
  return new Error("无法使用旧版桌面宿主的加密存储解密密钥；原配置未修改，仍可继续使用旧宿主");
}

async function decryptValue(
  decrypt: (ciphertext: Buffer) => Promise<string>,
  value: Buffer
): Promise<string> {
  let plaintext: string;
  try {
    plaintext = await decrypt(value);
  } catch {
    throw decryptionFailure();
  }
  if (typeof plaintext !== "string" || !plaintext || /[\r\n\0]/.test(plaintext)) throw decryptionFailure();
  return plaintext;
}

function encryptedProfiles(config: Record<string, unknown>): EncryptedProfile[] {
  const connections = config.modelConnections as { profiles?: unknown } | undefined;
  if (!connections || !Array.isArray(connections.profiles)) return [];
  const found: EncryptedProfile[] = [];
  for (const profile of connections.profiles) {
    if (!profile || typeof profile !== "object") continue;
    const value = profile as Record<string, unknown>;
    if (typeof value.encryptedApiKey !== "string" || !value.encryptedApiKey) continue;
    if (typeof value.id !== "string" || !value.id) throw new Error("旧版模型配置中的连接缺少标识，无法迁移");
    found.push({
      id: value.id,
      name: typeof value.name === "string" ? value.name : undefined,
      encryptedApiKey: value.encryptedApiKey
    });
  }
  return found;
}

async function writeConfig(path: string, config: unknown): Promise<void> {
  await withFileLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  });
}

export async function migrateDesktopCredentials(
  options: DesktopCredentialMigrationOptions
): Promise<DesktopCredentialMigration> {
  const configPath = resolve(options.configPath);
  const credentialsPath = options.credentialsPath
    ? resolve(options.credentialsPath)
    : join(dirname(configPath), "credentials.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new Error(`旧版桌面配置无法读取：${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("旧版桌面配置不是有效 JSON；原文件未修改");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("旧版桌面配置必须是 JSON 对象；原文件未修改");
  const config = structuredClone(parsed) as Record<string, unknown>;

  // A damaged host store is reported before anything else is touched.
  const current = readHostCredentials(credentialsPath);
  const profiles = encryptedProfiles(config);
  const search = config.webSearch as Record<string, unknown> | undefined;
  const encryptedSearch =
    typeof search?.encryptedExaApiKey === "string" && search.encryptedExaApiKey
      ? search.encryptedExaApiKey
      : undefined;
  const hasProfiles = Boolean(config.modelConnections);
  const legacySecretPath = options.legacySecretPath
    ? resolve(options.legacySecretPath)
    : join(dirname(configPath), "model-secret.bin");
  const legacySecret = hasProfiles
    ? undefined
    : await readFile(legacySecretPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && !options.legacySecretPath) return undefined;
        throw new Error(`旧版桌面密钥文件无法读取：${legacySecretPath}`);
      });
  const backupPath = `${configPath}.before-host-credentials`;
  const result = {
    configPath,
    credentialsPath,
    modelConnections: 0,
    webSearch: false,
    legacySecret: false
  };

  if (!profiles.length && !encryptedSearch && !legacySecret) {
    const covered = profiles.every((profile) => Boolean(current.modelConnections[profile.id]));
    const backupExists = await readFile(backupPath).then(
      () => true,
      () => false
    );
    return {
      status: backupExists && covered ? "already-migrated" : "no-credentials",
      ...result,
      ...(backupExists ? { backupPath } : {})
    };
  }

  // Decrypt everything first: one failed value leaves every original file usable.
  const modelKeys: Record<string, string> = {};
  for (const profile of profiles)
    modelKeys[profile.id] = await decryptValue(
      options.decrypt,
      Buffer.from(profile.encryptedApiKey, "base64")
    );
  const exaApiKey = encryptedSearch
    ? await decryptValue(options.decrypt, Buffer.from(encryptedSearch, "base64"))
    : undefined;
  const legacyApiKey = legacySecret ? await decryptValue(options.decrypt, legacySecret) : undefined;

  const migrated = structuredClone(config);
  const nextProfiles = (
    migrated.modelConnections as { profiles?: Array<Record<string, unknown>> } | undefined
  )?.profiles;
  if (Array.isArray(nextProfiles)) for (const profile of nextProfiles) delete profile.encryptedApiKey;
  const nextSearch = migrated.webSearch as Record<string, unknown> | undefined;
  // The search key belongs only to the host store; the public file keeps the provider.
  if (nextSearch) delete nextSearch.encryptedExaApiKey;

  // Plaintext keys still present in an old file move to the store in the same pass.
  const decrypted: HostCredentials = { ...emptyHostCredentials(), modelConnections: modelKeys };
  if (exaApiKey) decrypted.webSearch = { exaApiKey };
  if (legacyApiKey) decrypted.modelConnections.default = legacyApiKey;
  // Decrypted values win over stale plaintext copies of the same connection.
  const credentials = mergeHostCredentials(
    current,
    mergeHostCredentials(takeHostCredentials(migrated), decrypted)
  );

  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  // eslint-disable-next-line no-restricted-syntax -- 备份已由 copyFile 写成，收紧备份文件权限受挂载点/ACL 限制时只影响备份元数据，不能中断仍可完成迁移的流程
  await chmod(backupPath, 0o600).catch(() => {});
  // The host store commits first; a failed public write leaves the backup and the
  // already-migrated keys, so re-running finishes the conversion without duplicates.
  await writeHostCredentials(credentialsPath, credentials);
  await writeConfig(configPath, migrated);
  return {
    status: "migrated",
    ...result,
    backupPath,
    modelConnections: profiles.length + (legacyApiKey ? 1 : 0),
    webSearch: Boolean(exaApiKey),
    legacySecret: Boolean(legacyApiKey)
  };
}
