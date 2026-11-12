import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { browserFixture, browserTestOptions } from "./browser-fixture.mjs";
import { createImageArchive } from "../dist/src/tools/image-archive.js";

const exec = promisify(execFile);
test(
  "real Main Pi → owned Chromium → semantic action → downloaded file and archived PNG feedback",
  { ...browserTestOptions, timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-browser-pi-")),
      fixture = await browserFixture();
    t.after(async () => {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    });
    const project = join(root, "project"),
      workspace = join(root, "workspace"),
      task = join(workspace, "browser-task");
    await mkdir(project);
    await mkdir(workspace);
    let pageId, download, imageRef, observationId;
    const provider = await modelProtocolFixture("openai-completions", (body, requests) => {
      const last = body.messages.findLast((message) => message.role === "tool");
      const result = last?.content.startsWith("{") ? JSON.parse(last.content) : undefined;
      if (result?.pageId) pageId = result.pageId;
      if (result?.download) download = result.download;
      if (result?.observationId) observationId = result.observationId;
      if (result?.observation?.imageRef) imageRef = result.observation.imageRef;
      const index = requests.length;
      if (index === 1) return { name: "enable_tools", arguments: { groups: ["browser"] } };
      if (index === 2) return { name: "browser_open", arguments: { url: fixture.url } };
      if (index === 3)
        return {
          name: "browser_act",
          arguments: {
            pageId,
            observation: "none",
            action: { type: "fill", target: { kind: "label", text: "Name" }, value: "Pi Chromium" }
          }
        };
      if (index === 4)
        return {
          name: "browser_act",
          arguments: {
            pageId,
            observation: "aria",
            action: { type: "click", target: { kind: "role", role: "button", name: "Save" } }
          }
        };
      if (index === 5)
        return {
          name: "browser_wait",
          arguments: {
            pageId,
            condition: {
              type: "element",
              target: { kind: "text", text: "Saved Pi Chromium" },
              state: "visible"
            },
            timeoutMs: 500
          }
        };
      if (index === 6)
        return {
          name: "browser_act",
          arguments: {
            pageId,
            action: {
              type: "click",
              target: { kind: "role", role: "link", name: "Download report" },
              expectDownload: true
            }
          }
        };
      if (index === 7) return { name: "read_image", arguments: { imageRef } };
      if (index === 8)
        return { name: "browser_open", arguments: { url: `${fixture.url}advanced`, observation: "none" } };
      if (index === 9)
        return {
          name: "browser_act",
          arguments: {
            pageId,
            observation: "aria",
            action: {
              type: "click",
              target: {
                kind: "role",
                role: "button",
                name: "Save",
                scope: [{ kind: "role", role: "region", name: "Second" }],
                nth: 0
              }
            }
          }
        };
      if (index === 10) return { name: "browser_observe", arguments: { pageId, observation: "screenshot" } };
      if (index === 11)
        return {
          name: "browser_act",
          arguments: { pageId, observationId, action: { type: "click_at", x: 50, y: 330 } }
        };
      if (index === 12) return { name: "browser_close", arguments: {} };
      return { text: "BROWSER_PI_VERIFIED" };
    });
    t.after(() => provider.close());
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: "local-browser-fixture",
        model: "fixture",
        supportsImages: true,
        reasoningEffort: "off",
        supportsReasoningEffort: false
      })
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
    );
    const pending = exec(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "Open the test page, save input, wait for result, download and verify its screenshot."
      ],
      {
        cwd: resolve("."),
        timeout: 45000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...env,
          COWORK_CONFIG: configPath,
          COWORK_PROJECT_DIR: project,
          COWORK_WORKSPACE: workspace,
          COWORK_TASK_ID: "browser-task",
          COWORK_RUN_ID: "browser-run",
          COWORK_BROWSER_EXECUTABLE: chromium.executablePath(),
          PI_CODING_AGENT_DIR: join(root, "pi"),
          COWORK_DISABLE_MAIN_GUARDIAN: "1",
          PI_OFFLINE: "1"
        }
      }
    );
    pending.child.stdin.end();
    const { stdout, stderr } = await pending;
    assert.ok(stdout.includes("BROWSER_PI_VERIFIED"), stderr);
    assert.equal(provider.requests.length, 13);
    const results = provider.requests.slice(1).map((request) => {
      const message = request.body.messages.findLast((entry) => entry.role === "tool");
      return message?.content.startsWith("{") ? JSON.parse(message.content) : undefined;
    });
    assert.equal(results[2].observationStatus, "omitted");
    assert.equal(results[2].observation, undefined);
    assert.equal(results[3].observation.imageRef, undefined);
    assert.equal(results[7].observationStatus, "omitted");
    assert.match(results[8].observation.ariaSnapshot, /Second saved/);
    assert.equal(results[9].ariaSnapshot, undefined);
    assert.ok(results[9].observationId);
    assert.match(results[10].observation.ariaSnapshot, /Canvas clicked/);
    const waited = JSON.parse(
      provider.requests[5].body.messages.findLast((message) => message.role === "tool").content
    );
    assert.equal(waited.status, "condition_met");
    assert.match(waited.observation.ariaSnapshot, /Saved Pi Chromium/);
    const reread = provider.requests[7].body.messages.findLast((message) => message.role === "tool");
    assert.match(reread.content, /Image loaded/);
    assert.ok(download, stdout);
    const bytes = await readFile(join(task, download.path));
    assert.equal(bytes.toString(), "Saved report: CoworkOS 中文\n");
    assert.equal(download.sha256, createHash("sha256").update(bytes).digest("hex"));
    const archived = await createImageArchive({ taskDirectory: task }).read(imageRef);
    assert.equal(archived.record.source.kind, "browser");
    assert.equal(archived.record.width, 1280);
    const toolResults = provider.requests.flatMap((request) =>
      request.body.messages.filter((message) => message.role === "tool").map((message) => message.content)
    );
    assert.equal(
      toolResults.some((content) => /"image":"[A-Za-z0-9+/]/.test(content)),
      false,
      "base64 was duplicated in text metadata"
    );
    assert.ok(JSON.stringify(provider.requests[6].body.messages).includes("data:image/png;base64,"));
    assert.ok(provider.requests[1].body.tools.some((tool) => tool.function.name === "browser_open"));
  }
);
