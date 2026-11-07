/** Keep an open settings form bound to the backend that supplied its values. */
export function createSettingsBackend({ identity, api }) {
  let target;
  const assertCurrent = () => {
    if (!target || target !== identity()) throw new Error("后端已切换，请重新打开设置后重试");
  };
  return {
    bind() {
      target = identity();
      assertCurrent();
    },
    async request(path, options) {
      assertCurrent();
      const result = await api(path, options);
      assertCurrent();
      return result;
    }
  };
}
