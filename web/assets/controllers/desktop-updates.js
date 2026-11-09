import { ui } from "../ui/language.js";
import { icon } from "../ui/icons.js";

/** Render host-owned updates without exposing paths, commands or download URLs to the page. */
export function installDesktopUpdates({ host } = {}) {
  const desktop = window.bookmanDesktop;
  const section = document.querySelector("#profile-settings-about .desktop-updates");
  if (!desktop?.updateStatus || !desktop?.checkUpdates || !desktop?.applyUpdate || !section) return;
  const panel = document.querySelector("#settings-entry");
  const action = section.querySelector("[data-update-action]");
  action.hidden = false;
  const message = section.querySelector("[data-update-message]");
  const error = section.querySelector("[data-update-error]");
  const progress = section.querySelector("[data-update-progress]");
  const notice = document.createElement("button");
  notice.type = "button";
  notice.className = "desktop-update-notice";
  notice.dataset.updateNotice = "";
  notice.setAttribute("aria-controls", "settings-entry");
  notice.hidden = true;
  notice.innerHTML = icon("download");
  document.querySelector("#user-menu-button")?.before(notice);
  let state = { phase: "idle" };
  let pending = false;
  let applying = false;
  let revision = 0;
  let locked = false;
  let restoreInert = [];
  let disposed = false;

  function lockEditors(value) {
    if (locked === value) return;
    locked = value;
    if (value) {
      restoreInert = [...document.body.children]
        .filter((element) => element !== panel && !element.matches("script, svg, #night-sky, #toast"))
        .map((element) => [element, element.inert]);
      for (const [element] of restoreInert) element.inert = true;
    } else {
      for (const [element, previous] of restoreInert) element.inert = previous;
      restoreInert = [];
    }
    const back = document.querySelector("#settings-back");
    if (back) back.disabled = value;
  }

  function canApply() {
    return Boolean(state.available || state.downloaded || (state.updated && state.error));
  }

  function render() {
    if (disposed) return;
    const busy = pending || state.busy === true;
    const source = state.mode === "source";
    const manual = state.installMethod === "manual";
    const ready = state.downloaded === true;
    const preparing = applying || state.applying === true;
    const inAppInstall = ["native", "managed"].includes(state.installMethod);
    const finished = Boolean((state.updated || state.installReady) && !state.error);
    const editingLocked =
      finished ||
      (source && (preparing || state.phase === "updating")) ||
      (inAppInstall && ready && preparing);
    lockEditors(Boolean(editingLocked));
    section.querySelector("[data-update-version]").textContent = state.currentVersion
      ? ui`版本 ${state.currentVersion}${source ? ui(" · 源码开发版") : ""}`
      : ui("版本信息暂不可用");
    action.hidden = manual;
    action.disabled = manual || busy || finished;
    action.classList.toggle("is-primary", canApply());
    action.classList.toggle("is-secondary", !canApply());
    action.toggleAttribute("data-update-apply", canApply());
    action.toggleAttribute("data-update-check", !canApply());
    action.textContent = finished
      ? ui("正在重新打开…")
      : busy && state.phase === "checking"
        ? ui("检查中…")
        : busy && state.phase === "downloading"
          ? ui("下载中…")
          : busy && preparing
            ? source
              ? ui("更新中…")
              : ui("正在安装…")
            : canApply()
              ? source
                ? ui("更新并重启")
                : ready
                  ? inAppInstall
                    ? ui("重启并安装")
                    : ui("打开安装器")
                  : inAppInstall
                    ? ui("下载更新")
                    : ui("下载安装器")
              : ui("检查更新");
    const labels = {
      manual: ui("请使用本地安装包手动升级。"),
      checking: ui("正在检查更新…"),
      "up-to-date": ui("已是最新版本。"),
      updating: ui("正在更新，完成后会重新打开 Formicand。"),
      downloading: ui("正在下载更新…"),
      ready:
        source || state.installReady
          ? ui("更新完成，正在重新打开 Formicand…")
          : inAppInstall
            ? ui("更新已下载，重启即可安装。")
            : ui("安装器已下载并校验，请打开后将安装包内的 App 拖入 Applications，再重新打开。")
    };
    message.textContent =
      state.phase === "available"
        ? source
          ? state.rebuildRequired
            ? ui("CLI 已更新，需要重新构建 App，可以更新并重启。")
            : ui("发现新的开发提交，可以更新并重启。")
          : ui`有新版本 ${state.version}。`
        : labels[state.phase] || "";
    if (state.phase === "up-to-date" && state.message) message.textContent = state.message;
    message.hidden = !message.textContent;
    error.textContent =
      typeof state.error === "string"
        ? state.error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
        : "";
    error.hidden = !error.textContent;
    progress.hidden = !busy || !["updating", "downloading"].includes(state.phase);
    if (Number.isFinite(state.progress?.percent)) {
      progress.max = 100;
      progress.value = Math.min(100, Math.max(0, state.progress.percent));
    } else progress.removeAttribute("value");
    notice.hidden = !canApply() || busy || finished;
    const noticeLabel = source
      ? ui("发现更新，查看 Formicand 更新")
      : ready
        ? ui("更新已下载，查看并重启安装")
        : ui`发现新版本${state.version ? ` ${state.version}` : ""}，查看 Formicand 更新`;
    notice.setAttribute("aria-label", noticeLabel);
    notice.title = noticeLabel;
  }

  function reflect(value) {
    if (disposed || !value || typeof value !== "object") return;
    revision += 1;
    state = value;
    render();
  }

  async function operation(run, isApply = false) {
    if (disposed || pending || state.busy) return;
    pending = true;
    applying = isApply;
    state = { ...state, error: undefined };
    render();
    try {
      reflect(await run());
    } catch (failure) {
      state = {
        ...state,
        phase: "error",
        busy: false,
        applying: false,
        error: failure?.message || ui("更新暂时不可用，请稍后重试")
      };
    } finally {
      pending = false;
      applying = false;
      render();
    }
  }

  const runCheck = () => operation(() => desktop.checkUpdates({}));
  action.addEventListener("click", () => {
    if (canApply()) void operation(() => desktop.applyUpdate(), true);
    else void runCheck();
  });
  notice.addEventListener("click", () => {
    if (host) host.open();
    else document.querySelector("#user-menu-button")?.click();
    section.scrollIntoView({ block: "nearest" });
    action.focus({ preventScroll: true });
  });
  const preventClose = (event) => {
    if (locked && ((event.type === "click" && event.target === panel) || event.key === "Escape")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  panel.addEventListener("click", preventClose, true);
  window.addEventListener("keydown", preventClose, true);
  const unsubscribe = desktop.onUpdateStatus?.(reflect);
  const initialRevision = revision;
  void desktop
    .updateStatus()
    .then(async (value) => {
      if (disposed) return;
      if (revision === initialRevision) reflect(value);
      // A completed background download remains installable across page reloads.
      if (
        state.installMethod !== "manual" &&
        !state.downloaded &&
        !state.busy &&
        !state.installReady &&
        !state.updated
      )
        await runCheck();
    })
    .catch((failure) => {
      state = { ...state, error: failure?.message || ui("无法读取更新状态") };
      render();
    });
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener("keydown", preventClose, true);
      panel.removeEventListener("click", preventClose, true);
      lockEditors(false);
    },
    { once: true }
  );
  render();
}
