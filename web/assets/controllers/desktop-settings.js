import { ui } from "../ui/language.js";
import { installWebSearchSettings } from "./web-search-settings.js";
import { createSettingsBackend } from "./settings-backend.js";
import { installModelProviders } from "./model-providers.js";

/** Both hosts share one settings UI; keys are submitted once and never read back. */
export function installDesktopSettings({ showToast, onSaved, host, api, identity = () => location.origin }) {
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
  const models = installModelProviders({
    panel: document.querySelector('[data-settings-panel="models"]'),
    request,
    status: () => {
      settingsBackend.bind();
      return request("GET");
    },
    showToast,
    onSaved,
    errorMessage,
    identity
  });
  host?.onSection?.("models", () => void models.refresh());
  installWebSearchSettings({ showToast, host, api, identity });
  return {
    /** Open settings on the model page; without providers the add dialog opens too. */
    open: () => {
      host?.open?.("models");
      models.openSetup();
    },
    refresh: () => void models.refresh()
  };
}
