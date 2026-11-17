import { expect } from "@playwright/test";

/**
 * The model page as a person uses it: settings → 模型与角色, then the add,
 * fetch and manual dialogs. Every step goes through the visible controls.
 */

/** Open settings on the model page. */
export async function openModelSettings(page) {
  const panel = page.locator('[data-settings-panel="models"]');
  if (!(await panel.isVisible())) {
    await page.locator("#user-menu-button").click();
    await page.locator('[data-settings-section="models"]').click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Add a provider and one model. Uses the add dialog if it is already open
 * (first-use setup opens it), otherwise opens it from the page. The model is
 * picked from the fetched list when the endpoint lists it, else added by id.
 */
export async function addProviderThroughUi(
  page,
  { name = "测试服务", baseUrl, apiKey, api = "openai-completions", model, preset }
) {
  const add = page.locator(".provider-dialog.is-add");
  // First-use setup opens the dialog once the empty page has loaded; let it arrive.
  if (await page.locator('[data-settings-panel="models"]').isVisible())
    await add.waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
  if (!(await add.isVisible())) {
    const panel = await openModelSettings(page);
    // The empty state and the list each carry an add button; use the one on screen.
    await panel.locator("[data-provider-add]:visible").first().click();
  }
  await expect(add).toBeVisible();
  if (preset) await add.locator(`[data-add-preset="${preset}"]`).click();
  else {
    await add.locator('[data-add-preset="custom"]').click();
    await add.locator('[data-add="name"]').fill(name);
    await add.locator('[data-add="baseUrl"]').fill(baseUrl);
    await add.locator(`[data-add-api="${api}"]`).click();
  }
  await add.locator('[data-add="apiKey"]').fill(apiKey);
  await add.locator("[data-add-submit]").click();
  await expect(add).toBeHidden();
  const fetch = page.locator(".provider-dialog.is-fetch");
  await expect(fetch).toBeVisible();
  await expect(fetch.locator(".fetch-loading")).toHaveCount(0);
  const listed = fetch.locator(`.fetch-item input[value="${model}"]`);
  if (await listed.count()) {
    await listed.check();
    await fetch.locator("[data-fetch-submit]").click();
    await expect(fetch).toBeHidden();
  } else {
    await fetch.locator("[data-fetch-cancel]").click();
    await expect(fetch).toBeHidden();
    await page.locator("[data-models-add]").click();
    const manual = page.locator(".provider-dialog.is-manual");
    await manual.locator("[data-manual-id]").fill(model);
    await manual.locator("[data-manual-submit]").click();
    await expect(manual).toBeHidden();
  }
  await expect(page.locator(`.provider-model-row[data-model-id="${model}"]`)).toBeVisible();
}

/** Choose a role's model from the role tab's picker; `label` matches the menu item. */
export async function chooseRoleModel(page, role, label) {
  const panel = await openModelSettings(page);
  await panel.locator('[data-model-tab="roles"]').click();
  await panel.locator(`[data-role-picker="${role}"]`).click();
  await page.locator(".role-menu .role-menu-item", { hasText: label }).first().click();
  await expect(panel.locator(`[data-role-picker="${role}"]`)).toContainText(label);
}

/** The add-provider dialog that first use opens over the model page. */
export const setupDialog = (page) => page.locator(".provider-dialog.is-add");

/** Leave settings for the work page, if settings are showing. */
export async function leaveSettings(page) {
  const settings = page.locator("#settings-entry");
  if (await settings.isVisible()) await page.locator("#settings-back").click();
  await expect(settings).toBeHidden();
}

/**
 * Close first use's model setup and return to the work page. With `wait` the
 * setup may not come at all (it opens once the window learns there is no model,
 * which can land after navigation); without it the setup must be showing.
 */
export async function dismissModelSetup(page, { wait } = {}) {
  const add = setupDialog(page);
  if (wait === undefined) await expect(add).toBeVisible();
  else await add.waitFor({ state: "visible", timeout: wait }).catch(() => {});
  if (await add.isVisible()) await add.locator("[data-dialog-close]").click();
  await expect(add).toBeHidden();
  await leaveSettings(page);
}

/** Add a provider with one model through the page, then return to the work page. */
export async function connectModelThroughUi(page, options) {
  await addProviderThroughUi(page, options);
  await leaveSettings(page);
}

/** Run the selected provider's check and return its result line. */
export async function checkProvider(page) {
  const panel = await openModelSettings(page);
  await panel.locator("[data-provider-check]").click();
  const result = panel.locator("[data-check-result]");
  await expect(result).not.toHaveText(/正在用/);
  return result;
}

/** Select a provider in the list by its name. */
export async function selectProvider(page, name) {
  const panel = await openModelSettings(page);
  await panel.locator('[data-model-tab="providers"]').click();
  await panel.locator(".provider-item", { hasText: name }).first().click();
  await expect(panel.locator(".provider-name-input")).toHaveValue(name);
  return panel;
}

/** Open a model's parameter dialog on the selected provider. */
export async function openModelParams(page, modelId) {
  await page.locator(`[data-model-settings="${modelId}"]`).click();
  const dialog = page.locator(".provider-dialog.is-model");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Save the selected provider's unsaved edits from its save bar. */
export async function saveProviderEdits(page) {
  await page.locator("[data-provider-save]").click();
}

/**
 * `request(path, body)` through the page itself, so a desktop window's
 * transport nonce goes with it. Answers `{ status, body }`.
 */
export const windowRequest = (page) => (path, body) =>
  page.evaluate(
    async ([target, payload]) => {
      const headers = { "content-type": "application/json" };
      const nonce = window.bookmanDesktop?.transportNonce;
      if (nonce) headers["x-cowork-desktop-nonce"] = nonce;
      const response = await fetch(target, {
        method: payload === undefined ? "GET" : "POST",
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
      });
      return { status: response.status, body: await response.json() };
    },
    [path, body]
  );

/** The model Main uses, from a settings status. */
export function activeModelOf(status) {
  // A window that is still authorizing answers with an error instead of a status.
  for (const provider of status.providers ?? [])
    for (const model of provider.models)
      if (model.profileId === status.activeProfileId) return { ...model, provider };
  return undefined;
}
