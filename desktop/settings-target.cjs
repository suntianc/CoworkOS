/** Serialize backend selection with legacy desktop-owned settings operations. */
function createSettingsTargetGuard({ getOwner, getSelected, verifySelected }) {
  let occupied = false;
  let readers = 0;
  const identityFields = ["backendId", "url", "pid", "startedAt"];
  const same = (left, right) =>
    left &&
    right &&
    identityFields.every((field) => left[field] !== undefined && left[field] === right[field]);
  const describe = (value) => (value?.backendId && value?.url ? `${value.backendId} (${value.url})` : "未知");
  const changed = () => new Error("后端实例身份已变化，请重新选择后重试");
  const busy = () => new Error("后端切换或设置操作正在进行，请稍后重试");
  function acquire() {
    if (occupied || readers) throw busy();
    occupied = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        occupied = false;
      }
    };
  }
  function acquireRead() {
    if (occupied) throw busy();
    readers += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        readers -= 1;
      }
    };
  }
  async function run(action, release, canRetain) {
    let retained = false;
    try {
      const owner = getOwner();
      const selected = getSelected();
      if (!same(owner, selected))
        throw new Error(
          `当前后端 ${describe(selected)} 的模型和联网搜索设置不可在此修改；桌面设置属于 ${describe(owner)}。请切回该后端。`
        );
      const assertCurrent = async () => {
        if (!same(owner, getOwner()) || !same(selected, getSelected())) throw changed();
        const verified = await verifySelected(selected);
        if (!same(selected, verified) || !same(owner, getOwner()) || !same(selected, getSelected()))
          throw changed();
      };
      await assertCurrent();
      const retainUntil = (promise) => {
        if (!canRetain || retained || !promise || typeof promise.then !== "function")
          throw new Error("无效的设置操作生命周期");
        retained = true;
        Promise.resolve(promise).then(release, release);
      };
      const result = await action({ assertCurrent, retainUntil });
      if (!retained) await assertCurrent();
      return result;
    } finally {
      if (!retained) release();
    }
  }
  return {
    async select(action) {
      const release = acquire();
      try {
        return await action();
      } finally {
        release();
      }
    },
    async settings(action) {
      return run(action, acquire(), true);
    },
    async read(action) {
      return run(action, acquireRead(), false);
    }
  };
}

module.exports = { createSettingsTargetGuard };
