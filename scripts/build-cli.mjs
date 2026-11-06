import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { cleanCompiled } from "./clean-compiled.mjs";
import { buildScienceRuntime } from "./build-science.mjs";

// Compile the shared runtime and prepare CLI assets.
await cleanCompiled();
execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
  stdio: "inherit"
});
const { buildCliUiManifest } = await import("./build-cli-ui.mjs");
await buildCliUiManifest();
await buildScienceRuntime();
