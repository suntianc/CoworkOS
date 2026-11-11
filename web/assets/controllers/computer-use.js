import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";

/** One host-wide setting grants access; task ownership remains a runtime concern. */
export function installComputerUse({ api, getSelectedTaskId, getTaskLabel, showToast }) {
  const settings = document.querySelector("#settings-entry");
  const section = document.createElement("details");
  section.className = "computer-setting";
  section.setAttribute("aria-label", ui("窗口访问"));
  section.innerHTML = ui`<summary class="profile-setting"><span class="settings-row-copy"><span class="settings-row-icon">${icon("layout")}</span><span><strong>窗口访问</strong><small id="computer-access-state" data-computer-state role="status"></small></span></span><span class="settings-row-action">设置${icon("chevron-right")}</span></summary><div class="computer-setting-content"><p>允许所有对话观察并操作全部应用窗口。</p>
    <div class="computer-permission-actions">
      <button class="app-button is-secondary" type="button" data-computer-permission="screenRecording">开启屏幕录制</button>
      <button class="app-button is-secondary" type="button" data-computer-permission="accessibility">开启辅助功能</button>
      <button class="app-button" id="computer-access-enabled" type="button" aria-pressed="false" aria-describedby="computer-access-state">开启窗口访问</button>
    </div>
    <p data-computer-permissions role="status" hidden></p>
    <p data-computer-error role="alert" hidden></p></div>`;
  document.querySelector("#profile-settings-tools").append(section);
  const bar = document.createElement("div");
  bar.className = "computer-control-bar";
  bar.hidden = true;
  bar.setAttribute("aria-label", ui("电脑操作与人工接管"));
  bar.innerHTML = ui`<span class="computer-live-dot" aria-hidden="true"></span><span data-computer-label></span><button class="app-button is-secondary" type="button" data-computer-pause>暂停 · 人工接管</button><button class="app-button is-secondary" type="button" data-computer-bar-resume hidden>恢复窗口访问</button>`;
  document.querySelector("#conversation").before(bar);
  const $ = (selector) => section.querySelector(selector);
  const toggle = $("#computer-access-enabled");
  const native = window.bookmanDesktop?.computerUse;
  section.querySelector(".computer-permission-actions").hidden = !native;
  let access = { policy: { enabled: false }, paused: false },
    taskBlocked = false,
    pendingPolicy,
    warning,
    approvalRequired = false,
    permissions,
    takeoverShortcut,
    generation = 0,
    accessRequest = 0,
    permissionRequest = 0,
    viewedTaskId,
    timer,
    polling = false;
  const pendingPermissions = new Set();

  function error(message = "") {
    $("[data-computer-error]").textContent = message;
    $("[data-computer-error]").hidden = !message;
    if (message) section.open = true;
  }
  function missingPermissions() {
    const missing = [];
    if (permissions && !permissions.screenRecording) missing.push(ui("屏幕录制"));
    if (permissions && !permissions.accessibility) missing.push(ui("辅助功能"));
    else if (permissions?.postEventAccess === false) missing.push(ui("输入事件"));
    return missing;
  }
  function permissionGranted(permission) {
    return (
      permissions?.available === true &&
      permissions[permission] === true &&
      (permission !== "accessibility" || permissions.postEventAccess !== false)
    );
  }
  function permissionsReady() {
    return permissionGranted("screenRecording") && permissionGranted("accessibility");
  }
  function paint() {
    const enabled = access.policy.enabled;
    const paused = access.paused;
    const missing = missingPermissions();
    const effectiveEnabled = pendingPolicy ?? enabled;
    toggle.disabled = !native || ((!effectiveEnabled || paused || taskBlocked) && !permissionsReady());
    toggle.setAttribute("aria-pressed", String(effectiveEnabled));
    toggle.textContent = effectiveEnabled
      ? paused || taskBlocked
        ? ui("恢复窗口访问")
        : pendingPolicy
          ? ui("取消开启窗口访问")
          : ui("关闭窗口访问")
      : approvalRequired
        ? ui("确认并开启窗口访问")
        : ui("开启窗口访问");
    toggle.setAttribute("aria-busy", String(pendingPolicy !== undefined));
    for (const button of section.querySelectorAll("[data-computer-permission]")) {
      const permission = button.dataset.computerPermission;
      const label =
        permission === "screenRecording"
          ? { enabled: ui("屏幕录制已开启"), pending: ui("正在申请屏幕录制…"), idle: ui("开启屏幕录制") }
          : { enabled: ui("辅助功能已开启"), pending: ui("正在申请辅助功能…"), idle: ui("开启辅助功能") };
      const granted = permissionGranted(permission);
      const pending = pendingPermissions.has(permission);
      button.disabled = !native || granted || pending;
      button.textContent = granted ? label.enabled : pending ? label.pending : label.idle;
      button.setAttribute("aria-busy", String(pending));
    }
    $("[data-computer-state]").textContent = !native
      ? !permissions
        ? ui("正在读取执行主机状态")
        : !permissions.available || permissions.controlAvailable === false
          ? ui("执行主机窗口访问不可用")
          : paused
            ? ui("执行主机窗口访问已暂停")
            : enabled
              ? ui("执行主机窗口访问已开启")
              : ui("执行主机窗口访问已关闭")
      : pendingPolicy !== undefined
        ? pendingPolicy
          ? ui("正在开启窗口访问…")
          : ui("正在关闭…")
        : paused && enabled
          ? ui("已暂停，需手动恢复")
          : taskBlocked && enabled
            ? ui("当前对话已停止，需手动恢复窗口访问")
            : enabled
              ? !permissions?.available
                ? ui("窗口访问暂不可用")
                : missing.length
                  ? ui("等待系统授权")
                  : ui("已开启")
              : approvalRequired
                ? ui("等待本机确认")
                : warning || (permissionsReady() ? ui("已关闭") : ui("请先开启屏幕录制和辅助功能"));
    const permissionState = (granted) => (granted ? ui("已开启") : ui("未开启"));
    const permissionList = () =>
      ui`屏幕录制：${permissionState(permissions.screenRecording)} · 辅助功能：${permissionState(
        permissions.accessibility
      )}${permissions.accessibility && permissions.postEventAccess === false ? ui(" · 输入事件：未开启") : ""}`;
    // The host explains why access is unavailable; catalogue entries cover the
    // reasons this build can report, anything else stays the host's own text.
    const hostReason = () => (permissions?.reason ? ui(permissions.reason) : undefined);
    const permissionMessage = !permissions
      ? ""
      : !native
        ? `${ui("执行主机：")}${
            permissions.available
              ? `${permissionList()}${
                  permissions.controlAvailable === false ? ui`。${hostReason() ?? ui("桌面暂不可操作")}` : ""
                }`
              : (hostReason() ?? ui("窗口访问不可用"))
          }${ui("。请在执行主机的 Formicand 桌面版处理权限。")}`
        : !permissions.available
          ? (hostReason() ?? ui("当前电脑操作不可用"))
          : [
              missing.length ? permissionList() : ui("权限已开启 · 屏幕录制、辅助功能"),
              enabled && permissions.controlAvailable === false && !missing.length
                ? (hostReason() ?? ui("桌面暂不可操作"))
                : ""
            ]
              .filter(Boolean)
              .join(ui("。 "));
    $("[data-computer-permissions]").textContent = permissionMessage;
    $("[data-computer-permissions]").hidden = !permissionMessage;
    const owner = access.owner;
    const active = owner?.state === "active" && !paused;
    const focused = bar.contains(document.activeElement) ? document.activeElement : null;
    bar.hidden = !native || (!active && !(paused && enabled));
    bar.dataset.state = paused ? "paused" : "active";
    bar.querySelector("[data-computer-label]").textContent = paused
      ? ui("窗口访问已暂停")
      : owner
        ? `${getTaskLabel(owner.taskId)} · ${owner.target.application} · ${owner.target.title || ui("窗口")}${takeoverShortcut ? ui` · 接管 ${takeoverShortcut}` : ""}`
        : "";
    bar.querySelector("[data-computer-pause]").hidden = paused;
    bar.querySelector("[data-computer-bar-resume]").hidden = !paused;
    bar.querySelector("[data-computer-bar-resume]").disabled = !permissionsReady();
    if (focused && (focused.hidden || bar.hidden)) {
      const next = bar.hidden
        ? document.querySelector("#user-menu-button")
        : bar.querySelector(paused ? "[data-computer-bar-resume]" : "[data-computer-pause]");
      if (!settings.hidden) toggle.focus();
      else next.focus();
    }
  }
  function needsPolling() {
    return !settings.hidden || (native && (access.policy.enabled || access.owner));
  }
  function beginPolling() {
    if (timer || !needsPolling()) return;
    timer = setInterval(() => {
      if (polling) return;
      if (!needsPolling()) {
        clearInterval(timer);
        timer = undefined;
        return;
      }
      polling = true;
      const version = generation;
      void Promise.all([
        refreshAccess(),
        ...(!settings.hidden || missingPermissions().length || !permissions?.available
          ? [refreshPermissions()]
          : [])
      ])
        // eslint-disable-next-line no-restricted-syntax -- a failed 1s poll paints the panel's connection notice below and the next tick retries
        .catch(() => {
          if (version === generation)
            error(
              native ? ui("连接中断，可使用人工接管或关闭窗口访问") : ui("连接中断，无法读取执行主机权限")
            );
        })
        .finally(() => {
          polling = false;
        });
    }, 1_000);
  }
  async function refreshAccess() {
    const version = generation;
    const request = ++accessRequest;
    const selected = getSelectedTaskId();
    const current = await api("/api/computer/access");
    const task = selected ? await api(`/api/tasks/${encodeURIComponent(selected)}/computer`) : null;
    if (version !== generation || request !== accessRequest || selected !== getSelectedTaskId()) return;
    access = current;
    taskBlocked = Boolean(task?.access?.taskBlocked);
    paint();
    beginPolling();
    if (!needsPolling() && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  async function refreshPermissions() {
    const version = generation;
    const request = ++permissionRequest;
    const status = await api("/api/computer/status");
    if (version !== generation || request !== permissionRequest) return;
    permissions = status;
    paint();
  }
  async function refresh() {
    const version = generation;
    try {
      if (native) {
        const policy = await native({ operation: "policy-status" });
        if (version !== generation) return;
        warning = policy.warning;
        approvalRequired = policy.approvalRequired === true;
      }
      await Promise.all([refreshAccess(), refreshPermissions()]);
      if (version === generation) error();
      // eslint-disable-next-line no-restricted-syntax -- the host may still be starting when the panel opens; the error state is painted and the poll retries the read
    } catch {
      if (version === generation)
        error(native ? ui("连接中断，可使用人工接管或关闭窗口访问") : ui("连接中断，无法读取执行主机权限"));
    }
  }
  async function savePolicy() {
    if (!native) return;
    const enabled = !(pendingPolicy ?? access.policy.enabled);
    if (enabled && !permissionsReady()) return;
    const version = ++generation;
    pendingPolicy = enabled;
    error();
    paint();
    try {
      const result = await native({ operation: "policy", enabled, mode: "control" });
      if (version !== generation || result.cancelled) return;
      warning = result.warning;
      approvalRequired = false;
      takeoverShortcut = result.takeoverShortcut;
      access = { policy: { enabled: result.enabled, mode: "control" }, paused: false };
      taskBlocked = false;
      await Promise.all([refreshAccess(), refreshPermissions()]);
      if (version !== generation) return;
      showToast(
        !enabled
          ? ui("已关闭窗口访问")
          : permissions?.available && !missingPermissions().length
            ? ui("已允许所有对话观察和操作窗口")
            : ui("请完成系统授权后使用窗口访问")
      );
    } catch (reason) {
      if (version !== generation) return;
      error(reason.message);
      // eslint-disable-next-line no-restricted-syntax -- this is the recovery read after a failed save whose error is already shown; without a snapshot the previous approval flag stays
      const policy = await native({ operation: "policy-status" }).catch(() => undefined);
      if (version === generation && policy) approvalRequired = policy.approvalRequired === true;
      // eslint-disable-next-line no-restricted-syntax -- the same recovery path: failing to re-read access leaves the last known values behind the already-reported error
      await Promise.all([refreshAccess(), refreshPermissions()]).catch(() => {});
    } finally {
      if (version === generation) {
        pendingPolicy = undefined;
        paint();
      }
    }
  }
  async function control(operation) {
    if (!native) return;
    const version = ++generation;
    error();
    try {
      const result = await native({ operation });
      if (version !== generation || result?.cancelled) return;
      pendingPolicy = undefined;
      access = { ...access, paused: operation === "pause" };
      if (operation === "resume") taskBlocked = false;
      takeoverShortcut = result?.takeoverShortcut || takeoverShortcut;
      paint();
      await refreshAccess();
    } catch (reason) {
      if (version === generation) error(reason.message);
    }
  }
  async function requestPermission(permission) {
    if (!native || pendingPermissions.has(permission) || permissionGranted(permission)) return;
    const version = generation;
    pendingPermissions.add(permission);
    error();
    paint();
    try {
      const result = await native({ operation: "permissions", permission });
      if (version !== generation || result?.cancelled) return;
      await refreshPermissions();
    } catch (reason) {
      if (version === generation) error(reason.message);
    } finally {
      pendingPermissions.delete(permission);
      paint();
    }
  }
  toggle.addEventListener("click", () => {
    if (access.policy.enabled && (access.paused || taskBlocked) && pendingPolicy === undefined)
      void control("resume");
    else void savePolicy();
  });
  for (const button of section.querySelectorAll("[data-computer-permission]"))
    button.addEventListener("click", () => void requestPermission(button.dataset.computerPermission));
  bar.querySelector("[data-computer-pause]").addEventListener("click", () => void control("pause"));
  bar.querySelector("[data-computer-bar-resume]").addEventListener("click", () => void control("resume"));
  document.querySelector("#user-menu-button").addEventListener("click", () => void refresh());
  const refreshOnReturn = () => {
    if (!document.hidden && needsPolling()) void refresh();
  };
  window.addEventListener("focus", refreshOnReturn);
  document.addEventListener("visibilitychange", refreshOnReturn);
  window.addEventListener("pagehide", () => {
    generation++;
    if (timer) clearInterval(timer);
  });
  paint();
  void refresh();
  return {
    refresh,
    reset() {
      generation++;
      access = { policy: { enabled: false }, paused: false };
      permissions = undefined;
      pendingPolicy = undefined;
      approvalRequired = false;
      warning = undefined;
      takeoverShortcut = undefined;
      taskBlocked = false;
      viewedTaskId = undefined;
      pendingPermissions.clear();
      if (timer) clearInterval(timer);
      timer = undefined;
      error();
      paint();
    },
    syncTask() {
      const selected = getSelectedTaskId();
      if (selected === viewedTaskId) return;
      viewedTaskId = selected;
      taskBlocked = false;
      // eslint-disable-next-line no-restricted-syntax -- selecting a conversation reads access in the background; a failure keeps the last panel state until the next selection or access poll
      void refreshAccess().catch(() => {});
    }
  };
}
