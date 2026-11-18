/**
 * A per-conversation choice the composer keeps across restarts: the reasoning
 * level and the provider picked for each conversation. It reads like the Map
 * it replaces; every change is written to `storage()` under `key`. Storage
 * can be blocked, in which case the choices last only for this page.
 */
export function rememberedTaskMap(storage, key) {
  let values;
  const load = () => {
    if (values) return values;
    try {
      const saved = JSON.parse(storage()?.getItem(key) || "{}");
      values = new Map(Object.entries(saved && typeof saved === "object" ? saved : {}));
      // eslint-disable-next-line no-restricted-syntax -- blocked storage or a damaged entry only loses the remembered choices
    } catch {
      values = new Map();
    }
    return values;
  };
  const save = () => {
    try {
      storage()?.setItem(key, JSON.stringify(Object.fromEntries(values)));
      // eslint-disable-next-line no-restricted-syntax -- best-effort write: blocked or full storage keeps the choice for this page only
    } catch {
      /* storage may be disabled */
    }
  };
  return {
    get: (taskId) => load().get(taskId),
    has: (taskId) => load().has(taskId),
    /** `null` is "the default": nothing to remember. */
    set(taskId, value) {
      if (value === null || value === undefined) load().delete(taskId);
      else load().set(taskId, value);
      save();
      return this;
    },
    delete(taskId) {
      const removed = load().delete(taskId);
      save();
      return removed;
    },
    clear() {
      values = new Map();
      save();
    }
  };
}
