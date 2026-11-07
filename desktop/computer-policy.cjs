const fs = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

function validatePolicy(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.enabled !== "boolean" ||
    !["observe", "control"].includes(value.mode) ||
    Object.keys(value).some((key) => !["enabled", "mode"].includes(key))
  )
    throw new Error("窗口访问设置格式不正确");
  return { enabled: value.enabled, mode: value.mode };
}

/** Only the Electron host owns this file. No session, window, PID or image is persisted. */
function createComputerPolicyStore(userData) {
  const file = join(userData, "computer-policy.json");
  let policy = { enabled: false, mode: "observe" };
  let warning;
  let pending = Promise.resolve();
  return {
    async load() {
      policy = { enabled: false, mode: "observe" };
      warning = undefined;
      try {
        if ((await fs.stat(file)).size > 1024) throw new Error("policy too large");
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        if (saved.version !== 1) throw new Error("unsupported policy version");
        policy = validatePolicy(saved.policy);
        // A prior read-only grant cannot become a full-control switch on upgrade.
        if (policy.enabled && policy.mode === "observe") {
          policy = { enabled: false, mode: "observe" };
          warning = "旧版仅观察授权已关闭；开启窗口访问后允许观察和操作全部应用窗口";
        }
      } catch (error) {
        if (error.code !== "ENOENT") warning = "窗口访问设置无法恢复，已默认关闭；请在桌面设置中重新开启";
      }
      return this.snapshot();
    },
    snapshot: () => ({ ...policy, ...(warning ? { warning } : {}) }),
    save(value) {
      const next = validatePolicy(value);
      const result = pending
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(userData, { recursive: true, mode: 0o700 });
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await fs.writeFile(temporary, `${JSON.stringify({ version: 1, policy: next })}\n`, {
              mode: 0o600,
              flag: "wx"
            });
            await fs.rename(temporary, file);
          } finally {
            await fs.rm(temporary, { force: true });
          }
          policy = next;
          warning = undefined;
          return this.snapshot();
        });
      pending = result;
      return result;
    }
  };
}
function systemPermissionsReady(status) {
  return (
    status?.available === true &&
    status.screenRecording === true &&
    status.accessibility === true &&
    status.postEventAccess !== false
  );
}
/** Sender trust is checked by main before entering this host-only controller. */
function createComputerPolicyController({ store, getBackend, registerTakeover, openPermissionSettings }) {
  let intent = 0;
  let approvalRequired = false;
  return {
    async initialize(backend) {
      const version = ++intent;
      const live = await backend.computer({ operation: "access" });
      if (version !== intent || backend !== getBackend()) return;
      const enabled = live?.policy?.enabled === true;
      approvalRequired = store.snapshot().enabled && !enabled;
      registerTakeover(enabled);
    },
    async request(input) {
      const current = getBackend();
      if (!current) throw new Error("Computer Use 本地服务不可用");
      if (input?.operation === "policy-status") {
        const live = await current.computer({ operation: "access" });
        if (current !== getBackend()) return { ...store.snapshot(), cancelled: true };
        approvalRequired = store.snapshot().enabled && live?.policy?.enabled !== true;
        return { ...store.snapshot(), ...(approvalRequired ? { approvalRequired: true } : {}) };
      }
      if (input?.operation === "permissions") {
        const permission = input.permission;
        if (!["screenRecording", "accessibility"].includes(permission)) throw new Error("无效系统权限请求");
        const version = intent;
        const granted = (status) =>
          status?.available === true &&
          status[permission] === true &&
          (permission !== "accessibility" || status.postEventAccess !== false);
        let status = await current.computer({ operation: "status" });
        if (version !== intent || current !== getBackend()) return { cancelled: true };
        if (!status?.available) throw new Error(status?.reason || "电脑操作不可用");
        if (granted(status)) return status;
        // Only this explicit button requests its named OS permission. Neither
        // application policy nor restoring it may trigger a system prompt.
        await current.computer({ operation: "permissions", permission });
        if (version !== intent || current !== getBackend()) return { cancelled: true };
        status = await current.computer({ operation: "status" });
        if (version !== intent || current !== getBackend()) return { cancelled: true };
        if (!granted(status)) await openPermissionSettings?.(permission);
        return status;
      }
      if (input?.operation === "policy") {
        const next = validatePolicy({ enabled: input.enabled, mode: input.mode });
        const version = ++intent;
        // Revoke before checks and disk I/O. Failure cannot expand authority.
        await current.computer({ operation: "policy", enabled: false, mode: next.mode });
        if (version !== intent || current !== getBackend()) return { ...store.snapshot(), cancelled: true };
        if (next.enabled) {
          const status = await current.computer({ operation: "status" });
          if (version !== intent || current !== getBackend()) return { ...store.snapshot(), cancelled: true };
          if (!systemPermissionsReady(status))
            throw new Error("请先开启屏幕录制和辅助功能系统权限，再开启窗口访问");
        }
        await store.save(next);
        if (version !== intent || current !== getBackend()) return { ...store.snapshot(), cancelled: true };
        approvalRequired = next.enabled;
        await current.computer({ operation: "policy", ...next });
        if (version !== intent || current !== getBackend()) return { ...store.snapshot(), cancelled: true };
        approvalRequired = false;
        return {
          ...store.snapshot(),
          takeoverShortcut: registerTakeover(next.enabled)
        };
      }
      if (input?.operation === "pause" || input?.operation === "end" || input?.operation === "resume")
        intent++;
      const version = intent;
      if (input?.operation === "resume") {
        const status = await current.computer({ operation: "status" });
        if (version !== intent || current !== getBackend()) return { cancelled: true };
        if (!systemPermissionsReady(status))
          throw new Error("请先开启屏幕录制和辅助功能系统权限，再恢复窗口访问");
        // A takeover may interrupt an enable while it is being persisted.
        const { enabled, mode } = store.snapshot();
        // Disabled policy is an explicit revocation. Resuming a legacy grant
        // must not issue another close before restoring its temporary session.
        if (enabled) await current.computer({ operation: "policy", enabled, mode });
        if (version !== intent || current !== getBackend()) return { cancelled: true };
      }
      const result = await current.computer(input);
      if (version !== intent || current !== getBackend()) return { ...result, cancelled: true };
      if (input?.operation === "authorize" || input?.operation === "resume")
        return { ...result, takeoverShortcut: registerTakeover(true) };
      if (input?.operation === "pause" || input?.operation === "end") registerTakeover(false);
      return result;
    }
  };
}
module.exports = { createComputerPolicyStore, createComputerPolicyController, validatePolicy };
