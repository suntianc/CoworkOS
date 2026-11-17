import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import {
  activeModelOf,
  addProviderThroughUi,
  checkProvider,
  leaveSettings,
  openModelParams,
  openModelSettings,
  saveProviderEdits,
  setupDialog,
  windowRequest
} from "./model-provider-ui.js";

for (const reasoningEffort of ["off", "max"]) {
  test(`native desktop persists each protocol and ${reasoningEffort} across saves and application relaunch`, async ({}, testInfo) => {
    test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "atria-protocol-desktop-"));
    const executablePath = await developmentExecutable();
    const env = {
      ...process.env,
      COWORK_DESKTOP_DATA: root,
      ATRIA_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      COWORK_DISABLE_MAIN_GUARDIAN: "1",
      PI_OFFLINE: "1"
    };
    for (const name of Object.keys(env))
      if (
        /^(?:COWORK_|ATRIA_|PI_)/.test(name) &&
        ![
          "COWORK_DESKTOP_DATA",
          "ATRIA_HOME",
          "PI_CODING_AGENT_DIR",
          "COWORK_DISABLE_MAIN_GUARDIAN",
          "PI_OFFLINE"
        ].includes(name)
      )
        delete env[name];
    delete env.ELECTRON_RUN_AS_NODE;
    let native;
    const providers = [];
    const launch = async () => {
      native = await electron.launch({ executablePath, args: ["--use-mock-keychain", resolve(".")], env });
      return native.firstWindow();
    };
    try {
      let page = await launch();
      for (const api of ["openai-completions", "openai-responses"]) {
        const responseText = `协议会话验证成功 ${api}`;
        const provider = await modelProtocolFixture(api, () => ({ text: responseText }));
        providers.push(provider);
        if (api === "openai-completions") {
          await expect(setupDialog(page)).toBeVisible();
          await addProviderThroughUi(page, {
            baseUrl: provider.baseUrl,
            api,
            model: "protocol-fixture",
            apiKey: "local-desktop-fixture"
          });
        } else {
          // The same provider moves to another address and format; its key stays.
          const panel = await openModelSettings(page);
          await panel.locator('[data-field="baseUrl"]').fill(provider.baseUrl);
          await panel.locator(`[data-api="${api}"]`).click();
          await saveProviderEdits(page);
          await expect(panel.locator("[data-provider-save]")).toBeHidden();
        }
        const params = await openModelParams(page, "protocol-fixture");
        const supports = params.locator('[data-model-switch="supportsReasoningEffort"]');
        if ((await supports.getAttribute("aria-checked")) !== "true") await supports.click();
        await params.locator('[data-model-field="reasoningEffort"]').selectOption(reasoningEffort);
        await params.locator("[data-model-save]").click();
        await expect(params).toBeHidden();
        await expect(await checkProvider(page)).toContainText("连接通过");
        await leaveSettings(page);
        await expect(page.locator("#composer-input")).toBeVisible();
        await native.close();
        native = undefined;
        page = await launch();
        await expect(page.locator("#composer-input")).toBeVisible();
        const readStatus = async () => (await windowRequest(page)("/api/model-settings")).body;
        // A relaunched window authorizes its transport once the host session is ready.
        await expect.poll(async () => (await readStatus()).configured).toBe(true);
        const status = await readStatus();
        expect(status.providers[0].api).toBe(api);
        expect(activeModelOf(status).reasoningEffort).toBe(reasoningEffort);
        expect(JSON.stringify(status)).not.toContain("local-desktop-fixture");
        if (api === "openai-completions") {
          await page.locator("#new-project").click();
          await page.locator("#add-project-name").fill("模型协议验收项目");
          await page.locator("#add-project-directory").fill(root);
          await page.locator("#add-project-submit").click();
          await expect(page.locator("#add-project-modal")).toBeHidden();
          await expect(page.locator(".project-group.is-selected .project-name")).toHaveText(
            "模型协议验收项目"
          );
        }
        await page.locator("#composer-input").fill(`验证 ${api} 会话`);
        await page.locator("#send-button").click();
        await expect(page.locator("#conversation")).toContainText(responseText, { timeout: 30_000 });
        await expect(page.locator("#stop-button")).toBeHidden();
        expect(provider.requests.length).toBeGreaterThanOrEqual(2);
        expect(provider.requests.at(-1).path).toBe(
          api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions"
        );
        // The connection test reads the saved effort directly; a run keeps its own level.
        const probes = provider.requests.filter(({ body }) =>
          JSON.stringify(body).includes("atria_connection_check")
        );
        expect(probes.length).toBeGreaterThan(0);
        for (const { body } of probes)
          expect(api === "openai-responses" ? body.reasoning?.effort : body.reasoning_effort).toBe(
            reasoningEffort === "off" ? undefined : reasoningEffort
          );
      }
    } catch (error) {
      const diagnostics = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await diagnostics(path);
          else if (["dashboard.log", "runtime-stderr.log"].includes(entry.name)) {
            const body = await readFile(path, "utf8");
            await testInfo.attach(entry.name, { body, contentType: "text/plain" });
            console.error(`${entry.name}: ${body}`);
          }
        }
      };
      await diagnostics(root);
      console.error(
        JSON.stringify(
          providers.map((provider) =>
            provider.requests.map((request) => ({
              path: request.path,
              effort: request.body.reasoning_effort ?? request.body.reasoning?.effort
            }))
          )
        )
      );
      throw error;
    } finally {
      await native?.close();
      await stopNativeBackend(root);
      for (const provider of providers) await provider.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
