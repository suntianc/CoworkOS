import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("native edit restores an attachment-only message and survives relaunch with its original unsent draft", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(120000);
  await mkdir(testInfo.outputDir, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "atria-message-edit-desktop-"));
  let calls = 0;
  const provider = await modelProtocolFixture("openai-completions", (body) => {
    const context = JSON.stringify(body.messages);
    if (context.includes("NATIVE_STOP_QUESTION"))
      return { name: "askhuman", arguments: { question: "要查哪个城市？" } };
    if (context.includes("NATIVE_AFTER_STOP")) return { text: "NATIVE_AFTER_STOP_ANSWER" };
    return { text: ++calls === 1 ? "NATIVE_OLD_ANSWER" : "NATIVE_NEW_ANSWER" };
  });
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:COWORK_|ATRIA_|PI_)/.test(name)) delete env[name];
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  delete env.ELECTRON_RUN_AS_NODE;
  let native;
  const executablePath = await developmentExecutable();
  const launch = async () => {
    native = await electron.launch({ executablePath, args: ["--use-mock-keychain", resolve(".")], env });
    return native.firstWindow();
  };
  try {
    let page = await launch();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="model"]').fill("native-edit-fixture");
    await dialog.locator('[name="apiKey"]').fill("local-native-fixture");
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    // Saving applies the connection in place; the window keeps its origin.
    await expect(page.locator(".model-select")).toContainText("native-edit-fixture");
    await expect(page.getByRole("dialog", { name: "连接模型" })).toBeHidden();
    await page.locator("#new-project").click();
    await page.locator("#add-project-name").fill("修改重发验收");
    await page.locator("#add-project-directory").fill(root);
    await page.locator("#add-project-submit").click();
    await expect(page.locator("#add-project-modal")).toBeHidden();
    await expect(page.locator(".project-group.is-selected .project-name")).toContainText("修改重发验收");
    await page.locator("#composer-input").fill("UPLOAD_READINESS");
    await page.locator("#composer-input").fill("");
    const attachmentPath = join(root, "native.txt");
    await writeFile(attachmentPath, "NATIVE_ATTACHMENT_BODY");
    page.on("requestfailed", (request) =>
      console.log("native request failed", request.url(), request.failure()?.errorText)
    );
    page.on("console", (message) => {
      if (message.type() === "error") console.log("native console", message.text());
    });
    await page.locator("#file-input").setInputFiles(attachmentPath);
    await expect(page.locator("#attachment-strip")).toContainText("native.txt");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("NATIVE_OLD_ANSWER", { timeout: 30000 });
    await expect(page.locator("#stop-button")).toBeHidden();
    const taskId = new URL(page.url()).searchParams.get("task");
    await page.locator("#composer-input").fill("NATIVE_UNSENT_DRAFT\nKEEP_LINE");
    await page.getByRole("button", { name: "编辑消息" }).click();
    await expect(page.locator("[data-inline-message-edit]")).toHaveValue("");
    await expect(page.locator(".inline-edit-attachments")).toContainText("native.txt");
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("NATIVE_UNSENT_DRAFT\nKEEP_LINE");
    await page.getByRole("button", { name: "编辑消息" }).focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-inline-message-edit]").fill("NATIVE_EDITED_MESSAGE\nNEW_LINE");
    await native.close();
    native = undefined;
    const saved = JSON.parse(await readFile(join(root, "composer-drafts.json"), "utf8"));
    expect(saved.version).toBe(4);
    expect(JSON.stringify(saved)).toContain("NATIVE_UNSENT_DRAFT");
    page = await launch();
    await expect(page.locator("[data-inline-message-edit]")).toBeVisible();
    await expect(page.locator("[data-inline-message-edit]")).toHaveValue("NATIVE_EDITED_MESSAGE\nNEW_LINE");
    await expect(page.locator(".inline-edit-attachments")).toContainText("native.txt");
    await page.getByRole("button", { name: "发送编辑后的消息", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("NATIVE_UNSENT_DRAFT\nKEEP_LINE");
    await expect(page.locator("#conversation")).toContainText("NATIVE_NEW_ANSWER", { timeout: 30000 });
    const value = await page.evaluate(async (id) => {
      // The window's transport adds the host session; a bare fetch has no credential.
      const headers = window.bookmanDesktop?.transportNonce
        ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
        : {};
      return (await fetch(`/api/tasks/${encodeURIComponent(id)}`, { headers })).json();
    }, taskId);
    expect(value.conversationVersions).toHaveLength(1);
    expect(JSON.stringify(value.messages)).not.toContain("NATIVE_OLD_ANSWER");
    expect(value.conversationVersions[0].currentMessageId).toBe(value.editableMessage.messageId);
    expect(value.conversationVersions[0].messages).toBeUndefined();
    await expect(page.locator(".conversation-versions")).toHaveCount(0);
    const actual = JSON.stringify(provider.requests.at(-1).body.messages);
    expect(actual).toContain("NATIVE_EDITED_MESSAGE");
    expect(actual).toContain("native.txt");
    expect(actual).not.toContain("NATIVE_OLD_ANSWER");
    await page.locator(".composer").screenshot({ path: testInfo.outputPath("native-composer.png") });
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("NATIVE_STOP_QUESTION");
    await page.locator("#send-button").click();
    await expect(page.locator("#human-questions")).toContainText("要查哪个城市？", { timeout: 30000 });
    const stoppedTask = await page.locator(".conversation-item.active").getAttribute("data-task");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.locator('[data-session-action="stop"]').click();
    await expect(page.locator("#human-questions")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const headers = window.bookmanDesktop?.transportNonce
            ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
            : {};
          return (await (await fetch(`/api/tasks/${encodeURIComponent(id)}`, { headers })).json()).runtime
            ?.active;
        }, stoppedTask)
      )
      .toBe(false);
    await page.getByRole("button", { name: "编辑消息" }).click();
    await page.locator("[data-inline-message-edit]").fill("NATIVE_AFTER_STOP");
    const accepted = page.waitForResponse((response) =>
      response.url().endsWith(`/api/tasks/${stoppedTask}/messages/edit`)
    );
    await page.getByRole("button", { name: "发送编辑后的消息", exact: true }).click();
    expect((await accepted).status()).toBe(202);
    await expect(page.locator("#conversation")).toContainText("NATIVE_AFTER_STOP_ANSWER", { timeout: 30000 });
    await page.screenshot({ path: testInfo.outputPath("native-resend-after-question-stop.png") });
  } finally {
    await native?.close();
    const backendLog = await readFile(join(root, "logs", "dashboard.log"), "utf8").catch(() => "");
    await writeFile(testInfo.outputPath("native-backend.log"), backendLog);
    await provider.close();
    // The backend keeps writing its log while it shuts down; retry the removal
    // instead of racing it with a fixed pause.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
