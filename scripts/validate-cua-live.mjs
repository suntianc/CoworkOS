import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function options(args) {
  const value = { run: false, timeoutMs: 300_000 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run") value.run = true;
    else if (arg === "--help") value.help = true;
    else if (arg === "--evidence-dir" && args[index + 1]) value.evidenceDir = resolve(args[++index]);
    else if (arg === "--timeout-ms" && args[index + 1]) value.timeoutMs = Number(args[++index]);
    else throw new Error("invalid_arguments");
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 10_000 || value.timeoutMs > 600_000)
    throw new Error("invalid_timeout");
  return value;
}

function within(base, path) {
  const value = relative(base, path);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith("../"));
}

function prompt(url) {
  return `Run this isolated Browser Use acceptance task yourself, using the current multimodal model. Do not delegate or use native desktop control.
Open ${url} in Task-owned Chromium. The page has a pixel-only six-digit challenge, two forms with duplicate labels/buttons, and a downloadable receipt.
Required workflow:
1. Load the cua skill and enable browser and cua. Open the page in cua_script and save its Tab as state.tab. Return the actual imageRef so the screenshot is visible.
2. Call crop_image on that screenshot's imageRef, cropping the canvas containing the small digits, with scale=3. Read the enlarged pixels yourself. Never read source files, network responses, pixels via code, or the challenge image through bash/Python/HTTP. The answer is not supplied in this prompt.
3. In a later cua_script reuse state.tab. Scope duplicate controls to the region named Receipt form, e.g. const form=state.tab.getByRole("region",{name:"Receipt form"}); await form.getByLabel("Verification code").fill("THE_DIGITS_YOU_READ",{observation:"none"}); await form.getByLabel("Memo").fill("CoworkOS browser verification",{observation:"none"}); await form.getByRole("button",{name:"Save"}).click({observation:"aria"}); Then wait for the exact text Saved and verified using waitFor({timeoutMs:5000,observation:"aria"}). Return the actual wait status and observation metadata. This cell must contain multiple awaited Browser actions.
4. Download the saved receipt with a scripted scoped link click and expectDownload:true; return the real download metadata. Use the ordinary file-reading tool to read that downloaded Task file and check its JSON contents. Do not create or edit a replacement receipt. Do not submit again after success. If a result is uncertain, observe first. The fixture allows at most three attempts for visual reading errors.
5. Finally call browser_observe with observation:"aria" on the same page to check the business status. Update your normal task memory with confirmed/unknown outcome and the actual download evidence, then finish with a brief result.
All state is disposable and belongs to this acceptance task. Do not inspect user configuration, credentials, other tasks, the local validation runner, or fixture files. Operate only the supplied loopback web page and its downloaded Task receipt. If a tool fails, preserve its actual failure and recover by observing; never claim a check passed merely because input was sent.`;
}

function traceFacts(events) {
  const ended = events.filter((event) => event.type === "tool_execution_end");
  const starts = new Map(
    events.filter((event) => event.type === "tool_execution_start").map((event) => [event.toolCallId, event])
  );
  const scripts = ended.filter((event) => event.toolName === "cua_script" && !event.isError);
  const mutations = scripts
    .flatMap((event) => event.result?.details?.calls ?? [])
    .filter((call) => call.toolName === "browser_act" && call.status === "completed");
  return {
    toolCalls: ended.length,
    toolErrors: ended.filter((event) => event.isError).length,
    scriptCells: scripts.length,
    batchedScript: scripts.some(
      (event) =>
        (event.result?.details?.calls ?? []).filter(
          (call) => call.toolName === "browser_act" && call.status === "completed"
        ).length >= 2
    ),
    scopedScript: scripts.some(
      (event) =>
        /Receipt form/.test(starts.get(event.toolCallId)?.args?.code ?? "") &&
        /getByRole\s*\(\s*["']region|scope\s*:/.test(starts.get(event.toolCallId)?.args?.code ?? "")
    ),
    browserActions: mutations.length,
    cheapActionsWithoutScreenshot: mutations.filter((call) => !call.imageRef).length,
    cropZoom: ended.some(
      (event) =>
        event.toolName === "crop_image" && !event.isError && event.result?.details?.mapping?.scaleX >= 2
    ),
    finalAriaObservation: ended.some(
      (event) =>
        event.toolName === "browser_observe" &&
        !event.isError &&
        starts.get(event.toolCallId)?.args?.observation === "aria" &&
        event.result?.details?.observationStatus === "captured"
    )
  };
}

export async function validateCuaLive(args = process.argv.slice(2)) {
  const opts = options(args);
  if (opts.help || !opts.run) {
    console.log(
      "Opt-in real-model Browser Use acceptance. No model request without --run.\nUsage: node scripts/validate-cua-live.mjs --run --evidence-dir <directory outside repository> [--timeout-ms 300000]"
    );
    return;
  }
  const evidenceDir = opts.evidenceDir ?? join(tmpdir(), "atria-cua-live-receipts");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  if (within(await realpath(root), await realpath(evidenceDir)))
    throw new Error("evidence_directory_must_be_outside_repository");
  const id = randomUUID();
  const diagnostics = await mkdtemp(join(tmpdir(), `atria-cua-live-${id}-`));
  const deadline = Date.now() + opts.timeoutMs;
  const receipt = { version: 1, validationId: id, startedAt: new Date().toISOString(), passed: false };
  let storage, backend, fixture, taskId;
  let phase = "prerequisites";
  const remaining = () => Math.max(1, deadline - Date.now());
  const bounded = async (operation) => {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_done, reject) => {
          timer = setTimeout(() => reject(new Error("deadline_exceeded")), remaining());
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const electron = require("electron");
    await access(electron);
    const { chromium } = await import("playwright-core");
    await access(chromium.executablePath());
    const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
    const { atriaHome } = require("./data-home.cjs");
    const { createRetryableStorage } = require("../desktop/retryable-storage.cjs");
    const { createModelSettings } = require("../desktop/model-settings.cjs");
    const { startBackend } = require("../desktop/backend.cjs");
    const { selectedConnection } = await import("../dist/src/runtime/model-connections.js");
    const { connectionProfile } = await import("../dist/src/runtime/model-profile.js");
    phase = "default_model_keychain";
    storage = createRetryableStorage({
      executable: electron,
      args: [root],
      timeout: Math.min(60_000, remaining())
    });
    // Production settings reader and Electron Safe Storage worker only. No direct secret-file reads or copies.
    const originalPaths = desktopPaths(root, process.env.COWORK_DESKTOP_DATA || atriaHome(), process.env);
    const settings = await bounded(createModelSettings(originalPaths, storage).read());
    const selected = selectedConnection(settings, {}) ?? settings;
    if (typeof selected.model === "string") receipt.model = selected.model;
    if (!selected.model || !selected.baseUrl || !selected.apiKey)
      throw new Error("default_model_unavailable");
    if (selected.supportsImages !== true) throw new Error("default_model_not_multimodal");
    const connection = {
      ...connectionProfile(selected),
      model: selected.model,
      baseUrl: selected.baseUrl,
      apiKey: selected.apiKey,
      supportsImages: true
    };
    phase = "isolated_backend";
    const paths = desktopPaths(root, join(diagnostics, "data"), {});
    const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await prepareDesktopData(paths, packageInfo.version);
    // Persist only non-secret runtime settings. The production host passes the selected key in memory to its own backend.
    const publicConnection = {
      ...connectionProfile(selected),
      model: selected.model,
      baseUrl: selected.baseUrl,
      supportsImages: true
    };
    await writeFile(
      paths.configPath,
      JSON.stringify({
        ...publicConnection,
        mainTimeoutMs: Math.min(240_000, remaining()),
        mainMaxTurns: 40,
        webTools: false
      }) + "\n",
      { mode: 0o600 }
    );
    const inherited = { ...process.env };
    try {
      for (const key of Object.keys(process.env))
        if (
          /^(?:COWORK_|PI_|ATRIA_|SERPER_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/.test(key) ||
          /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)
        )
          delete process.env[key];
      process.env.COWORK_BROWSER_EXECUTABLE = chromium.executablePath();
      process.env.COWORK_DISABLE_WATCH_SUPERVISOR = "1";
      process.env.PI_OFFLINE = "1";
      backend = await bounded(startBackend(paths, connection, process.execPath));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key];
      Object.assign(process.env, inherited);
    }
    const api = async (path, body) => {
      const response = await fetch(`${backend.url}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", "x-atria-token": backend.token },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(Math.min(10_000, remaining()))
      });
      if (!response.ok) throw new Error("isolated_api_failed");
      return response.json();
    };
    const { cuaLiveFixture } = await import("../test/cua-live-fixture.mjs");
    fixture = await cuaLiveFixture();
    taskId = `cua-live-${id}`;
    await api("/api/tasks", { taskId, goal: "Isolated visual Browser Use acceptance" });
    const run = await api(`/api/tasks/${taskId}/run`, { prompt: prompt(fixture.url) });
    phase = "model_browser_task";
    let detail;
    while (Date.now() < deadline) {
      detail = await api(`/api/tasks/${taskId}`);
      if (!detail.runtime.active) break;
      await wait(Math.min(1000, remaining()));
    }
    if (!detail || detail.runtime.active) throw new Error("deadline_exceeded");
    receipt.taskCompleted = detail.task.status === "completed";
    phase = "independent_outcome_checks";
    const outputPath = join(paths.workspaceRoot, taskId, "runs", run.runId, "runtime-output.log");
    if ((await stat(outputPath)).size > 256 * 1024 * 1024) throw new Error("trace_too_large");
    const events = (await readFile(outputPath, "utf8")).split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line)];
        // eslint-disable-next-line no-restricted-syntax -- 运行日志里混有非 JSON 行，解析失败的行不进事件统计
      } catch {
        return [];
      }
    });
    Object.assign(receipt, traceFacts(events), fixture.summary());
    const downloads = join(paths.workspaceRoot, taskId, "visual", "downloads");
    // eslint-disable-next-line no-restricted-syntax -- 任务没有下载目录时按 0 个文件记账，receipt 的 downloads 断言据此判定失败
    const files = await readdir(downloads).catch(() => []);
    receipt.downloadFiles = files.length;
    const actual = files.length === 1 ? await readFile(join(downloads, files[0])) : undefined;
    const expected = fixture.receipt();
    receipt.downloadMatches = Boolean(actual && expected && actual.equals(expected));
    if (actual) {
      receipt.downloadBytes = actual.length;
      receipt.downloadSha256 = createHash("sha256").update(actual).digest("hex");
    }
    receipt.passed = Boolean(
      receipt.taskCompleted &&
      receipt.cropZoom &&
      receipt.scriptCells >= 2 &&
      receipt.batchedScript &&
      receipt.scopedScript &&
      receipt.cheapActionsWithoutScreenshot >= 2 &&
      receipt.finalAriaObservation &&
      receipt.accepted === 1 &&
      receipt.attempts <= 3 &&
      receipt.duplicateSubmissions === 0 &&
      receipt.decoySubmissions === 0 &&
      receipt.downloads === 1 &&
      receipt.downloadMatches
    );
    if (!receipt.passed) receipt.failurePhase = phase;
  } catch (error) {
    receipt.failurePhase = phase;
    receipt.failureCode = [
      "deadline_exceeded",
      "default_model_unavailable",
      "default_model_not_multimodal"
    ].includes(error.message)
      ? error.message
      : "validation_unavailable_or_failed";
    if (fixture) Object.assign(receipt, fixture.summary());
  } finally {
    if (backend && taskId && !receipt.taskCompleted)
      await fetch(`${backend.url}/api/tasks/${taskId}/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atria-token": backend.token },
        body: JSON.stringify({ action: "cancel" }),
        signal: AbortSignal.timeout(5000)
        // eslint-disable-next-line no-restricted-syntax -- 取消请求失败已被 receipt 的失败字段记账，清理阶段不再抛错
      }).catch(() => {});
    await backend?.stop();
    await fixture?.close();
    await storage?.close();
    receipt.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceDir, `${id}.json`), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx"
    });
  }
  // Only allowlisted counts, hashes and booleans leave the process; raw model output stays in our isolated diagnostics.
  console.log(JSON.stringify(receipt));
  if (!receipt.passed) process.exitCode = 1;
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  // eslint-disable-next-line no-restricted-syntax -- 入口失败已经打印原因并设置退出码 1，不再需要向上抛异常
  validateCuaLive().catch(() => {
    console.error("CUA live validation could not start; check arguments and prerequisites.");
    process.exitCode = 1;
  });
