/** A process-owned receipt prevents a rebuilt renderer from repeating a notice. */
function createDesktopNotifications({ getBackendId, supported, show }) {
  const delivered = new Set();
  return {
    notify(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const { backendId, taskId, completionId, title, body } = value;
      if (
        ![backendId, taskId, completionId, title, body].every(
          (field) => typeof field === "string" && field.length > 0 && field.length <= 4096
        ) ||
        backendId !== getBackendId() ||
        !supported()
      )
        return false;
      const key = JSON.stringify([backendId, taskId, completionId]);
      if (delivered.has(key)) return false;
      show({ title, body });
      delivered.add(key);
      return true;
    }
  };
}
module.exports = { createDesktopNotifications };
