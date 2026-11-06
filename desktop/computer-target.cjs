const { createComputerPolicyStore, createComputerPolicyController } = require("./computer-policy.cjs");

/** Serialize target changes against in-flight trusted Computer Use actions. */
function createComputerTargetCoordinator({
  registerTakeover,
  openPermissionSettings,
  createStore = createComputerPolicyStore
}) {
  let current;
  let pending = 0;
  let transition;
  let shortcutEnabled = false;
  const register = (enabled) => {
    shortcutEnabled = enabled;
    return registerTakeover(enabled);
  };
  const makeTarget = (home, backend) => {
    const store = createStore(home);
    const target = { home, backend, store, ready: false, error: undefined };
    target.controller = createComputerPolicyController({
      store,
      getBackend: () => (current === target ? backend : undefined),
      registerTakeover: register,
      openPermissionSettings
    });
    return target;
  };
  const initialize = async (target) => {
    if (!target.initializing)
      target.initializing = (async () => {
        try {
          await target.store.load();
          await target.controller.initialize(target.backend);
          target.ready = true;
          target.error = undefined;
          return { ok: true };
        } catch (error) {
          target.ready = false;
          target.error = error instanceof Error ? error.message : String(error);
          return { ok: false, error: target.error };
        } finally {
          target.initializing = undefined;
        }
      })();
    return target.initializing;
  };
  return {
    async beginSwitch() {
      if (transition || pending) throw new Error("窗口访问操作正在进行，请稍后切换后端");
      const change = { old: current, shortcutEnabled, paused: false };
      transition = change;
      try {
        if (change.old?.ready) await change.old.controller.request({ operation: "release-sessions" });
        register(false);
      } catch (error) {
        transition = undefined;
        throw error;
      }
    },
    async activate(home, backend) {
      if (!transition) throw new Error("窗口访问后端切换未开始");
      const target = makeTarget(home, backend);
      // Selection has committed. Keep B as the observable target even if its
      // policy cannot be restored, so the UI never falls back to A's controls.
      current = target;
      return initialize(target);
    },
    invalidateStopped(backendId, pid) {
      if (!transition) throw new Error("窗口访问后端切换未开始");
      if (current?.backend.backendId === backendId && current.backend.pid === pid) {
        current = undefined;
        register(false);
      }
    },
    endSwitch() {
      if (!transition) return;
      const change = transition;
      transition = undefined;
      if (current === change.old && change.shortcutEnabled && !change.paused) register(true);
    },
    async request(input) {
      if (transition) throw new Error("后端正在切换，请稍后重试窗口访问");
      const target = current;
      if (!target) throw new Error("窗口访问后端不可用");
      pending++;
      try {
        if (!target.ready) {
          const state = await initialize(target);
          if (!state.ok) throw new Error(state.error);
        }
        return await target.controller.request(input);
      } finally {
        pending--;
      }
    },
    async releaseForNavigation() {
      if (transition || !current?.ready) return;
      return this.request({ operation: "release-sessions" });
    },
    async pauseForTakeover() {
      if (transition) {
        transition.paused = true;
        register(false);
        return transition.old?.backend.pauseRetired();
      }
      return this.request({ operation: "pause" });
    },
    status() {
      return current
        ? {
            home: current.home,
            backendId: current.backend.backendId,
            ready: current.ready,
            error: current.error
          }
        : { ready: false };
    }
  };
}
module.exports = { createComputerTargetCoordinator };
