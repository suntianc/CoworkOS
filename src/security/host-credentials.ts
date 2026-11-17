import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CoworkConfig } from "../runtime/config.js";
import { modelConnections } from "../runtime/model-providers.js";
import { withFileLock } from "../storage/file-lock.js";

/**
 * Credentials owned by the execution host.
 *
 * The public configuration names connections; this file holds the secrets they
 * use. It lives beside the configuration, is written only by the host service
 * and never travels back through a settings response. The format is versioned
 * so an unreadable or future file is reported instead of being replaced.
 */
export interface HostCredentials {
  version: 1;
  /** Provider keys by provider id; `default` holds a single-connection host's key. */
  modelProviders: Record<string, string>;
  webSearch?: { exaApiKey?: string };
}

const unavailable = (path: string) =>
  new Error(`凭据存储无法读取（${path}），请从备份恢复或删除该文件后重新填写密钥`);

export function emptyHostCredentials(): HostCredentials {
  return { version: 1, modelProviders: {} };
}

/** `COWORK_CREDENTIALS` supports an isolated host; the default sits beside the configuration. */
export function hostCredentialsPath(configPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.COWORK_CREDENTIALS
    ? resolve(env.COWORK_CREDENTIALS)
    : join(dirname(configPath), "credentials.json");
}

function parseCredentials(path: string, raw: string): HostCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw unavailable(path);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable(path);
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw unavailable(path);
  const models: unknown = record.modelProviders ?? {};
  if (!models || typeof models !== "object" || Array.isArray(models)) throw unavailable(path);
  const entries: Array<[string, string]> = [];
  for (const [id, secret] of Object.entries(models as Record<string, unknown>)) {
    if (!id || typeof secret !== "string" || !secret || /[\r\n\0]/.test(secret)) throw unavailable(path);
    entries.push([id, secret]);
  }
  const search: unknown = record.webSearch;
  let exaApiKey: string | undefined;
  if (search !== undefined) {
    if (!search || typeof search !== "object" || Array.isArray(search)) throw unavailable(path);
    const candidate = (search as { exaApiKey?: unknown }).exaApiKey;
    if (candidate !== undefined) {
      if (typeof candidate !== "string" || !candidate || /[\r\n\0]/.test(candidate)) throw unavailable(path);
      exaApiKey = candidate;
    }
  }
  return {
    version: 1,
    modelProviders: Object.fromEntries(entries),
    ...(exaApiKey ? { webSearch: { exaApiKey } } : {})
  };
}

export function readHostCredentials(path: string): HostCredentials {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyHostCredentials();
    throw unavailable(path);
  }
  return parseCredentials(path, raw);
}

/** One atomic private write; a failed write leaves the previous credentials readable. */
export async function writeHostCredentials(path: string, value: HostCredentials): Promise<void> {
  await withFileLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  });
}

/**
 * The in-memory view of the host store.
 *
 * A damaged file is remembered rather than thrown from assembly, so the backend
 * still starts, reports the concrete error and refuses to overwrite the file.
 */
export class HostCredentialStore {
  readonly path: string;
  #value: HostCredentials = emptyHostCredentials();
  #error?: string;

  constructor(path: string) {
    this.path = path;
    this.reload();
  }

  get error(): string | undefined {
    return this.#error;
  }

  get value(): HostCredentials {
    return this.#value;
  }

  reload(): void {
    try {
      this.#value = readHostCredentials(this.path);
      this.#error = undefined;
    } catch (error) {
      this.#value = emptyHostCredentials();
      this.#error = (error as Error).message;
    }
  }

  async write(next: HostCredentials): Promise<void> {
    await writeHostCredentials(this.path, next);
    this.#value = next;
    this.#error = undefined;
  }
}

/** Overlay host-owned secrets on a loaded configuration in memory only. */
export function applyHostCredentials(config: CoworkConfig, credentials: HostCredentials): void {
  const providers = config.modelProviders?.providers;
  if (providers?.length) {
    for (const provider of providers) {
      const secret = credentials.modelProviders[provider.id];
      if (secret) provider.apiKey = secret;
    }
    // The single-connection fields mirror the default connection, key included.
    const registry = modelConnections(config);
    const active = registry.profiles.find((profile) => profile.id === registry.activeId);
    if (active?.apiKey) config.apiKey = active.apiKey;
  } else if (credentials.modelProviders.default) {
    config.apiKey = credentials.modelProviders.default;
  }
  const exaApiKey = credentials.webSearch?.exaApiKey;
  if (exaApiKey) config.webSearch = { provider: config.webSearch?.provider ?? "exa", exaApiKey };
}

/**
 * Remove plaintext secrets from a configuration that is about to be persisted.
 * The returned values belong in the host store; nothing is written here.
 */
export function takeHostCredentials(config: CoworkConfig): HostCredentials {
  const credentials = emptyHostCredentials();
  const providers = config.modelProviders?.providers;
  if (providers?.length) {
    for (const provider of providers) {
      if (!provider.apiKey) continue;
      credentials.modelProviders[provider.id] = provider.apiKey;
      delete provider.apiKey;
    }
    // The top-level copy only mirrors the default connection's provider key.
    delete config.apiKey;
  } else if (config.apiKey) {
    credentials.modelProviders.default = config.apiKey;
    delete config.apiKey;
  }
  const exaApiKey = config.webSearch?.exaApiKey;
  if (exaApiKey) {
    credentials.webSearch = { exaApiKey };
    delete config.webSearch!.exaApiKey;
  }
  return credentials;
}

/** Drop keys of providers the configuration no longer has. */
export function retainProviderCredentials(
  credentials: HostCredentials,
  config: CoworkConfig
): HostCredentials {
  const providers = config.modelProviders?.providers;
  if (!providers) return credentials;
  const keep = new Set(providers.map((provider) => provider.id));
  return {
    ...credentials,
    modelProviders: Object.fromEntries(
      Object.entries(credentials.modelProviders).filter(([id]) => keep.has(id))
    )
  };
}

export function mergeHostCredentials(current: HostCredentials, incoming: HostCredentials): HostCredentials {
  return {
    version: 1,
    modelProviders: { ...current.modelProviders, ...incoming.modelProviders },
    ...(incoming.webSearch?.exaApiKey
      ? { webSearch: { exaApiKey: incoming.webSearch.exaApiKey } }
      : current.webSearch
        ? { webSearch: current.webSearch }
        : {})
  };
}

export function hasHostCredentials(credentials: HostCredentials): boolean {
  return Object.keys(credentials.modelProviders).length > 0 || Boolean(credentials.webSearch?.exaApiKey);
}
