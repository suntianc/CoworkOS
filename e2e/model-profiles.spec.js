import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

for (const native of [false, true]) {
  test(`${native ? "desktop" : "web"}: saved connections switch protocols and continue the same conversation`, async ({
    page: browserPage
  }) => {
    test.skip(native && process.platform !== "darwin", "Native test requires macOS");
    test.setTimeout(120_000);
    const first = await modelProtocolFixture("openai-completions", () => ({ text: "第一组已回复" }));
    const second = await modelProtocolFixture("openai-responses", () => ({ text: "第二组继续回复" }));
    const root = await mkdtemp(join(tmpdir(), "atria-profiles-e2e-"));
    let app, dashboard, page;
    const launch = async () => {
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
      app = await electron.launch({
        executablePath: await developmentExecutable(),
        args: ["--use-mock-keychain", resolve(".")],
        env
      });
      page = await app.firstWindow();
    };
    const status = () =>
      page.evaluate(async () =>
        (
          await fetch("/api/model-settings", {
            headers: window.bookmanDesktop?.transportNonce
              ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
              : {}
          })
        ).json()
      );
    const open = async () => {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await expect(page.locator("#profile-modal #desktop-model-settings")).toHaveCount(1);
      await page.locator("#desktop-model-settings").click();
    };
    const waitForIdle = (taskId) =>
      expect
        .poll(() =>
          page.evaluate(async (id) => {
            const detail = await (
              await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
                headers: window.bookmanDesktop?.transportNonce
                  ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
                  : {}
              })
            ).json();
            return detail.runtime?.active;
          }, taskId)
        )
        .toBe(false);
    const save = async (activate = false) => {
      await page.getByRole("button", { name: activate ? "保存并启用" : "保存连接", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "连接模型" })).toBeHidden();
      await expect(page.locator("#composer-input")).toBeVisible();
    };
    try {
      if (native) await launch();
      else {
        dashboard = await startDashboard();
        page = browserPage;
        await page.goto(dashboard.base);
        await page.locator("#model-setup-button").click();
      }
      let dialog = page.getByRole("dialog", { name: "连接模型" });
      await expect(dialog.locator('[name="api"]')).toHaveValue("openai-responses");
      await dialog.locator('[name="api"]').selectOption("openai-completions");
      await dialog.locator('[name="profileName"]').fill("第一组");
      await dialog.locator('[name="baseUrl"]').fill(first.baseUrl);
      await dialog.locator('[name="model"]').fill("first-model");
      await dialog.locator('[name="apiKey"]').fill("local-first-key");
      await dialog.locator("summary").click();
      const contextWindow = dialog.getByLabel("上下文窗口大小（token）", { exact: true });
      await expect(contextWindow).toHaveValue("256000");
      await expect(dialog.locator("#model-context-help")).toContainText("自动压缩");
      await contextWindow.fill("0");
      await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
      await expect(dialog).toBeVisible();
      expect(await contextWindow.evaluate((input) => input.validity.rangeUnderflow)).toBe(true);
      expect((await status()).configured).toBe(false);
      await contextWindow.fill("64000");
      await save();
      if (native) {
        await page.locator("#new-project").click();
        await page.locator("#project-name").fill("连接切换验收项目");
        await page.locator("#project-directory").fill(root);
        await page.locator("#project-submit").click();
        await expect(page.locator("#project-modal")).toBeHidden();
        await expect(page.locator(".project-group.is-selected .project-name")).toHaveText("连接切换验收项目");
      }
      await page.locator("#composer-input").fill("请记住暗号蓝鲸");
      await page.locator("#send-button").click();
      await expect(page.locator("#conversation")).toContainText("第一组已回复", { timeout: 30_000 });
      await expect(page.locator("#stop-button")).toBeHidden();
      const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
      await waitForIdle(taskId);
      await page.locator("#composer-input").fill("切换配置保留草稿");
      await open();
      await dialog.locator("[data-model-profiles]").selectOption("");
      await expect(dialog.locator('[name="apiKey"]')).toHaveAttribute("required", "");
      await dialog.locator('[name="profileName"]').fill("第二组");
      await dialog.locator('[name="baseUrl"]').fill(second.baseUrl);
      await expect(dialog.locator('[name="api"]')).toHaveValue("openai-responses");
      await dialog.locator('[name="model"]').fill("second-model");
      await dialog.locator('[name="apiKey"]').fill("local-second-key");
      if (native) await dialog.locator("summary").click();
      await expect(contextWindow).toHaveValue("256000");
      await contextWindow.fill("128000");
      // Switching the editor selection retains drafts without changing the active connection.
      const firstId = (await status()).activeProfileId;
      await dialog.locator("[data-model-profiles]").selectOption(firstId);
      await expect(dialog.locator('[name="model"]')).toHaveValue("first-model");
      await expect(contextWindow).toHaveValue("64000");
      await dialog.locator("[data-model-profiles]").selectOption("");
      await expect(dialog.locator('[name="apiKey"]')).toHaveValue("local-second-key");
      await expect(contextWindow).toHaveValue("128000");
      await save();
      expect((await status()).model).toBe("first-model");
      expect((await status()).contextWindow).toBe(64000);
      const secondProfile = (await status()).profiles.find((p) => p.name === "第二组");
      await open();
      await dialog.locator("[data-model-profiles]").selectOption(secondProfile.id);
      await expect(dialog.locator('[name="apiKey"]')).toHaveValue("");
      await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
      await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
      if (!native) {
        await contextWindow.scrollIntoViewIfNeeded();
        await page.screenshot({ path: ".tmp/model-profiles-settings.png" });
        await page.setViewportSize({ width: 320, height: 568 });
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await save(true);
      if (!native) await page.setViewportSize({ width: 1440, height: 900 });
      if (native) {
        await app.close();
        app = undefined;
        await launch();
      } else await page.reload();
      dialog = page.getByRole("dialog", { name: "连接模型" });
      expect((await status()).activeProfileId).toBe(secondProfile.id);
      expect((await status()).contextWindow).toBe(128000);
      await expect(page.locator("#composer-input")).toHaveValue("切换配置保留草稿");
      await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", taskId);
      await expect(page.locator(".model-name")).toHaveText("second-model");
      await page.locator("#composer-input").fill("继续刚才的会话");
      await page.locator("#send-button").click();
      await expect(page.locator("#conversation")).toContainText("第二组继续回复", { timeout: 30_000 });
      await expect(page.locator("#stop-button")).toBeHidden();
      await waitForIdle(taskId);
      const request = second.requests.at(-1);
      expect(request.body.model).toBe("second-model");
      expect(JSON.stringify(request.body.input)).toContain("请记住暗号蓝鲸");
      expect(JSON.stringify(request.body.input)).toContain("第一组已回复");
      await open();
      await dialog.locator("[data-model-profiles]").selectOption(firstId);
      await save(true);
      await expect(page.locator(".model-name")).toHaveText("first-model");
      expect((await status()).profiles).toHaveLength(2);
      expect((await status()).contextWindow).toBe(64000);
    } finally {
      await app?.close();
      await dashboard?.stop();
      await first.close();
      await second.close();
      if (native) await stopNativeBackend(root);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("legacy minimal connections retain their effort until another level is chosen", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "推理配置已生效" }));
  const dashboard = await startDashboard();
  const status = async () => (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
  const open = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator("#desktop-model-settings").click();
  };
  try {
    const saved = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        model: "legacy-effort-model",
        apiKey: "synthetic-legacy-key",
        reasoningEffort: "minimal",
        supportsReasoningEffort: true
      }
    });
    expect(saved.ok()).toBe(true);
    await page.goto(dashboard.base);
    await open();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.getByText("高级连接参数", { exact: true }).click();
    const effort = dialog.locator('[name="reasoningEffort"]');
    expect(
      await effort.locator("option:not(:disabled)").evaluateAll((nodes) => nodes.map((n) => n.value))
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    await expect(effort).toHaveValue("minimal");
    await dialog.locator('[name="profileName"]').fill("保留历史推理配置");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await status()).reasoningEffort).toBe("minimal");
    await open();
    await effort.selectOption("low");
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await status()).reasoningEffort).toBe("low");
    await page.locator("#composer-input").fill("验证已测试的推理配置");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("推理配置已生效", { timeout: 30_000 });
    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) expect(request.body.reasoning_effort).toBe("low");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("a tested connection rejected during a run can be saved after the run finishes", async ({ page }) => {
  test.setTimeout(90_000);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = await modelProtocolFixture("openai-completions", async () => {
    await gate;
    return { text: "任务已结束，可以保存连接" };
  });
  const dashboard = await startDashboard();
  const status = async () => (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
  try {
    await page.goto(dashboard.base);
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="model"]').fill("initial-model");
    await dialog.locator('[name="apiKey"]').fill("synthetic-initial-key");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.locator("#composer-input").fill("等待任务结束后再保存模型配置");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(1);
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    expect(taskId).toBeTruthy();
    await page.locator("#composer-input").fill("保留任务草稿");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator("#desktop-model-settings").click();
    await dialog.locator('[name="model"]').fill("updated-model");
    await dialog.locator('[name="apiKey"]').fill("synthetic-updated-key");
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    const beforeSaveUrl = page.url();
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog.locator("[data-model-error]")).toContainText("停止运行中的任务");
    await expect(dialog.locator("[data-model-result]")).toContainText("保存未完成");
    await expect(dialog.getByRole("button", { name: "保存连接", exact: true })).toBeEnabled();
    expect(page.url()).toBe(beforeSaveUrl);
    expect((await status()).model).toBe("initial-model");
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("保留任务草稿");
    release();
    await expect(page.locator("#conversation")).toContainText("任务已结束，可以保存连接", {
      timeout: 30_000
    });
    await expect
      .poll(
        async () => {
          const detail = await (
            await page.request.get(`${dashboard.base}/api/tasks/${encodeURIComponent(taskId)}`)
          ).json();
          return detail.runtime?.active;
        },
        { timeout: 30_000 }
      )
      .toBe(false);
    await expect(page.locator("#stop-button")).toBeHidden();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator("#desktop-model-settings").click();
    await expect(dialog.locator('[name="model"]')).toHaveValue("updated-model");
    await expect(dialog.locator('[name="apiKey"]')).toHaveValue("synthetic-updated-key");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await status()).model).toBe("updated-model");
    await expect(page.locator("#composer-input")).toHaveValue("保留任务草稿");
  } finally {
    release();
    await dashboard.stop();
    await provider.close();
  }
});

test("switching connections during an active run is rejected without changing the current service", async ({
  page
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = await modelProtocolFixture("openai-completions", async () => {
    await gate;
    return { text: "运行完成后再切换" };
  });
  const dashboard = await startDashboard();
  try {
    const first = {
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      model: "running-model",
      apiKey: "local-running-key"
    };
    expect((await page.request.post(`${dashboard.base}/api/model-settings`, { data: first })).ok()).toBe(
      true
    );
    const saved = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: { ...first, profileId: "", profileName: "备用", model: "next-model", activate: false }
    });
    const before = await saved.json();
    const next = before.profiles.find((p) => p.name === "备用");
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("测试运行期间的配置保护");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(1);
    const blocked = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: { ...next, profileId: next.id, activate: true }
    });
    expect(blocked.ok()).toBe(false);
    expect((await blocked.json()).error).toContain("停止运行中的任务");
    expect(
      (await (await page.request.get(`${dashboard.base}/api/model-settings`)).json()).activeProfileId
    ).toBe(before.activeProfileId);
    release();
    await expect(page.locator("#conversation")).toContainText("运行完成后再切换", { timeout: 30_000 });
    await expect(page.locator("#stop-button")).toBeHidden();
    const switched = await page.request.post(`${dashboard.base}/api/model-settings`, {
      data: { ...next, profileId: next.id, activate: true }
    });
    expect(switched.ok()).toBe(true);
    expect((await switched.json()).activeProfileId).toBe(next.id);
  } finally {
    release();
    await dashboard.stop();
    await provider.close();
  }
});

test("composer reasoning level is sent with the selected Main request", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "推理档位已生效" }));
  const dashboard = await startDashboard({
    modelEndpoint: provider.baseUrl,
    env: { COWORK_SUPPORTS_REASONING_EFFORT: "1" }
  });
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#reasoning-select")).toHaveAttribute("aria-label", "推理强度：高");
    await page.locator("#reasoning-select").click();
    await expect(page.locator("#reasoning-menu")).toBeVisible();
    await expect(page.locator("#reasoning-menu [data-thinking-level]")).toHaveCount(7);
    await page.locator('#reasoning-menu [data-thinking-level="high"]').click();
    await expect(page.locator("#reasoning-select")).toHaveAttribute("aria-label", "推理强度：高");
    await page.locator("#composer-input").fill("用高推理强度完成这条消息");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("推理档位已生效", { timeout: 30_000 });
    expect(provider.requests.at(-1).body.reasoning_effort).toBe("high");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("advanced model fields may stay empty when saving a connection", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions", () => ({ text: "连接已保存" }));
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#model-setup-button").click();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator('[name="profileName"]').fill("可选高级参数");
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="model"]').fill("optional-fields-model");
    await dialog.locator('[name="apiKey"]').fill("synthetic-key");
    await dialog.locator("summary").click();
    for (const name of ["contextWindow", "mainMaxTokens", "subagentMaxTokens"])
      await dialog.locator(`[name="${name}"]`).fill("");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(status.contextWindow).toBe(256000);
    expect(status.mainMaxTokens).toBe(8192);
    expect(status.subagentMaxTokens).toBe(8192);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});
