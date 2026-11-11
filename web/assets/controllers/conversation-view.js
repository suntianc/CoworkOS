import { language, ui } from "../ui/language.js";
import { confirmCopied, copyText } from "../ui/code-blocks.js";
import { createConversationProjection } from "./conversation-projection.js";
import { splitUploadedFiles } from "../uploaded-files.js";
import { modelErrorDiagnostic, modelPolicyRejection, requestErrorMessage } from "../request-error.js";
import { outstandingWork } from "../tool-lifecycle.js";
import { presentToolCall } from "../tool-presentation.js";
import {
  buildLiveActivity,
  reasoningPreview,
  assistantDisplayContent,
  normalizeReasoningDisplay
} from "../activity.js";
import { finalAnswerIndex, isMachineTurn, exchangeExecutionState } from "../conversation.js";
import { answeredRequestFor } from "../human-questions.js";
import { renderMarkdown } from "../markdown.js";
import { resolveArtifactLink } from "../artifacts.js";
import { escapeHtml as esc } from "../workbench/html.js";
import { icon } from "../ui/icons.js";
import { executionElapsedMs, formatExecutionDuration } from "../execution-time.js";
import { reconcileParts } from "../ui/reconcile.js";

const replyClock = new Intl.DateTimeFormat(language, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
const replyDay = new Intl.DateTimeFormat(language, { month: "short", day: "numeric" });
const replyFull = new Intl.DateTimeFormat(language, {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

/** 18:50 today; the day too once it is not today. */
function replyTime(timestamp, now = new Date()) {
  const when = new Date(timestamp);
  const today = when.toDateString() === now.toDateString();
  return {
    short: today ? replyClock.format(when) : `${replyDay.format(when)} ${replyClock.format(when)}`,
    full: replyFull.format(when),
    iso: when.toISOString()
  };
}

const toolKinds = new Map([
  ...["read", "read_file"].map((name) => [name, "read"]),
  ...["write", "write_file", "edit", "apply_patch"].map((name) => [name, "edit"]),
  ...["bash", "run_command", "exec_command", "run_tests"].map((name) => [name, "command"])
]);

function latestModelRetry(events) {
  const retry = events
    .map((record) => (record?.type === "runtime_event" ? record.payload : record))
    .findLast((event) => ["auto_retry_start", "auto_retry_end"].includes(event?.type));
  return retry && Number.isInteger(retry.attempt) && retry.attempt > 0 ? retry : undefined;
}

function renderUserText(text, markdown) {
  const uploaded = splitUploadedFiles(text);
  if (uploaded.files.length)
    return `${markdown(uploaded.text)}<div class="message-attachments">${uploaded.files.map((file) => `<button type="button" data-upload-preview="${esc(file.uploadId)}">${file.kind === "image" ? `<img data-upload-src="${esc(file.uploadId)}" alt="" />` : icon("paperclip")}<span>${esc(file.name)}</span></button>`).join("")}</div>`;

  const marker = "\n\nAttached files:\n";
  const boundary = text.indexOf(marker);
  if (boundary < 0) return markdown(text);
  const attachments = text.slice(boundary + marker.length);
  return ui`${markdown(text.slice(0, boundary))}<details class="message-attachments"><summary>查看附件内容</summary>${markdown(attachments)}</details>`;
}

function stoppedRequestFailure(task, detail, exchange, submitting) {
  // A paused step aborts its model operation by design; that terminal error is
  // the pause boundary, not a failure the person can retry from a card.
  if (task.status === "paused") return;
  if (detail?.runtime?.active || submitting || ["completed", "cancelled"].includes(task.status)) return;
  const persisted = exchange?.messages.findLast((message) => message.role === "assistant");
  const streamed = exchange?.events
    .map((record) => (record?.type === "runtime_event" ? record.payload : record))
    .findLast(
      (event) =>
        ["message_start", "message_end", "turn_end"].includes(event?.type) &&
        event.message?.role === "assistant"
    )?.message;
  const latest =
    persisted &&
    streamed &&
    Number.isFinite(persisted.timestamp) &&
    Number.isFinite(streamed.timestamp) &&
    persisted.timestamp > streamed.timestamp
      ? persisted
      : streamed || persisted;
  if (task.status !== "failed" && latest?.stopReason !== "error") return;
  const terminal =
    task.activeRunId && Array.isArray(detail?.events)
      ? detail.events.findLast(
          (event) => event?.runId === task.activeRunId && event.type === "main.run_failed"
        )
      : undefined;
  const failureKind = terminal?.payload?.failure?.kind;
  if (failureKind === "main_process")
    return {
      title: ui("执行进程退出"),
      message: ui("本次执行进程未能正常结束。"),
      showModelSettings: false
    };
  const raw = String((task.status === "failed" && task.lastError) || latest?.errorMessage || "");
  const errorType = modelErrorDiagnostic(raw, terminal?.payload?.failure?.httpStatus);
  const policy = modelPolicyRejection(raw);
  if (policy)
    return {
      title: ui("模型服务安全策略拒绝"),
      errorType,
      message: policy,
      showModelSettings: false,
      suggestRetry: false
    };
  const httpStatus = terminal?.payload?.failure?.httpStatus;
  const modelStatus =
    failureKind === "model_request" && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
      ? httpStatus
      : undefined;
  // A status in the typed terminal event is evidence. Digits inside a raw
  // provider identifier or URL are not an HTTP status by themselves.
  const diagnostic =
    failureKind === "model_request" && !modelStatus
      ? raw.replace(/\b[45]\d{2}\b/g, "")
      : modelStatus
        ? String(modelStatus)
        : raw;
  const classified =
    modelStatus === 400
      ? ui("模型服务拒绝了本次请求（HTTP 400），请检查模型及请求参数后重试。")
      : modelStatus === 403
        ? ui("模型服务拒绝访问（HTTP 403），请检查当前连接的访问权限。")
        : modelStatus === 404
          ? terminal?.payload?.failure?.providerCode === "model_not_found"
            ? ui(
                "当前 API 账号或分组无法使用此模型（HTTP 404），请确认服务商的模型权限及可用状态，或选择可用的模型后重试。"
              )
            : ui("模型接口或模型未找到（HTTP 404），请检查 API 地址、模型 ID 及服务商的模型可用状态。")
          : modelStatus && ![401, 429, 500, 502, 503, 504].includes(modelStatus)
            ? ui`模型服务返回错误（HTTP ${modelStatus}），本次请求未能完成。`
            : requestErrorMessage(diagnostic);
  const interrupted =
    /连接已中断/.test(classified) ||
    (classified === diagnostic &&
      /upstream|HTTP\/2|stream.*fail|Failed to fetch|NetworkError|fetch failed|ECONN|ETIMEDOUT|socket|connection.*(?:reset|closed|failed)/i.test(
        raw
      ));
  const retry = latestModelRetry(exchange?.events || []);
  const exhausted = retry?.type === "auto_retry_end" && retry.success === false;
  return {
    retryCount: retry?.attempt ?? 0,
    title: interrupted
      ? ui("模型连接中断")
      : failureKind === "model_request"
        ? ui("模型请求未完成")
        : ui("任务失败"),
    errorType: errorType || (interrupted ? ui("连接中断") : ui("原因未确定")),
    // Unknown provider errors can contain URLs, headers or keys. Only known
    // classifications reach the UI; durable logs retain the original error.
    message:
      (exhausted ? ui`已自动重试 ${retry.attempt} 次，本次请求仍未完成。` : "") +
      (classified !== diagnostic
        ? classified
        : interrupted
          ? ui("本次请求未能完成。")
          : failureKind === "model_request"
            ? ui("本次模型请求未能完成，原因尚未确定。")
            : ui("本次运行未能完成，请检查模型连接后重试。")),
    showModelSettings: true
  };
}

/** Renders conversation history; networking and application windows are supplied by the page. */
export function createConversationView({
  state,
  $,
  textContent,
  retry,
  edit,
  messageEdit,
  openSettings,
  openArtifact,
  fork,
  resolveFile,
  showToast = () => {}
}) {
  const markdown = (source, options = {}) =>
    renderMarkdown(source, {
      resolveLocalLink: (path) => resolveArtifactLink(state.detail, path),
      resolveFile,
      ...options
    });
  const visibleText = (content) =>
    Array.isArray(content)
      ? content
          .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text || "" : ""))
          .join("")
      : String(textContent(content) || "");
  /**
   * The bar under a settled reply: copy its Markdown, fork the conversation
   * from it, and when it was written. The latest reply keeps it in full view;
   * earlier ones show it faintly until the reply is hovered.
   */
  const replyActions = (message, latest) => {
    const time = Number.isFinite(message.timestamp) ? replyTime(message.timestamp) : undefined;
    return `<div class="reply-actions${latest ? " is-latest" : ""}" role="toolbar" aria-label="${ui("回复操作")}"><button type="button" class="reply-action" data-reply-copy title="${ui("复制回复")}" aria-label="${ui("复制回复")}">${icon("copy")}</button>${
      message.id && fork
        ? `<button type="button" class="reply-action" data-reply-fork="${esc(message.id)}" title="${ui("从这条回复 Fork 出新会话")}">${icon("git-branch")}<span>Fork</span></button>`
        : ""
    }${
      time
        ? `<span class="reply-time" tabindex="0"><time datetime="${esc(time.iso)}">${esc(time.short)}</time><span class="reply-time-full" role="tooltip">${esc(time.full)}</span></span>`
        : ""
    }</div>`;
  };
  const activityStates = new Map();
  const errorDetailsOpen = new Set();
  const boundNodes = new WeakSet();
  // What the conversation's children were built from: one markup string per
  // exchange, how many top-level nodes each became, and the trailing parts.
  let lastRender;
  let historyMarkup = new Map();
  let renderedEditTask;
  const thinkingStartedAt = new Map();
  const resumeThinkingAnimations = (scroll) => {
    const activeKeys = new Set();
    const now = performance.now();
    for (const node of scroll.querySelectorAll("[data-thinking-key]")) {
      const key = node.dataset.thinkingKey;
      activeKeys.add(key);
      const startedAt = thinkingStartedAt.get(key) ?? now;
      thinkingStartedAt.set(key, startedAt);
      // innerHTML replaces the spinner on new deltas. Reuse its elapsed time
      // without adding style attributes that would invalidate markup equality.
      for (const animation of node.getAnimations?.() || []) animation.currentTime = now - startedAt;
    }
    for (const key of thinkingStartedAt.keys()) if (!activeKeys.has(key)) thinkingStartedAt.delete(key);
  };
  const readable = (node) => {
    if (!node.open) return false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === "DETAILS" && !parent.open) return false;
    return true;
  };
  const readingCopies = (node) =>
    [...node.querySelectorAll(".reasoning-copy, .tool-copy, .activity-raw-copy")].filter(
      (copy) => copy.closest("details[data-activity-key]") === node
    );
  const restoreReadingPosition = (node) => {
    const saved = activityStates.get(node.dataset.activityKey);
    if (!saved || !readable(node)) return;
    for (const [index, copy] of readingCopies(node).entries()) {
      const position = saved.positions?.[copy.dataset.readingKey || index];
      if (!position) continue;
      copy.scrollTop = position.scrollTop;
      copy.scrollLeft = position.scrollLeft;
    }
  };
  const rememberActivity = (node) => {
    const saved = activityStates.get(node.dataset.activityKey);
    activityStates.set(node.dataset.activityKey, {
      open: Boolean(node.open),
      positions: readable(node)
        ? Object.fromEntries(
            readingCopies(node).map((copy, index) => [
              copy.dataset.readingKey || index,
              {
                scrollTop: copy.scrollTop || 0,
                scrollLeft: copy.scrollLeft || 0
              }
            ])
          )
        : saved?.positions || {}
    });
  };
  const normalizeMessages = (messages) => {
    // Presentation repair applies only to assistant output. Original messages
    // remain durable and user-authored Markdown/code is never normalized.
    return (messages || []).map((message) =>
      message.role === "assistant"
        ? { ...message, content: assistantDisplayContent(message.content, { includeRaw: true }) }
        : message
    );
  };
  const projectExchanges = createConversationProjection(normalizeMessages);
  $("#conversation")?.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-reply-copy], [data-reply-fork]");
    const article = button?.closest(".chat-message.main");
    if (!article) return;
    const messageId = article.dataset.messageId;
    if (button.hasAttribute("data-reply-fork")) {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await fork?.(state.selected, button.dataset.replyFork);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
      return;
    }
    const message = messageId && state.detail?.messages?.find((entry) => entry.id === messageId);
    const source = message
      ? visibleText(message.content).trim()
      : article.querySelector(".markdown-body")?.innerText || "";
    if (await copyText(source)) confirmCopied(button);
    else showToast(ui("当前环境不支持复制"));
  });

  function renderFailure(task, failure) {
    const open = errorDetailsOpen.has(task.taskId);
    return ui`<div class="request-error" role="alert" data-recovery-task="${esc(task.taskId)}">
      <div class="run-error-head">${icon("circle-alert")}<strong>${esc(failure.title)}</strong>${failure.retryCount ? ui`<span class="run-error-retry">${ui("已自动重试 ")}${failure.retryCount}${ui("次")}</span>` : ""}</div>
      <div class="request-error-actions">
        <button data-retry-request type="button">${icon("rotate-ccw")}<span>从中断步骤继续</span></button>
        ${failure.showModelSettings ? ui`<button data-error-settings type="button">${icon("cpu")}<span>切换模型</span></button>` : ""}
        <button data-error-details type="button" aria-expanded="${open}">${icon("chevron-down")}<span>查看错误详情</span></button>
      </div>
      <div class="run-error-detail" data-error-detail ${open ? "" : "hidden"}>
        ${failure.errorType ? ui`<p data-error-type>错误类型：${esc(failure.errorType)}</p>` : ""}
        <p>${esc(failure.message)} ${allPreservedMessage(task)}${failure.suggestRetry === false ? "" : ui("可以手动重试继续。")}</p>
      </div>
    </div>`;
  }
  function allPreservedMessage(task) {
    return task.taskId && state.detail?.messages?.length ? ui("你发送的内容和已有过程已保留。") : "";
  }
  function renderConversation(messages, task) {
    const scroll = $("#conversation");
    // Capture live blocks as well as saved history, including before an empty
    // conversation replaces this task. Keys include the task and request.
    for (const history of scroll.querySelectorAll(".execution-history"))
      state.executionHistoryOpen.set(history.dataset.historyKey, history.open);
    for (const node of scroll.querySelectorAll("details[data-activity-key]")) rememberActivity(node);
    const focused = scroll.ownerDocument.activeElement;
    const focusedDetail = focused?.tagName === "SUMMARY" ? focused.parentElement : undefined;
    const focusedActivityKey = focusedDetail?.dataset.activityKey;
    const focusedHistoryKey = focusedDetail?.dataset.historyKey;
    const focusedRecovery =
      focused?.closest?.("[data-recovery-task]")?.dataset.recoveryTask === task.taskId
        ? focused?.hasAttribute?.("data-retry-request")
          ? "[data-retry-request]"
          : focused?.hasAttribute?.("data-error-settings")
            ? "[data-error-settings]"
            : undefined
        : undefined;
    const all = [
      ...(messages || []).filter(
        (message) =>
          !isMachineTurn(message) &&
          (message.role === "user" ||
            (message.role === "assistant" &&
              (message.stopReason !== "toolUse" || visibleText(message.content).trim())))
      ),
      ...state.localMessages
    ];
    const exchanges = projectExchanges(
      messages || [],
      state.localMessages,
      state.detail?.runtimeEvents || []
    );
    const currentExchangeIndex = exchanges.findLastIndex((exchange) => !exchange.awaitingDelivery);
    const failure = stoppedRequestFailure(
      task,
      state.detail,
      exchanges[currentExchangeIndex],
      state.submittingTaskId === task.taskId
    );
    const paused = task.status === "paused" ? task.pause || {} : undefined;
    if (!all.length && !failure && !paused && !messageEdit?.editingMessageId) {
      $("#conversation").innerHTML =
        task.monitoring?.scope === "background"
          ? ui(
              '<div class="welcome-empty monitoring-empty"><div class="welcome-symbol"><svg class="welcome-mark" aria-hidden="true"><use href="#i-formicand-mark" /></svg></div><h2>后台监控会话</h2></div>'
            )
          : ui(
              `<div class="welcome-empty"><div class="welcome-symbol"><svg class="welcome-mark" aria-hidden="true"><use href="#i-formicand-mark" /></svg></div><h2>有什么可以帮忙的？</h2></div>`
            );
      thinkingStartedAt.clear();
      lastRender = undefined;
      historyMarkup.clear();
      renderedEditTask = undefined;
      return;
    }
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    const editing = Boolean(messageEdit?.editingMessageId && state.selected === task.taskId);
    const preserveScroll =
      state.selected === task.taskId &&
      (editing || (renderedEditTask === task.taskId && !state.detail?.runtime?.active));
    const previousScrollTop = scroll.scrollTop || 0;
    let inlineEditorRendered = false;
    const nextHistoryMarkup = new Map();
    // Only settled historical exchanges can be reused. Current/retry/edit state
    // remains live, and replaced history is checked by value, not array identity.
    const historyContext = JSON.stringify([
      task.taskId,
      state.detail?.conversationVersion,
      state.detail?.storageRoot,
      state.detail?.workspaceRoot,
      state.detail?.artifacts,
      state.detail?.humanRequests,
      state.detail?.editableMessage,
      state.detail?.coordination,
      state.detail?.progress,
      state.detail?.jobs,
      state.detail?.runtimeEvents?.filter(
        (record) =>
          (record.type === "runtime_event" ? record.payload : record)?.message?.customType ===
          "cowork-callback"
      )
    ]);
    const parts = exchanges.map((exchange, exchangeIndex) => {
      const isCurrent = exchangeIndex === currentExchangeIndex;
      const cacheable = !isCurrent && !editing && !exchange.awaitingDelivery && !exchange.continued;
      const cacheKey = `${task.taskId}:${exchange.key}`;
      const historyOpen = state.executionHistoryOpen.get(cacheKey) ?? false;
      const elapsed = cacheable ? executionElapsedMs(exchange.events, state.detail?.events) : undefined;
      const cached = historyMarkup.get(cacheKey);
      // The append-only projector retains historical exchange identities.
      // Avoid serializing their unchanged events on every streamed delta.
      if (
        cacheable &&
        cached?.context === historyContext &&
        cached.exchange === exchange &&
        cached.open === historyOpen &&
        cached.elapsed === elapsed
      ) {
        nextHistoryMarkup.set(cacheKey, cached);
        return cached.markup;
      }
      const signature = cacheable ? JSON.stringify([exchange, elapsed, historyOpen]) : undefined;
      if (cacheable && cached?.context === historyContext && cached.signature === signature) {
        nextHistoryMarkup.set(cacheKey, { ...cached, exchange });
        return cached.markup;
      }
      const active =
        Boolean(state.detail?.runtime?.active || state.submittingTaskId === task.taskId) && isCurrent;
      const execution = exchangeExecutionState(exchange.events);
      const interrupted = ["cancelled", "failed", "paused", "waiting"].includes(execution.terminal);
      const parked =
        isCurrent &&
        execution.terminal === "waiting" &&
        task.status === "waiting" &&
        Boolean(state.detail?.monitoring?.sleep);
      const finalIndex =
        interrupted || exchange.continued ? -1 : finalAnswerIndex(exchange.messages, state.detail, isCurrent);
      const finalText = finalIndex >= 0 ? visibleText(exchange.messages[finalIndex].content).trim() : "";
      const historyKey = `${task.taskId}:${exchange.key}`;
      const workflow = renderLiveActivity(
        exchange.events,
        active,
        finalIndex >= 0,
        finalText,
        historyOpen,
        historyKey,
        finalIndex < 0,
        (interrupted && !parked && !paused) || (isCurrent && Boolean(failure)),
        isCurrent,
        exchange.continued
      );
      const workflowIndex = !active && finalIndex >= 0 ? finalIndex : -1;
      const rendered =
        exchange.messages
          .map((message, index) => {
            const user = message.role === "user";
            const text = visibleText(message.content);
            if (!text.trim()) return "";
            if (user) {
              if (message.delivery === "followUp" && message.pending) return "";
              // An answer the person gave to Formicand's own question is not a new
              // request. It has to travel to the model as a user turn for the run to
              // continue, but showing it as one made the transcript read as if they
              // had asked for something twice. It is rendered where it belongs:
              // attached to the question it answers.
              const answered = answeredRequestFor(message, state.detail?.humanRequests);
              if (answered) {
                const key = `${task.taskId}:human-answer:${answered.requestId}`;
                return ui`<article class="chat-message human-answer" data-view-key="${esc(key)}"><div class="message-copy"><details class="human-answer-details" data-activity-key="${esc(key)}"><summary title="已回答，点击查看问题和回复">${icon("help")}<span>回答问题</span>${icon("check", "human-answer-check")}<span class="sr-only">已回答</span></summary><div class="human-answer-content"><div class="human-answer-question">${esc(answered.question)}</div><div class="human-answer-value markdown-body">${markdown(answered.answer)}</div></div></details></div></article>`;
              }
              const editor = messageEdit?.markup(task.taskId, message.id) || "";
              if (editor) inlineEditorRendered = true;
              const editable = message.id && message.id === state.detail?.editableMessage?.messageId;
              const status =
                message.delivery === "followUp" ? ui("排队消息") : message.interjected ? ui("补充指令") : "";
              return `<article class="chat-message user${editor ? " is-editing" : ""}" data-view-key="${esc(`${historyKey}:user:${message.id || index}`)}"><div class="message-copy"><div class="user-message-bubble">${status ? `<div class="message-meta">${status}</div>` : ""}<div class="markdown-body">${renderUserText(text, markdown)}</div>${editor}${editor ? messageEdit.actions?.(task.taskId, message.id) || "" : ""}</div>${!editor && editable ? ui`<div class="user-message-actions"><button type="button" class="app-button" data-edit-message="${esc(message.id)}" aria-label="编辑消息" title="编辑消息">${icon("pencil")}</button></div>` : ""}</div></article>`;
            }
            if (index !== finalIndex) return "";
            return `${index === workflowIndex ? workflow : ""}<article class="chat-message main" data-answer-kind="final"${message.id ? ` data-message-id="${esc(message.id)}"` : ""}><div class="message-copy"><div class="markdown-body">${markdown(text)}</div>${active ? "" : replyActions(message, isCurrent)}</div></article>`;
          })
          .join("") +
        (workflowIndex < 0
          ? active || exchange.continued
            ? `<article class="chat-message main" data-view-key="${esc(`${historyKey}:response`)}" data-answer-kind="${active ? "pending" : "continuation"}"${active ? ' aria-busy="true"' : ""}><div class="message-copy">${workflow || (active ? renderThinkingPlaceholder(historyKey) : "")}</div></article>`
            : workflow
          : "");
      if (cacheable)
        nextHistoryMarkup.set(cacheKey, {
          context: historyContext,
          signature,
          markup: rendered,
          exchange,
          open: historyOpen,
          elapsed
        });
      return rendered;
    });
    historyMarkup = nextHistoryMarkup;
    // A restored edit can outlive its message after another window branches
    // the conversation. Keep its draft reachable for cancellation or recovery.
    const restoredEditor = inlineEditorRendered
      ? ""
      : messageEdit?.markup(task.taskId, messageEdit.editingMessageId) || "";
    parts.push(
      (restoredEditor
        ? `<article class="chat-message user is-editing" data-view-key="${esc(`${task.taskId}:restored-edit`)}"><div class="message-copy"><div class="user-message-bubble">${restoredEditor}${messageEdit.actions?.(task.taskId, messageEdit.editingMessageId) || ""}</div></div></article>`
        : "") + (failure ? renderFailure(task, failure) : "")
    );
    // A streamed delta changes the last exchange only. Patch from the first
    // part that differs; everything before it stays as it is in the page.
    // Anything else that touched the list (another task, an empty state)
    // shows as a node count that no longer adds up, and gets a full patch.
    const previous =
      lastRender?.taskId === task.taskId &&
      scroll.childNodes.length === lastRender.counts.reduce((sum, count) => sum + count, 0)
        ? lastRender
        : undefined;
    let first = 0;
    if (previous)
      while (first < parts.length && first < previous.parts.length && parts[first] === previous.parts[first])
        first += 1;
    if (!previous || first < parts.length || parts.length !== previous.parts.length) {
      const kept = previous ? previous.counts.slice(0, first) : [];
      const offset = kept.reduce((sum, count) => sum + count, 0);
      const counts = reconcileParts(scroll, parts.slice(kept.length), scroll.childNodes[offset] ?? null);
      lastRender = { taskId: task.taskId, parts, counts: [...kept, ...counts] };
      const ownsRecovery = () => state.selected === task.taskId && state.detail?.task?.taskId === task.taskId;
      for (const [selector, action] of [
        ["[data-edit-message]", () => edit?.(task.taskId, state.detail?.editableMessage)],
        ["[data-retry-request]", () => retry?.(task.taskId)],
        ["[data-error-settings]", () => openSettings?.()]
      ]) {
        const node = scroll.querySelector(selector);
        if (!node || boundNodes.has(node)) continue;
        boundNodes.add(node);
        node.addEventListener("click", () => {
          if (ownsRecovery()) action();
        });
      }
      const detailsButton = scroll.querySelector("[data-error-details]");
      if (detailsButton && !boundNodes.has(detailsButton)) {
        boundNodes.add(detailsButton);
        detailsButton.addEventListener("click", () => {
          const panel = scroll.querySelector("[data-error-detail]");
          if (!panel) return;
          const expanded = detailsButton.getAttribute("aria-expanded") !== "true";
          detailsButton.setAttribute("aria-expanded", String(expanded));
          panel.hidden = !expanded;
          if (expanded) errorDetailsOpen.add(task.taskId);
          else errorDetailsOpen.delete(task.taskId);
        });
      }
      scroll.querySelectorAll("[data-message-artifact]").forEach((link) => {
        if (boundNodes.has(link)) return;
        boundNodes.add(link);
        link.addEventListener("click", (event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          const path = link.dataset.messageArtifact;
          const taskId = link.dataset.messageTask;
          if (
            state.selected === taskId &&
            state.detail?.task?.taskId === taskId &&
            state.detail.artifacts?.some(
              (artifact) => artifact.taskId === taskId && artifact.relativePath === path
            )
          )
            openArtifact?.(path);
        });
      });
      scroll.querySelectorAll("details[data-activity-key]").forEach((node) => {
        const saved = activityStates.get(node.dataset.activityKey);
        if (saved) {
          node.open = saved.open;
          restoreReadingPosition(node);
        }
        const remember = () => {
          if (node.isConnected) rememberActivity(node);
        };
        if (!boundNodes.has(node)) {
          boundNodes.add(node);
          node.addEventListener("toggle", () => {
            if (node.isConnected) restoreReadingPosition(node);
            remember();
          });
        }
        readingCopies(node).forEach((copy) => {
          if (boundNodes.has(copy)) return;
          boundNodes.add(copy);
          copy.addEventListener("scroll", remember, { passive: true });
        });
        if (node.dataset.activityKey === focusedActivityKey) {
          const history = node.closest(".execution-history");
          (history && !history.open ? history : node)
            .querySelector("summary")
            ?.focus?.({ preventScroll: true });
        }
      });
      scroll.querySelectorAll(".execution-history").forEach((history) => {
        if (!boundNodes.has(history)) {
          boundNodes.add(history);
          history.addEventListener("toggle", () => {
            if (history.isConnected) {
              state.executionHistoryOpen.set(history.dataset.historyKey, history.open);
              if (history.open)
                history.querySelectorAll("details[data-activity-key]").forEach(restoreReadingPosition);
            }
          });
        }
        if (history.dataset.historyKey === focusedHistoryKey)
          history.querySelector("summary")?.focus?.({ preventScroll: true });
      });
      if (focusedRecovery) scroll.querySelector(focusedRecovery)?.focus?.({ preventScroll: true });
      if (!preserveScroll && (nearBottom || state.localMessages.length))
        scroll.scrollTop = scroll.scrollHeight;
    }
    messageEdit?.bind(scroll, task.taskId);
    if (preserveScroll) scroll.scrollTop = previousScrollTop;
    renderedEditTask = editing ? task.taskId : undefined;
    resumeThinkingAnimations(scroll);
  }

  function renderLiveActivity(
    events,
    active,
    hasFinalAnswer = false,
    finalText = "",
    historyOpen = false,
    historyKey = "",
    pending = false,
    failed = false,
    isCurrent = true,
    continued = false
  ) {
    const turns = buildLiveActivity(events);
    const retry = active && exchangeExecutionState(events).retry;
    const retryCode = retry && /\b(429|5\d\d)\b/.exec(retry.errorMessage || "")?.[1];
    const retryBanner = retry
      ? ui`<div class="request-retry" role="status" aria-live="polite"><strong>模型连接异常${retryCode ? `（HTTP ${retryCode}）` : ""}，正在重试</strong><p>第 ${esc(retry.attempt)} / ${esc(retry.maxAttempts)} 次自动重试，已有内容已保留。可以等待恢复或停止本轮。</p></div>`
      : "";
    if (!turns.length)
      return (
        retryBanner +
        (active
          ? renderThinkingPlaceholder(historyKey, retry ? ui("正在恢复模型连接…") : undefined, !retry)
          : "")
      );
    const calls = turns.flatMap((turn) => turn.calls);
    const presentations = new Map(
      calls.map((call) => [
        call,
        presentToolCall(call, {
          active,
          workspaceRoot: state.detail?.storageRoot || state.detail?.workspaceRoot,
          taskId: state.selected,
          detail: state.detail
        })
      ])
    );
    const pendingWork = isCurrent
      ? outstandingWork(state.detail)
      : { agents: 0, callbacks: 0, jobs: 0, human: 0 };
    const working = active || Object.values(pendingWork).some((count) => count > 0);
    const outstandingLabels = [
      pendingWork.agents ? ui`${pendingWork.agents} 项协作未结束` : "",
      pendingWork.callbacks ? ui`${pendingWork.callbacks} 个结果待接收` : "",
      pendingWork.jobs ? ui`${pendingWork.jobs} 个后台任务运行中` : "",
      pendingWork.human ? ui("等待你的答复") : ""
    ].filter(Boolean);
    const callCount = calls.length;
    const returnedCalls = calls.filter((call) => call.completed).length;
    const failedCalls = calls.filter((call) => presentations.get(call)?.status === "failed").length;
    const stepLabel = ui`${turns.reduce((total, turn) => total + turn.items.filter((item) => item.type !== "answer").length, 0)} 个步骤`;
    const streamedAnswer = turns.at(-1)?.answer?.trim() || "";
    // Do not collapse the streamed answer until the persisted transcript has
    // caught up. A completion event can arrive just before messages.json is
    // atomically replaced, and hiding it at that point makes the final answer
    // appear to vanish.
    const persistedAnswerMatches = Boolean(
      hasFinalAnswer && streamedAnswer && finalText && streamedAnswer === finalText
    );
    const items = turns.flatMap((turn, turnIndex) =>
      (turn.items?.length
        ? turn.items
        : [
            ...(turn.reasoning
              ? [{ type: "reasoning", text: turn.reasoning, done: turn.done, key: `${turnIndex}:reasoning` }]
              : []),
            ...turn.calls.map((call, callIndex) => ({
              type: "tool",
              call,
              key: `${turnIndex}:call:${callIndex}`
            }))
          ]
      ).map((item, itemIndex) => ({
        ...item,
        done: item.done ?? turn.done,
        key: `${historyKey}:${item.key || `${turnIndex}:${item.type}:${itemIndex}`}`
      }))
    );
    const finalMessageKey = turns.at(-1)?.answerMessageKey;
    const visibleItems = items.filter(
      (item) =>
        !(!active && persistedAnswerMatches && item.type === "answer" && item.messageKey === finalMessageKey)
    );
    // Adjacent text blocks form one response. Rendering each fragment on its
    // own inserts paragraph breaks and can split Markdown while persistence
    // is still catching up with the final stream.
    const activity = [];
    for (const item of visibleItems) {
      const previous = activity.at(-1);
      if (item.type === "answer" && previous?.type === "answer" && previous.messageKey === item.messageKey)
        previous.text += item.text;
      else activity.push({ ...item });
    }
    if (!activity.length)
      return (
        retryBanner +
        (active
          ? renderThinkingPlaceholder(historyKey, retry ? ui("正在恢复模型连接…") : undefined, !retry)
          : "")
      );
    const compactActivity = [];
    let batch = [];
    const flush = () => {
      if (batch.length > 1)
        compactActivity.push({ type: "tools", items: batch, key: `${batch[0].key}:group` });
      else compactActivity.push(...batch);
      batch = [];
    };
    for (const item of activity) {
      if (
        item.type === "tool" &&
        toolKinds.has(item.call.name) &&
        presentations.get(item.call)?.status === "completed"
      )
        batch.push(item);
      else {
        flush();
        compactActivity.push(item);
      }
    }
    flush();
    if (failed && !activity.some((item) => item.type === "tool" || item.text?.trim())) return "";
    const collapsible = !working && hasFinalAnswer && persistedAnswerMatches;
    const parked =
      isCurrent && pending && !continued && !failed && !working && Boolean(state.detail?.monitoring?.sleep);
    const latest = activity.at(-1);
    const currentTool = latest?.type === "tool" ? presentations.get(latest.call) : undefined;
    const phase = retry
      ? ui("正在恢复模型连接…")
      : latest?.type === "reasoning" && !latest.done
        ? ui("正在思考…")
        : latest?.type === "answer" && !latest.done
          ? ui("正在生成回复…")
          : currentTool?.status === "running"
            ? `${currentTool.title}…`
            : pendingWork.human
              ? ui("等待你的答复")
              : pendingWork.agents || pendingWork.callbacks
                ? ui("等待协作结果…")
                : pendingWork.jobs
                  ? ui("等待后台任务…")
                  : ui("等待模型响应…");
    const progress = active
      ? `<span class="workflow-progress-spinner" data-thinking-key="${esc(`${historyKey}:progress`)}" aria-hidden="true"></span>`
      : '<span class="live-pulse" aria-hidden="true"></span>';
    const caption = working
      ? [callCount ? ui`${returnedCalls}/${callCount} 项调用已返回` : "", ...outstandingLabels]
          .filter(Boolean)
          .join(" · ")
      : parked
        ? ui("本轮已处理，持续等待新进展")
        : continued
          ? ui("后续过程见补充指令下方")
          : pending || failed
            ? ui("整轮任务未完成")
            : ui("整轮任务已完成");
    const heading = collapsible
      ? ""
      : `<div class="live-workflow-head">${progress}<div class="workflow-heading"><strong>${esc(working ? (active ? phase : ui("仍有工作未结束")) : failed ? ui("执行已停止") : parked ? ui("等待唤醒") : pending && !continued ? ui("等待继续") : ui("执行过程"))}</strong><span>${esc(stepLabel)}</span></div>${caption ? `<span class="live-caption">${esc(caption)}</span>` : ""}</div>`;
    const content = `<section class="live-workflow ${working ? "is-active" : "is-complete"}"${active ? ' aria-live="polite"' : ""}>
    ${heading}
    <div class="workflow-rail">${compactActivity.map((item) => (item.type === "tools" ? renderToolGroup(item, active, presentations) : item.type === "reasoning" ? renderReasoningStep(item.text, { done: !active || item.done, interrupted: (!active || item.done) && !item.complete }, item.key, item.rawText) : item.type === "answer" ? `<div class="live-answer" data-activity-key="${esc(item.key)}"><div class="markdown-body">${markdown(item.text)}</div></div>` : renderToolStep(item.call, active, item.key, presentations.get(item.call)))).join("")}</div>
  </section>`;
    if (!collapsible) return retryBanner + content;
    const duration = formatExecutionDuration(executionElapsedMs(events, state.detail?.events));
    const title = duration ? ui`用时 ${duration}` : ui("处理完成");
    const operations = callCount ? ui`${callCount} 项操作` : "";
    return `<details class="execution-history" data-task="${esc(state.selected)}" data-history-key="${esc(historyKey)}"${historyOpen ? " open" : ""}><summary aria-label="${esc(ui`执行过程：${title}${operations ? `，${operations}` : ""}`)}"><strong>${esc(title)}</strong><span class="history-chevron" aria-hidden="true">${icon("chevron-down")}</span>${operations ? `<small>${esc(operations)}</small>` : ""}${failedCalls ? ui`<em class="history-failures">${failedCalls} 次调用未成功</em>` : ""}</summary>${content}</details>`;
  }

  function renderReasoningStep(reasoning, turn, key, rawReasoning = reasoning) {
    const original = String(rawReasoning || "");
    const normalized = normalizeReasoningDisplay(reasoning, { streaming: !turn.done });
    const preview = reasoningPreview(normalized);
    const label = turn.interrupted ? ui("思考已停止") : turn.done ? ui("思考完成") : ui("思考中");
    const spinner = turn.done
      ? ""
      : `<span class="thinking-spinner" data-thinking-key="${esc(key)}" aria-hidden="true"></span>`;
    return `<div class="activity-step reasoning-step" data-view-key="${esc(key)}">
    <div class="activity-step-content">
      ${preview ? `<details class="reasoning-details" data-activity-key="${esc(key)}"><summary>${spinner}<span class="reasoning-preview">${esc(preview)}</span><span class="reasoning-state">${label}</span><span class="reasoning-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="reasoning-copy markdown-body">${markdown(normalized)}</div>${original !== normalized || /\*\*|```/.test(original) ? ui`<details class="activity-raw" data-activity-key="${esc(`${key}:source`)}"><summary>原始内容</summary><pre class="activity-raw-copy">${esc(original)}</pre></details>` : ""}</details>` : `<div class="activity-step-head">${spinner}<strong>${label}</strong></div>`}
    </div>
  </div>`;
  }

  function renderThinkingPlaceholder(key, label = ui("正在思考…"), announce = true) {
    return `<div class="assistant-thinking"${announce ? ' role="status"' : ""}><span class="thinking-spinner" data-thinking-key="${esc(`${key}:pending`)}" aria-hidden="true"></span><span>${esc(label)}</span></div>`;
  }

  function renderToolGroup(group, active, presentations) {
    const counts = new Map();
    for (const item of group.items) {
      const kind = toolKinds.get(item.call.name);
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    const labels = {
      read: (n) => ui`读取了 ${n} 个文件`,
      edit: (n) => ui`编辑了 ${n} 个文件`,
      command: (n) => ui`运行了 ${n} 条命令`
    };
    const summary = [...counts].map(([kind, count]) => labels[kind](count)).join(" · ");
    return `<div class="activity-step tool-group" data-view-key="${esc(group.key)}"><div class="activity-step-content"><details class="tool-group-details" data-activity-key="${esc(group.key)}"><summary><span class="tool-group-label">${esc(summary)}</span><span class="tool-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="tool-group-body">${group.items.map((item) => renderToolStep(item.call, active, item.key, presentations.get(item.call))).join("")}</div></details></div></div>`;
  }

  function renderToolStep(
    call,
    active,
    key,
    presentation = presentToolCall(call, {
      active,
      workspaceRoot: state.detail?.storageRoot || state.detail?.workspaceRoot,
      taskId: state.selected,
      detail: state.detail
    })
  ) {
    const status = presentation.statusLabel === ui("调用完成") ? ui("完成") : presentation.statusLabel;
    const statusClass =
      {
        failed: "failed",
        completed: "done",
        interrupted: "stopped",
        waiting: "waiting",
        running: "running",
        recorded: "waiting"
      }[presentation.status] || "running";
    const name = presentation.title;
    const subject = presentation.subject || "";
    const resultContext = /^(?:命令执行完成|已完成|调用成功)[。.!]?$/.test(presentation.resultSummary || "")
      ? ""
      : presentation.resultSummary;
    const failed = presentation.status === "failed";
    const context = failed
      ? presentation.failureReason || presentation.resultSummary
      : [
          ...new Set([presentation.summary, resultContext].filter((value) => value && value !== subject))
        ].join(" · ");
    const sections = presentation.detailSections || [];
    const indicator =
      statusClass === "running"
        ? `<span class="tool-progress-spinner" data-thinking-key="${esc(`${key}:tool`)}" aria-hidden="true"></span>`
        : '<span class="tool-status-dot" aria-hidden="true"></span>';
    return `<div class="activity-step tool-step is-${statusClass}" data-view-key="${esc(key)}">
    <div class="activity-step-content">
      <details class="tool-details" data-activity-key="${esc(key)}"><summary class="activity-step-head"><span class="tool-action"><strong>${esc(name)}</strong>${subject ? `<span class="tool-subject" title="${esc(subject)}">${esc(subject)}</span>` : ""}</span><span class="activity-status ${statusClass}">${indicator}${esc(status)}</span>${presentation.durationLabel ? `<span class="tool-duration">${esc(presentation.durationLabel)}</span>` : ""}<span class="tool-chevron" aria-hidden="true">${icon("chevron-right")}</span></summary><div class="tool-details-body">${sections.map((section) => `<section><span class="activity-data-label">${esc(section.label)}</span><pre class="tool-copy" data-reading-key="${esc(section.label)}">${esc(section.text)}</pre></section>`).join("")}</div></details>${context ? `<p class="tool-context${failed ? " is-failure" : ""}">${esc(context)}</p>` : ""}
    </div>
  </div>`;
  }

  return { renderConversation };
}
