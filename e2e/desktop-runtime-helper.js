import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { developmentExecutable as brandExecutable } from "../scripts/desktop-dev.mjs";

/**
 * The branded Electron runtime is sealed with the generated app icon, so a desktop
 * test that starts from a clean checkout needs `build/atria.icns` before it can launch.
 * `npm run test:browser` builds it first; a bare `npx playwright test` does not.
 * Resolving the runtime through this helper keeps both entries at one precondition
 * instead of failing on a missing generated file.
 */
export function ensureDesktopIcon() {
  if (existsSync("build/atria.icns")) return;
  execFileSync(process.execPath, ["scripts/build-desktop-icon.mjs"], { stdio: "inherit" });
}

export async function developmentExecutable(options) {
  ensureDesktopIcon();
  return brandExecutable(options);
}
