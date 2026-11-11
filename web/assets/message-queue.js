import { ui } from "./ui/language.js";
import { escapeHtml as esc } from "./workbench/html.js";
import { reconcileMarkup } from "./ui/reconcile.js";
import { splitUploadedFiles } from "./uploaded-files.js";

/** Pending input stays beside the composer until it is delivered or promoted. */
export function renderMessageQueue(
  host,
  { taskId, messages, running, promoting, promote, cancel, disabled = false }
) {
  const pending = [
    ...new Map(
      messages
        .filter((message) => message.id && message.delivery === "followUp" && message.pending)
        .map((message) => [message.id, message])
    ).values()
  ];
  host.hidden = !pending.length;
  reconcileMarkup(
    host,
    pending.length
      ? pending
          .map((message, index) => {
            const text =
              typeof message.content === "string"
                ? message.content
                : (message.content || []).map((part) => part.text || "").join("");
            const preview =
              splitUploadedFiles(text).text.split("\n\nAttached files:")[0].trim() || ui("附件消息");
            const busy = promoting.has(`${taskId}:${message.id}`);
            const short = esc(preview.slice(0, 60));
            // While Main runs a queued message can join its next step; once the
            // round is over it starts the next one.
            const promoteLabel = running ? ui`立即插入：${short}` : ui`立即发送：${short}`;
            const promoteTitle = running ? ui("立即插入到下一步") : ui("立即发送，启动新一轮对话");
            return ui`<div class="queued-message"><svg class="ui-icon queued-message-icon" aria-hidden="true"><use href="#i-history"/></svg><span class="queued-message-state">排队 ${index + 1}<span aria-hidden="true"> · </span>${running ? ui("本轮结束后发送") : ui("等待发送")}</span><span class="queued-message-text" title="${esc(preview.slice(0, 500))}">${esc(preview)}</span><button type="button" class="queued-message-action" data-promote-message="${esc(message.id)}" ${disabled || busy ? "disabled" : ""} aria-label="${promoteLabel}" title="${promoteTitle}" ${busy ? 'aria-busy="true"' : ""}><svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M5 5v7a3 3 0 0 0 3 3h11m-4-4 4 4-4 4" /></svg></button><button type="button" class="queued-message-action" data-cancel-message="${esc(message.id)}" ${disabled || busy ? "disabled" : ""} aria-label="撤回：${short}" title="撤回，不再发送"><svg class="ui-icon" aria-hidden="true"><use href="#i-close"/></svg></button></div>`;
          })
          .join("")
      : ""
  );
  host.querySelectorAll("[data-cancel-message]").forEach((button) => {
    button.onclick = () => cancel(taskId, button.dataset.cancelMessage);
  });
  host.querySelectorAll("[data-promote-message]").forEach((button) => {
    button.onclick = () => promote(taskId, button.dataset.promoteMessage);
  });
}
