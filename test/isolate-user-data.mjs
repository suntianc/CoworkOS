import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded before each test worker: changing defaults must never read or write a real user's home.
const home = mkdtempSync(join(tmpdir(), "atria-test-home-"));
for (const key of Object.keys(process.env))
  if (/^(?:COWORK_|ATRIA_|PI_|SERPER_)/.test(key) && key !== "ATRIA_TEST_CLI_ENTRY") delete process.env[key];
process.env.ATRIA_HOME = home;
process.env.COWORK_CONFIG = join(home, "config.json");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
writeFileSync(process.env.COWORK_CONFIG, "{}\n", { mode: 0o600 });
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
