import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot, runCommand } from "./test.mjs";

export const verificationScripts = [
  "build:cli",
  "build:web-assets",
  "lint",
  "check:workbench",
  "check:extensions",
  "format:check",
  "check:docs",
  "check:source"
];

export const fullVerificationScripts = ["build:full", ...verificationScripts.slice(2), "test:release:runner"];

export async function verify(args = process.argv.slice(2), run = runCommand) {
  if (args.some((argument) => !["--full", "--list", "--help", "-h"].includes(argument)))
    throw new Error("verify accepts --full, --list or --help; use test:unit for focused checks");
  const full = args.includes("--full");
  const scripts = full ? fullVerificationScripts : verificationScripts;
  const steps = [
    ...scripts.map((script) => ({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", script]
    })),
    ...(full ? [{ command: process.execPath, args: ["scripts/test.mjs"] }] : [])
  ];
  if (args.some((argument) => ["--list", "--help", "-h"].includes(argument))) {
    console.log(
      full
        ? "Full verification builds all assets once, runs static checks, release-runner self-tests and all deterministic Node tests."
        : "Quick verification builds the CLI and web assets, then runs static checks. Run focused tests for changed behavior; use npm run verify:full for the full suite."
    );
    for (const step of steps) console.log(`${step.command} ${step.args.join(" ")}`);
    console.log(
      "Browser, native windows, real model calls and release/install evidence use explicit separate commands."
    );
    return 0;
  }
  for (const step of steps) {
    console.log(`\nVerify: ${step.command} ${step.args.join(" ")}`);
    const code = await run(step.command, step.args, { root: repositoryRoot });
    if (code !== 0) return code;
  }
  console.log(
    full
      ? "\nFull verification passed. Review skipped Node checks and run the relevant browser/native/release layer."
      : "\nQuick verification passed. Behavioral tests were not run; run focused tests for changed behavior."
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  verify()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
