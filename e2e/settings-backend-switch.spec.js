import { expect, test } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { saveTestConnection } from "../test/model-provider-fixture.mjs";
import { openModelSettings } from "./model-provider-ui.js";
import { openWebSearchSettings } from "./settings-helper.js";
import { createServer } from "node:net";
import { once } from "node:events";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return response.json();
}

const request = (base) => async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
};

test("dirty model and search settings stay with their backend when switching", async ({ page }) => {
  const portA = await freePort();
  let portB = await freePort();
  while (portA === portB) portB = await freePort();
  const origins = `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`;
  const a = await startDashboard({
    defaultProject: false,
    port: portA,
    env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
  });
  let b;
  try {
    b = await startDashboard({
      defaultProject: false,
      port: portB,
      env: { COWORK_TRUSTED_CLIENT_ORIGINS: origins }
    });
    for (const [backend, name] of [
      [a, "a"],
      [b, "b"]
    ]) {
      await saveTestConnection(request(backend.base), {
        profileName: `profile-${name}`,
        baseUrl: `https://${name}.invalid/v1`,
        model: `model-${name}`,
        api: "openai-completions",
        apiKey: `initial-key-${name}`
      });
    }
    await post(b.base, "/api/web-search-settings", { provider: "off" });
    const requests = [];
    page.on("request", (request) => {
      if (/\/api\/(model-settings\/providers|web-search-settings)$/.test(new URL(request.url()).pathname))
        requests.push({ url: request.url(), method: request.method(), body: request.postDataJSON() });
    });
    await page.goto(a.base);
    // A provider's unsaved edits are drafts of the backend they were made on.
    const openModel = async () => {
      const panel = await openModelSettings(page);
      await panel.locator(".provider-item").first().click();
      return panel;
    };
    const openSearch = async () => openWebSearchSettings(page);
    const switchTo = async (base) => {
      // The model and search dialogs leave the settings page open behind them.
      if (!(await page.locator("#settings-entry").isVisible()))
        await page.locator("#user-menu-button").click();
      await page.locator('[data-settings-section="nodes"]').click();
      await page.locator("[data-backend-open]").click();
      const dialog = page.getByRole("dialog", { name: "后端", exact: true });
      await dialog.locator('[name="baseUrl"]').fill(base);
      await dialog.locator('button[type="submit"]').click();
      await expect(dialog).toBeHidden();
      // The switch reloads the page; the node row is read again from settings.
      if (!(await page.locator("#settings-entry").isVisible()))
        await page.locator("#user-menu-button").click();
      await page.locator('[data-settings-section="nodes"]').click();
      await expect(page.locator("[data-backend-status]")).toContainText(new URL(base).port);
      await page.locator("#settings-back").click();
    };

    let model = await openModel();
    await expect(model.locator(".provider-name-input")).toHaveValue("profile-a");
    await model.locator(".provider-name-input").fill("draft-name-a");
    await model.locator('[data-field="apiKey"]').fill("draft-key-a");
    await model.locator('[data-field="baseUrl"]').fill("https://draft-a.invalid/v1");
    let search = await openSearch();
    await expect(search.locator('[name="provider"]')).toHaveValue("exa");
    await search.locator("details summary").click();
    await search.locator('[name="exaApiKey"]').fill("draft-search-a");
    await search.locator("[data-search-close]").click();

    await switchTo(b.base);
    model = await openModel();
    await expect(model.locator(".provider-name-input")).toHaveValue("profile-b");
    await expect(model.locator('[data-field="apiKey"]')).toHaveValue("");
    await model.locator(".provider-name-input").fill("saved-name-b");
    await model.locator('[data-field="apiKey"]').fill("saved-key-b");
    await model.locator("[data-provider-save]").click();
    await expect(model.locator("[data-provider-save]")).toBeHidden();
    search = await openSearch();
    await expect(search.locator('[name="provider"]')).toHaveValue("off");
    await expect(search.locator('[name="exaApiKey"]')).toHaveValue("");
    await search.locator("[data-search-close]").click();
    search = await openSearch();
    await search.locator('[name="provider"]').selectOption("exa");
    if (!(await search.locator("details").evaluate((element) => element.open)))
      await search.locator("details summary").click();
    await search.locator('[name="exaApiKey"]').fill("saved-search-b");
    await search.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(search).toBeHidden();

    await switchTo(a.base);
    model = await openModel();
    await expect(model.locator(".provider-name-input")).toHaveValue("draft-name-a");
    await expect(model.locator('[data-field="apiKey"]')).toHaveValue("draft-key-a");
    await expect(model.locator('[data-field="baseUrl"]')).toHaveValue("https://draft-a.invalid/v1");
    search = await openSearch();
    await expect(search.locator('[name="exaApiKey"]')).toHaveValue("draft-search-a");
    await search.locator("[data-search-close]").click();

    const modelA = await (await fetch(`${a.base}/api/model-settings`)).json();
    const modelB = await (await fetch(`${b.base}/api/model-settings`)).json();
    const searchA = await (await fetch(`${a.base}/api/web-search-settings`)).json();
    const searchB = await (await fetch(`${b.base}/api/web-search-settings`)).json();
    const backendA = await (await fetch(`${a.base}/api/backend`)).json();
    const backendB = await (await fetch(`${b.base}/api/backend`)).json();
    expect(modelA.providers[0].name).toBe("profile-a");
    expect(modelB.providers[0].name).toBe("saved-name-b");
    expect(searchA).toMatchObject({ provider: "exa", authenticated: false });
    expect(searchB).toMatchObject({ provider: "exa", authenticated: true });
    expect(JSON.stringify(modelB)).not.toContain("saved-key-b");
    expect(JSON.stringify(searchB)).not.toContain("saved-search-b");
    expect(
      requests.filter((request) => request.method === "POST").map((request) => new URL(request.url).origin)
    ).toEqual([b.base, b.base]);
    expect(
      requests.find(
        (request) => request.url === `${b.base}/api/model-settings/providers` && request.method === "POST"
      ).body.apiKey
    ).toBe("saved-key-b");
    expect(
      requests.find(
        (request) => request.url === `${b.base}/api/web-search-settings` && request.method === "POST"
      ).body.exaApiKey
    ).toBe("saved-search-b");
    console.log(
      "Settings switch evidence:",
      JSON.stringify({
        browser: page.context().browser().version(),
        a: {
          backendId: backendA.backendId,
          pid: a.child.pid,
          root: a.root,
          provider: modelA.providers[0].name,
          search: searchA.provider
        },
        b: {
          backendId: backendB.backendId,
          pid: b.child.pid,
          root: b.root,
          provider: modelB.providers[0].name,
          search: searchB.provider,
          searchAuthenticated: searchB.authenticated
        },
        saves: requests
          .filter((request) => request.method === "POST")
          .map((request) => ({ origin: new URL(request.url).origin, path: new URL(request.url).pathname })),
        aDraftsRestored: true,
        bResponsesRedacted: true
      })
    );
  } finally {
    await b?.stop();
    await a.stop();
  }
});
