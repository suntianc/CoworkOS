import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../ui/html.js";
import { createModal } from "../ui/modal.js";
import { LEVEL_LABELS } from "./model-picker.js";
import { PRESET_REGIONS, PROVIDER_PRESETS, presetById } from "../model-provider-presets.js";

const API_LABELS = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic Messages"
};
const API_PATHS = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages"
};
const LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
const ROLES = [
  { role: "main", label: "Main", icon: "cpu", hint: ui("理解需求、拆分与委派，并给出最终结论") },
  {
    role: "executor",
    label: "Executor",
    icon: "wrench",
    hint: ui("子 Agent 执行开发任务；未选择时沿用 Main 的模型")
  },
  {
    role: "reviewer",
    label: "Reviewer",
    icon: "shield-check",
    hint: ui("独立审查改动并给出结论；未选择时沿用 Main 的模型")
  }
];

/** The URL requests go to, as the backend builds it (`requestBaseUrl`). */
export function requestPreview(baseUrl, api) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";
  if (!URL.canParse(base)) return "";
  const path = new URL(base).pathname;
  const root = api === "anthropic-messages" || (path !== "/" && path !== "") ? base : `${base}/v1`;
  return `${root}${API_PATHS[api] || API_PATHS["openai-completions"]}`;
}

/** Model families a custom provider's model ids are recognized by. */
const MODEL_FAMILIES = [
  [/^(gpt|o\d|chatgpt|codex)/i, "openai"],
  [/deepseek/i, "deepseek"],
  [/claude/i, "anthropic"],
  [/gemini|gemma/i, "gemini"],
  [/^(glm|chatglm)/i, "zhipu"],
  [/kimi|moonshot/i, "moonshot"],
  [/qwen|qwq/i, "bailian"],
  [/grok/i, "xai"],
  [/mistral|mixtral|codestral|devstral/i, "mistral"],
  [/minimax|abab/i, "minimax"],
  [/hunyuan/i, "hunyuan"],
  [/doubao|seed-/i, "volcengine"],
  [/ernie/i, "qianfan"],
  [/mimo/i, "xiaomimimo"]
];

/** The preset whose logo a model id belongs to, e.g. `gpt-5` or `openai/gpt-5` → openai. */
export function modelFamily(model) {
  const id = String(model || "").trim();
  if (!id) return undefined;
  const name = id.split("/").pop();
  const match = MODEL_FAMILIES.find(([pattern]) => pattern.test(name) || pattern.test(id));
  return match ? presetById(match[1]) : undefined;
}

/**
 * A provider's mark: its preset logo. A custom provider has none, so the mark
 * follows the model it serves (a gpt model shows OpenAI's), and a model of no
 * known family shows a plain chip mark.
 */
export function providerLogo(provider, size = 28, model) {
  const preset = presetById(provider?.preset) || modelFamily(model);
  const style = `--logo-size:${size}px`;
  if (!preset)
    return `<span class="provider-logo is-generic" data-logo="generic" style="${style}" aria-hidden="true">${icon("cpu")}</span>`;
  const url = `/assets/brand/providers/${preset.logo ?? preset.id}.svg`;
  return preset.mono
    ? `<span class="provider-logo" data-logo="${preset.id}" style="${style}" aria-hidden="true"><span class="provider-logo-mono" style="--logo:url('${url}')"></span></span>`
    : `<span class="provider-logo" data-logo="${preset.id}" style="${style}" aria-hidden="true"><img src="${url}" alt=""></span>`;
}

const formatTokens = (value) =>
  !value ? "" : value >= 1_000_000 ? `${Math.round(value / 100_000) / 10}M` : `${Math.round(value / 1000)}K`;

function capabilityTags(model) {
  const tags = [];
  if (
    model.reasoning ??
    (model.supportsReasoningEffort || (model.reasoningLevels || []).some((l) => l !== "off"))
  )
    tags.push(`<span class="model-tag is-reasoning">${ui("推理")}</span>`);
  if (model.supportsImages ?? model.images)
    tags.push(`<span class="model-tag is-images">${ui("视觉")}</span>`);
  // The new-model default says nothing about the model; only a known window is shown.
  const context =
    model.contextWindow === 256000 && !model.autoLimits?.length ? "" : formatTokens(model.contextWindow);
  if (context) tags.push(`<span class="model-tag">${esc(context)} ${ui("上下文")}</span>`);
  return tags.join("");
}

/**
 * Model providers and role assignment.
 *
 * Providers hold an address, a wire format and a key, and offer models; roles
 * pick one provider model each. Keys are submitted once and never read back.
 */
export function installModelProviders({
  panel,
  request,
  status,
  showToast,
  onSaved,
  errorMessage,
  identity = () => ""
}) {
  let snapshot;
  let tab = "providers";
  let selectedId = "";
  let query = "";
  let busy = false;
  /** Unsaved account fields per provider id, kept per backend so a switch never mixes them. */
  const backendDrafts = new Map();
  const drafts = () => {
    const key = identity() ?? "";
    if (!backendDrafts.has(key)) backendDrafts.set(key, new Map());
    return backendDrafts.get(key);
  };

  panel.innerHTML = `
    <div class="model-settings-head">
      <h1 class="settings-page-title">${ui("模型与角色")}</h1>
      <div class="settings-segmented model-settings-tabs" role="tablist" aria-label="${esc(ui("模型与角色"))}">
        <button type="button" role="tab" data-model-tab="providers" aria-checked="true" aria-selected="true">${ui("供应商")}</button>
        <button type="button" role="tab" data-model-tab="roles" aria-checked="false" aria-selected="false">${ui("角色分配")}</button>
      </div>
      <p class="model-settings-hint">${icon("info")}<span data-model-hint></span></p>
    </div>
    <p class="model-settings-notice" data-model-notice role="alert" hidden></p>
    <div class="provider-layout" data-model-view="providers">
      <aside class="provider-list">
        <label class="provider-search">${icon("search")}<input type="search" data-provider-search placeholder="${esc(ui("搜索供应商"))}" aria-label="${esc(ui("搜索供应商"))}"></label>
        <div class="provider-items" data-provider-items></div>
        <button type="button" class="provider-add" data-provider-add>${icon("plus")}<span>${ui("添加供应商")}</span></button>
      </aside>
      <div class="provider-detail" data-provider-detail></div>
    </div>
    <div class="model-roles" data-model-view="roles" hidden>
      <div class="settings-rows" data-role-rows></div>
    </div>`;
  const $ = (selector) => panel.querySelector(selector);
  const notice = $("[data-model-notice]");
  const list = $("[data-provider-items]");
  const detail = $("[data-provider-detail]");

  const managed = () => snapshot?.managedByEnvironment === true;
  const providers = () => snapshot?.providers || [];
  const selected = () => providers().find((provider) => provider.id === selectedId);
  const roleOf = (role) => snapshot?.modelRoles?.roles?.find((entry) => entry.role === role);
  /** Roles that name a provider model, for the "used by" tags. */
  const usage = () => {
    const uses = new Map();
    for (const entry of snapshot?.modelRoles?.roles || [])
      if (entry.host?.profileId)
        uses.set(entry.host.profileId, [...(uses.get(entry.host.profileId) || []), entry.role]);
    return uses;
  };
  const roleLabel = (role) => ROLES.find((entry) => entry.role === role)?.label || role;

  const showNotice = () => {
    const message = managed()
      ? ui("当前模型连接由启动环境管理，请在启动配置中修改。")
      : snapshot?.credentialError || "";
    notice.textContent = message;
    notice.hidden = !message;
  };

  /* ------------------------------------------------------------ provider list */

  const providerState = (provider) =>
    !provider.enabled ? "off" : !provider.configured ? "warn" : provider.models.length ? "ok" : "idle";
  const renderList = () => {
    const items = providers().filter((provider) =>
      `${provider.name} ${provider.baseUrl}`.toLowerCase().includes(query.toLowerCase())
    );
    list.innerHTML = items.length
      ? items
          .map((provider) => {
            const state = providerState(provider);
            const meta = !provider.enabled
              ? ui("未启用")
              : !provider.configured
                ? ui("缺少 API Key")
                : provider.models.length
                  ? ui`${provider.models.length} 个模型`
                  : ui("未添加模型");
            return `<button type="button" class="provider-item" data-provider-id="${esc(provider.id)}" aria-current="${provider.id === selectedId}">
              ${providerLogo(provider, 28)}
              <span class="provider-item-text"><span class="provider-item-name">${esc(provider.name)}</span><span class="provider-item-meta">${esc(meta)}</span></span>
              <span class="provider-dot is-${state}" aria-hidden="true"></span>
            </button>`;
          })
          .join("")
      : `<p class="provider-empty-list">${providers().length ? ui("没有匹配的供应商") : ui("还没有供应商")}</p>`;
  };

  /* ---------------------------------------------------------- provider detail */

  const draftOf = (provider) => drafts().get(provider.id) || {};
  const value = (provider, field) => draftOf(provider)[field] ?? provider[field];
  const dirty = (provider) => Object.keys(draftOf(provider)).length > 0;

  const renderEmpty = () => {
    const quick = PROVIDER_PRESETS.filter((preset) =>
      ["deepseek", "zhipu", "moonshot", "bailian", "openai", "anthropic"].includes(preset.id)
    );
    detail.innerHTML = `<div class="provider-empty">
      <span class="provider-empty-icon">${icon("cpu")}</span>
      <h2>${ui("还没有模型供应商")}</h2>
      <p>${ui("添加一个供应商并填入 API Key，Main 和子 Agent 才能开始工作。")}</p>
      <div class="provider-quick">${quick
        .map(
          (preset) =>
            `<button type="button" class="provider-quick-item" data-preset="${preset.id}">${providerLogo({ preset: preset.id, name: preset.name }, 30)}<span>${esc(ui(preset.name))}</span></button>`
        )
        .join("")}</div>
      <button type="button" class="settings-link" data-provider-add>${icon("plus")}<span>${ui("其他供应商或自定义地址")}</span></button>
    </div>`;
  };

  const renderDetail = () => {
    const provider = selected();
    if (!provider) return renderEmpty();
    const api = value(provider, "api");
    const baseUrl = value(provider, "baseUrl");
    const uses = usage();
    const state = providerState(provider);
    const stateText = {
      ok: ui("已配置"),
      idle: ui("已配置，尚未添加模型"),
      warn: ui("缺少 API Key"),
      off: ui("未启用")
    }[state];
    const locked = managed() || busy;
    detail.innerHTML = `
      <div class="provider-head">
        ${providerLogo(provider, 36)}
        <div class="provider-head-text">
          <input class="provider-name-input" data-field="name" value="${esc(value(provider, "name"))}" aria-label="${esc(ui("供应商名称"))}" maxlength="80"${locked ? " disabled" : ""}>
          <span class="provider-head-state"><span class="provider-dot is-${state}" aria-hidden="true"></span>${esc(stateText)}</span>
        </div>
        <span class="settings-row-spacer"></span>
        <span class="provider-toggle-label">${ui("启用")}</span>
        <button type="button" class="ui-switch" role="switch" data-provider-enabled aria-checked="${provider.enabled}" aria-label="${esc(ui("启用供应商"))}"${locked ? " disabled" : ""}></button>
        <button type="button" class="settings-icon-button" data-provider-delete aria-label="${esc(ui("删除供应商"))}" title="${esc(ui("删除供应商"))}"${locked ? " disabled" : ""}>${icon("trash")}</button>
      </div>
      <div class="provider-card">
        <label class="provider-field">
          <span class="provider-field-label">API Key<small>${ui("保存在执行主机的私有配置中")}</small></span>
          <span class="provider-input-row">
            <span class="provider-input"><input type="password" data-field="apiKey" autocomplete="off" spellcheck="false" value="${esc(draftOf(provider).apiKey || "")}" placeholder="${esc(provider.configured ? ui("已保存，留空保留原密钥") : ui("填写 API Key"))}"${locked ? " disabled" : ""}><button type="button" class="provider-input-icon" data-reveal aria-label="${esc(ui("显示或隐藏 API Key"))}">${icon("eye")}</button></span>
            <button type="button" class="app-button is-secondary" data-provider-check${locked ? " disabled" : ""}>${icon("plug")}<span>${ui("检查")}</span></button>
          </span>
        </label>
        <label class="provider-field">
          <span class="provider-field-label">${ui("API 地址")}</span>
          <span class="provider-input"><input type="url" data-field="baseUrl" spellcheck="false" value="${esc(baseUrl)}"${locked ? " disabled" : ""}></span>
          <small class="provider-preview">${esc(requestPreview(baseUrl, api) ? ui`请求地址：${requestPreview(baseUrl, api)}` : "")}</small>
        </label>
        <div class="provider-field">
          <span class="provider-field-label">${ui("接口格式")}<small>${ui("决定请求路径与消息结构")}</small></span>
          <div class="settings-segmented" role="radiogroup" aria-label="${esc(ui("接口格式"))}">${Object.entries(
            API_LABELS
          )
            .map(
              ([id, label]) =>
                `<button type="button" role="radio" data-api="${id}" aria-checked="${api === id}"${locked ? " disabled" : ""}>${esc(label)}</button>`
            )
            .join("")}</div>
        </div>
        <details class="provider-advanced">
          <summary>${ui("高级")}${icon("chevron-down")}</summary>
          <div class="provider-advanced-body">
            <label class="provider-field is-inline"><span>${ui("思考模式格式")}</span>
              <select class="settings-select" data-field="thinkingFormat"${locked || api !== "openai-completions" ? " disabled" : ""}>
                ${[
                  ["auto", ui("自动识别")],
                  ["openai", ui("标准格式")],
                  ["zai", ui("GLM 格式")]
                ]
                  .map(
                    ([id, label]) =>
                      `<option value="${id}"${value(provider, "thinkingFormat") === id ? " selected" : ""}>${esc(label)}</option>`
                  )
                  .join("")}
              </select></label>
            <div class="provider-field is-inline"><span>${ui("会话缓存键（prompt_cache_key）")}<small>${ui("仅在服务商确认支持时开启")}</small></span>
              <button type="button" class="ui-switch" role="switch" data-field-switch="supportsPromptCacheKey" aria-checked="${value(provider, "supportsPromptCacheKey") === true}"${locked || api === "anthropic-messages" ? " disabled" : ""}></button></div>
          </div>
        </details>
        <div class="provider-save" ${dirty(provider) ? "" : "hidden"}>
          <span data-provider-result role="status"></span>
          <span class="settings-row-spacer"></span>
          <button type="button" class="app-button is-secondary" data-provider-discard>${ui("放弃")}</button>
          <button type="button" class="app-button is-primary" data-provider-save${locked ? " disabled" : ""}>${ui("保存")}</button>
        </div>
        <p class="provider-check-result" data-check-result role="status"></p>
      </div>
      <div class="provider-models">
        <div class="provider-models-head">
          <h2 class="settings-group-title">${ui("模型")}</h2><span class="model-count">${provider.models.length}</span>
          <span class="settings-row-spacer"></span>
          <button type="button" class="app-button is-secondary" data-models-fetch${locked || !provider.configured ? " disabled" : ""}>${icon("refresh")}<span>${ui("获取模型列表")}</span></button>
          <button type="button" class="app-button is-secondary" data-models-add${locked ? " disabled" : ""}>${icon("plus")}<span>${ui("手动添加")}</span></button>
        </div>
        <div class="settings-rows provider-model-rows">${
          provider.models.length
            ? provider.models
                .map((model) => {
                  const roles = uses.get(model.profileId) || [];
                  return `<div class="provider-model-row" data-model-id="${esc(model.id)}">
                    <span class="provider-model-text"><span class="provider-model-name">${esc(model.name || model.id)}</span>${model.name ? `<span class="provider-model-id">${esc(model.id)}</span>` : ""}</span>
                    <span class="model-tags">${capabilityTags(model)}</span>
                    <span class="settings-row-spacer"></span>
                    ${roles.map((role) => `<span class="model-tag is-role">${esc(roleLabel(role))}</span>`).join("")}
                    <button type="button" class="settings-icon-button" data-model-settings="${esc(model.id)}" aria-label="${esc(ui`${model.id} 的参数`)}" title="${esc(ui("模型参数"))}"${locked ? " disabled" : ""}>${icon("settings")}</button>
                    <button type="button" class="settings-icon-button" data-model-remove="${esc(model.id)}" aria-label="${esc(ui`移除 ${model.id}`)}" title="${esc(roles.length ? ui("正被角色使用，先在角色分配中改选") : ui("移除模型"))}"${locked || roles.length ? " disabled" : ""}>${icon("minus")}</button>
                  </div>`;
                })
                .join("")
            : `<div class="settings-row"><span class="settings-row-meta">${provider.configured ? ui("还没有模型，点「获取模型列表」从服务商读取，或手动添加。") : ui("填写 API Key 并保存后即可获取模型列表。")}</span></div>`
        }</div>
      </div>`;
  };

  /* -------------------------------------------------------------------- roles */

  const allModels = () =>
    providers()
      .filter((provider) => provider.enabled)
      .flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const findModel = (profileId) => allModels().find(({ model }) => model.profileId === profileId);
  const pickerLabel = (profileId, fallback) => {
    const found = profileId && findModel(profileId);
    return found
      ? `${providerLogo(found.provider, 22, found.model.id)}<span class="role-picker-text"><span>${esc(found.model.name || found.model.id)}</span><small>${esc(found.provider.name)}</small></span>`
      : `<span class="role-picker-text is-empty"><span>${esc(fallback)}</span></span>`;
  };
  /** The model a role runs on: its binding, or for Main the first available model. */
  const roleModelOf = (role) =>
    roleOf(role)?.host?.profileId || (role === "main" ? snapshot?.activeProfileId : undefined);
  const renderRoles = () => {
    const rows = $("[data-role-rows]");
    const locked = managed() || busy;
    rows.innerHTML = ROLES.map(({ role, label, icon: name, hint }) => {
      const entry = roleOf(role);
      const bound = entry?.host?.profileId;
      const used = roleModelOf(role);
      const model = used && findModel(used)?.model;
      const effort = model?.reasoningEffort ?? "off";
      const levels = model?.reasoningLevels?.length ? model.reasoningLevels : LEVELS;
      const fallback = role === "main" ? ui("未选择（使用第一个可用模型）") : ui("沿用 Main 的模型");
      return `<div class="role-row${entry?.error ? " has-error" : ""}" data-role="${role}">
        <span class="role-icon">${icon(name)}</span>
        <span class="role-text"><span class="role-name">${label}</span><span class="role-hint">${esc(hint)}</span></span>
        <button type="button" class="role-picker" data-role-picker="${role}" aria-haspopup="listbox" aria-label="${esc(ui`${label} 的模型`)}"${locked ? " disabled" : ""}>${pickerLabel(bound, fallback)}${icon("chevron-down")}</button>
        <select class="settings-select is-effort" data-role-effort="${role}" aria-label="${esc(ui`${label} 的推理强度`)}" title="${esc(ui("推理强度属于所选的模型"))}"${locked || !model ? " disabled" : ""}>
          ${levels.map((level) => `<option value="${level}"${level === effort ? " selected" : ""}>${esc(LEVEL_LABELS[level] || level)}</option>`).join("")}
        </select>
        ${entry?.error ? `<span class="role-error" role="alert">${esc(entry.error)}</span>` : ""}
      </div>`;
    }).join("");
  };

  /* -------------------------------------------------------------- rendering */

  const render = () => {
    for (const button of panel.querySelectorAll("[data-model-tab]")) {
      const on = button.dataset.modelTab === tab;
      button.setAttribute("aria-checked", String(on));
      button.setAttribute("aria-selected", String(on));
    }
    $('[data-model-view="providers"]').hidden = tab !== "providers";
    $('[data-model-view="roles"]').hidden = tab !== "roles";
    $("[data-model-hint]").textContent =
      tab === "providers"
        ? ui("配置供应商后获取模型，再到「角色分配」为 Main、Executor、Reviewer 选模型")
        : ui("每个角色从已启用供应商的模型中选择；推理强度属于所选模型");
    showNotice();
    renderList();
    renderDetail();
    renderRoles();
  };

  const apply = (next) => {
    snapshot = next;
    if (!providers().some((provider) => provider.id === selectedId)) selectedId = providers()[0]?.id || "";
    for (const id of drafts().keys())
      if (!providers().some((provider) => provider.id === id)) drafts().delete(id);
    render();
  };

  /** Only the newest read answers; an older one for another backend is dropped. */
  let reading = 0;
  const refresh = async () => {
    const revision = ++reading;
    try {
      const next = await status();
      if (revision === reading) apply(next);
    } catch (error) {
      if (revision !== reading) return;
      notice.textContent = errorMessage(error);
      notice.hidden = false;
    }
  };

  /** Run one change; the panel shows the backend's answer and stays usable on failure. */
  const run = async (work, success) => {
    if (busy) return;
    busy = true;
    render();
    try {
      const next = await work();
      busy = false;
      if (next?.providers) apply(next);
      else await refresh();
      if (success) showToast(success);
      onSaved?.();
      return true;
    } catch (error) {
      busy = false;
      render();
      showToast(errorMessage(error));
      return false;
    }
  };

  const post = (path, body) => request("POST", body, path);
  const saveDraft = async (provider) => {
    const draft = draftOf(provider);
    const ok = await run(
      () => post("/api/model-settings/providers", { id: provider.id, ...draft }),
      ui("供应商已保存")
    );
    if (ok) drafts().delete(provider.id);
    render();
  };

  /* ------------------------------------------------------------------ dialogs */

  const dialogs = [];
  const createDialog = (className, label) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop provider-dialog-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML = `<section class="modal-card provider-dialog ${className}" role="dialog" aria-modal="true" aria-label="${esc(label)}">
      <header class="provider-dialog-head"><h2>${esc(label)}</h2><button type="button" class="settings-icon-button" data-dialog-close aria-label="${esc(ui("关闭"))}">${icon("close")}</button></header>
      <div class="provider-dialog-body" data-dialog-body></div>
      <footer class="provider-dialog-foot" data-dialog-foot></footer>
    </section>`;
    document.body.append(backdrop);
    const modal = createModal(backdrop, backdrop.querySelector("[data-dialog-close]"));
    const dialog = {
      backdrop,
      body: backdrop.querySelector("[data-dialog-body]"),
      foot: backdrop.querySelector("[data-dialog-foot]"),
      open: modal.open,
      close: modal.close,
      title: (text) => (backdrop.querySelector(".provider-dialog-head h2").textContent = text)
    };
    dialogs.push(dialog);
    return dialog;
  };

  /* Add provider: presets grouped by region, then the key. */
  const addDialog = createDialog("is-add", ui("添加供应商"));
  let addPreset = "deepseek";
  const renderAdd = () => {
    const preset = presetById(addPreset);
    const custom = !preset;
    addDialog.body.innerHTML = `
      <p class="provider-dialog-lead">${ui("预置供应商会自动填好 API 地址和接口格式，只需填写 API Key；其他兼容 OpenAI 或 Anthropic 接口的服务选「自定义」。")}</p>
      ${PRESET_REGIONS.map(
        ([region, label]) =>
          `<div class="preset-section"><h3>${esc(ui(label))}</h3><div class="preset-grid">${PROVIDER_PRESETS.filter(
            (entry) => entry.region === region
          )
            .map(
              (entry) =>
                `<button type="button" class="preset-item" data-add-preset="${entry.id}" aria-pressed="${entry.id === addPreset}">${providerLogo({ preset: entry.id, name: entry.name }, 24)}<span>${esc(ui(entry.name))}</span></button>`
            )
            .join("")}${
            region === "local"
              ? `<button type="button" class="preset-item" data-add-preset="custom" aria-pressed="${custom}"><span class="provider-logo is-letter" style="--logo-size:24px">${icon("plus")}</span><span>${ui("自定义")}</span></button>`
              : ""
          }</div></div>`
      ).join("")}
      <div class="provider-dialog-fields">
        ${
          custom
            ? `<label class="provider-field"><span class="provider-field-label">${ui("名称")}</span><span class="provider-input"><input data-add="name" maxlength="80" required placeholder="${esc(ui("例如：公司网关"))}"></span></label>
               <label class="provider-field"><span class="provider-field-label">${ui("API 地址")}</span><span class="provider-input"><input data-add="baseUrl" type="url" required placeholder="https://example.com/v1"></span></label>
               <div class="provider-field"><span class="provider-field-label">${ui("接口格式")}</span><div class="settings-segmented" role="radiogroup">${Object.entries(
                 API_LABELS
               )
                 .map(
                   ([id, label], index) =>
                     `<button type="button" role="radio" data-add-api="${id}" aria-checked="${index === 0}">${esc(label)}</button>`
                 )
                 .join("")}</div></div>`
            : ""
        }
        <label class="provider-field"><span class="provider-field-label">API Key</span><span class="provider-input"><input data-add="apiKey" type="password" autocomplete="off" spellcheck="false" value="${esc(preset?.apiKey || "")}" placeholder="${esc(ui("填写 API Key"))}"></span>
          ${preset?.keyUrl ? `<small><a href="${esc(preset.keyUrl)}" target="_blank" rel="noreferrer">${esc(ui`前往 ${ui(preset.name)} 获取 API Key`)} ↗</a></small>` : ""}</label>
        ${preset ? `<small class="provider-preview">${esc(ui`API 地址：${preset.baseUrl}`)} · ${esc(API_LABELS[preset.api])}</small>` : ""}
      </div>`;
    addDialog.foot.innerHTML = `<span data-add-error class="provider-dialog-error" role="alert"></span><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-add-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-add-submit>${ui("添加并获取模型")}</button>`;
  };
  addDialog.backdrop.addEventListener("click", async (event) => {
    const presetButton = event.target.closest("[data-add-preset]");
    if (presetButton) {
      addPreset = presetButton.dataset.addPreset;
      renderAdd();
      addDialog.body.querySelector('[data-add="name"], [data-add="apiKey"]')?.focus();
      return;
    }
    const apiButton = event.target.closest("[data-add-api]");
    if (apiButton)
      for (const button of addDialog.body.querySelectorAll("[data-add-api]"))
        button.setAttribute("aria-checked", String(button === apiButton));
    if (event.target.closest("[data-add-cancel]")) addDialog.close();
    if (!event.target.closest("[data-add-submit]") || busy) return;
    const field = (name) => addDialog.body.querySelector(`[data-add="${name}"]`)?.value.trim() || "";
    const preset = presetById(addPreset);
    const body = preset
      ? {
          preset: preset.id,
          name: ui(preset.name),
          baseUrl: preset.baseUrl,
          api: preset.api,
          apiKey: field("apiKey")
        }
      : {
          name: field("name"),
          baseUrl: field("baseUrl"),
          api: addDialog.body.querySelector('[data-add-api][aria-checked="true"]')?.dataset.addApi,
          apiKey: field("apiKey")
        };
    const error = addDialog.foot.querySelector("[data-add-error]");
    error.textContent = "";
    const before = new Set(providers().map((provider) => provider.id));
    const submit = addDialog.foot.querySelector("[data-add-submit]");
    const pending = (on) => {
      submit.setAttribute("aria-busy", String(on));
      submit.disabled = on;
    };
    busy = true;
    pending(true);
    try {
      const next = await post("/api/model-settings/providers", body);
      busy = false;
      pending(false);
      apply(next);
      selectedId = providers().find((provider) => !before.has(provider.id))?.id || selectedId;
      tab = "providers";
      render();
      addDialog.close();
      onSaved?.();
      void openFetch();
    } catch (failure) {
      busy = false;
      pending(false);
      error.textContent = errorMessage(failure);
    }
  });
  const openAdd = (preset = "deepseek") => {
    if (managed()) return;
    addPreset = preset;
    renderAdd();
    addDialog.open();
    addDialog.body.querySelector('[data-add="apiKey"]')?.focus();
  };

  /* Fetch the provider's model list and pick what to add. */
  const fetchDialog = createDialog("is-fetch", ui("获取模型列表"));
  let listing = [];
  let listingLoading = false;
  let picked = new Set();
  let filter = { text: "", kind: "all" };
  const renderFetch = () => {
    const shown = listing.filter(
      (model) =>
        model.id.toLowerCase().includes(filter.text.toLowerCase()) &&
        (filter.kind === "all" ||
          (filter.kind === "reasoning" && model.reasoning) ||
          (filter.kind === "images" && model.images))
    );
    fetchDialog.body.querySelector("[data-fetch-list]").innerHTML = listingLoading
      ? `<div class="fetch-loading" role="status"><span class="ui-spinner" aria-hidden="true"></span><span>${ui("正在读取模型列表…")}</span></div>`
      : shown.length
        ? shown
            .map(
              (model) => `<label class="fetch-item${model.added ? " is-added" : ""}">
              <input type="checkbox" value="${esc(model.id)}"${model.added || picked.has(model.id) ? " checked" : ""}${model.added ? " disabled" : ""}>
              <span class="fetch-item-text"><span class="provider-model-id">${esc(model.id)}</span>${model.name ? `<small>${esc(model.name)}</small>` : ""}</span>
              <span class="model-tags">${capabilityTags({ ...model, supportsImages: model.images })}</span>
              <span class="settings-row-spacer"></span>
              ${model.added ? `<small>${ui("已加入")}</small>` : ""}
            </label>`
            )
            .join("")
        : `<p class="provider-empty-list">${listing.length ? ui("没有匹配的模型") : ui("服务商没有返回模型。请检查 API Key 和地址，或关闭后手动添加。")}</p>`;
    fetchDialog.foot.querySelector("[data-fetch-count]").textContent = picked.size
      ? ui`新选 ${picked.size} 个模型`
      : "";
    const submit = fetchDialog.foot.querySelector("[data-fetch-submit]");
    submit.disabled = !picked.size || busy;
    submit.textContent = picked.size ? ui`加入 ${picked.size} 个模型` : ui("加入模型");
  };
  const openFetch = async () => {
    const provider = selected();
    if (!provider || managed()) return;
    listing = [];
    listingLoading = true;
    picked = new Set();
    filter = { text: "", kind: "all" };
    fetchDialog.title(ui`${provider.name} 的可用模型`);
    fetchDialog.body.innerHTML = `<p class="provider-dialog-lead" data-fetch-lead></p>
      <div class="fetch-toolbar"><label class="provider-search">${icon("search")}<input type="search" data-fetch-filter placeholder="${esc(ui("筛选"))}"></label>
      <div class="settings-segmented" role="radiogroup">${[
        ["all", ui("全部")],
        ["reasoning", ui("推理")],
        ["images", ui("视觉")]
      ]
        .map(
          ([id, label]) =>
            `<button type="button" role="radio" data-fetch-kind="${id}" aria-checked="${id === "all"}">${esc(label)}</button>`
        )
        .join("")}</div></div>
      <div class="fetch-list" data-fetch-list></div>`;
    fetchDialog.foot.innerHTML = `<small data-fetch-count></small><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-fetch-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-fetch-submit disabled>${ui("加入模型")}</button>`;
    fetchDialog.open();
    renderFetch();
    try {
      listing = (await post("/api/model-settings/models/list", { id: provider.id })).models || [];
      fetchDialog.body.querySelector("[data-fetch-lead]").textContent = listing.length
        ? ui`从服务商获取到 ${listing.length} 个模型。勾选要加入的模型，已加入的会保留。`
        : ui("服务商没有返回模型。");
    } catch (error) {
      fetchDialog.body.querySelector("[data-fetch-lead]").textContent = errorMessage(error);
    }
    listingLoading = false;
    renderFetch();
  };
  fetchDialog.backdrop.addEventListener("input", (event) => {
    if (event.target.matches("[data-fetch-filter]")) {
      filter.text = event.target.value;
      renderFetch();
    }
  });
  fetchDialog.backdrop.addEventListener("change", (event) => {
    if (event.target.type !== "checkbox") return;
    if (event.target.checked) picked.add(event.target.value);
    else picked.delete(event.target.value);
    renderFetch();
  });
  fetchDialog.backdrop.addEventListener("click", async (event) => {
    const kind = event.target.closest("[data-fetch-kind]");
    if (kind) {
      filter.kind = kind.dataset.fetchKind;
      for (const button of fetchDialog.body.querySelectorAll("[data-fetch-kind]"))
        button.setAttribute("aria-checked", String(button === kind));
      renderFetch();
    }
    if (event.target.closest("[data-fetch-cancel]")) fetchDialog.close();
    if (!event.target.closest("[data-fetch-submit]") || !picked.size) return;
    const provider = selected();
    const models = listing
      .filter((model) => picked.has(model.id))
      .map((model) => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        supportsImages: model.images === true,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens
          ? {
              mainMaxTokens: Math.max(1, Math.min(model.maxTokens, 65536)),
              subagentMaxTokens: Math.max(1, Math.min(model.maxTokens, 65536))
            }
          : {}),
        ...(model.reasoning ? { supportsReasoningEffort: true } : {}),
        autoLimits: ["contextWindow", "maxTokens", "images"]
      }));
    const ok = await run(
      () => post("/api/model-settings/models", { providerId: provider.id, models }),
      ui`已加入 ${models.length} 个模型`
    );
    if (ok) fetchDialog.close();
  });

  /* Add one model by id. */
  const manualDialog = createDialog("is-manual", ui("手动添加模型"));
  const openManual = () => {
    manualDialog.body.innerHTML = `<label class="provider-field"><span class="provider-field-label">${ui("模型 ID")}</span>
      <span class="provider-input"><input data-manual-id required spellcheck="false" placeholder="${esc(ui("填写服务商提供的模型 ID"))}"></span></label>
      <label class="provider-field"><span class="provider-field-label">${ui("显示名称（可选）")}</span><span class="provider-input"><input data-manual-name maxlength="120"></span></label>`;
    manualDialog.foot.innerHTML = `<span class="provider-dialog-error" data-manual-error role="alert"></span><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-manual-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-manual-submit>${ui("添加")}</button>`;
    manualDialog.open();
    manualDialog.body.querySelector("[data-manual-id]").focus();
  };
  manualDialog.backdrop.addEventListener("click", async (event) => {
    if (event.target.closest("[data-manual-cancel]")) manualDialog.close();
    if (!event.target.closest("[data-manual-submit]") || busy) return;
    const id = manualDialog.body.querySelector("[data-manual-id]").value.trim();
    const name = manualDialog.body.querySelector("[data-manual-name]").value.trim();
    const error = manualDialog.foot.querySelector("[data-manual-error]");
    error.textContent = "";
    busy = true;
    try {
      const next = await post("/api/model-settings/models", {
        providerId: selectedId,
        models: [{ id, ...(name ? { name } : {}) }]
      });
      // The panel re-renders from the answer, so it must no longer read as busy.
      busy = false;
      apply(next);
      manualDialog.close();
      onSaved?.();
    } catch (failure) {
      busy = false;
      error.textContent = errorMessage(failure);
    }
  });

  /* One model's limits and reasoning levels. */
  const modelDialog = createDialog("is-model", ui("模型参数"));
  let modelAuto = new Set();
  let modelLimits = {};
  let modelSource = "manual";
  const openModel = async (modelId) => {
    const provider = selected();
    const model = provider?.models.find((entry) => entry.id === modelId);
    if (!model) return;
    modelDialog.title(model.id);
    // A model saved without `autoLimits` follows the endpoint while a field still holds its default.
    modelAuto = new Set(
      model.autoLimits ?? [
        ...(model.contextWindow === 256000 ? ["contextWindow"] : []),
        ...(model.mainMaxTokens === 8192 && model.subagentMaxTokens === 8192 ? ["maxTokens"] : []),
        ...(model.supportsImages ? [] : ["images"])
      ]
    );
    modelLimits = {};
    modelSource = "manual";
    const chosen = model.reasoningLevels?.length ? model.reasoningLevels : LEVELS;
    modelDialog.body.innerHTML = `
      <p class="provider-dialog-lead">${ui("标「自动」的值来自服务商接口或内置目录；手动修改后以填写的为准。")}</p>
      ${[
        ["contextWindow", ui("上下文窗口（token）"), model.contextWindow, "contextWindow"],
        ["mainMaxTokens", ui("Main 每次输出上限"), model.mainMaxTokens, "maxTokens"],
        ["subagentMaxTokens", ui("子 Agent 每次输出上限"), model.subagentMaxTokens, "maxTokens"]
      ]
        .map(
          ([
            name,
            label,
            current,
            auto
          ]) => `<label class="provider-field is-inline"><span>${esc(label)}<small class="model-auto" data-auto-tag="${auto}" hidden>${ui("自动")}</small></span>
          <span class="provider-input is-number"><input type="number" min="1" step="1" data-model-field="${name}" data-auto="${auto}" value="${esc(current)}"></span></label>`
        )
        .join("")}
      <div class="provider-field"><span class="provider-field-label">${ui("推理档位")}<small class="model-auto" data-levels-source hidden></small></span>
        <div class="level-chips" data-level-chips>${LEVELS.map(
          (level) =>
            `<label class="level-chip"><input type="checkbox" value="${level}"${chosen.includes(level) ? " checked" : ""}><span>${esc(LEVEL_LABELS[level] || level)}</span></label>`
        ).join("")}</div></div>
      <label class="provider-field is-inline"><span>${ui("默认推理强度")}</span><select class="settings-select is-effort" data-model-field="reasoningEffort">${LEVELS.map(
        (level) =>
          `<option value="${level}"${level === model.reasoningEffort ? " selected" : ""}>${esc(LEVEL_LABELS[level] || level)}</option>`
      ).join("")}</select></label>
      <div class="provider-field is-inline"><span>${ui("服务支持推理强度参数")}<small>reasoning_effort / thinking</small></span><button type="button" class="ui-switch" role="switch" data-model-switch="supportsReasoningEffort" aria-checked="${model.supportsReasoningEffort === true}"></button></div>
      <div class="provider-field is-inline"><span>${ui("图片输入")}<small class="model-auto" data-auto-tag="images" hidden>${ui("自动")}</small></span><button type="button" class="ui-switch" role="switch" data-model-switch="supportsImages" data-auto="images" aria-checked="${model.supportsImages === true}"></button></div>`;
    modelDialog.foot.innerHTML = `<button type="button" class="settings-link" data-model-reset>${ui("恢复自动值")}</button><span class="provider-dialog-error" data-model-error role="alert"></span><span class="settings-row-spacer"></span>
      <button type="button" class="app-button is-secondary" data-model-cancel>${ui("取消")}</button>
      <button type="button" class="app-button is-primary" data-model-save>${ui("保存")}</button>`;
    modelDialog.open();
    showAuto();
    try {
      const result = await post("/api/model-settings/levels", { id: provider.id, model: model.id });
      modelLimits = result.limits || {};
      modelSource = result.source;
      if (result.source !== "manual")
        for (const box of modelDialog.body.querySelectorAll("[data-level-chips] input")) {
          box.checked = result.levels.includes(box.value);
          box.disabled = true;
        }
      const badge = modelDialog.body.querySelector("[data-levels-source]");
      badge.hidden = result.source === "manual";
      badge.textContent = result.source === "endpoint" ? ui("来自 /models 接口") : ui("官方 · 自动");
      showAuto();
    } catch (error) {
      console.warn("model level detection failed", error);
    }
  };
  /** Fields that still follow the endpoint show its value and an "auto" tag. */
  const showAuto = () => {
    const values = {
      contextWindow: modelLimits.contextWindow,
      maxTokens: modelLimits.maxOutputTokens && Math.min(modelLimits.maxOutputTokens, 65536),
      images: modelLimits.images
    };
    for (const input of modelDialog.body.querySelectorAll("[data-auto]")) {
      const field = input.dataset.auto;
      if (!modelAuto.has(field) || values[field] === undefined) continue;
      if (input.matches("[role=switch]")) input.setAttribute("aria-checked", String(values[field] === true));
      else input.value = String(values[field]);
    }
    for (const tag of modelDialog.body.querySelectorAll("[data-auto-tag]"))
      tag.hidden = !(modelAuto.has(tag.dataset.autoTag) && values[tag.dataset.autoTag] !== undefined);
  };
  modelDialog.backdrop.addEventListener("input", (event) => {
    const field = event.target.dataset?.auto;
    if (field) {
      modelAuto.delete(field);
      showAuto();
    }
  });
  modelDialog.backdrop.addEventListener("change", (event) => {
    if (!event.target.closest("[data-level-chips]")) return;
    const boxes = [...modelDialog.body.querySelectorAll("[data-level-chips] input")];
    if (!boxes.some((box) => box.checked)) event.target.checked = true;
  });
  modelDialog.backdrop.addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-model-switch]");
    if (toggle) {
      toggle.setAttribute("aria-checked", String(toggle.getAttribute("aria-checked") !== "true"));
      if (toggle.dataset.auto) {
        modelAuto.delete(toggle.dataset.auto);
        showAuto();
      }
    }
    if (event.target.closest("[data-model-reset]")) {
      modelAuto = new Set(["contextWindow", "maxTokens", "images"]);
      showAuto();
    }
    if (event.target.closest("[data-model-cancel]")) modelDialog.close();
    if (!event.target.closest("[data-model-save]") || busy) return;
    const body = modelDialog.body;
    const number = (name) => Number(body.querySelector(`[data-model-field="${name}"]`).value);
    const levels = [...body.querySelectorAll("[data-level-chips] input")]
      .filter((box) => box.checked)
      .map((box) => box.value);
    const entry = {
      id: modelDialog.backdrop.querySelector(".provider-dialog-head h2").textContent,
      contextWindow: number("contextWindow"),
      mainMaxTokens: number("mainMaxTokens"),
      subagentMaxTokens: number("subagentMaxTokens"),
      reasoningEffort: body.querySelector('[data-model-field="reasoningEffort"]').value,
      reasoningLevels: modelSource !== "manual" || levels.length === LEVELS.length ? null : levels,
      supportsReasoningEffort:
        body.querySelector('[data-model-switch="supportsReasoningEffort"]').getAttribute("aria-checked") ===
        "true",
      supportsImages:
        body.querySelector('[data-model-switch="supportsImages"]').getAttribute("aria-checked") === "true",
      autoLimits: [...modelAuto]
    };
    const error = modelDialog.foot.querySelector("[data-model-error]");
    error.textContent = "";
    busy = true;
    try {
      const next = await post("/api/model-settings/models", { providerId: selectedId, models: [entry] });
      busy = false;
      apply(next);
      modelDialog.close();
      onSaved?.();
    } catch (failure) {
      busy = false;
      error.textContent = errorMessage(failure);
    }
  });

  /* Role model picker: one floating list grouped by provider. */
  const menu = document.createElement("div");
  menu.className = "role-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  document.body.append(menu);
  let menuRole = "";
  let menuQuery = "";
  const closeMenu = () => {
    menu.hidden = true;
    menuRole = "";
  };
  const renderMenu = () => {
    const current = roleOf(menuRole)?.host?.profileId;
    const empty = menuRole === "main" ? ui("未选择（使用第一个可用模型）") : ui("沿用 Main 的模型");
    const groups = providers()
      .map((provider) => ({
        provider,
        models: provider.models.filter((model) =>
          `${model.id} ${model.name || ""} ${provider.name}`.toLowerCase().includes(menuQuery.toLowerCase())
        )
      }))
      .filter((group) => group.models.length);
    menu.querySelector("[data-menu-items]").innerHTML =
      `<button type="button" class="role-menu-item" role="option" data-menu-pick="" aria-selected="${!current}"><span>${esc(empty)}</span>${!current ? icon("check") : ""}</button>${groups
        .map(({ provider, models }) => {
          const unusable = !provider.enabled || !provider.configured;
          return `<div class="role-menu-group${unusable ? " is-disabled" : ""}">${providerLogo(provider, 16)}<span>${esc(provider.name)}</span>${unusable ? `<small>${!provider.enabled ? ui("未启用") : ui("缺少 API Key")}</small>` : ""}</div>${models
            .map(
              (model) =>
                `<button type="button" class="role-menu-item" role="option" data-menu-pick="${esc(model.profileId)}" aria-selected="${model.profileId === current}"${unusable ? " disabled" : ""}><span>${esc(model.name || model.id)}</span><span class="model-tags">${capabilityTags({ ...model, contextWindow: 0 })}</span><span class="settings-row-spacer"></span>${model.profileId === current ? icon("check") : ""}</button>`
            )
            .join("")}`;
        })
        .join("")}`;
  };
  menu.innerHTML = `<label class="provider-search">${icon("search")}<input type="search" data-menu-search placeholder="${esc(ui("搜索模型"))}"></label><div class="role-menu-items" data-menu-items></div>`;
  const openMenu = (button) => {
    menuRole = button.dataset.rolePicker;
    menuQuery = "";
    menu.querySelector("[data-menu-search]").value = "";
    renderMenu();
    const box = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - 348))}px`;
    menu.style.top = `${Math.min(box.bottom + 6, innerHeight - 320)}px`;
    menu.hidden = false;
    menu.querySelector("[data-menu-search]").focus();
  };
  menu.addEventListener("input", (event) => {
    if (!event.target.matches("[data-menu-search]")) return;
    menuQuery = event.target.value;
    renderMenu();
  });
  menu.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-menu-pick]");
    if (!pick || pick.disabled) return;
    const role = menuRole;
    closeMenu();
    void run(async () => {
      await post("/api/model-settings/roles", { role, profileId: pick.dataset.menuPick });
      return status();
    }, ui("角色模型已更新"));
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !event.target.closest("[data-role-picker]"))
      closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeMenu();
    }
  });

  /* ------------------------------------------------------------------ events */

  panel.addEventListener("click", (event) => {
    const target = event.target;
    const tabButton = target.closest("[data-model-tab]");
    if (tabButton) {
      tab = tabButton.dataset.modelTab;
      return render();
    }
    const item = target.closest("[data-provider-id]");
    if (item) {
      selectedId = item.dataset.providerId;
      renderList();
      return renderDetail();
    }
    if (target.closest("[data-provider-add]")) return openAdd();
    const quick = target.closest("[data-preset]");
    if (quick) return openAdd(quick.dataset.preset);
    const provider = selected();
    const picker = target.closest("[data-role-picker]");
    if (picker) return menu.hidden || menuRole !== picker.dataset.rolePicker ? openMenu(picker) : closeMenu();
    if (!provider) return;
    if (target.closest("[data-reveal]")) {
      const input = detail.querySelector('[data-field="apiKey"]');
      input.type = input.type === "password" ? "text" : "password";
      return;
    }
    const apiButton = target.closest("[data-api]");
    if (apiButton) {
      drafts().set(provider.id, { ...draftOf(provider), api: apiButton.dataset.api });
      return renderDetail();
    }
    const fieldSwitch = target.closest("[data-field-switch]");
    if (fieldSwitch) {
      const field = fieldSwitch.dataset.fieldSwitch;
      drafts().set(provider.id, { ...draftOf(provider), [field]: !(value(provider, field) === true) });
      return renderDetail();
    }
    if (target.closest("[data-provider-enabled]"))
      return void run(
        () => post("/api/model-settings/providers", { id: provider.id, enabled: !provider.enabled }),
        provider.enabled ? ui("已停用供应商") : ui("已启用供应商")
      );
    const remove = target.closest("[data-provider-delete]");
    if (remove) {
      if (remove.dataset.confirm !== "1") {
        remove.dataset.confirm = "1";
        remove.classList.add("is-confirming");
        remove.title = ui("再次点击确认删除");
        showToast(ui`再次点击删除「${provider.name}」，它的模型也会一并移除`);
        return;
      }
      return void run(
        () => post("/api/model-settings/providers/delete", { id: provider.id }),
        ui("供应商已删除")
      );
    }
    if (target.closest("[data-provider-discard]")) {
      drafts().delete(provider.id);
      return renderDetail();
    }
    if (target.closest("[data-provider-save]")) return void saveDraft(provider);
    if (target.closest("[data-provider-check]")) {
      const result = detail.querySelector("[data-check-result]");
      const model = provider.models[0]?.id;
      if (!model) {
        result.textContent = ui("先添加一个模型，再检查连接。");
        return;
      }
      result.textContent = ui`正在用 ${model} 检查连接与工具调用…（会消耗少量额度）`;
      void post("/api/model-settings/test", { id: provider.id, model, ...draftOf(provider) }).then(
        (answer) => {
          result.textContent = ui`连接通过 · 工具调用可用 · ${(answer.durationMs / 1000).toFixed(1)} 秒`;
        },
        (error) => {
          result.textContent = errorMessage(error);
        }
      );
      return;
    }
    if (target.closest("[data-models-fetch]")) return void openFetch();
    if (target.closest("[data-models-add]")) return openManual();
    const settings = target.closest("[data-model-settings]");
    if (settings) return void openModel(settings.dataset.modelSettings);
    const removeModel = target.closest("[data-model-remove]");
    if (removeModel)
      return void run(
        () =>
          post("/api/model-settings/models", {
            providerId: provider.id,
            remove: [removeModel.dataset.modelRemove]
          }),
        ui("模型已移除")
      );
  });
  panel.addEventListener("input", (event) => {
    if (event.target.matches("[data-provider-search]")) {
      query = event.target.value;
      return renderList();
    }
    const field = event.target.dataset?.field;
    const provider = selected();
    if (!field || !provider) return;
    const next = { ...draftOf(provider) };
    const raw = event.target.value;
    if (field === "apiKey" ? raw.trim() : raw !== provider[field]) next[field] = raw;
    else delete next[field];
    if (Object.keys(next).length) drafts().set(provider.id, next);
    else drafts().delete(provider.id);
    detail.querySelector(".provider-save").hidden = !dirty(provider);
    if (field === "baseUrl")
      detail.querySelector(".provider-preview").textContent = requestPreview(raw, value(provider, "api"))
        ? ui`请求地址：${requestPreview(raw, value(provider, "api"))}`
        : "";
  });
  panel.addEventListener("change", (event) => {
    const effort = event.target.closest("[data-role-effort]");
    if (effort) {
      const found = findModel(roleModelOf(effort.dataset.roleEffort));
      if (!found) return;
      void run(
        () =>
          post("/api/model-settings/models", {
            providerId: found.provider.id,
            models: [{ id: found.model.id, reasoningEffort: effort.value }]
          }),
        ui("推理强度已更新")
      );
    }
    const select = event.target.closest("select[data-field]");
    const provider = selected();
    if (select && provider) {
      drafts().set(provider.id, { ...draftOf(provider), [select.dataset.field]: select.value });
      detail.querySelector(".provider-save").hidden = false;
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-field]") && selected() && dirty(selected())) {
      event.preventDefault();
      void saveDraft(selected());
    }
  });

  return {
    refresh,
    /** Show the panel ready for a first provider when nothing is configured. */
    openSetup: () => {
      tab = "providers";
      void refresh().then(() => {
        if (!providers().length) openAdd();
      });
    }
  };
}
