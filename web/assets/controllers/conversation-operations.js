import { ui } from "../ui/language.js";

/** The context menu and row quick actions; each keeps the conversation it was opened for. */
export function createConversationOperations({
  readState,
  onReadChange,
  titleFor,
  rename,
  update,
  remove,
  stop,
  showToast,
  confirmDelete = (task) => window.confirm(ui`确定删除“${titleFor(task)}”吗？删除后无法恢复。`)
}) {
  return async (action, taskId, task) => {
    if (!task || task.taskId !== taskId) return;
    try {
      if (action === "rename") return rename(task);
      if (action === "stop") return await stop(taskId);
      if (action === "delete") {
        if (!confirmDelete(task)) return;
        await remove(taskId);
        showToast(ui("会话已删除"));
        return;
      }
      if (action === "pin" || action === "archive")
        return await update(
          action === "pin" ? { pinned: !task.pinned } : { archived: !task.archived },
          taskId
        );
      if (action === "unread") {
        const unread = !readState.isUnread(taskId);
        readState.setUnread(taskId, unread);
        onReadChange();
        showToast(unread ? ui("已标记为未读") : ui("已标记为已读"));
        return;
      }
    } catch (error) {
      showToast(error.message || ui("操作未完成，请重试"));
    }
  };
}
