import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { JsonlEventStore } from "../dist/src/storage/event-store.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");
const toolResult = (body) =>
  JSON.parse(messageText(body.messages.findLast((message) => message.role === "tool")));
const commandStdout = (body) => {
  const text = messageText(body.messages.findLast((message) => message.role === "tool"));
  assert.doesNotMatch(text, /Command exited with code/, "the read-only inspection command succeeded");
  return JSON.parse(text);
};
/** Quote one shell word so an argument containing spaces or quotes stays intact. */
const shellWord = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

// A scripted local provider checks the real discovery/delegation/read/callback/archive
// path. It does not measure whether an LLM chooses this workflow spontaneously.
for (const channel of ["inbox", "wait"]) {
  test(
    `real Pi loads workspace-explore and archives an async explorer's observations (${channel} delivery)`,
    { timeout: 45_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-workspace-explore-"));
      const project = join(root, "project"),
        workspace = join(root, "workspace");
      const taskId = "explore-task",
        runId = "explore-run";
      const files = {
        "README.md": "销售资料入口。原始数据位于 data/sales.csv；金额单位为元。\n",
        "data/sales.csv": "month,revenue\n2026-01,120\n2026-02,180\n",
        "request.txt": "先了解资料结构，再说明数据字段。\n"
      };
      await mkdir(join(project, "data"), { recursive: true });
      for (const [path, content] of Object.entries(files)) await writeFile(join(project, path), content);
      await writeFile(join(root, "config.json"), JSON.stringify({ contextWindow: 96000 }));
      const store = new LocalWorkspaceStore(workspace);
      await store.createTask(taskId, { goal: files["request.txt"] });
      await store.createRun(taskId, runId);

      // Select each legal delivery order without replacing real dispatch, waits,
      // model messages or durable acknowledgement. No wall-clock race is needed.
      const preload = join(root, "delivery-order.mjs");
      await writeFile(
        preload,
        `import { MainInboxDelivery } from ${JSON.stringify(pathToFileURL(resolve("dist/src/runtime/main-inbox-delivery.js")).href)};
import { CoordinatorRuntime } from ${JSON.stringify(pathToFileURL(resolve("dist/src/runtime/coordinator-runtime.js")).href)};
const channel = ${JSON.stringify(channel)};
let waitReturned = false, markInboxQueued;
const inboxQueued = new Promise(resolve => { markInboxQueued = resolve; });
const deliver = MainInboxDelivery.prototype.deliver;
MainInboxDelivery.prototype.deliver = function(send, options) {
  if (channel === "wait" && !waitReturned) return Promise.resolve();
  return deliver.call(this, async (message, delivery) => {
    await send(message, delivery);
    if (message.customType === "cowork-callback") markInboxQueued();
  }, options);
};
const wait = CoordinatorRuntime.prototype.waitForSubagents;
CoordinatorRuntime.prototype.waitForSubagents = async function(input) {
  if (channel === "inbox" && input.consumeCompletedCallbacks) await inboxQueued;
  const result = await wait.call(this, input);
  if (input.consumeCompletedCallbacks) waitReturned = true;
  return result;
};\n`
      );

      const skillName = "workspace-explore";
      const skillPath = resolve(".pi/skills", skillName, "SKILL.md");
      const brief = `资料入口：${join(project, "README.md")}；数据：${join(project, "data/sales.csv")}，字段为 month、revenue，金额单位为元。`;
      const failures = [],
        steps = { main: 0, explorer: 0 };
      let child,
        childExit,
        output = "",
        call;
      let finishIndependentRead;
      const independentRead = new Promise((done) => {
        finishIndependentRead = done;
      });
      const observe =
        "const fs=require('node:fs'),path=require('node:path');const root=process.argv[1];console.log(JSON.stringify({entries:fs.readdirSync(root).sort(),files:Object.fromEntries(['README.md','data/sales.csv'].map(p=>[p,fs.readFileSync(path.join(root,p),'utf8')]))}));";
      const provider = await modelProtocolFixture("openai-completions", async (body) => {
        try {
          const system = body.messages
            .filter((message) => ["system", "developer"].includes(message.role))
            .map(messageText)
            .join("\n");
          const explorer = system.includes("You are a CoworkOS Subagent");
          const role = explorer ? "explorer" : "main",
            step = ++steps[role];
          const context = JSON.stringify(body.messages);
          const names = body.tools.map((tool) => tool.function.name);
          assert.ok(context.includes(skillName), `${role} can discover the skill`);
          assert.ok(names.includes("load_skill"));
          if (step === 1) {
            // Discovery contains metadata, not an eagerly copied skill body.
            if (!explorer) assert.ok(context.includes(skillPath));
            assert.ok(!context.includes(JSON.stringify(await readFile(skillPath, "utf8")).slice(1, -1)));
            return { name: "load_skill", arguments: { name: skillName } };
          }
          if (step === 2) {
            const loaded = toolResult(body);
            assert.equal(loaded.name, skillName);
            assert.equal(loaded.path, skillPath);
            assert.equal(loaded.content, await readFile(skillPath, "utf8"));
            if (explorer) {
              assert.ok(context.includes(project), "Main supplied the external project path");
              // Main must be able to finish another read while this child is active.
              await independentRead;
              return {
                name: "bash",
                arguments: {
                  command: `${shellWord(process.execPath)} -e ${shellWord(observe)} ${shellWord(project)}`
                }
              };
            }
            return {
              name: "call_subagent",
              arguments: {
                mode: "async",
                task: `Load workspace-explore with load_skill and follow only its Subagent exploration workflow. User goal: understand the sales materials and their fields. Scope: ${project}. Depth: medium. Read README.md and its referenced data/sales.csv without modifying files; return paths and evidence.`
              }
            };
          }
          if (explorer) {
            assert.equal(step, 3);
            const observed = commandStdout(body);
            assert.deepEqual(observed.entries, ["README.md", "data", "request.txt"]);
            assert.deepEqual(observed.files, {
              "README.md": files["README.md"],
              "data/sales.csv": files["data/sales.csv"]
            });
            return { text: brief };
          }
          if (step === 3) {
            call = toolResult(body);
            assert.equal(call.accepted, true);
            assert.equal(call.mode, "async");
            assert.ok(call.callId && call.agentId);
            return { name: "read", arguments: { path: join(project, "request.txt") } };
          }
          if (step === 4) {
            const read = body.messages.findLast((message) => message.role === "tool");
            assert.ok(messageText(read).includes(files["request.txt"].trim()));
            finishIndependentRead();
            // In the inbox order the callback is already queued when this wait
            // returns, and its delivery ends the turn; the durable records below
            // cover that order.
            return { name: "wait_for_subagents", arguments: { callIds: [call.callId], timeoutMs: 15_000 } };
          }
          assert.equal(step, 5);
          const waited = toolResult(body);
          assert.deepEqual(waited.pending, []);
          assert.equal(waited.timedOut, false);
          const delivered = waited.calls.find((item) => item.callId === call.callId);
          assert.equal(delivered?.status, "completed");
          assert.ok(delivered.response.includes(brief), "the wait result carries the explorer brief");
          assert.deepEqual(
            body.messages.filter(
              (message) =>
                message.role === "user" &&
                messageText(message).includes(call.callId) &&
                messageText(message).includes(brief)
            ),
            [],
            "the claimed callback is not also injected as user input"
          );
          return { text: brief };
        } catch (error) {
          failures.push(error.stack ?? error.message);
          finishIndependentRead();
          return { text: "Workspace exploration fixture failed." };
        }
      });
      t.after(async () => {
        finishIndependentRead();
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
          await childExit;
        }
        await provider.close();
        await rm(root, { recursive: true, force: true });
      });

      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/^(COWORK_|ATRIA_|PI_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name) && name !== "NODE_OPTIONS"
        )
      );
      child = spawn(
        process.execPath,
        [
          "scripts/start-pi.mjs",
          "--print",
          "--mode",
          "json",
          "--session-id",
          runId,
          "--session-dir",
          join(root, "sessions"),
          files["request.txt"]
        ],
        {
          cwd: resolve("."),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...inherited,
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            ATRIA_HOME: join(root, "atria"),
            COWORK_CONFIG: join(root, "config.json"),
            COWORK_WORKSPACE: workspace,
            COWORK_PROJECT_DIR: project,
            COWORK_TASK_ID: taskId,
            COWORK_RUN_ID: runId,
            COWORK_GLOBAL_INDEX: join(root, "index.json"),
            COWORK_API_BASE: provider.baseUrl,
            COWORK_API_KEY: "local-fixture",
            COWORK_MODEL: "protocol-fixture",
            COWORK_MODEL_API: "openai-completions",
            COWORK_DASHBOARD_URL: "",
            COWORK_DISABLE_MAIN_GUARDIAN: "1",
            COWORK_REASONING_EFFORT: "off",
            COWORK_SUPPORTS_REASONING_EFFORT: "0",
            COWORK_WEB_TOOLS: "0",
            COWORK_MAX_ATTEMPTS: "1",
            COWORK_SUBAGENT_TIMEOUT_MS: "20000",
            PI_CODING_AGENT_DIR: join(root, "pi"),
            PI_OFFLINE: "1"
          }
        }
      );
      childExit = once(child, "exit");
      const record = (chunk) => {
        output = (output + chunk).slice(-20_000);
      };
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      const [code] = await childExit;
      assert.equal(code, 0, output);
      assert.deepEqual(failures, [], output);
      // An inbox delivery ends Main's turn, so only the wait delivery asks the
      // model for one more step; both orders still run the same delegation.
      assert.deepEqual(steps, { main: channel === "wait" ? 5 : 4, explorer: 3 });

      const runPath = join(workspace, taskId, "runs", runId);
      const inbox = new InboxStore(join(runPath, "agents", "main", "inbox-store.json"));
      const callbacks = (await inbox.list("main")).filter(
        (message) => message.kind === "callback" && message.callId === call.callId
      );
      assert.equal(callbacks.length, 1, "the explorer result is queued for Main exactly once");
      assert.ok(
        callbacks[0].payload.response.includes(brief),
        "the queued callback carries the exploration brief"
      );
      const receipts = (await new JsonlEventStore(join(runPath, "run_events.jsonl")).list(runId)).filter(
        (event) => event.type === "callback.consumed" && event.callId === call.callId
      );
      if (channel === "wait") {
        assert.equal(callbacks[0].state, "consumed", "the wait result is durably acknowledged");
        assert.equal(receipts.length, 1, "the callback has exactly one durable delivery receipt");
        assert.equal(receipts[0].payload.delivery, "wait");
      } else {
        // Inbox delivery ends this Main's turn; the process exits before the
        // message is confirmed, so it stays deliverable for the next Main.
        assert.equal(callbacks[0].state, "ready", "an unacknowledged callback stays deliverable");
        assert.equal(receipts.length, 0, "a queued callback is not acknowledged by this process");
      }
      for (const [path, content] of Object.entries(files))
        assert.equal(
          await readFile(join(project, path), "utf8"),
          content,
          "exploration preserves the source files"
        );

      // The Subagent's own transcript is the persisted evidence: the skill it
      // loaded, the bytes it inspected and the brief it returned to Main.
      const sessionDirectory = join(workspace, taskId, "sessions", call.agentId, "pi", call.callId);
      const [sessionFile] = await readdir(sessionDirectory);
      const transcript = (await readFile(join(sessionDirectory, sessionFile), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((row) => row.type === "message")
        .map((row) => row.message);
      assert.ok(
        transcript.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "load_skill" &&
            message.content.some((part) => part.text?.includes(skillName))
        ),
        "the Subagent loaded the published skill"
      );
      const inspected = messageText(
        transcript.findLast((message) => message.role === "toolResult" && message.toolName === "bash")
      );
      assert.doesNotMatch(inspected, /Command exited with code/, "the inspection command succeeded");
      assert.deepEqual(
        JSON.parse(inspected).files,
        { "README.md": files["README.md"], "data/sales.csv": files["data/sales.csv"] },
        "the inspected source files survive in the Subagent transcript"
      );
      assert.ok(
        messageText(transcript.findLast((message) => message.role === "assistant")).includes(brief),
        "the Subagent returned the exploration brief"
      );
    }
  );
}
