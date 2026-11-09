import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseUpdateVersion } from "./update-release.mjs";

export async function verifyNpmRelease({
  version = process.env.VERSION,
  directory = resolve(".tmp/npm-release"),
  attempts = 20,
  delayMs = 15000,
  fetchImpl = fetch,
  wait = delay
} = {}) {
  parseUpdateVersion(version);
  const packages = await Promise.all(
    ["coworkos-desktop-darwin-arm64", "coworkos-app"].map(async (name) => ({
      name,
      integrity:
        "sha512-" +
        createHash("sha512")
          .update(await readFile(join(directory, `${name}-${version}.tgz`)))
          .digest("base64")
    }))
  );
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pending = [];
    for (const pkg of packages) {
      let response;
      try {
        response = await fetchImpl(
          `https://registry.npmjs.org/${pkg.name}/${version}?verification=${Date.now()}`,
          {
            headers: { "cache-control": "no-cache" },
            signal: AbortSignal.timeout(15000)
          }
        );
        // eslint-disable-next-line no-restricted-syntax -- 轮询期间网络抖动把该包记为待发布并进入下一个退避周期重试
      } catch {
        pending.push(pkg.name);
        continue;
      }
      if (response.status === 404 || response.status >= 500) {
        pending.push(pkg.name);
        continue;
      }
      if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${pkg.name}`);
      const metadata = await response.json();
      if (
        metadata.name !== pkg.name ||
        metadata.version !== version ||
        metadata.dist?.integrity !== pkg.integrity
      )
        throw new Error(`Published npm package differs from the verified candidate: ${pkg.name}@${version}`);
    }
    if (!pending.length) {
      console.log(`Verified npm versions and SHA-512 integrity for both ${version} packages.`);
      return;
    }
    if (attempt + 1 < attempts) {
      console.log(`Waiting for npm processing (${attempt + 1}/${attempts}): ${pending.join(", ")}`);
      await wait(delayMs);
    }
  }
  throw new Error(
    `npm ${version} is not yet visible. Retry with verify_only=true; do not republish accepted packages.`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await verifyNpmRelease();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
