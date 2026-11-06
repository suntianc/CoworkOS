#!/usr/bin/env node
/**
 * Move model and search credentials out of the old Electron encryption.
 *
 * The backend now owns credentials for the execution host, so the old host is
 * needed exactly once: to decrypt what only its safeStorage key can read. This
 * script talks to that host over the existing keychain-worker protocol, writes the
 * host credential store beside the configuration, backs up the original file and
 * only then rewrites the public configuration without ciphertext. Re-running after
 * a successful conversion reports `already-migrated`; one failed decryption leaves
 * every original file untouched.
 *
 *   node scripts/migrate-desktop-settings.mjs --config <model-config.json>
 *       [--credentials <credentials.json>] [--legacy-secret <model-secret.bin>]
 *       [--host <electron executable>] [--host-arg <flag> ...]
 *
 * Stop the backend first, migrate, then start it again; a running backend keeps
 * its already-loaded configuration in memory.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDesktopCredentials } from "../dist/src/security/desktop-credentials-migration.js";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
function options(name) {
  const found = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1]) found.push(args[index + 1]);
  return found;
}
function usage(message) {
  console.error(message);
  console.error(
    "用法：node scripts/migrate-desktop-settings.mjs --config <旧配置> [--credentials <凭据文件>] [--legacy-secret <旧密钥>] [--host <宿主>] [--host-arg <参数>]"
  );
  process.exitCode = 2;
}

const config = option("--config");
if (!config) usage("缺少 --config");
else {
  const configPath = resolve(config);
  const credentialsPath = option("--credentials");
  const legacySecretPath = option("--legacy-secret");
  const hostExecutable = option("--host");
  const hostArgs = options("--host-arg");
  let storage;

  const decrypt = async (ciphertext) => {
    if (!storage) {
      const { createRetryableStorage } = require("../desktop/retryable-storage.cjs");
      // The host process must keep its own user data; the worker receives a private temp directory.
      storage = createRetryableStorage({
        executable: hostExecutable ?? require("electron"),
        args: [repositoryRoot, ...hostArgs],
        timeout: Number(option("--host-timeout") ?? 120_000)
      });
    }
    return storage.decryptString(ciphertext);
  };

  try {
    const result = await migrateDesktopCredentials({
      configPath,
      credentialsPath: credentialsPath ? resolve(credentialsPath) : undefined,
      legacySecretPath: legacySecretPath ? resolve(legacySecretPath) : undefined,
      decrypt
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "旧版桌面配置迁移失败");
    process.exitCode = 1;
  } finally {
    await storage?.close();
  }
}
