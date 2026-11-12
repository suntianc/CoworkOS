import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { stopBackendsUnder } from "../scripts/test-run-root.mjs";
import { browserTestOptions } from "./browser-fixture.mjs";
import { cuaProgressFixture } from "./cua-progress-fixture.mjs";
import { readFixtureRequestBody } from "./http-request-body-fixture.mjs";
import { protocolStream } from "./model-protocol-fixture.mjs";
import { mainInputPath, saveMainInput } from "../dist/src/runtime/main-continuation.js";
import { createImageArchive } from "../dist/src/tools/image-archive.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const tool = (name, args) => ({ name, arguments: args });
const text = (content) =>
  typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
const readRows = async (path) => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);

for (const progress of ["confirmed", "unknown", "intent"])
  test(
    `real Main resumes ${progress} CUA progress from durable memory after ${progress === "intent" ? "a hard crash before recording the outcome" : "compaction and process restart"} without resubmitting`,
    { ...browserTestOptions, timeout: 90_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "atria-cua-progress-"));
      const project = join(root, "project");
      const workspace = join(root, "workspace");
      const taskId = `progress-${progress}`;
      const runId = "progress-run";
      const taskRoot = join(workspace, taskId);
      const memoryPath = join(taskRoot, "agents/main/context/memory.md");
      const operation = `report-${progress}`;
      const prompt = `Submit ${operation} once, verify its receipt and preserve recoverable progress.`;
      const business = await cuaProgressFixture(root, operation);
      const failures = [];
      const requests = [];
      const summaryRequests = [];
      const events = [];
      const stages = [];
      let child, childExit;
      let phase = "initial";
      let phaseRequest = 0;
      let pageId, oldPageId, imageRef, download, verifiedFile;
      let checkpointMemory;
      let hardCrash = false;
      let output = "";
      const intentMemory = `# Main Agent Memory

## Goal
Save ${operation} exactly once.
Expected outcome: a saved receipt for ${operation}.

## Completed
- (no confirmed business milestone yet)

## Important information/constraints
- Intent: click Submit report once for operation ${operation}; Progress: unknown.
- Dispatch status: not yet known; a crash may occur after input is sent and before the outcome is recorded.
- Recovery check: ${business.url}/status and its saved receipt identify this operation.
- Do not repeat Submit report after restart; first query the live read-only status and reread its receipt.

## Next
- Submit once, then verify the saved receipt. After any interruption, resolve this unknown intent with read-only checks before another submission.
`;

      const memory = (state, checked) => `# Main Agent Memory

## Goal
Save ${operation} exactly once and verify the saved receipt.
Expected outcome: a saved receipt for ${operation}, containing receipt-1.

## Completed
${state === "confirmed" ? `- confirmed: ${operation} saved; evidence ${download.path}; sha256 ${download.sha256}.` : "- (no confirmed business milestone yet)"}

## Important information/constraints
- Progress: ${state}; dispatchStatus: sent; effectVerified: false.
- Evidence: imageRef ${imageRef}; status URL ${business.url}/status.
- Machine check: ${checked ? `file reread matched operation, receiptId and saved flag; sha256 ${download.sha256}.` : "input delivery only; no saved receipt has been checked."}
- Model judgment: ${checked ? "live status page reports the saved receipt; visual interpretation is separate from the file check." : "the UI says dispatched, which does not establish business completion."}
- Do not repeat Submit report after restart; query the live status and reread its receipt first.

## Next
- ${state === "confirmed" ? "Recheck durable receipt and live status after recovery, then finish." : "Resolve unknown with the live read-only status and receipt; then update confirmed if evidence matches."}
`;
      const checkDownload = () => {
        const path = join(taskRoot, download.path);
        const code = `const fs=require('node:fs'),crypto=require('node:crypto');const b=fs.readFileSync(${JSON.stringify(path)});const r=JSON.parse(b);if(r.operation!==${JSON.stringify(operation)}||r.receiptId!=='receipt-1'||r.saved!==true)throw Error('receipt mismatch');console.log(JSON.stringify({machineChecked:true,operation:r.operation,receiptId:r.receiptId,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}));`;
        return tool("bash", { command: `${quote(process.execPath)} -e ${quote(code)}`, timeout: 10 });
      };
      const observeResult = (body) => {
        const last = body.messages.findLast((message) => message.role === "tool");
        if (!last) return;
        const content = text(last.content);
        const result = content.startsWith("{") ? JSON.parse(content) : undefined;
        if (result?.pageId) pageId = result.pageId;
        if (result?.observation?.imageRef) imageRef = result.observation.imageRef;
        else if (result?.imageRef) imageRef = result.imageRef;
        if (result?.download) download = result.download;
        if (result?.machineChecked) verifiedFile = result;
      };
      const initialSteps = [
        () => tool("load_skill", { name: "cua" }),
        () => tool("enable_tools", { groups: ["browser"] }),
        () =>
          tool("write", {
            path: memoryPath,
            content: intentMemory
          }),
        () => tool("browser_open", { url: business.url }),
        () =>
          tool("browser_act", {
            pageId,
            action: { type: "click", target: { kind: "role", role: "button", name: "Submit report" } }
          }),
        () =>
          tool("browser_wait", {
            pageId,
            condition: {
              type: "element",
              target: { kind: "text", text: "Request dispatched; business result unverified" },
              state: "visible"
            },
            timeoutMs: 1000
          })
      ];
      const verifySteps = [
        () => tool("browser_open", { url: `${business.url}/status` }),
        () =>
          tool("browser_act", {
            pageId,
            action: {
              type: "click",
              target: { kind: "role", role: "link", name: "Download receipt" },
              expectDownload: true
            }
          }),
        checkDownload
      ];
      if (progress === "confirmed") initialSteps.push(...verifySteps);
      if (progress === "intent") checkpointMemory = intentMemory;
      else
        initialSteps.push(() => {
          checkpointMemory = memory(progress, progress === "confirmed");
          oldPageId = pageId;
          return tool("write", { path: memoryPath, content: checkpointMemory });
        });
      const recoverySteps = [
        () => tool("read", { path: memoryPath }),
        ...(progress === "confirmed" ? [checkDownload] : []),
        ...verifySteps,
        () => tool("write", { path: memoryPath, content: memory("confirmed", true) })
      ];
      const provider = createServer(async (request, response) => {
        let reply;
        try {
          const body = JSON.parse(await readFixtureRequestBody(request));
          requests.push({ phase, body });
          if (!body.tools?.length) {
            summaryRequests.push(body);
            assert.notEqual(progress, "intent", "the hard-crash fixture never reaches compaction");
            assert.ok(JSON.stringify(body.messages).includes(prompt));
            reply = { text: `# Verified task checkpoint\n${prompt}\n${checkpointMemory}` };
          } else {
            observeResult(body);
            if (progress === "intent" && phase === "initial" && phaseRequest === 5) {
              // The real action result has reached the model boundary, but the
              // provider has not emitted any outcome-memory write or next action.
              const action = JSON.parse(
                text(body.messages.findLast((message) => message.role === "tool").content)
              );
              assert.equal(action.dispatchStatus, "sent");
              assert.equal(action.effectVerified, false);
              assert.equal((await business.receipts()).length, 1);
              assert.equal(await readFile(memoryPath, "utf8"), intentMemory);
              oldPageId = pageId;
              hardCrash = true;
              process.kill(-child.pid, "SIGKILL");
              response.destroy();
              return;
            }
            const steps = phase === "initial" ? initialSteps : recoverySteps;
            if (phase === "recovery" && phaseRequest === 0 && progress !== "intent") {
              assert.ok(
                body.messages.some((message) => text(message.content).includes(checkpointMemory.trim()))
              );
              assert.equal(
                body.messages.some((message) => message.role === "tool"),
                false,
                "the compacted context must use memory, not the old tool receipts"
              );
              assert.equal(JSON.stringify(body.messages).includes("/atria-internal-continue"), false);
            }
            if (phase === "recovery" && phaseRequest === 0 && progress === "intent") {
              assert.equal(
                body.messages.filter(
                  (message) => message.role === "user" && text(message.content).includes(prompt)
                ).length,
                1,
                "restoring the accepted input after SIGKILL must not submit a second user turn"
              );
              assert.equal(JSON.stringify(body.messages).includes("/atria-internal-continue"), false);
            }
            if (phase === "recovery" && phaseRequest === 1)
              assert.ok(
                text(body.messages.findLast((message) => message.role === "tool").content).includes(
                  checkpointMemory.trim()
                ),
                "the production read tool must reread the durable progress before any recovery browser action"
              );
            if (phaseRequest < steps.length) {
              reply = steps[phaseRequest++]();
              stages.push({ phase, name: reply.name, args: reply.arguments });
            } else reply = { text: phase === "initial" ? "CHECKPOINT_READY" : "RECOVERED_WITH_RECEIPT" };
          }
        } catch (error) {
          failures.push(error.stack ?? error.message);
          reply = { text: "Progress fixture assertion failed" };
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        let stream = protocolStream("openai-completions", reply).replaceAll(
          "call_protocol",
          `progress_${requests.length}`
        );
        if (reply.text === "CHECKPOINT_READY")
          stream = stream.replace(
            "data: [DONE]",
            `data: ${JSON.stringify({ id: "progress-usage", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 53000, completion_tokens: 10, total_tokens: 53010 } })}\n\ndata: [DONE]`
          );
        response.end(stream);
      });
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      t.after(async () => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
          await childExit;
        }
        // A SIGKILL reaches only Pi's process group; the browser it launched
        // lives in its own and outlives the crash, so stop what is left here.
        await stopBackendsUnder(root);
        provider.closeAllConnections();
        await new Promise((done) => provider.close(done));
        await business.close();
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(project);
      await mkdir(join(root, "pi"));
      await writeFile(
        join(root, "pi/settings.json"),
        JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32 } })
      );
      const config = join(root, "config.json");
      await writeFile(config, JSON.stringify({ contextWindow: 64000 }));
      const store = new LocalWorkspaceStore(workspace);
      await store.createTask(taskId, { goal: prompt });
      await store.createRun(taskId, runId);
      const input = mainInputPath(workspace, taskId, runId);
      await saveMainInput(input, { version: 1, prompt, submittedAt: Date.now() });
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name)
        )
      );
      const env = {
        ...inherited,
        ATRIA_HOME: join(root, "home"),
        COWORK_CONFIG: config,
        COWORK_PROJECT_DIR: project,
        COWORK_WORKSPACE: workspace,
        COWORK_TASK_ID: taskId,
        COWORK_RUN_ID: runId,
        COWORK_API_BASE: `http://127.0.0.1:${provider.address().port}/v1`,
        COWORK_API_KEY: "local-progress-fixture",
        COWORK_MODEL: "fixture",
        COWORK_MODEL_API: "openai-completions",
        COWORK_SUPPORTS_IMAGES: "1",
        COWORK_REASONING_EFFORT: "off",
        COWORK_SUPPORTS_REASONING_EFFORT: "0",
        COWORK_BROWSER_EXECUTABLE: chromium.executablePath(),
        COWORK_DISABLE_WATCH_SUPERVISOR: "1",
        COWORK_WEB_TOOLS: "0",
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1"
      };
      const launch = async (args, expectCrash = false) => {
        child = spawn(
          process.execPath,
          [
            "scripts/start-pi.mjs",
            "--print",
            "--mode",
            "json",
            "--session-dir",
            join(root, "sessions"),
            ...args
          ],
          { cwd: resolve("."), detached: true, stdio: ["ignore", "pipe", "pipe"], env }
        );
        childExit = once(child, "exit");
        let pending = "";
        child.stdout.on("data", (chunk) => {
          output = (output + chunk).slice(-12000);
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) {
            try {
              events.push(JSON.parse(line));
            } catch {
              /* startup diagnostics */
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          output = (output + chunk).slice(-12000);
        });
        const [code, signal] = await childExit;
        if (expectCrash) {
          assert.equal(code, null);
          assert.equal(signal, "SIGKILL");
          assert.equal(hardCrash, true);
        } else assert.equal(code, 0, output);
        assert.deepEqual(failures, []);
      };
      await launch(["--session-id", runId, prompt], progress === "intent");
      if (progress !== "intent") assert.ok(output.includes("CHECKPOINT_READY"), output);
      const submitted = events.find(
        (event) => event.type === "tool_execution_end" && event.toolName === "browser_act"
      ).result.details;
      assert.equal(submitted.dispatchStatus, "sent");
      assert.equal(submitted.effectVerified, false, "delivery alone must not claim business verification");
      assert.equal(
        (await business.receipts()).length,
        1,
        "the real browser must perform the submission before restart"
      );
      assert.equal(await readFile(memoryPath, "utf8"), checkpointMemory);
      if (progress !== "confirmed") {
        assert.equal(download, undefined, "unknown checkpoint must not invent a checked receipt");
        assert.equal(verifiedFile, undefined);
        assert.match(checkpointMemory, /Progress: unknown/);
      }
      const checkpointImageRef = imageRef;
      const beforeState = JSON.parse(
        await readFile(join(taskRoot, "agents/main/context/state.json"), "utf8")
      );
      assert.equal(beforeState.memorySha256, createHash("sha256").update(checkpointMemory).digest("hex"));
      if (progress === "intent") {
        assert.equal(beforeState.contextEpoch, 0, "the crash happens before compaction or orderly shutdown");
        assert.equal(
          events.some((event) => event.type === "agent_settled"),
          false
        );
        assert.equal(
          stages.filter((stage) => stage.name === "write").length,
          1,
          "no outcome-memory write was issued before the hard crash"
        );
      } else {
        assert.ok(summaryRequests.length > 0, "production compaction must summarize the real progress");
        assert.ok(beforeState.contextEpoch > 0, "production compaction hook must update context epoch");
        assert.ok(
          events.some(
            (event) => event.type === "compaction_end" && event.result?.summary.includes(checkpointMemory)
          )
        );
        assert.ok(beforeState.memoryVersion >= 2, "both pre-action intent and outcome memory were persisted");
      }
      const sessions = (await readdir(join(root, "sessions"))).filter((path) => path.endsWith(".jsonl"));
      assert.equal(sessions.length, 1);
      const firstPid = child.pid;
      phase = "recovery";
      phaseRequest = 0;
      env.COWORK_MAIN_CONTINUATION = input;
      await launch(["--continue", "/atria-internal-continue"]);
      assert.notEqual(child.pid, firstPid);
      assert.ok(output.includes("RECOVERED_WITH_RECEIPT"), output);
      assert.notEqual(
        pageId,
        oldPageId,
        "recovery must acquire a new Chromium page, not restore an old page handle"
      );
      assert.ok(
        stages
          .filter((stage) => stage.phase === "recovery")
          .every(
            (stage) => stage.name !== "browser_act" || stage.args.action.target.name === "Download receipt"
          )
      );
      const receipts = await business.receipts();
      assert.deepEqual(receipts, [{ operation, receiptId: "receipt-1", saved: true }]);
      assert.equal(
        business.requests.filter((request) => request.method === "POST" && request.path === "/submit").length,
        1
      );
      assert.ok(
        business.requests.filter((request) => request.method === "GET" && request.path === "/status")
          .length >= (progress === "confirmed" ? 2 : 1)
      );
      const expected = business.receiptBytes(receipts[0]);
      assert.deepEqual(await readFile(join(taskRoot, download.path)), expected.bytes);
      assert.deepEqual(verifiedFile, {
        machineChecked: true,
        operation,
        receiptId: "receipt-1",
        bytes: expected.bytes.length,
        sha256: expected.sha256
      });
      assert.equal(download.sha256, expected.sha256);
      assert.match(await readFile(memoryPath, "utf8"), /Progress: confirmed/);
      const archived = await createImageArchive({ taskDirectory: taskRoot }).read(imageRef);
      assert.equal(archived.record.source.kind, "browser");
      assert.equal(
        (await createImageArchive({ taskDirectory: taskRoot }).read(checkpointImageRef)).record.source.kind,
        "browser",
        "old image evidence must survive the process restart independently of live page handles"
      );
      const rows = await readRows(join(taskRoot, "sessions/main", `${runId}-requests.jsonl`));
      assert.equal(
        new Set(rows.map((row) => row.recorderId)).size,
        2,
        "two production runtime recorders must append to the same Task trace"
      );
      const toolEnds = events.filter((event) => event.type === "tool_execution_end");
      assert.ok(
        toolEnds.every((event) => !event.isError),
        output
      );
      assert.equal(
        toolEnds.filter(
          (event) => event.toolName === "browser_act" && event.result.details?.dispatchStatus === "sent"
        ).length,
        progress === "confirmed" ? 3 : 2
      );
      assert.deepEqual(business.failures, []);
    }
  );
