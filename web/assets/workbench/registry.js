/** UI adapters are assembled here; the main page only hosts them. */
export function createWorkbenchRegistry(adapters = []) {
  const registry = Object.create(null);
  for (const adapter of adapters) {
    const appType = adapter.definition?.appType;
    if (!appType) throw new Error("UI adapter definition requires appType");
    if (registry[appType]) throw new Error(`UI adapter already registered: ${appType}`);
    registry[appType] = adapter;
  }
  return Object.freeze(registry);
}
