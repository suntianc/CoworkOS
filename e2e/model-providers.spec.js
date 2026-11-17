import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";
import { pageRequest, saveTestConnection } from "../test/model-provider-fixture.mjs";
import {
  activeModelOf,
  addProviderThroughUi,
  checkProvider,
  chooseRoleModel,
  leaveSettings,
  openModelParams,
  openModelSettings,
  saveProviderEdits,
  selectProvider,
  setupDialog,
  windowRequest
} from "./model-provider-ui.js";

const waitForIdle = (page, taskId) =>
  expect
    .poll(
      async () =>
        (await windowRequest(page)(`/api/tasks/${encodeURIComponent(taskId)}`)).body.runtime?.active,
      { timeout: 30_000 }
    )
    .toBe(false);

for (const native of [false, true]) {
  test(`${native ? "desktop" : "web"}: Main moves between providers of different formats and continues the same conversation`, async ({
    page: browserPage
  }) => {
    test.skip(native && process.platform !== "darwin", "Native test requires macOS");
    test.setTimeout(120_000);
    const first = await modelProtocolFixture("openai-completions", () => ({ text: "第一家已回复" }), {
      models: []
    });
    const second = await modelProtocolFixture("openai-responses", () => ({ text: "第二家继续回复" }), {
      models: [{ id: "second-model" }]
    });
    const root = await mkdtemp(join(tmpdir(), "atria-providers-e2e-"));
    let app, dashboard, page;
    const launch = async () => {
      const keep = [
        "COWORK_DESKTOP_DATA",
        "ATRIA_HOME",
        "PI_CODING_AGENT_DIR",
        "COWORK_DISABLE_MAIN_GUARDIAN",
        "PI_OFFLINE"
      ];
      const env = {
        ...process.env,
        COWORK_DESKTOP_DATA: root,
        ATRIA_HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "pi"),
        COWORK_DISABLE_MAIN_GUARDIAN: "1",
        PI_OFFLINE: "1"
      };
      for (const name of Object.keys(env))
        if (/^(?:COWORK_|ATRIA_|PI_)/.test(name) && !keep.includes(name)) delete env[name];
      delete env.ELECTRON_RUN_AS_NODE;
      app = await electron.launch({
        executablePath: await developmentExecutable(),
        args: ["--use-mock-keychain", resolve(".")],
        env
      });
      page = await app.firstWindow();
    };
    const status = async () => (await windowRequest(page)("/api/model-settings")).body;
    try {
      if (native) await launch();
      else {
        dashboard = await startDashboard();
        page = browserPage;
        await page.goto(dashboard.base);
        await page.locator("#model-setup-button").click();
      }
      // First use opens the add dialog on the model page.
      await expect(setupDialog(page)).toBeVisible();
      await addProviderThroughUi(page, {
        name: "第一家",
        baseUrl: first.baseUrl,
        model: "first-model",
        apiKey: "local-first-key"
      });

      // A model's limits are its own; an invalid one keeps the dialog open.
      let params = await openModelParams(page, "first-model");
      const contextWindow = params.locator('[data-model-field="contextWindow"]');
      await expect(contextWindow).toHaveValue("256000");
      await contextWindow.fill("0");
      await params.locator("[data-model-save]").click();
      await expect(params.locator("[data-model-error]")).toContainText("上下文窗口");
      await contextWindow.fill("64000");
      await params.locator("[data-model-save]").click();
      await expect(params).toBeHidden();
      await leaveSettings(page);

      if (native) {
        await page.locator("#new-project").click();
        await page.locator("#add-project-name").fill("供应商切换验收项目");
        await page.locator("#add-project-directory").fill(root);
        await page.locator("#add-project-submit").click();
        await expect(page.locator("#add-project-modal")).toBeHidden();
      }
      await page.locator("#composer-input").fill("请记住暗号蓝鲸");
      await page.locator("#send-button").click();
      await expect(page.locator("#conversation")).toContainText("第一家已回复", { timeout: 30_000 });
      await expect(page.locator("#stop-button")).toBeHidden();
      const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
      await waitForIdle(page, taskId);

      // A second provider joins without taking Main, and its model comes from /models.
      await page.locator("#composer-input").fill("切换供应商保留草稿");
      await addProviderThroughUi(page, {
        name: "第二家",
        baseUrl: second.baseUrl,
        api: "openai-responses",
        model: "second-model",
        apiKey: "local-second-key"
      });
      params = await openModelParams(page, "second-model");
      await params.locator('[data-model-field="contextWindow"]').fill("128000");
      await params.locator("[data-model-save]").click();
      await expect(params).toBeHidden();
      expect((await status()).model).toBe("first-model");
      await expect(await checkProvider(page)).toContainText("连接通过");

      // An unsaved edit on one provider survives looking at another.
      await page.locator(".provider-name-input").fill("第二家（草稿）");
      await selectProvider(page, "第一家");
      await page.locator(".provider-item", { hasText: "第二家" }).click();
      await expect(page.locator(".provider-name-input")).toHaveValue("第二家（草稿）");
      await page.locator("[data-provider-discard]").click();
      await expect(page.locator(".provider-name-input")).toHaveValue("第二家");

      await chooseRoleModel(page, "main", "second-model");
      await leaveSettings(page);
      if (native) {
        await app.close();
        app = undefined;
        await launch();
      } else await page.reload();
      await expect.poll(async () => activeModelOf(await status())?.id).toBe("second-model");
      expect(activeModelOf(await status()).contextWindow).toBe(128000);
      await expect(page.locator("#composer-input")).toHaveValue("切换供应商保留草稿");
      await expect(page.locator(".conversation-item.active")).toHaveAttribute("data-task", taskId);
      await expect(page.locator(".model-name")).toHaveText("second-model");
      await page.locator("#composer-input").fill("继续刚才的会话");
      await page.locator("#send-button").click();
      await expect(page.locator("#conversation")).toContainText("第二家继续回复", { timeout: 30_000 });
      await expect(page.locator("#stop-button")).toBeHidden();
      await waitForIdle(page, taskId);
      const request = second.requests.at(-1);
      expect(request.body.model).toBe("second-model");
      expect(JSON.stringify(request.body.input)).toContain("请记住暗号蓝鲸");
      expect(JSON.stringify(request.body.input)).toContain("第一家已回复");

      await chooseRoleModel(page, "main", "first-model");
      await leaveSettings(page);
      await expect(page.locator(".model-name")).toHaveText("first-model");
      expect(activeModelOf(await status()).contextWindow).toBe(64000);
    } finally {
      await app?.close();
      await dashboard?.stop();
      await first.close();
      await second.close();
      if (native) await stopNativeBackend(root);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test("a provider check probes the saved model's settings and keeps the task draft", async ({ page }) => {
  const provider = await modelProtocolFixture("openai-completions", undefined, {
    models: [{ id: "connection-fixture" }]
  });
  const dashboard = await startDashboard();
  try {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("检查连接不会丢失任务草稿");
    await page.locator("#model-setup-button").click();
    await expect(setupDialog(page)).toBeVisible();
    await addProviderThroughUi(page, {
      baseUrl: provider.baseUrl,
      model: "connection-fixture",
      apiKey: "private-test-key"
    });
    let result = await checkProvider(page);
    await expect(result).toContainText("连接通过");
    const probe = provider.requests.at(-1).body;
    expect(probe.stream).toBe(true);
    expect(probe.max_completion_tokens).toBe(8192);
    expect(probe.reasoning_effort).toBeUndefined();
    expect(
      probe.messages
        .find((message) => message.role === "user")
        .content.some((block) => block.type === "image_url")
    ).toBe(false);

    // Image input is a model setting; the next check sends a picture.
    const params = await openModelParams(page, "connection-fixture");
    await params.locator('[data-model-switch="supportsImages"]').click();
    await params.locator("[data-model-save]").click();
    await expect(params).toBeHidden();
    // The fixture cannot read pictures, so the check now fails on the image challenge.
    result = await checkProvider(page);
    await expect(result).toContainText("测试图片");
    expect(
      provider.requests
        .at(-1)
        .body.messages.find((message) => message.role === "user")
        .content.some((block) => block.type === "image_url")
    ).toBe(true);

    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await leaveSettings(page);
    await expect(page.locator("#composer-input")).toHaveValue("检查连接不会丢失任务草稿");
    const status = await (await page.request.get(`${dashboard.base}/api/model-settings`)).json();
    expect(activeModelOf(status).supportsImages).toBe(true);
    expect(JSON.stringify(status)).not.toContain("private-test-key");
    expect(JSON.parse(await readFile(join(dashboard.root, "config.json"), "utf8")).model).toBe(
      "connection-fixture"
    );
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("a refused key fails the check with a plain message", async ({ page }) => {
  const dashboard = await startDashboard();
  const refusing = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") return res.end('{"data":[]}');
    res.writeHead(401);
    res.end('{"error":{"message":"private-test-key provider detail"}}');
  });
  await new Promise((done) => refusing.listen(0, "127.0.0.1", done));
  try {
    await page.goto(dashboard.base);
    await page.locator("#model-setup-button").click();
    await expect(setupDialog(page)).toBeVisible();
    await addProviderThroughUi(page, {
      baseUrl: `http://127.0.0.1:${refusing.address().port}/v1`,
      model: "refused-fixture",
      apiKey: "private-test-key"
    });
    const result = await checkProvider(page);
    await expect(result).toContainText("认证失败");
    await expect(result).not.toContainText("provider detail");
  } finally {
    await dashboard.stop();
    refusing.closeAllConnections();
    await new Promise((done) => refusing.close(done));
  }
});

test("a provider edit refused during a run keeps its draft and saves after the run", async ({ page }) => {
  test.setTimeout(90_000);
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const provider = await modelProtocolFixture("openai-completions", async () => {
    await gate;
    return { text: "任务已结束，可以保存供应商" };
  });
  const dashboard = await startDashboard();
  const request = pageRequest(page, dashboard.base);
  try {
    await saveTestConnection(request, {
      profileName: "运行中供应商",
      baseUrl: provider.baseUrl,
      model: "initial-model",
      apiKey: "synthetic-initial-key"
    });
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("等待任务结束后再保存供应商");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(1);
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    await page.locator("#composer-input").fill("保留任务草稿");

    await selectProvider(page, "运行中供应商");
    await page.locator(".provider-name-input").fill("改名后的供应商");
    await saveProviderEdits(page);
    await expect(page.locator("#toast")).toContainText("停止运行中的任务");
    await expect(page.locator(".provider-name-input")).toHaveValue("改名后的供应商");
    expect((await request("/api/model-settings")).body.providers[0].name).toBe("运行中供应商");
    await leaveSettings(page);
    await expect(page.locator("#composer-input")).toHaveValue("保留任务草稿");

    release();
    await expect(page.locator("#conversation")).toContainText("任务已结束，可以保存供应商", {
      timeout: 30_000
    });
    await waitForIdle(page, taskId);
    await openModelSettings(page);
    await expect(page.locator(".provider-name-input")).toHaveValue("改名后的供应商");
    await saveProviderEdits(page);
    await expect(page.locator("[data-provider-save]")).toBeHidden();
    expect((await request("/api/model-settings")).body.providers[0].name).toBe("改名后的供应商");
    await leaveSettings(page);
    await expect(page.locator("#composer-input")).toHaveValue("保留任务草稿");
  } finally {
    release();
    await dashboard.stop();
    await provider.close();
  }
});

test("moving Main to another model during a run leaves that turn alone and takes the next one", async ({
  page
}) => {
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const provider = await modelProtocolFixture("openai-completions", async (body) => {
    if (body.model === "running-model") await gate;
    return { text: `${body.model} 已回复` };
  });
  const dashboard = await startDashboard();
  const request = pageRequest(page, dashboard.base);
  try {
    const first = await saveTestConnection(request, {
      baseUrl: provider.baseUrl,
      model: "running-model",
      apiKey: "local-running-key"
    });
    const next = await saveTestConnection(request, {
      profileName: "备用",
      baseUrl: provider.baseUrl,
      model: "next-model",
      apiKey: "local-running-key",
      activate: false
    });
    expect((await request("/api/model-settings")).body.activeProfileId).toBe(first.profileId);
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("运行期间切换 Main 的模型");
    await page.locator("#send-button").click();
    await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(1);
    // A role binding is read when a turn starts, so it may change while one runs.
    const switched = await request("/api/model-settings/roles", { role: "main", profileId: next.profileId });
    expect(switched.status).toBe(200);
    expect(switched.body.activeProfileId).toBe(next.profileId);
    release();
    await expect(page.locator("#conversation")).toContainText("running-model 已回复", { timeout: 30_000 });
    await expect(page.locator("#stop-button")).toBeHidden();
    await page.locator("#composer-input").fill("下一轮用新的模型");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("next-model 已回复", { timeout: 30_000 });
    expect(provider.requests.at(-1).body.model).toBe("next-model");
  } finally {
    release();
    await dashboard.stop();
    await provider.close();
  }
});

test("the composer switches one conversation to another provider's model and back", async ({ page }) => {
  const alpha = await modelProtocolFixture("openai-completions", (body) => ({ text: `${body.model} 来自甲` }));
  const beta = await modelProtocolFixture("openai-completions", (body) => ({ text: `${body.model} 来自乙` }));
  const dashboard = await startDashboard();
  const request = pageRequest(page, dashboard.base);
  try {
    await saveTestConnection(request, {
      profileName: "甲供应商",
      baseUrl: alpha.baseUrl,
      model: "alpha-model",
      apiKey: "local-alpha-key"
    });
    const other = await saveTestConnection(request, {
      profileName: "乙供应商",
      baseUrl: beta.baseUrl,
      model: "beta-model",
      apiKey: "local-beta-key",
      activate: false
    });
    await page.goto(dashboard.base);
    await expect(page.locator("#model-select .model-name")).toHaveText("alpha-model");
    await expect(page.locator("#model-select .model-logo .provider-logo")).toHaveText("甲");
    await page.locator("#composer-input").fill("第一轮走 Main 的连接");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("alpha-model 来自甲", { timeout: 30_000 });
    await expect(page.locator("#stop-button")).toBeHidden();

    // The picker lists both providers; a model of the other one pins its connection.
    await page.locator("#model-select").click();
    await page.locator('#model-menu [data-picker-page="models"]').click();
    await expect(page.locator("#model-menu .picker-group")).toHaveText(["甲供应商", "乙供应商"]);
    await page.locator(`#model-menu [data-profile="${other.profileId}"]`).click();
    await expect(page.locator("#model-select .model-name")).toHaveText("beta-model");
    await expect(page.locator("#model-select .model-logo .provider-logo")).toHaveText("乙");
    await page.keyboard.press("Escape");
    await page.locator("#composer-input").fill("第二轮换到乙");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("beta-model 来自乙", { timeout: 30_000 });
    expect(beta.requests.at(-1).body.model).toBe("beta-model");
    await expect(page.locator("#stop-button")).toBeHidden();

    // Back on the Main connection's model, the next turn returns to it.
    await page.locator("#model-select").click();
    await page.locator('#model-menu [data-picker-page="models"]').click();
    await page.locator('#model-menu .model-option[data-model="alpha-model"]').click();
    await page.keyboard.press("Escape");
    const alphaBefore = alpha.requests.length;
    await page.locator("#composer-input").fill("第三轮回到甲");
    await page.locator("#send-button").click();
    await expect.poll(() => alpha.requests.length, { timeout: 30_000 }).toBeGreaterThan(alphaBefore);
    expect(alpha.requests.at(-1).body.model).toBe("alpha-model");
  } finally {
    await dashboard.stop();
    await alpha.close();
    await beta.close();
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
    // Nothing is picked yet: the label is the effort this fixture's connection saved.
    await expect(page.locator("#model-select .reasoning-name")).toHaveText("关闭");
    await page.locator("#model-select").click();
    await expect(page.locator("#model-menu")).toBeVisible();
    // A relay address that names no levels offers the default six.
    await expect(page.locator("#model-menu [data-thinking-level]")).toHaveCount(5);
    await page.locator('#model-menu [data-thinking-level="high"]').click();
    await expect(page.locator("#model-select .reasoning-name")).toHaveText("高");
    await page.locator("#composer-input").fill("用高推理强度完成这条消息");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("推理档位已生效", { timeout: 30_000 });
    expect(provider.requests.at(-1).body.reasoning_effort).toBe("high");
  } finally {
    await dashboard.stop();
    await provider.close();
  }
});

test("thinking format belongs to its provider and a new provider starts on automatic detection", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const request = pageRequest(page, dashboard.base);
  try {
    await saveTestConnection(request, {
      profileName: "GLM gateway",
      baseUrl: "https://gateway.example/v1",
      model: "glm-fixture",
      apiKey: "local-fixture-key"
    });
    await saveTestConnection(request, {
      profileName: "Other gateway",
      baseUrl: "https://other.example/v1",
      model: "other-fixture",
      apiKey: "local-fixture-key",
      activate: false
    });
    await page.goto(dashboard.base);
    const panel = await selectProvider(page, "GLM gateway");
    await panel.locator(".provider-advanced > summary").click();
    const format = panel.locator('[data-field="thinkingFormat"]');
    await expect(format).toHaveValue("auto");
    await format.selectOption("zai");
    await saveProviderEdits(page);
    await expect(page.locator("[data-provider-save]")).toBeHidden();
    await page.reload();
    await selectProvider(page, "Other gateway");
    await panel.locator(".provider-advanced > summary").click();
    await expect(format).toHaveValue("auto");
    await selectProvider(page, "GLM gateway");
    await panel.locator(".provider-advanced > summary").click();
    await expect(format).toHaveValue("zai");
    const status = (await request("/api/model-settings")).body;
    expect(status.providers.find((entry) => entry.name === "GLM gateway").thinkingFormat).toBe("zai");
    expect(status.providers.find((entry) => entry.name === "Other gateway").thinkingFormat).toBe("auto");
  } finally {
    await dashboard.stop();
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 320, height: 568 }
]) {
  test(`the provider page and its dialogs fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const dashboard = await startDashboard();
    const request = pageRequest(page, dashboard.base);
    try {
      await saveTestConnection(request, {
        profileName: "布局供应商",
        baseUrl: "https://fixture.example/v1",
        api: "openai-responses",
        model: "scroll-fixture",
        apiKey: "local-fixture"
      });
      await page.goto(dashboard.base);
      await selectProvider(page, "布局供应商");
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const params = await openModelParams(page, "scroll-fixture");
      const rect = await params.boundingBox();
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
      await params.locator('[data-model-field="subagentMaxTokens"]').fill("2048");
      await params.locator("[data-model-save]").scrollIntoViewIfNeeded();
      await params.locator("[data-model-save]").click();
      await expect(params).toBeHidden();
      expect(activeModelOf((await request("/api/model-settings")).body).subagentMaxTokens).toBe(2048);
    } finally {
      await dashboard.stop();
    }
  });
}
