import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { discoverNodeTests } from "./test.mjs";

export const stageIds = ["basic", "cli", "app", "applications", "cases"];

export function parseOptions(args) {
  const options = {
    stages: [...stageIds],
    list: false,
    native: false,
    packages: false,
    skipBuild: false,
    strict: false,
    timeoutSeconds: 1800
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") options.list = true;
    else if (arg === "--native") options.native = true;
    else if (arg === "--packages") options.packages = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--stage") {
      const value = args[++i];
      options.stages = value?.split(",");
      if (!options.stages?.length || options.stages.some((id) => !stageIds.includes(id)))
        throw new Error("--stage 必须为 basic,cli,app,applications,cases 的一个或多个值");
      options.stages = stageIds.filter((id) => options.stages.includes(id));
    } else if (arg === "--timeout-seconds") {
      options.timeoutSeconds = Number(args[++i]);
      if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1)
        throw new Error("--timeout-seconds 必须为正整数");
    } else throw new Error(`未知选项：${arg}`);
  }
  return options;
}

export function classify(file, kind, catalog) {
  const name = basename(file);
  return (
    catalog.rules.find((rule) => rule[kind] && new RegExp(rule[kind]).test(name))?.stage ??
    (kind === "node" ? "basic" : "app")
  );
}

export function parseTap(text) {
  const stats = {};
  for (const match of text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm))
    stats[match[1]] = Number(match[2]);
  return stats.tests > 0 ? stats : null;
}

export function stepStatus(exitCode, stats, interrupted = false, timedOut = false) {
  if (interrupted) return "interrupted";
  if (timedOut) return "timed_out";
  if (exitCode !== 0 || (stats && (stats.fail > 0 || stats.cancelled > 0 || stats.flaky > 0)))
    return "failed";
  if (!stats) return "unverified";
  return stats.skipped > 0 || stats.todo > 0 ? "passed_with_skips" : "passed";
}

export function automationOutcome(steps, selectedStages, completedStages) {
  if (steps.some((step) => step.status === "interrupted")) return "interrupted";
  if (steps.some((step) => ["failed", "timed_out", "unverified", "blocked"].includes(step.status)))
    return "failed";
  if (selectedStages.some((id) => !completedStages.includes(id))) return "incomplete";
  return steps.some((step) => step.status === "passed_with_skips") ? "passed_with_skips" : "passed";
}

export async function loadPlan(root, options, platform = process.platform) {
  const catalog = JSON.parse(await readFile(join(root, "test/release/catalog.json"), "utf8"));
  if (JSON.stringify(catalog.stages.map((stage) => stage.id)) !== JSON.stringify(stageIds))
    throw new Error("发布目录必须保留五个环节");
  for (const rule of catalog.rules) {
    if (!stageIds.includes(rule.stage)) throw new Error(`未知目录环节：${rule.stage}`);
    for (const kind of ["node", "browser"]) if (rule[kind]) new RegExp(rule[kind]);
  }
  const nodeFiles = await discoverNodeTests(root);
  const browserFiles = (await readdir(join(root, "e2e")))
    .filter((name) => name.endsWith(".spec.js"))
    .sort()
    .map((name) => `e2e/${name}`);
  const knownFiles = new Set([...nodeFiles, ...browserFiles]);
  const nativeEnabled = options.native && platform === "darwin";
  const nativeVariants = catalog.nativeVariants ?? [];
  for (const variant of nativeVariants) {
    if (!knownFiles.has(variant.file) || !["node", "browser"].includes(variant.kind))
      throw new Error(`未知原生变体：${variant.file}`);
    new RegExp(variant.pattern);
  }
  const deferredVariants = nativeEnabled
    ? []
    : nativeVariants.map((variant) => ({
        ...variant,
        stage: classify(variant.file, variant.kind, catalog),
        reason: options.native ? "requires_macos" : "requires_native_flag"
      }));
  const requirements = [];
  for (const [document, child] of [
    ["docs/testing-case-catalog.md", false],
    ["docs/testing-application-release.md", true]
  ]) {
    const content = await readFile(join(root, document), "utf8");
    const pattern = child ? /^\|\s*([A-Z][A-Z-]*-\d+\/[a-z-]+)\s*\|/gm : /^\|\s*([A-Z][A-Z-]*-\d+)\s*\|/gm;
    for (const match of content.matchAll(pattern)) {
      if (requirements.some((requirement) => requirement.id === match[1]))
        throw new Error(`重复用例：${match[1]}`);
      requirements.push({ id: match[1], document, coverage: "planned", anchors: [] });
    }
  }
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  for (const anchor of catalog.anchors) {
    for (const id of anchor.cases) if (!requirementIds.has(id)) throw new Error(`映射不存在的用例：${id}`);
    for (const file of anchor.files) if (!knownFiles.has(file)) throw new Error(`映射不存在的测试：${file}`);
  }
  for (const requirement of requirements) {
    const parent = requirement.id.split("/")[0];
    if (!requirementIds.has(parent)) throw new Error(`子项没有父用例：${requirement.id}`);
    requirement.anchors = catalog.anchors
      .filter((anchor) => anchor.cases.includes(parent))
      .flatMap((anchor) => anchor.files);
    requirement.anchors = [...new Set(requirement.anchors)];
    if (requirement.anchors.length) requirement.coverage = "partial_mapping";
  }
  const deferred = [];
  function eligible(file, kind) {
    const native =
      kind === "node"
        ? catalog.nativeNode.includes(file)
        : new RegExp(catalog.nativeBrowserPattern).test(basename(file));
    if (!native || (options.native && platform === "darwin")) return true;
    deferred.push({
      file,
      stage: classify(file, kind, catalog),
      reason: options.native ? "requires_macos" : "requires_native_flag"
    });
    return false;
  }
  const groups = catalog.stages.map((stage) => ({
    ...stage,
    node: nodeFiles.filter((file) => classify(file, "node", catalog) === stage.id && eligible(file, "node")),
    browser: browserFiles.filter(
      (file) => classify(file, "browser", catalog) === stage.id && eligible(file, "browser")
    )
  }));
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  const steps = [];
  if (!options.skipBuild)
    steps.push({ id: "build", stage: "setup", kind: "command", command: npm, args: ["run", "build:full"] });
  if (options.stages.includes("basic")) {
    for (const script of ["lint", "check:extensions", "format:check", "check:docs"])
      steps.push({
        id: script.replace(":", "-"),
        stage: "basic",
        kind: "command",
        command: npm,
        args: ["run", script]
      });
    steps.push({
      id: "release-runner",
      stage: "basic",
      kind: "node",
      command: process.execPath,
      args: ["--test", "--test-reporter=tap", "test/release/runner.test.mjs"]
    });
  }
  for (const group of groups.filter((stage) => options.stages.includes(stage.id))) {
    const env = Object.fromEntries(
      nativeVariants
        .filter(
          (variant) => variant.kind === "node" && variant.enableEnv && group.node.includes(variant.file)
        )
        .map((variant) => [variant.enableEnv, nativeEnabled ? "1" : "0"])
    );
    for (const file of group.node.filter((file) => file.endsWith(".ts")))
      steps.push({
        id:
          /^test\/(p[012])\.test\.ts$/.exec(file)?.[1] ?? `${group.id}-compiled-${encodeURIComponent(file)}`,
        stage: group.id,
        kind: "node",
        command: process.execPath,
        env,
        args: ["--test", "--test-reporter=tap", file.replace(/^test\//, "dist/test/").replace(/\.ts$/, ".js")]
      });
    const sourceTests = group.node.filter((file) => !file.endsWith(".ts"));
    if (sourceTests.length)
      steps.push({
        id: `${group.id}-node`,
        stage: group.id,
        kind: "node",
        command: process.execPath,
        env,
        args: ["--test", "--test-reporter=tap", "--test-concurrency=4", ...sourceTests]
      });
    if (group.browser.length)
      steps.push({
        id: `${group.id}-browser`,
        stage: group.id,
        kind: "browser",
        command: process.execPath,
        args: [
          "node_modules/@playwright/test/cli.js",
          "test",
          "--reporter=list,json",
          ...(options.native ? ["--workers=1"] : []),
          ...(!nativeEnabled &&
          nativeVariants.some((variant) => variant.kind === "browser" && group.browser.includes(variant.file))
            ? [
                "--grep-invert",
                nativeVariants
                  .filter((variant) => variant.kind === "browser" && group.browser.includes(variant.file))
                  .map((variant) => `(?:${variant.pattern})`)
                  .join("|")
              ]
            : []),
          ...group.browser
        ]
      });
  }
  if (options.packages) {
    if (options.stages.includes("cli"))
      steps.push({
        id: "cli-package",
        stage: "cli",
        kind: "command",
        command: npm,
        args: ["run", "cli:pack"]
      });
    if (options.stages.includes("app")) {
      if (platform === "darwin")
        steps.push({
          id: "app-package",
          stage: "app",
          kind: "command",
          command: npm,
          args: ["run", "desktop:dist"]
        });
      else deferred.push({ file: "final-mac-package", stage: "app", reason: "requires_macos" });
    }
  }
  return {
    options,
    groups,
    steps,
    requirements,
    deferred: deferred.filter((item) => options.stages.includes(item.stage)),
    deferredVariants: deferredVariants.filter((item) => options.stages.includes(item.stage)),
    manual: catalog.manual
      .filter((item) => options.stages.includes(item.stage))
      .map((item) => ({ ...item, status: "pending" }))
  };
}
