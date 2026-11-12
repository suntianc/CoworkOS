import { ui } from "../ui/language.js";
import { installWebSearchSettings } from "./web-search-settings.js";
import { createSettingsModal } from "./settings-modal.js";
import { createSettingsBackend } from "./settings-backend.js";
import { icon } from "../ui/icons.js";
import { escapeHtml as esc } from "../workbench/html.js";
import { LEVEL_LABELS as LEVEL_NAMES } from "./model-picker.js";

/** The levels a connection can narrow to (#27); `minimal` stays only on old settings. */
const LEVEL_CHOICES = ["off", "low", "medium", "high", "xhigh", "max"];
const LEVEL_SOURCES = { endpoint: ui("来自 /models 接口"), official: ui("官方 · 自动") };
/** Both hosts share one settings UI; keys are submitted once and never read back. */
export function installDesktopSettings({
  showToast,
  onSaved,
  host,
  api,
  projectId: projectIdOf,
  identity = () => location.origin
}) {
  const desktop = window.bookmanDesktop;
  const errorMessage = (error) => {
    const message = typeof error?.message === "string" ? error.message : ui("模型设置暂时不可用，请稍后重试");
    if (/Failed to fetch|fetch failed|NetworkError/.test(message))
      return ui("无法联系本机服务，请稍后重试；当前输入已保留。");
    return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  };
  if (desktop?.onDraftError) desktop.onDraftError((message) => showToast(errorMessage({ message })));
  else if (desktop?.draftWarning) showToast(desktop.draftWarning);
  const transport = async (path, options) => {
    if (api) return api(path, options);
    const response = await fetch(path, options);
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(ui("模型服务未返回有效的设置响应，请稍后重试"));
    }
    if (!response.ok)
      throw new Error(typeof result?.error === "string" ? result.error : ui("模型设置无法读取"));
    return result;
  };
  const settingsBackend = createSettingsBackend({ identity, api: transport });
  const request = async (method, body, path = "/api/model-settings") => {
    const options = {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    };
    return settingsBackend.request(path, options);
  };
  const currentProject = () => {
    const value = projectIdOf?.();
    return typeof value === "string" ? value : "";
  };
  const status = () => {
    const scoped = currentProject();
    return request(
      "GET",
      undefined,
      scoped ? `/api/model-settings?projectId=${encodeURIComponent(scoped)}` : "/api/model-settings"
    );
  };
  const save = (body) => request("POST", body);
  const saveRole = (body) => request("POST", body, "/api/model-settings/roles");
  const test = (body) => request("POST", body, "/api/model-settings/test");
  const detectLevels = (body) => request("POST", body, "/api/model-settings/levels");
  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card model-settings-card settings-card" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
    <header class="settings-heading"><button class="settings-nav-button" type="button" data-settings-back aria-label="返回设置" title="返回设置">${icon("chevron-left")}</button><div><h2 id="model-settings-title">连接模型</h2></div><button class="settings-nav-button" type="button" data-model-close aria-label="关闭设置" title="关闭设置">${icon("close")}</button></header>
    <form id="model-settings-form" class="settings-form"><div class="settings-scroll settings-form-content">
      <div class="settings-profile"><label class="settings-field model-profile-picker">已保存的配置<select data-model-profiles aria-label="已保存的配置"></select></label><p class="settings-help" data-model-active></p></div>
      <div class="settings-profile" data-model-roles>
        <label class="settings-field">Main 角色<select data-role-host aria-label="Main 角色默认连接"></select></label>
        <label class="settings-field" data-role-project-field hidden>项目覆盖<select data-role-project aria-label="当前项目的 Main 模型连接"></select></label>
        <p class="settings-help" data-role-effective></p>
      </div>
      <div class="model-connection-fields">
        <label class="settings-field">配置名称<input name="profileName" maxlength="80" required></label>
        <label class="settings-field">模型 ID<input name="model" required placeholder="填写服务商提供的模型 ID"></label>
        <label class="settings-field model-full-width">API 地址<input name="baseUrl" type="url" required placeholder="https://example.com/v1"></label>
        <label class="settings-field">消息格式<select name="api"><option value="openai-responses">Responses</option><option value="openai-completions">Chat Completions</option></select></label>
        <label class="settings-field">API Key<input name="apiKey" type="password" autocomplete="off" aria-label="API Key" aria-describedby="model-key-help"><small class="settings-help" id="model-key-help">${ui("密钥保存在执行主机的私有配置中。")}</small></label>
      </div>
      <div class="settings-capabilities">
        <label class="settings-toggle"><span><strong>此模型支持图像输入</strong><small>未启用时，历史图片不会发送给模型；原图仍保留。</small></span><input name="supportsImages" type="checkbox" aria-label="此模型支持图像输入"></label>
        <label class="settings-toggle"><span><strong>用此连接分析图片，供纯文本模型使用</strong><small>所选图片将发送到此服务；仅保存用途，不切换聊天模型。</small></span><input name="vision" type="checkbox" aria-label="用此连接分析图片，供纯文本模型使用"></label>
      </div>
      <details class="settings-advanced"><summary>高级连接参数${icon("chevron-down")}</summary><div class="settings-advanced-content">
        <label class="settings-field">思考模式格式<select name="thinkingFormat"><option value="auto">自动识别</option><option value="openai">标准格式</option><option value="zai">GLM 格式</option></select></label>
        <label class="settings-checkbox"><input name="supportsReasoningEffort" type="checkbox"><span>服务支持推理强度参数（reasoning_effort / reasoning.effort）</span></label>
        <label class="settings-checkbox"><input name="supportsPromptCacheKey" type="checkbox"><span>服务支持会话缓存键（prompt_cache_key）</span></label>
        <small class="settings-help">仅在服务商确认支持时开启；发送稳定会话键不保证服务端缓存命中。</small>
        <label class="settings-field">推理强度<select name="reasoningEffort"><option value="off">${esc(LEVEL_NAMES.off)}</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
        <div class="settings-field settings-levels" data-model-levels><span class="settings-levels-head">支持的推理档位<small class="settings-levels-source" data-levels-source hidden></small></span><div class="settings-levels-chips" role="group" aria-label="支持的推理档位" data-levels-chips>${LEVEL_CHOICES.map((level) => `<label class="settings-level-chip"><input type="checkbox" name="reasoningLevels" value="${level}" checked><span>${esc(LEVEL_NAMES[level])}</span></label>`).join("")}</div><p class="settings-levels-value" data-levels-value hidden></p><small class="settings-help" data-levels-help></small></div>
        <label class="settings-field">上下文窗口大小（token）<input name="contextWindow" type="number" min="1" max="9007199254740991" step="1" aria-describedby="model-context-help"></label>
        <small class="settings-help" id="model-context-help">按服务商容量填写，包含输入与输出，用于上下文预算和自动压缩。</small>
        <div class="model-connection-fields"><label class="settings-field">Main 每次输出上限<input name="mainMaxTokens" type="number" min="1" max="65536" step="1"></label><label class="settings-field">子智能体每次输出上限<input name="subagentMaxTokens" type="number" min="1" max="65536" step="1"></label></div>
      </div></details>
    </div><div class="settings-feedback"><p data-model-error role="alert"></p><p data-model-result role="status" aria-live="polite"></p></div>
    <footer class="modal-actions"><button class="app-button is-secondary" type="button" data-model-test>测试连接</button><button class="app-button is-primary" type="submit">保存连接</button><button type="submit" class="app-button is-primary" data-model-activate>保存并启用</button></footer></form></section>`;
  document.body.append(panel);
  const form = panel.querySelector("form");
  const dialog = createSettingsModal(panel, panel.querySelector("[data-model-close]"), {
    host,
    returnFocus: () => document.querySelector("#settings-model-add")?.focus()
  });
  const testButton = panel.querySelector("[data-model-test]");
  const submitButton = form.querySelector('[type="submit"]');
  const picker = panel.querySelector("[data-model-profiles]");
  const activateButton = panel.querySelector("[data-model-activate]");
  let snapshot = {};
  let selectedId = "";
  const drafts = new Map();
  const backendDrafts = new Map();
  let target;
  let busy = false;
  let loading = false;
  let loaded = false;
  let managed = false;
  let openRevision = 0;
  let dirty = false;
  const setBusy = (value) => {
    busy = value;
    for (const input of form.querySelectorAll("input, select"))
      if (!input.closest("[data-model-roles]")) input.disabled = busy || !loaded || managed;
    submitButton.disabled = busy || !loaded || managed;
    activateButton.disabled = busy || !loaded || managed;
    picker.disabled = busy || !loaded || managed;
    testButton.disabled = busy || !loaded;
    testButton.textContent = loading ? ui("载入中…") : busy ? ui("请稍候…") : ui("测试连接");
    setRoleDisabled();
  };
  const hostRole = panel.querySelector("[data-role-host]");
  const projectRole = panel.querySelector("[data-role-project]");
  const projectRoleField = projectRole.closest("label");
  const roleEffective = panel.querySelector("[data-role-effective]");
  let roleBusy = false;
  const roleLabels = {
    project: ui("项目覆盖"),
    host: ui("主机默认"),
    active: ui("当前启用连接"),
    environment: ui("启动环境"),
    explicit: ui("单次选择"),
    retry: ui("原请求快照")
  };
  const roleOption = (value, label) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  };
  const mainRole = () => snapshot.modelRoles?.roles?.find((role) => role.role === "main");
  const setRoleDisabled = () => {
    const disabled = roleBusy || busy || !loaded || managed;
    hostRole.disabled = disabled || !(snapshot.profiles || []).length;
    projectRole.disabled = disabled;
  };
  const fillRoleSelect = (select, current, fallback) => {
    select.replaceChildren(roleOption("", fallback));
    for (const profile of snapshot.profiles || []) select.append(roleOption(profile.id, profile.name));
    select.value = current || "";
  };
  const showRoles = () => {
    const main = mainRole();
    projectRoleField.hidden = !snapshot.modelRoles?.projectId;
    fillRoleSelect(hostRole, main?.host?.profileId, ui("跟随当前启用连接"));
    fillRoleSelect(projectRole, main?.project?.profileId, ui("跟随主机默认"));
    if (main?.error) roleEffective.textContent = main.error;
    else if (main?.effective) {
      const label = roleLabels[main.effective.source] || main.effective.source;
      roleEffective.textContent = ui`生效：${main.effective.connectionName || main.effective.model} · ${main.effective.model}（${label}）`;
    } else roleEffective.textContent = ui("尚未配置 Main 模型");
    setRoleDisabled();
  };
  const modelsRows = document.querySelector("#profile-settings-connections");
  const roleRows = document.querySelector("#settings-role-rows");
  const ROLE_META = [
    { role: "main", label: "Main", hint: ui("Main 的默认模型连接"), fallback: ui("跟随当前启用连接") },
    {
      role: "executor",
      label: "Executor",
      hint: ui("子 Agent 执行时的默认模型连接"),
      fallback: ui("沿用启动时的连接")
    },
    {
      role: "reviewer",
      label: "Reviewer",
      hint: ui("审查时的默认模型连接"),
      fallback: ui("沿用启动时的连接")
    }
  ];
  const REASONING = ["off", "low", "medium", "high", "xhigh", "max"];
  const REASONING_LABEL = {
    off: ui("关闭"),
    low: ui("低"),
    medium: ui("中"),
    high: ui("高"),
    xhigh: ui("极高"),
    max: ui("最高")
  };
  const apiLabel = (api) => (api === "openai-responses" ? "Responses" : ui("OpenAI 兼容"));

  const renderModels = (value) => {
    if (!modelsRows) return;
    const profiles = value.profiles || [];
    modelsRows.innerHTML = profiles.length
      ? profiles
          .map(
            (profile) => `<div class="settings-row" data-model-profile="${esc(profile.id)}">
        ${icon("plug")}
        <span class="settings-row-text">
          <span class="settings-row-name">${esc(profile.name)}</span>
          <span class="settings-row-meta">${esc(apiLabel(profile.api))} · ${esc(profile.model)}</span>
        </span>
        <span class="settings-row-spacer"></span>
        <span class="settings-dot ${profile.active ? "is-ok" : "is-muted"}" aria-hidden="true"></span>
        <span class="settings-row-state">${profile.active ? ui("当前启用") : ui("未启用")}</span>
        <button class="settings-icon-button" type="button" data-model-edit="${esc(profile.id)}" aria-label="${esc(ui`配置 ${profile.name}`)}" title="${esc(ui("配置"))}">${icon("more")}</button>
      </div>`
          )
          .join("")
      : `<div class="settings-row"><span class="settings-row-meta">${ui("尚未配置模型连接")}</span></div>`;
  };

  const roleBinding = (value, role) => (value.modelRoles?.roles || []).find((entry) => entry.role === role);
  // A change made on this section may fail after the person looked away from
  // the row; the reason stays with the row until its next change.
  const roleErrors = new Map();
  const effortProfileFor = (value, role) => {
    const profiles = value.profiles || [];
    const entry = roleBinding(value, role);
    return (
      profiles.find((profile) => profile.id === entry?.host?.profileId) ||
      profiles.find((profile) => profile.active)
    );
  };

  const renderRoles = (value) => {
    if (!roleRows) return;
    const profiles = value.profiles || [];
    roleRows.innerHTML = ROLE_META.map(({ role, label, hint, fallback }) => {
      const entry = roleBinding(value, role);
      const bound = profiles.find((profile) => profile.id === entry?.host?.profileId);
      const option = (profile) =>
        `<option value="${esc(profile.id)}"${profile.id === bound?.id ? " selected" : ""}>${esc(`${profile.name} / ${profile.model}`)}</option>`;
      const effortProfile = effortProfileFor(value, role);
      const effort = effortProfile?.reasoningEffort ?? "off";
      const failure = roleErrors.get(role);
      return `<div class="settings-row${failure ? " has-error" : ""}" data-model-role="${role}">
        <span class="settings-row-line settings-role-name"><span class="settings-row-name">${label}</span><span class="settings-info" title="${esc(hint)}">${icon("info")}</span></span>
        <span class="settings-row-spacer"></span>
        <select class="settings-select is-model" data-role-model="${role}" aria-label="${esc(ui`${label} 的模型连接`)}"${profiles.length ? "" : " disabled"}>
          <option value=""${bound ? "" : " selected"}>${esc(fallback)}</option>${profiles.map(option).join("")}
        </select>
        <select class="settings-select is-effort" data-role-effort="${role}" aria-label="${esc(ui`${label} 的推理强度`)}" title="${esc(
          ui("推理强度属于所选的模型连接")
        )}"${effortProfile ? "" : " disabled"}>
          ${REASONING.map((level) => `<option value="${level}"${level === effort ? " selected" : ""}>${esc(REASONING_LABEL[level])}</option>`).join("")}
        </select>
        <span class="settings-row-error" role="alert" data-role-error="${role}"${failure ? "" : " hidden"}>${failure ? esc(failure) : ""}</span>
      </div>`;
    }).join("");
  };

  let listed = {};
  const refreshList = async () => {
    settingsBackend.bind();
    try {
      const value = await status();
      listed = value;
      renderModels(value);
      renderRoles(value);
    } catch (error) {
      showToast(errorMessage(error));
    }
  };

  /**
   * Save one change made on this section and answer on the row itself.
   *
   * A failure must not go to the connection dialog's error line: that dialog is
   * closed, so nothing would be visible. The row keeps the reason, and the
   * controls go back to what the host persisted.
   */
  let roleSaving = false;
  const saveRoleFromSection = async (role, work) => {
    if (roleSaving) return;
    roleSaving = true;
    roleErrors.delete(role);
    if (listed.profiles) renderRoles(listed);
    settingsBackend.bind();
    let saved = true;
    try {
      await work();
    } catch (error) {
      saved = false;
      roleErrors.set(role, errorMessage(error));
      // Show the last persisted values at once, then confirm with the host.
      if (listed.profiles) renderRoles(listed);
    } finally {
      roleSaving = false;
    }
    await refreshList();
    // A role or effort change moves the level the next Main run sends, so the
    // composer must re-read it instead of keeping the previous label.
    if (saved) onSaved?.();
  };

  roleRows?.addEventListener("change", (event) => {
    const modelSelect = event.target.closest("[data-role-model]");
    if (modelSelect) {
      const role = modelSelect.dataset.roleModel;
      void saveRoleFromSection(role, () => saveRole({ role, profileId: modelSelect.value }));
      return;
    }
    const effortSelect = event.target.closest("[data-role-effort]");
    if (!effortSelect) return;
    const role = effortSelect.dataset.roleEffort;
    const level = effortSelect.value;
    const profile = effortProfileFor(listed, role);
    if (!profile) return;
    void saveRoleFromSection(role, () =>
      save({
        profileId: profile.id,
        profileName: profile.name,
        baseUrl: profile.baseUrl,
        model: profile.model,
        api: profile.api,
        reasoningEffort: level
      })
    );
  });
  modelsRows?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-model-edit]");
    if (button) void open(button.dataset.modelEdit);
  });
  document.querySelector("#settings-model-add")?.addEventListener("click", () => void open(""));
  host?.onSection?.("models", () => void refreshList());

  const changeRole = async (body) => {
    if (roleBusy || busy || !loaded || managed) return;
    roleBusy = true;
    setRoleDisabled();
    panel.querySelector("[data-model-error]").textContent = "";
    try {
      await saveRole(body);
      // A host-default save answers without a project scope, so re-read what
      // this page shows; otherwise the project override would disappear until
      // the panel is reopened.
      snapshot.modelRoles = (await status()).modelRoles;
      onSaved?.();
    } catch (error) {
      panel.querySelector("[data-model-error]").textContent = errorMessage(error);
    } finally {
      roleBusy = false;
      showRoles();
    }
  };
  hostRole.addEventListener("change", () => void changeRole({ role: "main", profileId: hostRole.value }));
  projectRole.addEventListener(
    "change",
    () =>
      void changeRole({
        role: "main",
        projectId: snapshot.modelRoles?.projectId || "",
        profileId: projectRole.value
      })
  );
  /**
   * Supported reasoning levels (#27): what the provider's /models entry or
   * Pi's table for an official address says is shown read-only; otherwise the
   * person ticks the levels, at least one. The default effort follows them.
   */
  let levelSource = "manual";
  let levelRevision = 0;
  let levelTimer;
  const levelsField = panel.querySelector("[data-model-levels]");
  const levelBoxes = () => levelsField.querySelectorAll('[name="reasoningLevels"]');
  const checkedLevels = () => [...levelBoxes()].filter((box) => box.checked).map((box) => box.value);
  const limitEffort = (levels) => {
    const effort = form.elements.reasoningEffort;
    for (const option of effort.options)
      if (!option.dataset.legacyEffort) option.hidden = option.disabled = !levels.includes(option.value);
    if (!levels.includes(effort.value) && effort.value !== "minimal") {
      const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const at = order.indexOf(effort.value);
      effort.value = levels.reduce((best, next) =>
        Math.abs(order.indexOf(next) - at) < Math.abs(order.indexOf(best) - at) ? next : best
      );
    }
  };
  const showLevels = ({ source, levels }) => {
    levelSource = source;
    const described = source !== "manual";
    const badge = levelsField.querySelector("[data-levels-source]");
    badge.hidden = !described;
    badge.textContent = LEVEL_SOURCES[source] || "";
    levelsField.querySelector("[data-levels-chips]").hidden = described;
    const value = levelsField.querySelector("[data-levels-value]");
    value.hidden = !described;
    value.textContent = levels.map((level) => LEVEL_NAMES[level] || level).join(" · ");
    levelsField.querySelector("[data-levels-help]").textContent =
      source === "endpoint"
        ? ui("服务商的模型列表给出了这个模型支持的档位，按模型自动识别。")
        : source === "official"
          ? ui("这是模型厂商的官方地址，档位按模型自动识别，不能修改。")
          : ui("无法自动识别这个服务的档位，请按服务商文档勾选；没勾的档位不会出现在输入框里。");
    limitEffort(described ? levels : checkedLevels());
  };
  const refreshLevels = async () => {
    const revision = ++levelRevision;
    const { baseUrl, model, apiKey } = values();
    if (!baseUrl.trim() || !model.trim()) return showLevels({ source: "manual", levels: checkedLevels() });
    try {
      const result = await detectLevels({ profileId: selectedId, baseUrl, model, apiKey });
      if (revision !== levelRevision) return;
      showLevels(result.source === "manual" ? { source: "manual", levels: checkedLevels() } : result);
    } catch (error) {
      // Detection only describes the levels; saving still validates what is sent.
      if (revision === levelRevision) showLevels({ source: "manual", levels: checkedLevels() });
      console.warn("reasoning level detection failed", error);
    }
  };
  levelsField.querySelector("[data-levels-chips]").addEventListener("change", (event) => {
    // At least one level stays chosen.
    if (!checkedLevels().length) event.target.checked = true;
    limitEffort(checkedLevels());
  });
  form.addEventListener("input", (event) => {
    if (!["baseUrl", "model", "apiKey"].includes(event.target.name)) return;
    clearTimeout(levelTimer);
    levelTimer = setTimeout(() => void refreshLevels(), 400);
  });
  const fill = (value) => {
    form.elements.profileName.value = value.profileName || value.name || ui("新配置");
    form.elements.baseUrl.value = value.baseUrl || "";
    form.elements.model.value = value.model || "";
    form.elements.api.value = value.api || "openai-responses";
    form.elements.supportsImages.checked = value.supportsImages === true;
    form.elements.vision.checked = value.vision === true;
    form.elements.supportsPromptCacheKey.checked = value.supportsPromptCacheKey === true;
    form.elements.supportsReasoningEffort.checked = value.supportsReasoningEffort === true;
    const effort = form.elements.reasoningEffort;
    effort.querySelector("[data-legacy-effort]")?.remove();
    // Keep old configurations unchanged without offering minimal as a new choice.
    if (value.reasoningEffort === "minimal") {
      const legacy = document.createElement("option");
      legacy.value = "minimal";
      legacy.textContent = ui("minimal（旧配置）");
      legacy.hidden = true;
      legacy.disabled = true;
      legacy.dataset.legacyEffort = "";
      effort.append(legacy);
    }
    effort.value = value.reasoningEffort || "off";
    form.elements.thinkingFormat.value = value.thinkingFormat || "auto";
    form.elements.mainMaxTokens.value = value.mainMaxTokens ?? 8192;
    form.elements.subagentMaxTokens.value = value.subagentMaxTokens ?? 8192;
    form.elements.contextWindow.value = value.contextWindow ?? 256000;
    form.elements.apiKey.value = value.apiKey || "";
    form.elements.apiKey.placeholder = value.configured ? ui("留空保留已有密钥") : ui("填写 API Key");
    form.elements.apiKey.required = !value.configured;
    const chosen = Array.isArray(value.reasoningLevels) ? value.reasoningLevels : LEVEL_CHOICES;
    for (const box of levelBoxes()) box.checked = chosen.includes(box.value);
    showLevels({ source: "manual", levels: chosen });
    void refreshLevels();
    panel.querySelector("[data-model-error]").textContent = managed
      ? ui("当前连接由启动环境管理，请在启动配置中修改。")
      : snapshot.credentialError || "";
    panel.querySelector("[data-model-result]").textContent = ui("测试连接会消耗模型额度。");
    activateButton.hidden = managed || !snapshot.activeProfileId || selectedId === snapshot.activeProfileId;
    setBusy(false);
  };
  picker.addEventListener("change", () => {
    drafts.set(selectedId, readDraft());
    selectedId = picker.value;
    fill(drafts.get(selectedId) || snapshot.profiles?.find((p) => p.id === selectedId) || {});
  });
  const showProfiles = () => {
    picker.replaceChildren();
    for (const profile of snapshot.profiles || []) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.name}${profile.id === snapshot.activeProfileId ? ui(" · 当前启用") : ""}`;
      picker.append(option);
    }
    const add = document.createElement("option");
    add.value = "";
    add.textContent = ui("＋ 新增配置");
    picker.append(add);
    picker.value = selectedId;
    const active = snapshot.profiles?.find((p) => p.id === snapshot.activeProfileId);
    panel.querySelector("[data-model-active]").textContent = active
      ? ui`当前启用：${active.name} · ${snapshot.model}`
      : ui("尚未启用模型连接");
  };
  const open = async (requestedProfile) => {
    // Reopening a pending operation keeps the same locked form and result target.
    if (!dialog.open()) return;
    const next = identity();
    if (target !== next) {
      if (target && loaded && (dirty || busy))
        backendDrafts.set(target, {
          snapshot,
          selectedId,
          drafts: new Map(drafts),
          input: readDraft(),
          managed
        });
      target = next;
      openRevision++;
      busy = false;
      loading = false;
      loaded = false;
      dirty = false;
      managed = false;
      snapshot = {};
      selectedId = "";
      drafts.clear();
      submitButton.textContent = ui("保存连接");
      showProfiles();
      fill({});
      showRoles();
      panel.querySelector("[data-model-error]").textContent = "";
      panel.querySelector("[data-model-result]").textContent = "";
      const draft = next && backendDrafts.get(next);
      if (draft) {
        settingsBackend.bind();
        snapshot = draft.snapshot;
        selectedId = draft.selectedId;
        for (const [id, value] of draft.drafts) drafts.set(id, value);
        managed = draft.managed;
        loaded = true;
        dirty = true;
        showProfiles();
        fill(draft.input);
        showRoles();
        return;
      }
    }
    if (busy || dirty || loading) return;
    const revision = ++openRevision;
    loading = true;
    loaded = false;
    setBusy(false);
    panel.querySelector("[data-model-result]").textContent = ui("正在读取模型连接…");
    try {
      settingsBackend.bind();
      const value = await status();
      if (revision !== openRevision || busy) return;
      snapshot = value;
      drafts.clear();
      selectedId = requestedProfile === undefined ? value.activeProfileId || "" : requestedProfile;
      managed = value.managedByEnvironment === true;
      showProfiles();
      const selected = value.profiles?.find((p) => p.id === selectedId);
      loaded = true;
      fill(managed ? value : selected || value);
      showRoles();
    } catch (error) {
      if (revision !== openRevision) return;
      panel.querySelector("[data-model-error]").textContent = errorMessage(error);
      panel.querySelector("[data-model-result]").textContent = ui("请返回设置后重新进入，重试读取连接。");
      showToast(errorMessage(error));
    } finally {
      if (revision === openRevision) {
        loading = false;
        setBusy(busy);
      }
    }
  };
  const optionalNumber = (name) => {
    const raw = form.elements[name].value.trim();
    return raw === "" ? undefined : Number(raw);
  };
  const values = () => ({
    profileName: form.elements.profileName.value,
    baseUrl: form.elements.baseUrl.value,
    model: form.elements.model.value,
    api: form.elements.api.value,
    apiKey: form.elements.apiKey.value,
    profileId: selectedId,
    supportsImages: form.elements.supportsImages.checked,
    vision: form.elements.vision.checked,
    supportsReasoningEffort: form.elements.supportsReasoningEffort.checked,
    supportsPromptCacheKey: form.elements.supportsPromptCacheKey.checked,
    reasoningEffort: form.elements.reasoningEffort.value,
    // Only a connection nothing describes keeps its own levels; all of them is no narrowing.
    reasoningLevels:
      levelSource !== "manual" || checkedLevels().length === LEVEL_CHOICES.length ? null : checkedLevels(),
    thinkingFormat: form.elements.thinkingFormat.value,
    mainMaxTokens: optionalNumber("mainMaxTokens"),
    subagentMaxTokens: optionalNumber("subagentMaxTokens"),
    contextWindow: optionalNumber("contextWindow")
  });
  const readDraft = () => ({
    ...values(),
    configured: !form.elements.apiKey.required,
    contextWindow: form.elements.contextWindow.value,
    mainMaxTokens: form.elements.mainMaxTokens.value,
    subagentMaxTokens: form.elements.subagentMaxTokens.value
  });
  testButton.addEventListener("click", async () => {
    if (busy || !loaded || !form.reportValidity()) return;
    const input = values();
    const revision = openRevision;
    setBusy(true);
    testButton.textContent = ui("测试中…");
    panel.querySelector("[data-model-error]").textContent = "";
    panel.querySelector("[data-model-result]").textContent = ui("正在验证工具调用和已选择的图像能力…");
    try {
      const result = await test(input);
      if (revision !== openRevision) return;
      if (result?.ok !== true || typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs))
        throw new Error(ui("连接测试未返回有效结果，请重试；当前输入已保留。"));
      panel.querySelector("[data-model-result]").textContent =
        ui`连接通过 · ${result.streaming ? ui("流式响应与") : ""}工具调用可用${result.supportsImages ? ui(" · 图像识别可用") : ""} · ${(result.durationMs / 1000).toFixed(1)} 秒`;
    } catch (error) {
      if (revision !== openRevision) return;
      panel.querySelector("[data-model-error]").textContent = errorMessage(error);
      panel.querySelector("[data-model-result]").textContent = ui("测试未通过，请调整后重试。");
    } finally {
      if (revision === openRevision) setBusy(false);
    }
  });
  form.addEventListener("input", (event) => {
    // Role selects save on change; they must not mark the connection form dirty.
    if (event.target?.closest?.("[data-model-roles]")) return;
    if (!busy && !loading) {
      dirty = true;
      panel.querySelector("[data-model-error]").textContent = "";
      panel.querySelector("[data-model-result]").textContent = ui("配置已修改，可测试后保存。");
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !loaded || managed || !form.reportValidity()) return;
    const input = {
      ...values(),
      activate:
        event.submitter === activateButton ||
        !snapshot.activeProfileId ||
        selectedId === snapshot.activeProfileId
    };
    const revision = openRevision;
    setBusy(true);
    submitButton.textContent = ui("保存中…");
    panel.querySelector("[data-model-error]").textContent = "";
    panel.querySelector("[data-model-result]").textContent = ui("正在保存模型连接…");
    try {
      await save(input);
      if (revision !== openRevision) return;
      form.elements.apiKey.value = "";
      dirty = false;
      backendDrafts.delete(target);
      drafts.clear();
      dialog.close();
      void refreshList();
      showToast(input.activate ? ui("模型连接已保存并启用") : ui("模型连接已保存，当前启用项未改变"));
      onSaved?.();
    } catch (error) {
      if (revision !== openRevision) return;
      dirty = true;
      panel.querySelector("[data-model-error]").textContent = errorMessage(error);
      panel.querySelector("[data-model-result]").textContent =
        ui("保存未完成，当前输入已保留；请处理上方提示后重试。");
    } finally {
      if (revision === openRevision) {
        setBusy(false);
        submitButton.textContent = ui("保存连接");
      }
    }
  });
  installWebSearchSettings({ showToast, host, api, identity });
  return { open, refresh: () => void refreshList() };
}
