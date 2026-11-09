import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { parseOptions, loadPlan, parseTap, stepStatus, automationOutcome } from "./release-test-plan.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const help = `本地发布验收：npm run test:release -- [选项]
  --list                    查看分组和未自动执行项，不构建、不写报告
  --stage basic,cli,app,applications,cases  选择环节，默认全部
  --native                  Mac 上加入真实 Electron/Computer Use 测试，串行浏览器
  --packages                构建 CLI tgz/Mac DMG；最终安装仍需人工验收
  --skip-build              调试已有构建，报告记录跳过构建
  --timeout-seconds N        每一步超时，默认 1800 秒
  --strict                  未完成全部发布证据时返回 2
默认复用确定性测试，不自动调用收费模型、不授予系统权限、不触发 GitHub CI。`;

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    // eslint-disable-next-line no-restricted-syntax -- 发布验收可在没有 Git 元数据的源码归档里运行，取不到信息按 null 记录
  } catch {
    return null;
  }
}

async function sourceStamp() {
  const hash = createHash("sha256");
  const tracked = git(["ls-files", "-z"])?.split("\0").filter(Boolean) ?? [];
  // Include source-like new files without reading live task data or private config.
  const extras =
    git(["ls-files", "--others", "--exclude-standard", "-z"])
      ?.split("\0")
      .filter((file) => /^(src|scripts|desktop|web|test|e2e|docs|\.pi)\//.test(file)) ?? [];
  for (const file of [...new Set([...tracked, ...extras])].sort()) {
    hash.update(file);
    try {
      hash.update(await readFile(join(root, file)));
      // eslint-disable-next-line no-restricted-syntax -- 已跟踪但磁盘上缺失的文件用固定标记参与摘要，不能让报告生成中断
    } catch {
      hash.update("<missing>");
    }
  }
  return {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    dirty: !!git(["status", "--porcelain", "--untracked-files=no"]) || extras.length > 0,
    digest: hash.digest("hex")
  };
}

function showPlan(plan) {
  for (const stage of plan.groups.filter((group) => plan.options.stages.includes(group.id)))
    console.log(`${stage.name}：${stage.node.length} 个 Node 文件，${stage.browser.length} 个浏览器文件`);
  console.log(
    `规划：${plan.requirements.filter((item) => !item.id.includes("/")).length} 个父用例，${plan.requirements.filter((item) => item.id.includes("/")).length} 个软件子项。文件映射只表示部分覆盖线索。`
  );
  for (const step of plan.steps) console.log(`  ${step.stage} / ${step.id} (${step.kind})`);
  for (const item of plan.deferred) console.log(`未自动执行：${item.file} (${item.reason})`);
  for (const item of plan.deferredVariants)
    console.log(`未自动执行变体：${item.file} / ${item.pattern} (${item.reason})`);
  for (const item of plan.manual) console.log(`人工待验：${item.description}`);
}

async function runStep(step, directory, options) {
  const logFile = join(directory, `${step.id}.log`),
    jsonFile = join(directory, `${step.id}.json`);
  const testArtifactsDirectory =
    step.kind === "browser" ? join(directory, `${step.id}-artifacts`) : undefined;
  const args = testArtifactsDirectory ? [...step.args, "--output", testArtifactsDirectory] : step.args;
  const log = createWriteStream(logFile, { flags: "wx" });
  let child,
    interrupted = false,
    timedOut = false,
    killTimer;
  const started = Date.now();
  const terminate = () => {
    if (!child || child.exitCode !== null) return;
    const signal = (value) => {
      try {
        if (process.platform === "win32") child.kill(value);
        else process.kill(-child.pid, value);
        // eslint-disable-next-line no-restricted-syntax -- 终止子进程时它可能已经退出，kill 失败不影响超时终止流程
      } catch {}
    };
    signal("SIGTERM");
    killTimer ??= setTimeout(() => signal("SIGKILL"), 10_000);
  };
  const onInterrupt = () => {
    interrupted = true;
    terminate();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  let exitCode, error;
  try {
    child = spawn(step.command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...step.env,
        ...(step.kind === "browser" ? { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile } : {})
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ])
      stream.on("data", (chunk) => {
        log.write(chunk);
        destination.write(chunk);
      });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutSeconds * 1000);
    try {
      exitCode = await new Promise((done, fail) => {
        child.once("error", fail);
        child.once("close", (code) => done(code ?? 1));
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (cause) {
    exitCode = 1;
    error = cause.message;
    log.write(`${error}\n`);
  } finally {
    clearTimeout(killTimer);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    await new Promise((done, fail) => {
      log.once("error", fail);
      log.end(done);
    });
  }
  let stats = null;
  if (step.kind === "node") stats = parseTap(await readFile(logFile, "utf8"));
  else if (step.kind === "browser") {
    try {
      const result = JSON.parse(await readFile(jsonFile, "utf8"));
      stats = {
        tests: result.stats.expected + result.stats.unexpected + result.stats.flaky + result.stats.skipped,
        pass: result.stats.expected,
        fail: result.stats.unexpected,
        flaky: result.stats.flaky,
        skipped: result.stats.skipped
      };
      if (!stats.tests) stats = null;
      // eslint-disable-next-line no-restricted-syntax -- 浏览器步骤没有可解析的 JSON 报告时按 stats=null 处理，退出码仍是结论
    } catch {
      stats = null;
    }
  }
  // Build/check commands have no test summary; their exit code is their result.
  const status = stepStatus(
    exitCode,
    step.kind === "command" ? { tests: 1, fail: 0 } : stats,
    interrupted,
    timedOut
  );
  return {
    id: step.id,
    stage: step.stage,
    kind: step.kind,
    command: step.command,
    args,
    ...(testArtifactsDirectory ? { testArtifactsDirectory } : {}),
    status,
    exitCode,
    startedAt: new Date(started).toISOString(),
    elapsedSeconds: (Date.now() - started) / 1000,
    stats,
    logFile,
    ...(error ? { error } : {})
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  const plan = await loadPlan(root, options);
  showPlan(plan);
  if (options.list) return;
  const directory = join(
    root,
    ".tmp/release-tests",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  );
  await mkdir(directory, { recursive: true });
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    source: await sourceStamp(),
    options,
    automationOutcome: "running",
    releaseReadiness: "incomplete",
    steps: [],
    deferred: plan.deferred,
    deferredVariants: plan.deferredVariants,
    manual: plan.manual,
    requirements: plan.requirements,
    artifacts: []
  };
  const reportPath = join(directory, "report.json");
  const save = async () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await save();
  for (const step of plan.steps) {
    console.log(`\n开始 ${step.id}`);
    report.steps.push(await runStep(step, directory, options));
    await save();
    if (["failed", "timed_out", "unverified", "interrupted"].includes(report.steps.at(-1).status)) break;
  }
  const completedStages = options.stages.filter((stage) =>
    plan.steps
      .filter((step) => step.stage === stage)
      .every((step) =>
        report.steps.some(
          (result) => result.id === step.id && ["passed", "passed_with_skips"].includes(result.status)
        )
      )
  );
  report.automationOutcome = automationOutcome(report.steps, options.stages, completedStages);
  report.finishedAt = new Date().toISOString();
  report.sourceAfter = await sourceStamp();
  report.sourceChangedDuringRun = report.source.digest !== report.sourceAfter.digest;
  if (report.sourceChangedDuringRun && ["passed", "passed_with_skips"].includes(report.automationOutcome))
    report.automationOutcome = "incomplete";
  for (const step of report.steps.filter(
    (item) => item.id.endsWith("-package") && item.status === "passed"
  )) {
    // eslint-disable-next-line no-restricted-syntax -- 打包步骤可能没有产出 release 目录，按空文件列表继续生成报告
    const files = await readdir(join(root, "release")).catch(() => []);
    for (const file of files.filter((name) =>
      step.id === "cli-package" ? name.endsWith(".tgz") : name.endsWith(".dmg")
    )) {
      const path = join(root, "release", file);
      if ((await stat(path)).mtimeMs < Date.parse(step.startedAt)) continue;
      report.artifacts.push({
        path: `release/${file}`,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        validation: "built_not_install_verified"
      });
    }
  }
  await save();
  const summary = `# 本地发布验收结果\n\n工程结果：${report.automationOutcome}。发布验收：INCOMPLETE。\n\n源码：${report.source.commit}；工作区摘要：${report.source.digest}；运行中源码变化：${report.sourceChangedDuringRun}。\n\n| 步骤 | 状态 | 耗时（秒） | 跳过 |\n| --- | --- | --- | --- |\n${report.steps.map((step) => `| ${step.id} | ${step.status} | ${step.elapsedSeconds.toFixed(1)} | ${step.stats?.skipped ?? 0} |`).join("\n")}\n\n## 人工与未完成项\n\n${plan.manual.map((item) => `- [ ] ${item.id}：${item.description}（${item.document}）`).join("\n")}\n${[...plan.deferred, ...plan.deferredVariants].map((item) => `- [ ] ${item.file}${item.pattern ? ` / ${item.pattern}` : ""}：${item.reason}`).join("\n")}\n\n具体目录覆盖仍需核对，已有文件通过不能把规划项改为完整覆盖。真实模型、最终包安装、权限体验须按手册验收。日志仅保存在本地，分享前脱敏。\n`;
  await writeFile(join(directory, "summary.md"), summary);
  console.log(
    `\n工程结果：${report.automationOutcome}；发布验收：INCOMPLETE\n报告：${reportPath}\n人工清单：${join(directory, "summary.md")}`
  );
  process.exitCode =
    report.automationOutcome === "interrupted"
      ? 130
      : ["failed", "incomplete"].includes(report.automationOutcome)
        ? 1
        : options.strict
          ? 2
          : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
