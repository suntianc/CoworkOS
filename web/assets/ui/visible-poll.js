/** Automatic reads sleep offscreen; explicit actions call their read directly. */
export function createVisiblePoll({
  run,
  intervalMs,
  immediate = false,
  active = true,
  document: pageDocument = globalThis.document,
  window: pageWindow = globalThis.window
}) {
  let timer,
    running = false,
    catchUp = false,
    disposed = false,
    pageActive = true;
  const visible = () => !disposed && active && pageActive && !pageDocument?.hidden;
  let wasVisible = visible();

  function clear() {
    clearTimeout(timer);
    timer = undefined;
  }
  function schedule() {
    clear();
    if (visible()) timer = setTimeout(tick, typeof intervalMs === "function" ? intervalMs() : intervalMs);
  }
  function tick({ resume = false } = {}) {
    clear();
    if (!visible() || running) return;
    running = true;
    let result;
    try {
      result = run({ resume });
      // eslint-disable-next-line no-restricted-syntax -- run 可能同步抛出，失败后由下一次可见 tick 重试
    } catch {
      /* A later visible tick can retry. */
    }
    void Promise.resolve(result)
      // eslint-disable-next-line no-restricted-syntax -- 读请求的失败由下一次可见 tick 重试，finally 仍要复位 running 并重新排期
      .catch(() => {})
      .finally(() => {
        running = false;
        if (catchUp && visible()) {
          catchUp = false;
          tick({ resume: true });
        } else schedule();
      });
  }
  function sync() {
    const next = visible();
    if (next === wasVisible) return;
    wasVisible = next;
    clear();
    catchUp = false;
    if (!next) return;
    if (running) catchUp = true;
    else tick({ resume: true });
  }
  const hide = () => {
    pageActive = false;
    sync();
  };
  const show = () => {
    pageActive = true;
    sync();
  };
  pageDocument?.addEventListener("visibilitychange", sync);
  pageWindow?.addEventListener("pagehide", hide);
  pageWindow?.addEventListener("pageshow", show);
  if (immediate) tick({ resume: true });
  else schedule();
  return {
    setActive(value) {
      active = Boolean(value);
      sync();
    },
    dispose() {
      disposed = true;
      clear();
      catchUp = false;
      pageDocument?.removeEventListener("visibilitychange", sync);
      pageWindow?.removeEventListener("pagehide", hide);
      pageWindow?.removeEventListener("pageshow", show);
    }
  };
}
