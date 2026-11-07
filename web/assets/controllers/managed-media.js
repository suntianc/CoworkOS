/** Session-bound media object URLs used for preview and attachments. */
export function createManagedMedia({ read, createObjectURL, revokeObjectURL, limit = 64 }) {
  const cache = new Map();
  let generation = 0;
  function get(path) {
    const existing = cache.get(path);
    if (existing) return existing;
    const at = generation;
    const pending = read(path)
      .then(({ blob }) => {
        if (at !== generation) throw new Error("已切换后端，文件读取已取消");
        if (cache.get(path) !== pending) throw new Error("文件预览已取消");
        const href = createObjectURL(blob);
        cache.set(path, Promise.resolve(href));
        while (cache.size > limit) {
          const [oldPath, oldValue] = cache.entries().next().value;
          cache.delete(oldPath);
          Promise.resolve(oldValue)
            .then(revokeObjectURL)
            .catch(() => undefined);
        }
        return href;
      })
      .catch((error) => {
        if (cache.get(path) === pending) cache.delete(path);
        throw error;
      });
    cache.set(path, pending);
    return pending;
  }
  function clear() {
    generation += 1;
    for (const value of cache.values())
      Promise.resolve(value)
        .then(revokeObjectURL)
        .catch(() => undefined);
    cache.clear();
  }
  return { get, clear };
}
