import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { exaMcpFixture, sourceConversationFixture } from "../test/exa-mcp-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

test("native App after normal model setup performs anonymous search and source fetch without a search key", async () => {
  test.skip(process.platform !== "darwin", "Native App acceptance requires macOS");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "atria-search-desktop-"));
  const exa = await exaMcpFixture(),
    provider = await modelProtocolFixture("openai-completions", sourceConversationFixture());
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_|EXA_)/.test(name))
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_EXA_MCP_ENDPOINT: exa.endpoint,
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  });
  delete env.ELECTRON_RUN_AS_NODE;
  let native;
  try {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env
    });
    const page = await native.firstWindow();
    const dialog = page.getByRole("dialog", { name: "连接模型", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="model"]').fill("protocol-fixture");
    await dialog.locator('[name="apiKey"]').fill("synthetic-model-key");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#composer-input")).toBeVisible();
    const status = await page.evaluate(async () =>
      (
        await fetch("/api/web-search-settings", {
          headers: window.bookmanDesktop?.transportNonce
            ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
            : {}
        })
      ).json()
    );
    expect(status.provider).toBe("exa");
    expect(status.authenticated).toBe(false);
    expect(status).not.toHaveProperty("exaApiKey");
    await page.locator("#new-project").click();
    await page.locator("#project-name").fill("搜索验收项目");
    await page.locator("#project-directory").fill(root);
    await page.locator("#project-submit").click();
    await expect(page.locator("#project-modal")).toBeHidden();
    await page.locator("#composer-input").fill("搜索相关论文，读取来源并附链接");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("来源读取成功", { timeout: 30_000 });
    await expect(page.locator('#conversation a[href="https://example.org/paper"]').first()).toBeVisible();
    expect(exa.calls.map((call) => call.name)).toEqual(["web_search_exa", "web_fetch_exa"]);
    const saveSearch = async (provider, key, clear = false) => {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "管理联网搜索", exact: true }).click();
      const searchDialog = page.getByRole("dialog", { name: "联网搜索", exact: true });
      await searchDialog.locator('[name="provider"]').selectOption(provider);
      if (key || clear) {
        const advanced = searchDialog.locator("details.settings-advanced");
        if (!(await advanced.evaluate((element) => element.open)))
          await searchDialog.getByText("高级设置 · 可选认证", { exact: true }).click();
        if (key) await searchDialog.locator('[name="exaApiKey"]').fill(key);
        if (clear) await searchDialog.locator('[name="clearExaApiKey"]').check();
      }
      await searchDialog.getByRole("button", { name: "保存设置" }).click();
      await expect(searchDialog).toBeHidden();
      await expect(page.locator("#composer-input")).toBeVisible();
      return page.evaluate(async () =>
        (
          await fetch("/api/web-search-settings", {
            headers: window.bookmanDesktop?.transportNonce
              ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
              : {}
          })
        ).json()
      );
    };
    expect((await saveSearch("off")).enabled).toBe(false);
    expect((await saveSearch("exa", "synthetic-exa-key")).authenticated).toBe(true);
    expect((await saveSearch("exa", "", true)).authenticated).toBe(false);
  } finally {
    await native?.close();
    await stopNativeBackend(root);
    await provider.close();
    await exa.close();
    await rm(root, { recursive: true, force: true });
  }
});
