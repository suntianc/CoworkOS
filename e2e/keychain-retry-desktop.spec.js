import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "./desktop-runtime-helper.js";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";
import { stopNativeBackend } from "../test/native-backend-fixture.mjs";

test("fresh Keychain helpers preserve the existing Electron ciphertext format", async () => {
  test.skip(process.platform !== "darwin", "macOS Keychain process acceptance");
  test.setTimeout(180000);
  const data = await mkdtemp(join(tmpdir(), "atria-keychain-compat-"));
  let native;
  try {
    native = await electron.launch({
      executablePath: await developmentExecutable(),
      args: ["--use-mock-keychain", resolve(".")],
      env: desktopSmokeEnvironment({ data })
    });
    const page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toBeVisible();
    const result = await native.evaluate(async ({ app, safeStorage }, root) => {
      const { createRequire } = process.getBuiltinModule("node:module");
      const require = createRequire(root + "/package.json");
      const { createRetryableStorage } = require(root + "/desktop/retryable-storage.cjs");
      const storage = createRetryableStorage({
        executable: process.execPath,
        args: [app.getAppPath(), "--use-mock-keychain"]
      });
      const secret = "synthetic-compatibility-marker";
      try {
        const previousCipher = safeStorage.encryptString(secret);
        await storage.retry();
        const previousReadable = (await storage.decryptString(previousCipher)) === secret;
        const newCipher = await storage.encryptString(secret);
        const nativeReadable = safeStorage.decryptString(newCipher) === secret;
        await storage.retry();
        const freshReadable = (await storage.decryptString(newCipher)) === secret;
        // A renamed packaged Helper can answer once before its GPU subprocess
        // crashes. Verify the same worker survives and can still read later.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const retainedReadable = (await storage.decryptString(newCipher)) === secret;
        return {
          previousReadable,
          nativeReadable,
          freshReadable,
          retainedReadable,
          version: newCipher.subarray(0, 3).toString()
        };
      } finally {
        await storage.close();
      }
    }, resolve("."));
    expect(result).toEqual({
      previousReadable: true,
      nativeReadable: true,
      freshReadable: true,
      retainedReadable: true,
      version: "v10"
    });
    const dialog = page.getByRole("dialog", { name: "连接模型", exact: true });
    if (!(await dialog.isVisible())) await page.locator("#model-setup-button").click();
    await dialog.locator('[name="baseUrl"]').fill("http://127.0.0.1:9/v1");
    await dialog.locator('[name="model"]').fill("keychain-fixture");
    await dialog.locator('[name="apiKey"]').fill("synthetic-compatibility-marker");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (
              await (
                await fetch("/api/model-settings", {
                  headers: window.bookmanDesktop?.transportNonce
                    ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
                    : {}
                })
              ).json()
            ).configured
        )
      )
      .toBe(true);
    await expect(dialog).toBeHidden();
    await expect(page.locator("#composer-input")).toBeVisible();
  } finally {
    await native?.close();
    await stopNativeBackend(data);
    await rm(data, { recursive: true, force: true });
  }
});
