/** Keep an open settings form bound to the backend that supplied its values. */
export function createSettingsBackend({ identity, api }) {
  let target;
  let generation = 0;
  const assertCurrent = (expected, version) => {
    if (!expected || expected !== identity() || expected !== target || version !== generation)
      throw new Error("后端已切换，请重新打开设置后重试");
  };
  return {
    bind() {
      target = identity();
      generation++;
      assertCurrent(target, generation);
    },
    async request(path, options) {
      const expected = target;
      const version = generation;
      assertCurrent(expected, version);
      const result = await api(path, options);
      assertCurrent(expected, version);
      return result;
    }
  };
}
