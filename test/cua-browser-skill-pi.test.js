import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { browserFixture } from "./browser-fixture.mjs";
import { createImageArchive } from "../dist/src/tools/image-archive.js";

const exec = promisify(execFile);
test(
  "real Main Pi loads CUA skill and reuses a scripted Chromium Tab across cells",
  { timeout: 60000 },
  async (t) => {
    const executable = chromium.executablePath();
    try {
      await access(executable);
    } catch {
      return t.skip(
        "Chromium unavailable: npx --yes --package=playwright-core@1.63.0 playwright-core install chromium"
      );
    }
    const root = await mkdtemp(join(tmpdir(), "atria-script-browser-pi-"));
    const fixture = await browserFixture();
    t.after(async () => {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    });
    const project = join(root, "project"),
      workspace = join(root, "workspace"),
      task = join(workspace, "script-browser");
    await mkdir(project);
    await mkdir(workspace);
    const results = [];
    let pageId;
    const provider = await modelProtocolFixture("openai-completions", (body, requests) => {
      const last = body.messages.findLast((message) => message.role === "tool");
      if (last?.content.startsWith("{")) {
        const result = JSON.parse(last.content);
        results.push(result);
        if (result.value?.pageId) pageId = result.value.pageId;
      }
      switch (requests.length) {
        case 1:
          return { name: "load_skill", arguments: { name: "cua" } };
        case 2:
          return { name: "enable_tools", arguments: { groups: ["browser", "cua"] } };
        case 3:
          return {
            name: "cua_script",
            arguments: {
              code: `state.tab = await cua.browser.open(${JSON.stringify(fixture.url)}); return {pageId: state.tab.pageId, imageRef: state.tab.observation.imageRef};`
            }
          };
        case 4:
          return {
            name: "cua_script",
            arguments: {
              code: `
        await state.tab.getByLabel("Name").fill("Script Flow");
        await state.tab.getByRole("button", {name: "Save"}).click();
        const waited = await state.tab.getByText("Saved Script Flow").waitFor({timeoutMs: 1000});
        const downloaded = await state.tab.getByRole("link", {name: "Download report"}).click({expectDownload: true});
        return {waitStatus: waited.status, download: downloaded.download, imageRef: state.tab.observation.imageRef};
      `
            }
          };
        case 5:
          return {
            name: "cua_script",
            arguments: {
              code: `const observed = await state.tab.observe(); await cua.emitImage(observed.imageRef); return {saved: observed.ariaSnapshot.includes("Saved Script Flow")};`
            }
          };
        case 6:
          return {
            name: "cua_script",
            arguments: { code: `await state.tab.getByRole("button", {name: "Duplicate"}).click();` }
          };
        case 7:
          return {
            name: "cua_script",
            arguments: {
              code: `return {keys: Object.keys(state), process: typeof process, require: typeof require, fetch: typeof fetch};`
            }
          };
        case 8:
          return { name: "browser_observe", arguments: { pageId } };
        default:
          return { text: "SCRIPT_BROWSER_SKILL_VERIFIED" };
      }
    });
    t.after(() => provider.close());
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: "local-script-browser",
        model: "fixture",
        supportsImages: true,
        reasoningEffort: "off",
        supportsReasoningEffort: false
      })
    );
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(COWORK_|PI_|ATRIA_)/.test(name))
    );
    const pending = exec(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "Load the CUA skill, fill Name with Script Flow, save and download the report. Use two script cells with the same Tab, inspect actual feedback, and verify recovery after a duplicate-target error."
      ],
      {
        cwd: resolve("."),
        timeout: 45000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...inherited,
          COWORK_CONFIG: configPath,
          COWORK_PROJECT_DIR: project,
          COWORK_WORKSPACE: workspace,
          COWORK_TASK_ID: "script-browser",
          COWORK_RUN_ID: "script-browser-run",
          COWORK_BROWSER_EXECUTABLE: executable,
          PI_CODING_AGENT_DIR: join(root, "pi"),
          COWORK_DISABLE_MAIN_GUARDIAN: "1",
          PI_OFFLINE: "1"
        }
      }
    );
    pending.child.stdin.end();
    const { stdout, stderr } = await pending;
    assert.ok(stdout.includes("SCRIPT_BROWSER_SKILL_VERIFIED"), stderr);
    assert.equal(provider.requests.length, 9);
    assert.equal(results[0].name, "cua");
    assert.equal(results[0].directory, resolve(".pi/skills/cua"));
    assert.ok(results[1].groups.browser.enabled);
    assert.ok(results[1].groups.cua.enabled);
    assert.equal(results[1].groups.computer.enabled, false);
    assert.equal(results[2].vmReset, false, stdout);
    assert.equal(results[3].vmReset, false, stdout);
    assert.equal(results[3].value.waitStatus, "condition_met");
    assert.deepEqual(
      results[3].calls.map((call) => call.toolName),
      ["browser_act", "browser_act", "browser_wait", "browser_act"]
    );
    assert.ok(results[3].calls.every((call) => call.pageId === pageId));
    assert.equal(results[4].value.saved, true);
    assert.equal(results[4].visualFeedback.delivered, 2);
    assert.equal(results[5].errorCode, "ambiguous_target");
    assert.equal(results[5].dispatchStatus, "not_sent");
    assert.equal(results[5].vmReset, true);
    assert.deepEqual(results[6].value, {
      keys: [],
      process: "undefined",
      require: "undefined",
      fetch: "undefined"
    });
    assert.equal(results[7].pageId, pageId);
    assert.ok(results[7].ariaSnapshot.includes("Saved Script Flow"));
    assert.equal(results[7].ariaSnapshot.includes("incorrect duplicate"), false);
    const download = results[3].value.download;
    const bytes = await readFile(join(task, download.path));
    assert.equal(bytes.toString(), "Saved report: CoworkOS 中文\n");
    assert.equal(download.bytes, bytes.length);
    assert.equal(download.sha256, createHash("sha256").update(bytes).digest("hex"));
    const archive = createImageArchive({ taskDirectory: task });
    const image = await archive.read(results[3].value.imageRef);
    assert.equal(image.record.source.kind, "browser");
    assert.equal(image.record.width, 1280);
    const history = await archive.list({ limit: 50 });
    assert.ok(history.length >= 6);
    assert.ok(JSON.stringify(provider.requests[4].body.messages).includes("data:image/png;base64,"));
    assert.equal(
      results.some((result) => /"image":"[A-Za-z0-9+/]/.test(JSON.stringify(result))),
      false
    );
    // No explicit browser_close: successful --print exit also exercises shutdown cleanup.
  }
);
