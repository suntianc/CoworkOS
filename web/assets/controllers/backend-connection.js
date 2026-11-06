import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";
import { createSettingsModal } from "./settings-modal.js";
import { normalizeBackendUrl } from "./management-client.js";

/**
 * Which backend this page is managing, and how to reach another one.
 *
 * The banner and the settings row exist because authorization and protocol
 * refusals are states a person can act on: reauthorize, or connect to a backend
 * that speaks this client's protocol. They are not background diagnostics, so
 * they never report a command's result — only the connection itself.
 */
export function createBackendConnection({ management, overview, showToast, onReady }) {
  const row = document.createElement("div");
  row.className = "profile-setting";
  row.innerHTML = ui`<span class="settings-row-copy"><span class="settings-row-icon">${icon("grid")}</span><span><strong>后端</strong><small data-backend-status>正在连接…</small></span></span><button type="button" class="app-button is-secondary" data-backend-open aria-label="切换后端">切换${icon("chevron-right")}</button>`;
  document.querySelector("#profile-settings-connections").append(row);

  const banner = document.querySelector("#connection-state");
  banner.classList.add("backend-banner");
  banner.innerHTML = ui`<span data-backend-banner-message></span><button type="button" class="app-button is-secondary" data-backend-banner-action hidden></button>`;
  const bannerMessage = banner.querySelector("[data-backend-banner-message]");
  const bannerAction = banner.querySelector("[data-backend-banner-action]");

  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card model-settings-card settings-card" role="dialog" aria-modal="true" aria-labelledby="backend-title"><header class="settings-heading"><button class="settings-nav-button" type="button" data-settings-back aria-label="返回设置" title="返回设置">${icon("chevron-left")}</button><div><h2 id="backend-title">后端</h2></div><button class="settings-nav-button" type="button" data-backend-close aria-label="关闭设置" title="关闭设置">${icon("close")}</button></header><form class="settings-form"><div class="settings-scroll settings-form-content"><p class="settings-status" data-backend-state role="status"></p><label class="settings-field">后端地址<input name="baseUrl" type="url" inputmode="url" autocomplete="off" placeholder="http://127.0.0.1:3880" aria-describedby="backend-address-help"></label><small class="settings-help" id="backend-address-help">留空使用当前页面所在的后端。</small></div><div class="settings-feedback"><p data-backend-error role="alert"></p></div><footer class="modal-actions"><button type="button" class="app-button is-secondary" data-backend-page>当前页面</button><button type="button" class="app-button is-primary" data-backend-choose hidden>选择本地后端</button><button type="submit" class="app-button is-primary">连接</button></footer></form></section>`;
  document.body.append(panel);
  const form = panel.querySelector("form");
  const input = form.querySelector('[name="baseUrl"]');
  const submit = form.querySelector('[type="submit"]');
  const stateLine = panel.querySelector("[data-backend-state]");
  const errorLine = panel.querySelector("[data-backend-error]");
  const dialog = createSettingsModal(panel, panel.querySelector("[data-backend-close]"), {
    overview,
    returnFocus: () => row.querySelector("[data-backend-open]").focus()
  });
  const desktopBackend = window.bookmanDesktop?.backend;
  if (desktopBackend) {
    form.querySelector("[data-backend-choose]").hidden = false;
    form.querySelector("[data-backend-page]").hidden = true;
    submit.hidden = true;
    input.readOnly = true;
    form.querySelector("#backend-address-help").hidden = true;
  }
  let current = management.state();
  let busy = false;
  let offline = false;

  const host = (baseUrl) => {
    try {
      return new URL(baseUrl || location.href).host;
    } catch {
      return baseUrl;
    }
  };
  const shortId = (backendId) =>
    typeof backendId === "string" && backendId ? backendId.replace(/^backend_/, "").slice(0, 8) : "";
  const describe = (state) => {
    if (state.status === "connected")
      return [host(state.baseUrl), shortId(state.backendId)].filter(Boolean).join(" · ");
    if (state.status === "connecting") return ui("正在连接…");
    if (state.status === "unauthorized") return ui("会话已失效");
    if (state.status === "incompatible") return ui("协议不兼容");
    if (state.status === "unsupported") return ui("缺少目录事件能力");
    if (state.status === "stopped") return ui("已断开");
    return state.error?.message || ui("无法连接");
  };

  function renderBanner() {
    if (current.status === "connected" || current.status === "connecting" || current.status === "idle") {
      if (offline) {
        bannerMessage.textContent = ui("连接中断 · 正在重连");
        bannerAction.hidden = true;
        banner.hidden = false;
        return;
      }
      banner.hidden = true;
      bannerAction.hidden = true;
      return;
    }
    // An ended session or an incompatible backend is the actionable reason the
    // connection is unavailable; do not replace it with the generic notice.
    const unauthorized = current.status === "unauthorized";
    bannerMessage.textContent = unauthorized
      ? ui("本地会话已失效，未发送草稿已保留")
      : current.error?.message || ui("后端连接不可用");
    bannerAction.textContent = unauthorized ? ui("重新授权") : ui("连接设置");
    bannerAction.dataset.backendBannerAction = unauthorized ? "authorize" : "settings";
    bannerAction.hidden = false;
    banner.hidden = false;
  }

  function render() {
    current = management.state();
    row.querySelector("[data-backend-status]").textContent = describe(current);
    stateLine.textContent = current.error?.message
      ? `${describe(current)} · ${current.error.message}`
      : describe(current);
    if (!busy) input.value = current.baseUrl || location.origin;
    renderBanner();
  }

  async function run(action) {
    if (busy) return current;
    busy = true;
    submit.disabled = true;
    errorLine.textContent = "";
    try {
      const next = await action();
      current = next;
      render();
      if (next.status === "connected") {
        dialog.close();
        showToast(ui`已连接 ${host(next.baseUrl)}`);
        await onReady?.(next);
      }
      return next;
    } catch (error) {
      errorLine.textContent = error.message;
      render();
      return current;
    } finally {
      busy = false;
      submit.disabled = false;
    }
  }

  row.querySelector("[data-backend-open]").addEventListener("click", () => {
    if (!dialog.open()) return;
    render();
  });

  bannerAction.addEventListener("click", () => {
    if (bannerAction.dataset.backendBannerAction === "authorize") void run(() => management.authorize());
    else row.querySelector("[data-backend-open]").click();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let target;
    try {
      target = normalizeBackendUrl(input.value.trim() === location.origin ? "" : input.value);
    } catch (error) {
      errorLine.textContent = error.message;
      return;
    }
    void run(() => management.switchBackend({ baseUrl: target }));
  });

  panel.querySelector("[data-backend-choose]").addEventListener("click", async () => {
    if (!desktopBackend || busy) return;
    busy = true;
    errorLine.textContent = "";
    try {
      await desktopBackend.choose();
    } catch (error) {
      errorLine.textContent = error.message;
    } finally {
      busy = false;
    }
  });

  panel.querySelector("[data-backend-page]").addEventListener("click", () => {
    void run(() => management.switchBackend({ baseUrl: "" }));
  });

  return {
    apply(state) {
      current = state;
      render();
    },
    /** A catalog read failed: say the connection dropped, without changing identity. */
    setOnline(online) {
      offline = !online;
      renderBanner();
    },
    /** Reauthorize from outside the banner, e.g. after a refused action. */
    reauthorize: () => run(() => management.authorize()),
    ready: () => management.state().status === "connected",
    open() {
      if (dialog.open()) render();
    }
  };
}
