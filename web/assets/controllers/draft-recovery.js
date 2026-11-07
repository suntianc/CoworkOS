import { createModal } from "../ui/modal.js";
import { ui } from "../ui/language.js";

/** Let the user assign one previously unbound draft to the current backend. */
export function createDraftRecovery({ button, session, getBackend, getProjects, openDraft }) {
  const panel = document.createElement("div");
  panel.className = "modal-backdrop app-dialog-backdrop";
  panel.hidden = true;
  panel.innerHTML = ui`<section class="modal-card app-dialog" role="dialog" aria-modal="true" aria-labelledby="draft-recovery-title">
    <h2 id="draft-recovery-title">恢复草稿</h2>
    <form>
      <label class="dialog-field">待恢复草稿<select name="source" required></select></label>
      <label class="dialog-field">目标后端<input name="backend" readonly></label>
      <label class="dialog-field">目标项目<select name="project" required></select></label>
      <p class="dialog-error" role="alert" hidden></p>
      <div class="dialog-actions"><button class="app-button is-secondary" type="button" data-close>取消</button><button class="app-button is-primary" type="submit">恢复草稿</button></div>
    </form>
  </section>`;
  document.body.append(panel);
  const modal = createModal(panel, panel.querySelector("[data-close]"));
  const form = panel.querySelector("form");
  const source = form.elements.source;
  const backend = form.elements.backend;
  const project = form.elements.project;
  const error = panel.querySelector('[role="alert"]');
  const option = (select, value, label) => {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = label;
    select.append(item);
  };
  let openedBackend;
  let candidates = [];
  const refresh = async () => {
    const currentBackend = getBackend();
    const entries = currentBackend ? await session.listRecoverableDrafts() : [];
    if (currentBackend !== getBackend()) return;
    candidates = entries;
    button.hidden = entries.length === 0;
  };
  button.addEventListener("click", async () => {
    await refresh();
    if (!candidates.length || !getBackend()) return;
    openedBackend = getBackend();
    backend.value = openedBackend;
    source.replaceChildren();
    option(source, "", ui("选择草稿"));
    for (const entry of candidates) {
      const location = entry.projectId || ui("无项目");
      const preview = entry.text.trim().slice(0, 60) || entry.attachments.map((file) => file.name).join(", ");
      option(source, entry.id, `${location} · ${preview}`);
    }
    project.replaceChildren();
    option(project, "", ui("选择目标项目"));
    option(project, "global", ui("无项目"));
    for (const item of getProjects()) option(project, `project:${item.projectId}`, item.projectName);
    error.hidden = true;
    modal.open();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!source.value || !project.value) return;
    if (openedBackend !== getBackend()) {
      error.textContent = ui("后端已切换，请重新选择");
      error.hidden = false;
      return;
    }
    const projectId = project.value === "global" ? null : project.value.slice("project:".length);
    const result = await session.recoverDraft(source.value, { projectId });
    if (!result.ok) {
      error.textContent =
        result.reason === "conflict" ? ui("目标已有草稿，请选择其他项目") : ui("草稿暂时无法恢复，请重试");
      error.hidden = false;
      return;
    }
    modal.close();
    openDraft(projectId);
    await refresh();
  });
  return { refresh };
}
