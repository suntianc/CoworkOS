import { ui } from "../ui/language.js";
import { createSettingsModal } from "./settings-modal.js";
import { icon } from "../ui/icons.js";

/** One profile editor. Drafts and revision conflicts never silently overwrite user input. */
export function createUserMemoryViewer({ overview, returnFocus, api }) {
  const panel = document.createElement("div");
  panel.className = "modal-backdrop settings-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="user-memory-title">
    <header class="settings-heading"><button class="settings-nav-button" type="button" data-settings-back aria-label="返回设置">${icon("chevron-left")}</button><div><h2 id="user-memory-title">个人记忆</h2><p>记住你的偏好与习惯，让协作更默契</p></div><button class="settings-nav-button" type="button" data-memory-close aria-label="关闭记忆">${icon("close")}</button></header>
    <div class="settings-scroll"><form class="user-memory-editor user-memory-compose" data-memory-compose>
      <label class="settings-field">你希望 CoworkOS 记住什么？<textarea aria-label="个人记忆内容" maxlength="2000" rows="8" placeholder="例如：我叫张三，你可以叫我小张；我喜欢简洁、自然的回答。"></textarea></label>
      <p class="settings-help" data-memory-count>0 / 2000</p>
      <div class="user-memory-compose-actions"><p class="settings-help">可以提前填写，也可以随时补充。关闭个人记忆后，内容仍会保留。</p><button type="button" class="app-button is-secondary" data-memory-discard hidden>取消修改</button><button type="submit" class="app-button is-primary" disabled>保存记忆</button></div>
      <p role="alert" data-memory-compose-result></p>
    </form><p role="status" data-memory-view-status></p></div>
  </section>`;
  document.body.append(panel);
  /** One backend read/write; the shared client supplies the session and origin. */
  const send = async (path, options) => {
    if (api) return api(path, options);
    const response = await fetch(path, options);
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || ui("记忆读取失败，请重试"));
      error.status = response.status;
      throw error;
    }
    return value;
  };
  const status = panel.querySelector("[data-memory-view-status]");
  const form = panel.querySelector("form");
  const input = form.querySelector("textarea");
  const result = panel.querySelector("[data-memory-compose-result]");
  const save = form.querySelector("[type=submit]");
  const discard = form.querySelector("[data-memory-discard]");
  const count = panel.querySelector("[data-memory-count]");
  let revision,
    baseline = "",
    dirty = false,
    saving = false,
    sequence = 0,
    controller;
  const update = () => {
    dirty = input.value !== baseline;
    discard.hidden = !dirty;
    discard.disabled = saving;
    count.textContent = `${input.value.length} / 2000`;
    save.disabled = saving || !revision || !dirty || input.value.trim().length > 2000;
  };
  input.addEventListener("input", update);
  discard.addEventListener("click", () => {
    input.value = baseline;
    update();
    void load();
  });
  const cancel = () => {
    sequence++;
    controller?.abort();
  };
  const dialog = createSettingsModal(panel, panel.querySelector("[data-memory-close]"), {
    overview,
    returnFocus,
    onClose: cancel
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.disabled || saving) return;
    const content = input.value.trim();
    if (content.length > 2000) {
      result.textContent = ui("个人记忆最多 2000 个字符，请精简后保存。");
      return;
    }
    saving = true;
    input.disabled = true;
    update();
    result.textContent = ui("正在保存…");
    try {
      const value = await send("/api/user-memory", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save_text", content, revision })
      }).catch((error) => {
        throw new Error(
          error?.status === 409
            ? ui("记忆已变化，输入已保留。请先复制草稿，取消修改后核对最新记忆再保存。")
            : error.message || ui("保存失败，输入已保留，请重试。")
        );
      });
      revision = value.revision;
      baseline = value.content;
      input.value = baseline;
      result.textContent = value.enabled ? ui("已保存") : ui("已保存；开启个人记忆后用于后续对话");
    } catch (error) {
      result.textContent = error.message || ui("保存失败，输入已保留，请重试。");
    } finally {
      saving = false;
      input.disabled = false;
      update();
    }
  });
  async function load() {
    if (dirty || saving) return;
    controller?.abort();
    controller = new AbortController();
    const request = ++sequence;
    status.textContent = ui("正在读取记忆…");
    input.disabled = true;
    save.disabled = true;
    try {
      const value = await send("/api/user-memory", { cache: "no-store", signal: controller.signal });
      if (request !== sequence || panel.hidden) return;
      baseline = value.content;
      revision = value.revision;
      input.value = baseline;
      status.textContent =
        baseline.length > 2000 ? ui("旧版记忆超过 2000 个字符，内容已保留，请精简后保存。") : "";
      result.textContent = "";
    } catch (error) {
      if (request === sequence && !panel.hidden)
        status.textContent = error.message || ui("记忆读取失败，请重试");
    } finally {
      if (request === sequence && !panel.hidden) {
        input.disabled = false;
        update();
      }
    }
  }
  window.addEventListener("pagehide", cancel, { once: true });
  return {
    open() {
      if (dialog.open()) void load();
    }
  };
}
