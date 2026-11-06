import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createBuiltinTools } from "../tools/builtin.js";
import { RunService } from "../runtime/run-service.js";
import { readHostCoworkConfig } from "../runtime/config.js";
import {
  configuredModelApi,
  configuredContextWindow,
  configuredThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsImages,
  runtimeSettingsEnv
} from "../runtime/runtime-settings.js";

const config = readHostCoworkConfig();
const runtimeEnv = runtimeSettingsEnv(config);
const apiKey = process.env.COWORK_API_KEY ?? config.apiKey;
const baseUrl = process.env.COWORK_API_BASE ?? config.baseUrl ?? config.apiBase;
if (!apiKey || !baseUrl)
  throw new Error("Set COWORK_API_BASE and COWORK_API_KEY before running smoke:coding");

const parent = process.env.COWORK_WORKSPACE ?? tmpdir();
await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, "cowork-coding-smoke-"));
const started = Date.now();
const model = process.env.COWORK_MODEL ?? config.model ?? "glm-5.3";
const testSource = [
  "import assert from 'node:assert/strict';",
  "import { answer } from './calc.mjs';",
  "assert.equal(answer(), 2);",
  "console.log('coding smoke test passed');"
].join("\n");
let succeeded = false;
try {
  const service = new RunService(workspace);
  const result = await service.runPi({
    taskId: "coding-smoke",
    runId: "run-1",
    agentId: "main",
    baseUrl,
    apiKey,
    model,
    thinkingLevel: configuredReasoningEffort(runtimeEnv),
    api: configuredModelApi(runtimeEnv),
    thinkingFormat: configuredThinkingFormat(runtimeEnv),
    supportsReasoningEffort: configuredSupportsReasoningEffort(runtimeEnv),
    supportsImages: configuredSupportsImages(runtimeEnv),
    tools: (workingDirectory, workspaceDirectory, artifactDirectory) =>
      createBuiltinTools({ rootDirectory: workingDirectory, workspaceDirectory, artifactDirectory }),
    maxTurns: 8,
    maxTokens: 2048,
    contextWindow: configuredContextWindow(runtimeEnv),
    maxErrorRetries: 0,
    timeoutMs: 120_000,
    prepare: async (workingDirectory) => {
      await writeFile(join(workingDirectory, "calc.mjs"), "export function answer() { return 1; }\n");
      await writeFile(join(workingDirectory, "calc.test.mjs"), testSource);
    },
    prompt: [
      "Modify calc.mjs so answer() returns 2.",
      'Use read_file first, then apply_patch, then run the test with run_tests using command node and args ["calc.test.mjs"].',
      "Do not just explain; actually perform the edits and test."
    ].join("\n")
  });
  const source = await readFile(join(result.workingDirectory, "calc.mjs"), "utf8");
  if ((await readFile(join(result.workingDirectory, "calc.test.mjs"), "utf8")) !== testSource)
    throw new Error("Agent changed the verification test");
  const toolResults = result.messages.filter((message) => message.role === "toolResult");
  for (const name of ["read_file", "apply_patch", "run_tests"]) {
    if (!toolResults.some((message) => message.toolName === name && !message.isError))
      throw new Error(`Agent did not successfully execute ${name}`);
  }
  const verified = await promisify(execFile)(process.execPath, ["calc.test.mjs"], {
    cwd: result.workingDirectory,
    timeout: 5000
  });
  if (!verified.stdout.includes("coding smoke test passed"))
    throw new Error("Edited code did not pass independent verification");
  console.log(
    JSON.stringify({
      ok: true,
      model,
      elapsedMs: Date.now() - started,
      messages: result.messages.length,
      tools: toolResults.map((message) => message.toolName),
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      independentlyVerified: true,
      stopReason: result.assistant?.stopReason
    })
  );
  succeeded = true;
} catch (error) {
  const path = join(workspace, "coding-smoke", "runs", "run-1", "agents", "main", "result.json");
  let diagnostics: {
    termination?: string;
    stopReason?: string;
    error?: string;
    messages?: Array<{
      role?: string;
      stopReason?: string;
      errorMessage?: string;
      toolName?: string;
      usage?: unknown;
    }>;
  } = {};
  try {
    diagnostics = JSON.parse(await readFile(path, "utf8"));
  } catch {
    /* Startup can fail before a model request exists. */
  }
  const latest = [...(diagnostics.messages ?? [])].reverse().find((message) => message.role === "assistant");
  console.error(
    JSON.stringify({
      ok: false,
      model,
      elapsedMs: Date.now() - started,
      workspace,
      termination: diagnostics.termination,
      stopReason: latest?.stopReason ?? diagnostics.stopReason,
      usage: latest?.usage,
      tools: diagnostics.messages
        ?.filter((message) => message.role === "toolResult")
        .map((message) => message.toolName),
      error:
        latest?.errorMessage ?? diagnostics.error ?? (error instanceof Error ? error.message : String(error))
    }).replaceAll(apiKey, "[redacted]")
  );
  process.exitCode = 1;
} finally {
  if (succeeded) await rm(workspace, { recursive: true, force: true });
}
