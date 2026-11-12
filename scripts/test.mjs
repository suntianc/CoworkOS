import { spawn } from "node:child_process";
import { closeTestRun, openTestRun } from "./test-run-root.mjs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const help = `Deterministic Node tests: npm run test:unit -- [options]
  --list             Show selected files and deferred native work; no build
  --match TEXT       Select file paths containing TEXT (case sensitive)
  --file PATH        Select an exact source test path; repeat for multiple files
  --skip-build       Reuse a previous complete build (explicitly reported)
  --concurrency N    Parallel Node files, default 4
No selection runs all tests. Native windows use npm run test:release -- --native.
Browser, release-runner, real model and package-install checks are separate.`;

export function parseTestOptions(args) {
  const options = { build: false, skipBuild: false, list: false, files: [], concurrency: 4 };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--build") options.build = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--file") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--file requires a source test path");
      options.files.push(value.replaceAll("\\", "/").replace(/^\.\//, ""));
    } else if (argument === "--match") {
      if (options.match !== undefined) throw new Error("--match may only be used once");
      options.match = args[++index];
      if (!options.match || options.match.startsWith("--"))
        throw new Error("--match requires non-empty text");
    } else if (argument === "--concurrency") {
      options.concurrency = Number(args[++index]);
      if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
        throw new Error("--concurrency requires a positive integer");
    } else throw new Error(`Unknown test option: ${argument}`);
  }
  if (options.files.length && options.match !== undefined) throw new Error("Choose either --file or --match");
  options.files = [...new Set(options.files)];
  return options;
}

export async function discoverNodeTests(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      // The separately invoked release harness validates its own execution/reporting contract.
      if (entry.isDirectory() && file !== "test/release") await visit(file);
      else if (entry.isFile() && /\.test\.(?:js|mjs|ts)$/.test(entry.name)) files.push(file);
    }
  }
  await visit("test");
  return files.sort();
}

export async function createTestPlan(root, options) {
  const files = await discoverNodeTests(root);
  const catalog = JSON.parse(await readFile(resolve(root, "test/release/catalog.json"), "utf8"));
  const nativeFiles = new Set(catalog.nativeNode);
  const unknown = options.files.filter((file) => !files.includes(file));
  if (unknown.length) throw new Error(`Unknown source test file: ${unknown.join(", ")}`);
  const selected = files.filter((file) =>
    options.files.length ? options.files.includes(file) : options.match ? file.includes(options.match) : true
  );
  if (!selected.length) throw new Error("No test files matched; nothing was run");
  const deferred = selected.filter((file) => nativeFiles.has(file));
  if (options.files.length && deferred.length)
    throw new Error(`${deferred.join(", ")} requires npm run test:release -- --native`);
  const eligible = selected.filter((file) => !nativeFiles.has(file));
  if (!eligible.length) throw new Error("Selection contains only native tests; use test:release -- --native");
  const compiled = eligible.filter((file) => file.endsWith(".ts"));
  const node = eligible.filter((file) => !file.endsWith(".ts"));
  const env = Object.fromEntries(
    (catalog.nativeVariants ?? [])
      .filter((variant) => variant.kind === "node" && variant.enableEnv)
      .map((variant) => [variant.enableEnv, "0"])
  );
  const deferredVariants = (catalog.nativeVariants ?? []).filter(
    (variant) => variant.kind === "node" && eligible.includes(variant.file)
  );
  return {
    selected: eligible,
    deferred,
    deferredVariants,
    env,
    commands: [
      ...compiled.map((file) => [file.replace(/^test\//, "dist/test/").replace(/\.ts$/, ".js")]),
      ...(node.length
        ? [["--test", "--test-reporter=tap", `--test-concurrency=${options.concurrency}`, ...node]]
        : [])
    ]
  };
}

export async function runCommand(command, args, { root = repositoryRoot, env = {} } = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  const onInterrupt = () => child.kill("SIGINT");
  const onTerminate = () => child.kill("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    return await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseTestOptions(args);
  if (options.help) return console.log(help);
  const plan = await createTestPlan(repositoryRoot, options);
  console.log(
    `Selected ${plan.selected.length} Node test files${options.files.length || options.match ? " (focused run)" : " (full deterministic suite)"}.`
  );
  for (const file of plan.deferred)
    console.log(`Deferred native file: ${file} (requires --native release run)`);
  for (const variant of plan.deferredVariants)
    console.log(
      `Deferred native variant: ${variant.file} / ${variant.pattern} (requires --native release run)`
    );
  if (options.list) {
    for (const file of plan.selected) console.log(file);
    return 0;
  }
  if (options.build && !options.skipBuild) {
    const code = await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:full"]);
    if (code !== 0) return code;
  } else console.log("Using existing build; ensure it matches the current sources.");
  // Each run owns its temporary directories; a backend left running fails it (#35).
  const runRoot = await openTestRun();
  let code = 0;
  try {
    for (const command of plan.commands) {
      code = await runCommand(process.execPath, ["--import", "./test/isolate-user-data.mjs", ...command], {
        env: { ...plan.env, TMPDIR: runRoot }
      });
      if (code !== 0) break;
    }
  } finally {
    const leaked = await closeTestRun(runRoot);
    if (leaked.length && code === 0) code = 1;
  }
  if (code !== 0) return code;
  console.log(
    "Node suite passed. Review TAP skipped/todo counts; native, browser and release evidence are separate."
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
