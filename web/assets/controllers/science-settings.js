import { ui } from "../ui/language.js";
import { createSettingsModal } from "./settings-modal.js";
import { icon } from "../ui/icons.js";
import { createScienceInstallation } from "./science-installation.js";

/** Configuration reads never start Python; checks require an explicit click. */
export function installScienceSettings({ showToast, overview, api }) {
  const request = async (method, body, suffix = "") => {
    const options = {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    };
    if (api) return api(`/api/science-settings${suffix}`, options);
    const response = await fetch(`/api/science-settings${suffix}`, options);
    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error(ui("科学环境服务未返回有效响应，请稍后重试"));
    }
    if (!response.ok) throw new Error(value.error || ui("科学环境设置暂时不可用"));
    return value;
  };
  const row = document.createElement("div");
  row.className = "profile-setting";
  row.innerHTML = ui`<span class="settings-row-copy"><span class="settings-row-icon">${icon("flask")}</span><span><strong>科学计算</strong><small data-science-status>正在读取科学设置…</small></span></span><button type="button" class="app-button is-secondary" data-science-open aria-label="管理科学环境">配置${icon("chevron-right")}</button>`;
  (
    document.querySelector("#profile-settings-tools") ||
    document.querySelector("#profile-settings-connections")
  ).append(row);
  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="science-settings-title">
    <header class="settings-heading"><button class="settings-nav-button" type="button" data-settings-back aria-label="返回设置" title="返回设置">${icon("chevron-left")}</button><div><h2 id="science-settings-title">科学计算</h2></div><button class="settings-nav-button" type="button" data-science-close aria-label="关闭设置" title="关闭设置">${icon("close")}</button></header>
    <form class="settings-form"><div class="settings-scroll settings-form-content">
      <p class="settings-status" data-science-state role="status"></p>
      <div class="settings-capabilities"><label class="settings-toggle"><span><strong>启用科学工具</strong></span><input name="enabled" type="checkbox" aria-label="启用科学工具"></label></div>
      <p class="settings-note">路径用于新任务，开关在下次启动会话时生效。已有任务保留原环境；关闭后，恢复旧任务时科学计算不可用。</p>
      <div data-science-installations></div>
      <label class="settings-field">基础 Python<input name="pythonExecutable" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="python3" aria-describedby="science-general-help"></label>
      <small id="science-general-help" class="settings-help">留空使用 python3；数组分析需要 NumPy 和 SciPy。</small>
      <div class="science-check-action"><button type="button" class="app-button is-secondary" data-science-check="general">检查基础环境</button><small class="settings-help">不保存当前设置。</small></div>
      <div class="science-check-result" data-science-result="general" role="status" aria-live="polite" hidden></div>
      <label class="settings-field">RDKit Python<input name="chemistryPythonExecutable" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="留空使用基础 Python"></label>
      <div class="science-check-action"><button type="button" class="app-button is-secondary" data-science-check="chemistry">检查 RDKit 环境</button></div>
      <div class="science-check-result" data-science-result="chemistry" role="status" aria-live="polite" hidden></div>
      <p class="settings-help" data-science-managed></p>
      <details class="settings-advanced" data-science-install><summary>安装指引 · 手动操作${icon("chevron-down")}</summary><div class="settings-advanced-content">
        <p class="settings-help">使用 Python 3.10+ 创建环境，再填写解释器绝对路径。</p>
        <strong class="science-install-title">基础数组分析（可选）</strong><pre class="science-install-command"><code>python3 -m venv .tools/science
.tools/science/bin/python -m pip install numpy==2.2.6 scipy==1.15.3</code></pre>
        <strong class="science-install-title">独立 RDKit 环境</strong><pre class="science-install-command"><code>python3 -m venv .tools/science-rdkit
.tools/science-rdkit/bin/python -m pip install rdkit==2026.9.1 numpy==2.2.6 Pillow==11.3.0</code></pre>
        <p class="settings-help">以上为 macOS/Linux 命令示例；Windows 使用环境内 Scripts/python.exe。RDKit 固定为 2026.9.1；该版未提供 Intel Mac wheel，可在受支持环境运行，不能直接替换为旧版。</p>
      </div></details>
    </div><div class="settings-feedback"><p data-science-error role="alert"></p></div>
    <footer class="modal-actions"><button type="submit" class="app-button is-primary">保存设置</button></footer></form></section>`;
  document.body.append(panel);
  const form = panel.querySelector("form");
  const dialog = createSettingsModal(panel, panel.querySelector("[data-science-close]"), {
    overview,
    returnFocus: () => row.querySelector("[data-science-open]").focus(),
    onClose: () => installations.close()
  });
  let busy = false,
    loading = false,
    loaded = false,
    dirty = false,
    revision = 0;
  let managedFields = {};
  const message = (error) => {
    const value = String(error?.message || ui("科学环境设置暂时不可用，请稍后重试"));
    return /Failed to fetch|fetch failed|NetworkError/.test(value)
      ? ui("无法联系本机服务，请稍后重试；当前输入已保留。")
      : value;
  };
  const display = (value) => {
    const label = value.enabled ? ui("已启用") : ui("已关闭");
    row.querySelector("[data-science-status]").textContent = label;
    panel.querySelector("[data-science-state]").textContent = label;
  };
  const fill = (value) => {
    display(value);
    form.elements.enabled.checked = value.enabled;
    form.elements.pythonExecutable.value = value.pythonExecutable || "";
    form.elements.chemistryPythonExecutable.value = value.chemistryInheritsGeneral
      ? ""
      : value.chemistryPythonExecutable || "";
    managedFields = value.managedFields || {};
    panel.querySelector("[data-science-managed]").textContent = value.managedByEnvironment
      ? ui("部分设置由启动环境管理，已锁定相应字段；请在启动配置中修改。")
      : "";
    panel.querySelector("[data-science-error]").textContent = value.configurationError || "";
  };
  const lock = () => {
    for (const input of form.querySelectorAll("input"))
      input.disabled = busy || !loaded || managedFields[input.name] === true;
    form.querySelector('[type="submit"]').disabled =
      busy ||
      !loaded ||
      ["enabled", "pythonExecutable", "chemistryPythonExecutable"].every((field) => managedFields[field]);
    for (const button of form.querySelectorAll("[data-science-check]")) button.disabled = busy || !loaded;
    installations.availability(!busy && loaded, managedFields);
  };
  const clearChecks = () => {
    for (const result of form.querySelectorAll("[data-science-result]")) {
      result.hidden = true;
      result.replaceChildren();
    }
  };
  const values = () => ({
    enabled: form.elements.enabled.checked,
    pythonExecutable: form.elements.pythonExecutable.value.trim(),
    chemistryPythonExecutable: form.elements.chemistryPythonExecutable.value.trim()
  });
  const installations = createScienceInstallation({
    container: panel.querySelector("[data-science-installations]"),
    request,
    interpreter: (target) => {
      const draft = values();
      return (
        (target === "chemistry" ? draft.chemistryPythonExecutable : "") || draft.pythonExecutable || "python3"
      );
    },
    useEnvironment: (field, python) => {
      form.elements[field].value = python;
      form.elements[field].dispatchEvent(new Event("input", { bubbles: true }));
      showToast(ui("环境路径已填入，保存设置后供新任务使用"));
    }
  });
  row.querySelector("[data-science-open]").addEventListener("click", async () => {
    if (!dialog.open()) return;
    installations.open();
    if (busy || dirty || loading) return;
    const current = ++revision;
    loading = true;
    loaded = false;
    clearChecks();
    lock();
    panel.querySelector("[data-science-error]").textContent = "";
    panel.querySelector("[data-science-state]").textContent = ui("正在读取科学设置…");
    try {
      const value = await request("GET");
      if (current !== revision || dirty || busy) return;
      fill(value);
      loaded = true;
    } catch (error) {
      panel.querySelector("[data-science-error]").textContent = message(error);
      panel.querySelector("[data-science-state]").textContent =
        ui("请返回设置后重新进入，重试读取科学设置。");
    } finally {
      loading = false;
      lock();
    }
  });
  form.addEventListener("input", () => {
    dirty = true;
    revision++;
    clearChecks();
  });
  for (const button of form.querySelectorAll("[data-science-check]")) {
    button.addEventListener("click", async () => {
      if (busy || !loaded) return;
      const target = button.dataset.scienceCheck;
      const draft = values();
      const interpreter =
        (target === "chemistry" ? draft.chemistryPythonExecutable : "") ||
        draft.pythonExecutable ||
        "python3";
      const field = target === "chemistry" ? "chemistryPythonExecutable" : "pythonExecutable";
      const current = revision;
      const result = panel.querySelector(`[data-science-result="${target}"]`);
      busy = true;
      lock();
      result.hidden = false;
      result.textContent = ui("正在检查环境…");
      panel.querySelector("[data-science-error]").textContent = "";
      try {
        const value = await request(
          "POST",
          { target, ...(managedFields[field] ? {} : { pythonExecutable: interpreter }) },
          "/check"
        );
        if (current !== revision) return;
        const heading = document.createElement("strong");
        heading.textContent = value.ok
          ? ui("环境可用")
          : value.python.available
            ? ui("Python 可用 · 依赖缺失或版本不兼容")
            : ui("Python 不可用");
        const details = document.createElement("p");
        details.textContent = value.python.available
          ? `Python ${value.python.version || ui("版本未知")}`
          : value.error?.message || ui("请检查解释器路径和安装情况。");
        const packages = document.createElement("ul");
        for (const name of target === "general" ? ["numpy", "scipy"] : ["rdkit"]) {
          const item = document.createElement("li");
          const dependency = value.packages[name];
          item.textContent = `${name}: ${dependency?.available ? dependency.version || ui("可用") : ui("未安装或无法导入")}`;
          packages.append(item);
        }
        result.replaceChildren(heading, details, packages);
        if (!value.ok) {
          const help = document.createElement("p");
          help.textContent =
            value.error?.message ||
            (target === "general"
              ? ui("缺少数组依赖时，标准库标量计算仍可使用。请参照下方指引手动安装。")
              : ui("请在独立环境安装所需 RDKit 版本，并重新检查。"));
          result.append(help);
          panel.querySelector("[data-science-install]").open = true;
        }
      } catch (error) {
        if (current === revision) result.textContent = message(error);
      } finally {
        busy = false;
        lock();
      }
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !loaded) return;
    busy = true;
    lock();
    panel.querySelector("[data-science-error]").textContent = "";
    try {
      const draft = values();
      const input = Object.fromEntries(Object.entries(draft).filter(([field]) => !managedFields[field]));
      fill(await request("POST", input));
      dirty = false;
      clearChecks();
      dialog.close();
      showToast(ui("科学环境设置已保存，后续启动会话时生效"));
    } catch (error) {
      panel.querySelector("[data-science-error]").textContent = message(error);
    } finally {
      busy = false;
      lock();
    }
  });
  void request("GET")
    .then((value) => {
      if (revision === 0 && !busy && !dirty) display(value);
    })
    .catch((error) => {
      if (revision === 0 && !busy && !dirty)
        row.querySelector("[data-science-status]").textContent = message(error);
    });
}
