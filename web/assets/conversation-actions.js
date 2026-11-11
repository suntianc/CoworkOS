const unreadKey = "atria.conversations.unread.v1";
const validTaskId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) && !value.includes("..");

/** Read markers belong to this browser, independently of the task's execution state. */
export function createConversationReadState(storage) {
  let unread = new Set();
  const pending = new Map();
  const apply = (taskId, value) => (value ? unread.add(taskId) : unread.delete(taskId));
  function reload() {
    try {
      if (storage) {
        const saved = JSON.parse(storage.getItem(unreadKey) || "null");
        unread = new Set(
          saved?.version === 1 && Array.isArray(saved.unread) ? saved.unread.filter(validTaskId) : []
        );
      }
      // eslint-disable-next-line no-restricted-syntax -- 存储被浏览器禁用时 getItem 与 JSON.parse 都会抛出，此时沿用本窗口内存里的未读标记
    } catch {
      // A blocked store keeps the current window's markers usable.
    }
    for (const [taskId, value] of pending) apply(taskId, value);
  }
  reload();
  return {
    isUnread: (taskId) => validTaskId(taskId) && unread.has(taskId),
    setUnread(taskId, value) {
      if (!validTaskId(taskId) || typeof value !== "boolean") return false;
      reload();
      apply(taskId, value);
      pending.set(taskId, value);
      try {
        if (!storage) return false;
        storage.setItem(unreadKey, JSON.stringify({ version: 1, unread: [...unread].sort() }));
        pending.clear();
        return true;
        // eslint-disable-next-line no-restricted-syntax -- 配额耗尽或存储被禁用时 setItem 抛出，返回 false 让调用方保留待写标记
      } catch {
        return false;
      }
    },
    reload
  };
}

export function conversationTaskId(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const taskId = url.searchParams.get("task");
    return validTaskId(taskId) ? taskId : null;
    // eslint-disable-next-line no-restricted-syntax -- 深链可能来自任意粘贴文本，不是合法 URL 时说明它不是本应用的任务链接
  } catch {
    return null;
  }
}
