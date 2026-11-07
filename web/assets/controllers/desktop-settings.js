import { ui } from "../ui/language.js";
import { installWebSearchSettings } from "./web-search-settings.js";
import { createSettingsModal } from "./settings-modal.js";
import { createSettingsBackend } from "./settings-backend.js";
import { icon } from "../ui/icons.js";
/** Both hosts share one settings UI; keys are submitted once and never read back. */
export function installDesktopSettings({
  showToast,
  onSaved,
  overview,
  api,
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
  if (desktop?.capabilities) {
    const row = document.createElement("div");
    row.className = "profile-setting";
    const notice = desktop.capabilities.notifications ? ui("支持") : ui("不可用");
    const tray = desktop.capabilities.tray ? ui("支持") : ui("不可用");
    row.innerHTML = ui`<span class="settings-row-copy"><span class="settings-row-icon">${icon("bell")}</span><span><strong>桌面能力</strong><small>通知：${notice} · 托盘：${tray}</small></span></span>`;
    document.querySelector("#profile-settings-general").append(row);
  }
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
  const status = () => request("GET");
  const save = (body) => request("POST", body);
  const test = (body) => request("POST", body, "/api/model-settings/test");
  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card model-settings-card settings-card" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
    <header class="settings-heading"><button class="settings-nav-button" type="button" data-settings-back aria-label="返回设置" title="返回设置">${icon("chevron-left")}</button><div><h2 id="model-settings-title">连接模型</h2></div><button class="settings-nav-button" type="button" data-model-close aria-label="关闭设置" title="关闭设置">${icon("close")}</button></header>
    <form id="model-settings-form" class="settings-form"><div class="settings-scroll settings-form-content">
      <div class="settings-profile"><label class="settings-field model-profile-picker">已保存的配置<select data-model-profiles aria-label="已保存的配置"></select></label><p class="settings-help" data-model-active></p></div>
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
        <label class="settings-field">推理强度<select name="reasoningEffort"><option value="off">关闭</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
        <label class="settings-field">上下文窗口大小（token）<input name="contextWindow" type="number" min="1" max="9007199254740991" step="1" aria-describedby="model-context-help"></label>
        <small class="settings-help" id="model-context-help">按服务商容量填写，包含输入与输出，用于上下文预算和自动压缩。</small>
        <div class="model-connection-fields"><label class="settings-field">Main 每次输出上限<input name="mainMaxTokens" type="number" min="1" max="65536" step="1"></label><label class="settings-field">子智能体每次输出上限<input name="subagentMaxTokens" type="number" min="1" max="65536" step="1"></label></div>
      </div></details>
    </div><div class="settings-feedback"><p data-model-error role="alert"></p><p data-model-result role="status" aria-live="polite"></p></div>
    <footer class="modal-actions"><button class="app-button is-secondary" type="button" data-model-test>测试连接</button><button class="app-button is-primary" type="submit">保存连接</button><button type="submit" class="app-button is-primary" data-model-activate>保存并启用</button></footer></form></section>`;
  document.body.append(panel);
  const form = panel.querySelector("form");
  const dialog = createSettingsModal(panel, panel.querySelector("[data-model-close]"), {
    overview,
    returnFocus: () => button.focus()
  });
  const testButton = panel.querySelector("[data-model-test]");
  const submitButton = form.querySelector('[type="submit"]');
  const picker = panel.querySelector("[data-model-profiles]");
  const activateButton = panel.querySelector("[data-model-activate]");
  let snapshot = {};
  let selectedId = "";
  const drafts = new Map();
  let busy = false;
  let loading = false;
  let loaded = false;
  let managed = false;
  let openRevision = 0;
  let dirty = false;
  const setBusy = (value) => {
    busy = value;
    for (const input of form.querySelectorAll("input, select")) input.disabled = busy || !loaded || managed;
    submitButton.disabled = busy || !loaded || managed;
    activateButton.disabled = busy || !loaded || managed;
    picker.disabled = busy || !loaded || managed;
    testButton.disabled = busy || !loaded;
    testButton.textContent = loading ? ui("载入中…") : busy ? ui("请稍候…") : ui("测试连接");
  };
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
    panel.querySelector("[data-model-error]").textContent = managed
      ? ui("当前连接由启动环境管理，请在启动配置中修改。")
      : snapshot.credentialError || "";
    panel.querySelector("[data-model-result]").textContent = ui("测试连接会消耗模型额度。");
    activateButton.hidden = managed || !snapshot.activeProfileId || selectedId === snapshot.activeProfileId;
    setBusy(false);
  };
  picker.addEventListener("change", () => {
    drafts.set(selectedId, { ...values(), configured: !form.elements.apiKey.required });
    selectedId = picker.value;
    fill(drafts.get(selectedId) || snapshot.profiles?.find((p) => p.id === selectedId) || {});
  });
  const open = async () => {
    // Reopening a pending operation keeps the same locked form and result target.
    if (!dialog.open()) return;
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
      selectedId = value.activeProfileId || "";
      managed = value.managedByEnvironment === true;
      picker.replaceChildren();
      for (const profile of value.profiles || []) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = `${profile.name}${profile.id === value.activeProfileId ? ui(" · 当前启用") : ""}`;
        picker.append(option);
      }
      const add = document.createElement("option");
      add.value = "";
      add.textContent = ui("＋ 新增配置");
      picker.append(add);
      picker.value = selectedId;
      const active = value.profiles?.find((p) => p.id === value.activeProfileId);
      panel.querySelector("[data-model-active]").textContent = active
        ? ui`当前启用：${active.name} · ${value.model}`
        : ui("尚未启用模型连接");
      loaded = true;
      fill(managed ? value : active || value);
    } catch (error) {
      panel.querySelector("[data-model-error]").textContent = errorMessage(error);
      panel.querySelector("[data-model-result]").textContent = ui("请返回设置后重新进入，重试读取连接。");
      showToast(errorMessage(error));
    } finally {
      loading = false;
      setBusy(busy);
    }
  };
  const optionalNumber = (name) => {
    const raw = form.elements[name].value.trim();
    return raw === "" ? undefined : Number(raw);
  };
  const values = () => ({
    ...Object.fromEntries(new FormData(form)),
    profileId: selectedId,
    supportsImages: form.elements.supportsImages.checked,
    vision: form.elements.vision.checked,
    supportsReasoningEffort: form.elements.supportsReasoningEffort.checked,
    supportsPromptCacheKey: form.elements.supportsPromptCacheKey.checked,
    reasoningEffort: form.elements.reasoningEffort.value,
    mainMaxTokens: optionalNumber("mainMaxTokens"),
    subagentMaxTokens: optionalNumber("subagentMaxTokens"),
    contextWindow: optionalNumber("contextWindow")
  });
  testButton.addEventListener("click", async () => {
    if (busy || !loaded || !form.reportValidity()) return;
    const input = values();
    setBusy(true);
    testButton.textContent = ui("测试中…");
    panel.querySelector("[data-model-error]").textContent = "";
    panel.querySelector("[data-model-result]").textContent = ui("正在验证工具调用和已选择的图像能力…");
    try {
      const result = await test(input);
      if (result?.ok !== true || typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs))
        throw new Error(ui("连接测试未返回有效结果，请重试；当前输入已保留。"));
      panel.querySelector("[data-model-result]").textContent =
        ui`连接通过 · ${result.streaming ? ui("流式响应与") : ""}工具调用可用${result.supportsImages ? ui(" · 图像识别可用") : ""} · ${(result.durationMs / 1000).toFixed(1)} 秒`;
    } catch (error) {
      panel.querySelector("[data-model-error]").textContent = errorMessage(error);
      panel.querySelector("[data-model-result]").textContent = ui("测试未通过，请调整后重试。");
    } finally {
      setBusy(false);
    }
  });
  form.addEventListener("input", () => {
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
    setBusy(true);
    submitButton.textContent = ui("保存中…");
    panel.querySelector("[data-model-error]").textContent = "";
    panel.querySelector("[data-model-result]").textContent = ui("正在保存模型连接…");
    try {
      await save(input);
      form.elements.apiKey.value = "";
      dirty = false;
      drafts.clear();
      dialog.close();
      showToast(input.activate ? ui("模型连接已保存并启用") : ui("模型连接已保存，当前启用项未改变"));
      onSaved?.();
    } catch (error) {
      dirty = true;
      panel.querySelector("[data-model-error]").textContent = errorMessage(error);
      panel.querySelector("[data-model-result]").textContent =
        ui("保存未完成，当前输入已保留；请处理上方提示后重试。");
    } finally {
      setBusy(false);
      submitButton.textContent = ui("保存连接");
    }
  });
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = ui`配置${icon("chevron-right")}`;
  button.setAttribute("aria-label", ui("管理模型连接"));
  button.className = "app-button is-secondary";
  button.id = "desktop-model-settings";
  button.addEventListener("click", () => {
    void open();
  });
  const connectionRow = document.createElement("div");
  connectionRow.className = "profile-setting";
  connectionRow.innerHTML = ui`<span class="settings-row-copy"><span class="settings-row-icon">${icon("code")}</span><span><strong>模型连接</strong></span></span>`;
  connectionRow.append(button);
  document.querySelector("#profile-settings-connections").append(connectionRow);
  installWebSearchSettings({ showToast, overview, api, identity });
  return { open };
}
