import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedPiEnvironment, startLocalProvider } from "./fixtures/pi-process-fixture.mjs";

/**
 * Foreground command output in a delegated process.
 *
 * The in-process command runner is gone; a delegated agent runs commands
 * through Pi's own `bash`. This keeps the user-visible contract under test: a
 * successful command keeps exit 0 and its output in the result the model reads.
 */

const harness = resolve(".");
const TASK_ID = "p46-foreground-output";
const RUN_ID = "p46-foreground-run";
const AGENT_ID = "subagent_foreground";

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");

test(
  "a delegated foreground command keeps exit 0 and its output in the model-visible result",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p46-foreground-output-"));
    const workspace = join(root, "workspace");
    const site = join(root, "site");
    const runRoot = join(workspace, TASK_ID, "runs", RUN_ID);
    const resultPath = join(runRoot, "agents", "subagents", AGENT_ID, "result.json");
    await mkdir(site, { recursive: true });
    await mkdir(dirname(resultPath), { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));

    const provider = await startLocalProvider({
      handle: (body, requests) => {
        if (requests.length === 1)
          return { name: "bash", arguments: { command: "printf 'foreground-ok\\n'; exit 0" } };
        if (requests.length === 2) {
          const tool = body.messages.findLast((message) => message.role === "tool");
          const evidence = tool ? messageText(tool) : "";
          assert.match(evidence, /foreground-ok/, evidence);
          // A successful bash result carries either the bare output or an
          // explicit zero exit; a failure would name a non-zero code.
          assert.doesNotMatch(evidence, /exit code [1-9]|failed/i, evidence);
          return { text: "命令完成。" };
        }
        return { text: "命令完成。" };
      }
    });
    t.after(() => provider.close());
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: "fixture-key",
        model: "p46-fixture-model"
      })
    );
    const child = spawn(
      process.execPath,
      [join(harness, "scripts", "start-pi.mjs"), "--print", "运行命令并返回结果。"],
      {
        cwd: site,
        env: isolatedPiEnvironment({
          HOME: root,
          TMPDIR: root,
          ATRIA_HOME: join(root, "home"),
          COWORK_CONFIG: configPath,
          COWORK_CONFIG_ROOT: root,
          COWORK_HARNESS_ROOT: harness,
          COWORK_WORKSPACE: workspace,
          COWORK_TASK_ID: TASK_ID,
          COWORK_RUN_ID: RUN_ID,
          COWORK_AGENT_ROLE: "executor",
          COWORK_AGENT_ID: AGENT_ID,
          COWORK_SUBAGENT_CALL_ID: "call-foreground",
          COWORK_SUBAGENT_TOKEN: "fixture-token",
          COWORK_SUBAGENT_RESULT: resultPath,
          COWORK_API_BASE: provider.baseUrl,
          COWORK_API_KEY: "fixture-key",
          COWORK_MODEL: "p46-fixture-model",
          COWORK_MODEL_API: "openai-completions",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          COWORK_SUPPORTS_IMAGES: "0",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const outcome = await Promise.race([
      once(child, "close").then(([code]) => code),
      delay(45_000).then(() => "timeout")
    ]);
    assert.notEqual(outcome, "timeout", `the delegated process did not exit: ${output}`);
    assert.equal(outcome, 0, output);
    assert.ok(existsSync(resultPath), `no result record: ${output}`);
    const record = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(record.termination, "completed", JSON.stringify(record));
    assert.match(String(record.response), /命令完成/);
    assert.equal(provider.requests.length, 2);
  }
);
