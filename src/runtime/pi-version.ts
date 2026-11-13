import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

let cached: string | undefined;

/**
 * Version of the Pi runtime this process actually loads.
 *
 * Read from the installed package instead of a constant so an upgrade cannot
 * leave the recorded snapshot version behind. The package does not export its
 * manifest, so this walks up from the resolved entry point to its package root.
 */
export function currentPiVersion(): string {
  cached ??= readInstalledVersion();
  return cached;
}

function readInstalledVersion(): string {
  for (
    let directory = dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE)));
    ;
    directory = dirname(directory)
  ) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
      if (metadata.name === PI_PACKAGE && metadata.version) return metadata.version;
    }
    if (dirname(directory) === directory) throw new Error(`找不到 ${PI_PACKAGE} 的 package.json。`);
  }
}
