/**
 * Model provider configuration for tests.
 *
 * Most tests need "a connection": an address, a key and one model. Each entry
 * here becomes a provider with that one model, and `profileId` names the
 * flattened connection the runtime and role bindings use.
 */

const MODEL_FIELDS = [
  "reasoningEffort",
  "reasoningLevels",
  "supportsReasoningEffort",
  "mainMaxTokens",
  "subagentMaxTokens",
  "contextWindow",
  "autoLimits",
  "supportsImages"
];

/** The connection id of a provider's model. */
export const profileId = (entry) => `${entry.id}#${entry.model}`;

/** One provider entry with one model. Unset model settings take the defaults. */
export function provider(entry) {
  const model = { id: entry.model, supportsImages: entry.supportsImages === true };
  for (const field of MODEL_FIELDS)
    if (entry[field] !== undefined && field !== "supportsImages") model[field] = entry[field];
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    baseUrl: entry.baseUrl,
    api: entry.api ?? "openai-completions",
    ...(entry.thinkingFormat ? { thinkingFormat: entry.thinkingFormat } : {}),
    supportsPromptCacheKey: entry.supportsPromptCacheKey === true,
    enabled: entry.enabled ?? true,
    ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    models: [model, ...(entry.extraModels ?? [])]
  };
}

/**
 * Configuration fields for these connections. The first entry is what Main
 * uses without a binding; `main` binds Main to another one.
 */
export function providerConfig(entries, { main } = {}) {
  return {
    modelProviders: { version: 1, providers: entries.map(provider) },
    ...(main ? { roleModels: { version: 1, host: { main: { profileId: profileId(main) } } } } : {})
  };
}

/** The host credential store content for these connections' keys. */
export function providerCredentials(entries) {
  return {
    version: 1,
    modelProviders: Object.fromEntries(
      entries.filter((entry) => entry.apiKey).map((entry) => [entry.id, entry.apiKey])
    )
  };
}

const answer = (result) => ({ status: result.status, body: result.body ?? result.value });

/** The settings status as the old flat connection list, for assertions. */
export function connectionsOf(status) {
  return (status.providers ?? []).flatMap((entry) =>
    entry.models.map((model) => ({
      ...model,
      id: model.profileId,
      providerId: entry.id,
      name: entry.name,
      model: model.id,
      baseUrl: entry.baseUrl,
      api: entry.api,
      configured: entry.configured
    }))
  );
}

/**
 * Save "a connection" through the settings API: a provider with one model.
 * `request(path, body)` answers `{ status, body }` (or `{ status, value }`).
 * Like the single-connection form it replaces, a saved connection becomes the
 * one Main uses unless `activate` is false. Returns the final status with
 * `profiles`, `activeProfileId`, `profileId` and `status` added.
 */
export async function saveTestConnection(request, value) {
  const {
    profileName,
    baseUrl,
    api,
    apiKey,
    thinkingFormat,
    supportsPromptCacheKey,
    model,
    activate,
    providerId,
    // The old form's empty profile id meant "a new connection, keep the active one".
    profileId: previousForm,
    ...modelFields
  } = value;
  // Saving over an existing connection edits its provider.
  const existing = providerId ?? (previousForm ? previousForm.split("#")[0] : undefined);
  const provider = answer(
    await request("/api/model-settings/providers", {
      ...(existing ? { id: existing } : {}),
      name: profileName ?? model,
      baseUrl,
      ...(api ? { api } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(thinkingFormat ? { thinkingFormat } : {}),
      ...(supportsPromptCacheKey === undefined ? {} : { supportsPromptCacheKey })
    })
  );
  if (provider.status !== 200) return { ...provider.body, status: provider.status };
  const saved = existing
    ? provider.body.providers.find((entry) => entry.id === existing)
    : (provider.body.providers.find(
        (entry) => entry.name === (profileName ?? model) && !entry.models.length
      ) ?? provider.body.providers.at(-1));
  const models = answer(
    await request("/api/model-settings/models", {
      providerId: saved.id,
      models: [{ id: model, ...modelFields }]
    })
  );
  if (models.status !== 200) return { ...models.body, status: models.status };
  const id = `${saved.id}#${model}`;
  let status = models.body;
  if (activate ?? previousForm !== "") {
    const bound = answer(await request("/api/model-settings/roles", { role: "main", profileId: id }));
    if (bound.status !== 200) return { ...bound.body, status: bound.status };
    status = bound.body;
  }
  return { ...status, status: 200, profileId: id, profiles: connectionsOf(status) };
}

/** A `request(path, body)` for `saveTestConnection` over Playwright's API client. */
export const pageRequest = (page, base) => async (path, body) => {
  const response =
    body === undefined
      ? await page.request.get(`${base}${path}`)
      : await page.request.post(`${base}${path}`, { data: body });
  return { status: response.status(), body: await response.json() };
};
