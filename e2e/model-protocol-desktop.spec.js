import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

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
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      PI_OFFLINE: "1"
    };
    for (const name of Object.keys(env))
      if (
        /^(?:COWORK_|ATRIA_|PI_)/.test(name) &&
        ![
          "COWORK_DESKTOP_DATA",
          "ATRIA_HOME",
          "PI_CODING_AGENT_DIR",
          "COWORK_DISABLE_WATCH_SUPERVISOR",
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
        const dialog = page.getByRole("dialog", { name: "连接模型" });
        if (api === "openai-responses") {
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page.locator("#desktop-model-settings").click();
        }
        await expect(dialog).toBeVisible();
        await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
        await dialog.locator('[name="api"]').selectOption(api);
        await dialog.locator('[name="model"]').fill("protocol-fixture");
        await dialog.locator('[name="apiKey"]').fill("local-desktop-fixture");
        await dialog.getByText("高级连接参数", { exact: true }).click();
        await dialog.locator('[name="supportsReasoningEffort"]').check();
        await dialog.locator('[name="reasoningEffort"]').selectOption(reasoningEffort);
        await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
        await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
        await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.locator("#composer-input")).toBeVisible();
        await native.close();
        native = undefined;
        page = await launch();
        await expect(page.locator("#composer-input")).toBeVisible();
        const status = await page.evaluate(async () =>
          (
            await fetch("/api/model-settings", {
              headers: window.bookmanDesktop?.transportNonce
                ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
                : {}
            })
          ).json()
        );
        expect(status.api).toBe(api);
        expect(status.reasoningEffort).toBe(reasoningEffort);
        expect(status.configured).toBe(true);
        expect(status).not.toHaveProperty("apiKey");
        if (api === "openai-completions") {
          await page.locator("#new-project").click();
          await page.locator("#project-name").fill("模型协议验收项目");
          await page.locator("#project-directory").fill(root);
          await page.locator("#project-submit").click();
          await expect(page.locator("#project-modal")).toBeHidden();
          await expect(page.locator("#project-context")).toHaveText("模型协议验收项目");
        }
        await page.locator("#composer-input").fill(`验证 ${api} 会话`);
        await page.locator("#send-button").click();
        await expect(page.locator("#conversation")).toContainText(responseText, { timeout: 30_000 });
        await expect(page.locator("#stop-button")).toBeHidden();
        expect(provider.requests.length).toBeGreaterThanOrEqual(2);
        expect(provider.requests.at(-1).path).toBe(
          api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions"
        );
        for (const { body } of provider.requests)
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
      await rm(root, { recursive: true, force: true });
    }
  });
}
