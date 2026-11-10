import { expect, test } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
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
      await post(backend.base, "/api/model-settings", {
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
      if (/\/api\/(model-settings|web-search-settings)$/.test(new URL(request.url()).pathname))
        requests.push({ url: request.url(), method: request.method(), body: request.postDataJSON() });
    });
    await page.goto(a.base);
    const openModel = async () => {
      await page.locator("#user-menu-button").click();
      await page.locator('[data-settings-section="models"]').click();
      await page.locator("[data-model-edit]").first().click();
      return page.getByRole("dialog", { name: "连接模型", exact: true });
    };
    const openSearch = async () => {
      await page.locator("#user-menu-button").click();
      await page.locator('[data-settings-section="tools"]').click();
      await page.locator("[data-search-open]").click();
      return page.getByRole("dialog", { name: "联网搜索", exact: true });
    };
    const switchTo = async (base) => {
      await page.locator("#user-menu-button").click();
      await page.locator('[data-settings-section="nodes"]').click();
      await page.locator("[data-backend-open]").click();
      const dialog = page.getByRole("dialog", { name: "后端", exact: true });
      await dialog.locator('[name="baseUrl"]').fill(base);
      await dialog.locator('button[type="submit"]').click();
      await expect(dialog).toBeHidden();
      // The switch reloads the page; the node row is read again from settings.
      await page.locator("#user-menu-button").click();
      await page.locator('[data-settings-section="nodes"]').click();
      await expect(page.locator("[data-backend-status]")).toContainText(new URL(base).port);
      await page.locator("#settings-back").click();
    };

    let model = await openModel();
    await expect(model.locator('[name="model"]')).toHaveValue("model-a");
    await model.locator('[name="model"]').fill("draft-model-a");
    await model.locator('[name="apiKey"]').fill("draft-key-a");
    await model.locator("details summary").click();
    await model.locator('[name="contextWindow"]').fill("");
    await model.locator('[name="mainMaxTokens"]').fill("2048");
    await model.locator('[name="subagentMaxTokens"]').fill("");
    await model.locator("[data-model-close]").click();
    let search = await openSearch();
    await expect(search.locator('[name="provider"]')).toHaveValue("exa");
    await search.locator("details summary").click();
    await search.locator('[name="exaApiKey"]').fill("draft-search-a");
    await search.locator("[data-search-close]").click();

    await switchTo(b.base);
    model = await openModel();
    await expect(model.locator('[name="model"]')).toHaveValue("model-b");
    await expect(model.locator('[name="apiKey"]')).toHaveValue("");
    await model.locator("[data-model-close]").click();
    model = await openModel();
    await model.locator('[name="model"]').fill("saved-model-b");
    await model.locator('[name="apiKey"]').fill("saved-key-b");
    await model.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(model).toBeHidden();
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
    await expect(model.locator('[name="model"]')).toHaveValue("draft-model-a");
    await expect(model.locator('[name="apiKey"]')).toHaveValue("draft-key-a");
    await expect(model.locator('[name="contextWindow"]')).toHaveValue("");
    await expect(model.locator('[name="mainMaxTokens"]')).toHaveValue("2048");
    await expect(model.locator('[name="subagentMaxTokens"]')).toHaveValue("");
    await model.locator("[data-model-close]").click();
    search = await openSearch();
    await expect(search.locator('[name="exaApiKey"]')).toHaveValue("draft-search-a");
    await search.locator("[data-search-close]").click();

    const modelA = await (await fetch(`${a.base}/api/model-settings`)).json();
    const modelB = await (await fetch(`${b.base}/api/model-settings`)).json();
    const searchA = await (await fetch(`${a.base}/api/web-search-settings`)).json();
    const searchB = await (await fetch(`${b.base}/api/web-search-settings`)).json();
    const backendA = await (await fetch(`${a.base}/api/backend`)).json();
    const backendB = await (await fetch(`${b.base}/api/backend`)).json();
    expect(modelA.model).toBe("model-a");
    expect(modelB.model).toBe("saved-model-b");
    expect(searchA).toMatchObject({ provider: "exa", authenticated: false });
    expect(searchB).toMatchObject({ provider: "exa", authenticated: true });
    expect(JSON.stringify(modelB)).not.toContain("saved-key-b");
    expect(JSON.stringify(searchB)).not.toContain("saved-search-b");
    expect(
      requests.filter((request) => request.method === "POST").map((request) => new URL(request.url).origin)
    ).toEqual([b.base, b.base]);
    expect(
      requests.find((request) => request.url === `${b.base}/api/model-settings` && request.method === "POST")
        .body.apiKey
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
          model: modelA.model,
          search: searchA.provider
        },
        b: {
          backendId: backendB.backendId,
          pid: b.child.pid,
          root: b.root,
          model: modelB.model,
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
