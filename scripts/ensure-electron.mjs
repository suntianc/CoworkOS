import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

/**
 * Electron downloads its runtime on first use, but packaging points
 * electron-builder at `node_modules/electron/dist` directly, so a clean
 * `npm ci` has no runtime to package. Fetch it here, once, before packaging.
 */
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("electron/package.json"));
if (existsSync(join(packageRoot, "dist"))) process.exit(0);
process.stdout.write("Downloading the Electron runtime for packaging…\n");
execFileSync(process.execPath, [join(packageRoot, "install.js")], { stdio: "inherit" });
