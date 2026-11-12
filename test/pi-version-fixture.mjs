import { readFile } from "node:fs/promises";

/**
 * The installed Pi release, read straight from its manifest so a snapshot
 * fixture does not take the module under test as its own source of truth.
 */
export const installedPiVersion = JSON.parse(
  await readFile(
    new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
    "utf8"
  )
).version;
