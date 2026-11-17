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
  { name, baseUrl, apiKey, api = "openai-completions", model, preset }
) {
  const add = page.locator(".provider-dialog.is-add");
  if (!(await add.isVisible())) {
    const panel = await openModelSettings(page);
    await panel.locator("[data-provider-add]").first().click();
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
  await expect(fetch.locator("[data-fetch-lead]")).not.toHaveText(/正在从服务商读取/);
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
