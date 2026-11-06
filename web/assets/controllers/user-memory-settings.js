import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { createUserMemoryViewer } from "./user-memory-viewer.js";

/** Inline controls with an on-demand view of saved memories. */
export function installUserMemorySettings({ showToast, overview, api }) {
  const row = document.createElement("div");
  row.className = "user-memory-settings";
  row.innerHTML = ui`<div class="profile-setting user-memory-setting"><span class="settings-row-copy"><span class="settings-row-icon">${icon("history")}</span><span><strong>个人记忆</strong><small role="status" data-memory-status></small></span></span><span class="user-memory-actions"><label class="settings-toggle user-memory-switch"><input type="checkbox" aria-label="使用个人记忆" data-memory-use></label><button type="button" class="app-button is-secondary" data-memory-open aria-label="查看记忆">查看${icon("chevron-right")}</button></span></div>
    <details class="user-memory-learning-options"><summary><span>自动学习设置</span><small data-memory-learning-summary>正在读取…</small>${icon("chevron-right")}</summary><div class="user-memory-learning-content"><label class="settings-toggle"><span><strong>自动学习</strong><small data-memory-learning-status>后台整理会产生额外模型用量</small></span><input type="checkbox" aria-label="自动学习" data-memory-learn></label><form data-memory-options>
      <label class="settings-field">后台模型<input data-memory-model aria-label="后台模型" maxlength="160" placeholder="留空使用当前连接的模型"><small class="settings-help">使用当前连接；可填写该连接支持的其他模型。</small></label>
      <label class="settings-field">单次输出上限（tokens）<input type="number" data-memory-tokens aria-label="单次输出上限" min="256" max="4096" step="1" value="2048"></label>
      <label class="settings-field">每小时请求上限<input type="number" data-memory-limit aria-label="每小时请求上限" min="2" max="24" step="1" value="6"><small class="settings-help">提取和压缩各计一次；达到上限后保留输入，稍后继续。</small></label>
      <button type="submit" class="app-button is-secondary" disabled>保存学习设置</button><p role="status" data-memory-options-result></p>
    </form></div></details>`;
  (
    document.querySelector("#profile-settings-general") ||
    document.querySelector("#profile-settings-connections")
  ).append(row);
  let viewer;
  const open = row.querySelector("[data-memory-open]");
  open.addEventListener("click", () => {
    viewer ??= createUserMemoryViewer({ overview, returnFocus: () => open.focus(), api });
    viewer.open();
  });
  const use = row.querySelector("[data-memory-use]");
  const learn = row.querySelector("[data-memory-learn]");
  const status = row.querySelector("[data-memory-status]");
  const learningStatus = row.querySelector("[data-memory-learning-status]");
  const learningSummary = row.querySelector("[data-memory-learning-summary]");
  const form = row.querySelector("[data-memory-options]");
  const model = row.querySelector("[data-memory-model]");
  const tokens = row.querySelector("[data-memory-tokens]");
  const limit = row.querySelector("[data-memory-limit]");
  const save = form.querySelector("[type=submit]");
  const result = row.querySelector("[data-memory-options-result]");
  let busy = false;
  let optionsDirty = false;
  let last = { enabled: false, learningEnabled: false };
  const render = (value) => {
    last = value;
    use.checked = value.enabled;
    learn.checked = value.learningEnabled;
    use.disabled = busy;
    learn.disabled = busy || (!value.enabled && !value.learningEnabled);
    learningSummary.textContent = value.learningEnabled
      ? value.enabled
        ? ui("已开启")
        : ui("已暂停")
      : ui("已关闭");
    learningStatus.textContent = !value.enabled
      ? ui("需先开启个人记忆；暂停期间保留已有输入")
      : ui("后台整理会产生额外模型用量");
    use.title = value.enabled ? ui("使用已保存的个人记忆") : ui("已关闭个人记忆，已有内容仍会保留");
    if (!optionsDirty) {
      const options = value.learningOptions ?? {};
      model.value = options.model ?? "";
      tokens.value = String(options.maxTokens ?? 2048);
      limit.value = String(options.maxRequestsPerHour ?? 6);
    }
    for (const field of [model, tokens, limit]) field.disabled = busy;
    save.disabled = busy || !optionsDirty;
  };
  const refresh = async (change) => {
    if (busy) {
      render(last);
      return;
    }
    busy = true;
    use.disabled = true;
    learn.disabled = true;
    for (const field of [model, tokens, limit]) field.disabled = true;
    save.disabled = true;
    try {
      const options = {
        cache: "no-store",
        ...(change
          ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) }
          : {})
      };
      const value = api
        ? await api("/api/user-memory", options)
        : await fetch("/api/user-memory", options).then(async (response) => {
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || ui("用户记忆暂不可用"));
            return body;
          });
      status.textContent = "";
      if (change?.action === "set_learning_options") {
        optionsDirty = false;
        result.textContent = ui("学习设置已保存");
      }
      render(value);
    } catch (error) {
      render(last);
      status.textContent = error.message;
      showToast(error.message);
    } finally {
      busy = false;
      render(last);
    }
  };
  use.addEventListener("change", () => void refresh({ action: "set_enabled", enabled: use.checked }));
  learn.addEventListener("change", () => void refresh({ action: "set_learning", enabled: learn.checked }));
  form.addEventListener("input", () => {
    optionsDirty = true;
    result.textContent = "";
    save.disabled = busy;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled || busy) return;
    const modelId = model.value.trim();
    const maxTokens = Number(tokens.value);
    const maxRequestsPerHour = Number(limit.value);
    if (
      (modelId && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(modelId)) ||
      !Number.isInteger(maxTokens) ||
      maxTokens < 256 ||
      maxTokens > 4096 ||
      !Number.isInteger(maxRequestsPerHour) ||
      maxRequestsPerHour < 2 ||
      maxRequestsPerHour > 24
    ) {
      result.textContent = ui("请检查模型名称和用量上限。");
      return;
    }
    void refresh({
      action: "set_learning_options",
      options: { ...(modelId ? { model: modelId } : {}), maxTokens, maxRequestsPerHour }
    });
  });
  // Re-read when the existing settings surface opens (including changes made in chat).
  const panel = document.querySelector("#profile-modal");
  if (panel)
    new MutationObserver(() => {
      if (!panel.hidden) void refresh();
    }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  void refresh();
}
