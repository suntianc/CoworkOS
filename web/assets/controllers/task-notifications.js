import { ui } from "../ui/language.js";

/** Observe the existing catalog subscription; snapshots establish and repair the baseline. */
export function createTaskNotifications({ notify }) {
  let backendId;
  let tasks = new Map();
  function observe(task) {
    if (!task || typeof task.taskId !== "string") return;
    const previous = tasks.get(task.taskId);
    tasks.set(task.taskId, task);
    if (!previous || !["running", "waiting"].includes(previous.status) || task.status !== "completed") return;
    const completionId = task.completedAt || previous.activeRunId;
    if (!completionId || !notify) return;
    try {
      const pending = notify({
        backendId,
        taskId: task.taskId,
        completionId,
        title: ui("任务已完成"),
        body: task.title || task.goal || task.taskId
      });
      // eslint-disable-next-line no-restricted-syntax -- the desktop host may refuse the notification (permission or focus rules); task state updates continue regardless
      pending?.catch?.(() => {});
      // eslint-disable-next-line no-restricted-syntax -- a synchronous host notify failure must not interrupt catalog adoption or the unread state
    } catch {
      // Notification failures must not interrupt application state updates.
    }
  }
  return {
    snapshot(snapshot) {
      if (!snapshot?.backendId || !Array.isArray(snapshot.tasks)) return;
      if (snapshot.backendId !== backendId) {
        backendId = snapshot.backendId;
        tasks = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
        return;
      }
      const present = new Set(snapshot.tasks.map((task) => task.taskId));
      for (const task of snapshot.tasks) observe(task);
      for (const key of tasks.keys()) if (!present.has(key)) tasks.delete(key);
    },
    event(record) {
      if (record?.backendId !== backendId || record.scope !== "task") return;
      if (record.type === "task.deleted") tasks.delete(record.objectId);
      else if (record.type === "task.changed" && record.payload?.taskId === record.objectId)
        observe(record.payload);
    }
  };
}
