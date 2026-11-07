import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { cleanCompiled } from "./clean-compiled.mjs";

// Compile the shared runtime and prepare CLI assets.
await cleanCompiled();
// Older builds copied the retired Python runtime outside TypeScript's output set.
await rm(resolve("dist/src/tools/science"), { recursive: true, force: true });
execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
  stdio: "inherit"
});
const { buildCliUiManifest } = await import("./build-cli-ui.mjs");
await buildCliUiManifest();
