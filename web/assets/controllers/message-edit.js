import { ui } from "../ui/language.js";
import { escapeHtml as esc } from "../ui/html.js";
import { icon } from "../ui/icons.js";

/** A turn producing an answer is not editable; its transcript is still in use. */
const turnBusy = (detail) => Boolean(detail?.runtime?.active || detail?.runtime?.stopping);

/**
 * Whether the turn is only parked on a durable question.
 *
 * The person deciding how to answer may prefer to edit what they asked. The
 * Run service stops the parked process and relaunches it on the edited branch,
 * retiring the question, so the transcript is never rewritten under a reply
 * that is still arriving.
 */
const awaitingAnswer = (detail) =>
  Boolean(detail?.runtime?.active) &&
  (detail?.humanRequests ?? []).some((request) => request.status === "pending");

/** Whether the turn still owns the transcript, so an edit has to wait. */
const editBlocked = (detail) =>
  awaitingAnswer(detail) ? Boolean(detail?.runtime?.stopping) : turnBusy(detail);

/** Owns the inline editor and request identity; Composer Session keeps its draft and backup. */
export function createMessageEditController({
  composerSession,
  input,
  getState,
  isBusy,
  api,
  onError,
  onChange,
  onSubmit,
  onAccepted
}) {
  const submitting = new Set();
  const bindings = new WeakMap();
  let root;
  function ownsEdit(node) {
    const binding = bindings.get(node);
    return Boolean(
      binding &&
      node.isConnected &&
      getState().selected === binding.taskId &&
      composerSession.currentKey === binding.taskId &&
      composerSession.editing?.editId === binding.editId
    );
  }
  function sync() {
    const editor = root?.querySelector("[data-inline-message-edit]");
    if (!editor || editor.dataset.inlineMessageEdit !== composerSession.editing?.editId) return;
    const draft = composerSession.editSnapshot();
    if (editor.value !== draft.text) editor.value = draft.text;
    const pending = submitting.has(composerSession.currentKey);
    editor.readOnly = pending;
    root.querySelector("[data-cancel-message-edit]").disabled = pending;
    const state = getState();
    root.querySelector("[data-submit-message-edit]").disabled =
      pending ||
      isBusy() ||
      state.online === false ||
      editBlocked(state.detail) ||
      (!draft.text.trim() && !draft.attachments.length);
    for (const button of root.querySelectorAll("[data-remove-edit-attachment]")) button.disabled = pending;
  }
  function cancel() {
    if (submitting.has(composerSession.currentKey)) return;
    const messageId = composerSession.editing?.messageId;
    composerSession.finishEdit();
    sync();
    onChange();
    const trigger = [...(root?.querySelectorAll("[data-edit-message]") || [])].find(
      (button) => button.dataset.editMessage === messageId
    );
    (trigger || input).focus({ preventScroll: true });
  }
  return {
    sync,
    cancel,
    get editingMessageId() {
      return composerSession.editing?.messageId;
    },
    markup(taskId, messageId) {
      const target = composerSession.editing;
      if (!target || composerSession.currentKey !== taskId || target.messageId !== messageId) return "";
      return ui`<div class="inline-message-editor"><textarea rows="1" data-inline-message-edit="${esc(target.editId)}" aria-label="编辑消息内容"></textarea></div>`;
    },
    actions(taskId, messageId) {
      const target = composerSession.editing;
      if (!target || composerSession.currentKey !== taskId || target.messageId !== messageId) return "";
      const draft = composerSession.editSnapshot();
      return ui`<div class="user-message-actions"><div class="inline-edit-actions">${draft.attachments.length ? ui`<details class="inline-edit-attachments-menu" data-activity-key="edit-attachments:${esc(target.editId)}"><summary class="app-button" role="button" aria-label="编辑附件" title="编辑附件（${draft.attachments.length}）">${icon("paperclip")}</summary><div class="inline-edit-attachments">${draft.attachments.map((file, index) => ui`<span class="inline-edit-attachment"><span title="${esc(file.name)}">${esc(file.name)}</span><button type="button" data-remove-edit-attachment="${index}" aria-label="移除附件 ${esc(file.name)}">${icon("close")}</button></span>`).join("")}</div></details>` : ""}<button type="button" class="app-button" data-cancel-message-edit aria-label="取消编辑" title="取消编辑（Esc）">取消</button><button type="button" class="app-button is-primary" data-submit-message-edit aria-label="发送编辑后的消息" title="发送（⌘/Ctrl + Enter）">发送</button></div></div>`;
    },
    bind(container, taskId) {
      root = container;
      const editor = root.querySelector("[data-inline-message-edit]");
      if (!editor) return;
      const editId = editor.dataset.inlineMessageEdit;
      const newEditor = !bindings.has(editor);
      // Reconciliation can retain a textarea or button for a later edit. Keep
      // the live ownership separate from the listener installed only once.
      bindings.set(editor, { taskId, editId });
      if (newEditor) {
        editor.addEventListener("input", () => {
          if (!ownsEdit(editor)) return;
          composerSession.updateEdit({ text: editor.value });
          sync();
        });
        editor.addEventListener("keydown", (event) => {
          if (!ownsEdit(editor) || event.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!root.querySelector("[data-submit-message-edit]").disabled) void onSubmit();
          }
        });
      }
      for (const button of root.querySelectorAll(
        "[data-cancel-message-edit], [data-submit-message-edit], [data-remove-edit-attachment]"
      )) {
        const newButton = !bindings.has(button);
        bindings.set(button, { taskId, editId });
        if (!newButton) continue;
        button.addEventListener("click", () => {
          if (!ownsEdit(button)) return;
          if (button.hasAttribute("data-cancel-message-edit")) cancel();
          else if (button.hasAttribute("data-submit-message-edit")) void onSubmit();
          else if (button.hasAttribute("data-remove-edit-attachment")) {
            const draft = composerSession.editSnapshot();
            draft.attachments.splice(Number(button.dataset.removeEditAttachment), 1);
            composerSession.updateEdit(draft);
            onChange();
          }
        });
      }
      sync();
    },
    begin(taskId, target) {
      const state = getState();
      if (state.selected !== taskId || !target || isBusy()) return;
      if (editBlocked(state.detail)) return onError(ui("请先停止当前运行并等待停止完成，再编辑消息。"));
      if (composerSession.editing) return onError(ui("请先取消或发送当前编辑。原来的草稿仍然保留。"));
      if (!composerSession.beginEdit(target)) return;
      sync();
      onChange();
      const editor = root?.querySelector("[data-inline-message-edit]");
      editor?.focus({ preventScroll: true });
      editor?.setSelectionRange(editor.value.length, editor.value.length);
    },
    async submit() {
      const state = getState();
      const target = composerSession.editing;
      const taskId = composerSession.currentKey;
      if (!target || submitting.has(taskId) || state.selected !== taskId) return;
      if (editBlocked(state.detail)) return onError(ui("请先停止当前运行，再修改重发。"));
      const draft = composerSession.editSnapshot();
      if (!draft.text.trim() && !draft.attachments.length)
        return onError(ui("请输入消息或保留至少一个附件。"));
      submitting.add(taskId);
      composerSession.save();
      sync();
      try {
        const run = await api(`/api/tasks/${encodeURIComponent(taskId)}/messages/edit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scopeToken: target.scopeToken,
            messageId: target.messageId,
            versionId: target.versionId,
            runId: target.runId,
            editId: target.editId,
            body: draft.text,
            attachmentIds: draft.attachments.filter((file) => file.uploadId).map((file) => file.uploadId),
            textAttachments: draft.attachments.filter((file) => !file.uploadId),
            model: state.model || state.defaultModel || undefined
          })
        });
        const restored = composerSession.finishEdit(taskId, target.editId, draft);
        if (restored === false)
          onError(ui("新回复已开始，发送期间继续修改的编辑内容仍保留。取消编辑可恢复原草稿。"));
        await onAccepted(taskId, run);
      } catch (error) {
        onError(ui`修改重发失败：${error.message}。编辑内容和原草稿已保留。`);
      } finally {
        submitting.delete(taskId);
        sync();
        onChange();
      }
    }
  };
}
