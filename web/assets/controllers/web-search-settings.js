import { ui } from "../ui/language.js";
import { createSettingsModal } from "./settings-modal.js";
import { icon } from "../ui/icons.js";
import { createSettingsBackend } from "./settings-backend.js";

/** Search credentials are submitted once. Both hosts use the same choices and status vocabulary. */
export function installWebSearchSettings({ showToast, host, api, identity = () => location.origin }) {
  const transport = async (path, options) => {
    if (api) return api(path, options);
    const response = await fetch(path, options);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || ui("搜索设置暂时不可用"));
    return value;
  };
  const settingsBackend = createSettingsBackend({ identity, api: transport });
  const request = async (method, body) => {
    const options = {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    };
    return settingsBackend.request("/api/web-search-settings", options);
  };
  const status = () => request("GET");
  const save = (input) => request("POST", input);
  const row = document.createElement("div");
  row.className = "profile-setting";
  row.innerHTML = ui`<span class="settings-row-copy"><span class="settings-row-icon">${icon("search")}</span><span><strong>联网搜索</strong><small data-search-status></small></span></span><button type="button" class="app-button is-secondary" data-search-open aria-label="管理联网搜索">配置${icon("chevron-right")}</button>`;
  document.querySelector("#profile-settings-tools").append(row);
  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card model-settings-card settings-card" role="dialog" aria-modal="true" aria-labelledby="web-search-title">
    <header class="settings-heading"><button class="settings-nav-button" type="button" data-settings-back aria-label="返回设置" title="返回设置">${icon("chevron-left")}</button><div><h2 id="web-search-title">联网搜索</h2></div><button class="settings-nav-button" type="button" data-search-close aria-label="关闭设置" title="关闭设置">${icon("close")}</button></header>
    <form class="settings-form"><div class="settings-scroll settings-form-content">
      <p class="settings-status" data-search-state role="status"></p>
      <p class="settings-note">Exa 可匿名使用，受免费限额和地区网络限制。</p>
      <label class="settings-field">搜索服务<select name="provider" aria-describedby="search-provider-help"><option value="exa">Exa（默认）</option><option value="serper">Serper（保留已有配置）</option><option value="off">关闭联网搜索</option></select></label>
      <small id="search-provider-help" class="settings-help">查询和来源链接会发送给所选服务。</small>
      <details class="settings-advanced"><summary>高级设置 · 可选认证${icon("chevron-down")}</summary><div class="settings-advanced-content">
        <label class="settings-field">自有 Exa API Key<input name="exaApiKey" type="password" autocomplete="off" placeholder="可选；留空保留已有密钥"></label>
        <label class="settings-checkbox"><input name="clearExaApiKey" type="checkbox"><span>清除已有 Exa 密钥，使用匿名模式</span></label>
        <small class="settings-help">${ui("密钥保存在执行主机的私有配置中。")}自有密钥的额度和计费由 Exa 管理；Serper 沿用已有密钥。</small>
      </div></details>
    </div><div class="settings-feedback"><p data-search-error role="alert"></p></div>
    <footer class="modal-actions"><button type="submit" class="app-button is-primary">保存设置</button></footer></form></section>`;
  document.body.append(panel);
  const dialog = createSettingsModal(panel, panel.querySelector("[data-search-close]"), {
    host,
    returnFocus: () => row.querySelector("[data-search-open]").focus()
  });
  const form = panel.querySelector("form");
  let busy = false,
    loading = false,
    loaded = false,
    dirty = false,
    revision = 0,
    managed = false,
    target,
    lastStatus;
  const drafts = new Map();
  const message = (error) =>
    String(error?.message || ui("搜索设置暂时不可用，请稍后重试")).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      ""
    );
  const label = (value) =>
    value.enabled
      ? ui`已启用 · ${value.provider === "exa" ? "Exa" : "Serper"} · ${value.authenticated ? ui("自有密钥") : value.provider === "exa" ? ui("匿名限额") : ui("需配置 Serper 密钥")}`
      : ui("已关闭");
  const display = (value) => {
    lastStatus = value;
    row.querySelector("[data-search-status]").textContent = label(value);
    panel.querySelector("[data-search-state]").textContent = label(value);
  };
  const lock = () => {
    for (const input of form.querySelectorAll("input, select, button[type=submit]"))
      input.disabled = busy || !loaded || managed;
  };
  row.querySelector("[data-search-open]").addEventListener("click", async () => {
    if (!dialog.open()) return;
    const next = identity();
    if (target !== next) {
      if (target && dirty)
        drafts.set(target, {
          provider: form.elements.provider.value,
          exaApiKey: form.elements.exaApiKey.value,
          clearExaApiKey: form.elements.clearExaApiKey.checked,
          managed,
          lastStatus
        });
      target = next;
      revision++;
      busy = false;
      loading = false;
      loaded = false;
      dirty = false;
      managed = false;
      lastStatus = undefined;
      form.elements.provider.value = "exa";
      form.elements.exaApiKey.value = "";
      form.elements.clearExaApiKey.checked = false;
      panel.querySelector("[data-search-error]").textContent = "";
      panel.querySelector("[data-search-state]").textContent = "";
      row.querySelector("[data-search-status]").textContent = "";
      const draft = next && drafts.get(next);
      if (draft) {
        settingsBackend.bind();
        form.elements.provider.value = draft.provider;
        form.elements.exaApiKey.value = draft.exaApiKey;
        form.elements.clearExaApiKey.checked = draft.clearExaApiKey;
        managed = draft.managed;
        if (draft.lastStatus) display(draft.lastStatus);
        loaded = true;
        dirty = true;
        lock();
        return;
      }
    }
    if (busy || dirty || loading) return;
    const current = ++revision;
    loading = true;
    loaded = false;
    lock();
    panel.querySelector("[data-search-state]").textContent = ui("正在读取搜索设置…");
    try {
      settingsBackend.bind();
      const value = await status();
      if (current !== revision || busy || dirty) return;
      display(value);
      form.elements.provider.value = value.provider;
      managed = value.managedByEnvironment;
      panel.querySelector("[data-search-error]").textContent = managed
        ? ui("搜索设置由启动环境管理，请在启动配置中修改。")
        : value.secretUnavailable
          ? ui("已有 Exa 密钥无法解密，请填写新密钥或清除后使用匿名模式。")
          : "";
      loaded = true;
      lock();
    } catch (error) {
      if (current !== revision) return;
      panel.querySelector("[data-search-error]").textContent = message(error);
      panel.querySelector("[data-search-state]").textContent = ui("请返回设置后重新进入，重试读取搜索设置。");
      showToast(message(error));
    } finally {
      if (current === revision) {
        loading = false;
        lock();
      }
    }
  });
  form.addEventListener("input", () => {
    dirty = true;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !loaded || managed) return;
    busy = true;
    const current = revision;
    lock();
    panel.querySelector("[data-search-error]").textContent = "";
    try {
      const value = await save({
        provider: form.elements.provider.value,
        exaApiKey: form.elements.exaApiKey.value,
        clearExaApiKey: form.elements.clearExaApiKey.checked
      });
      if (current !== revision) return;
      display(value);
      form.elements.exaApiKey.value = "";
      form.elements.clearExaApiKey.checked = false;
      dirty = false;
      drafts.delete(target);
      dialog.close();
      showToast(ui("联网搜索设置已保存，后续运行使用新设置"));
    } catch (error) {
      if (current !== revision) return;
      panel.querySelector("[data-search-error]").textContent = message(error);
    } finally {
      if (current === revision) {
        busy = false;
        lock();
      }
    }
  });
}
