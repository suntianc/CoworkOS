import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { createModal } from "../ui/modal.js";
import { escapeHtml as esc } from "../workbench/html.js";

const POLL_MS = 400;

function operationId() {
  const random = globalThis.crypto?.randomUUID?.();
  return `clone:${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/** The folder git creates under a chosen parent, named after the repository. */
function repositoryName(remoteUrl) {
  const trimmed = remoteUrl.trim().replace(/[\\/]+$/, "");
  const last =
    trimmed
      .split(/[\\/:]/)
      .filter(Boolean)
      .at(-1) || "";
  return last.replace(/\.git$/i, "");
}

function joinPath(parent, name) {
  if (!name) return parent;
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

/**
 * Add a project from a local folder or a Git clone.
 *
 * The dialog keeps its inputs across a failed attempt, owns the clone's
 * progress polling, and cancels a running clone when the dialog closes. A
 * finished clone or a created folder is handed to `onCreated`; the caller
 * refreshes the catalog so the sidebar shows the project.
 */
export function createAddProjectController({ api, command, showToast = () => {}, onCreated = () => {} }) {
  let panel,
    dialog,
    epoch = 0,
    source = "local",
    busy = false,
    cloneId,
    timer;
  const markup = ui`<section class="add-project-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
    <div class="add-project-head"><h2 id="add-project-title">添加项目</h2><button class="add-project-close" type="button" aria-label="关闭">${icon("close")}</button></div>
    <div class="add-project-sources" role="tablist" aria-label="添加方式">
      <button class="add-project-source" type="button" role="tab" id="add-project-tab-local" data-add-project-source="local" aria-controls="add-project-panel-local">${icon("folder-open")}<span>本地目录</span></button>
      <button class="add-project-source" type="button" role="tab" id="add-project-tab-git" data-add-project-source="git" aria-controls="add-project-panel-git">${icon("git-branch")}<span>Git 地址</span></button>
    </div>
    <form id="add-project-form" novalidate>
      <div class="add-project-panel" id="add-project-panel-local" role="tabpanel" aria-labelledby="add-project-tab-local" data-add-project-panel="local">
        <div class="add-project-field"><label class="add-project-label" for="add-project-name">项目名称</label><div class="add-project-input-row"><input class="add-project-input" id="add-project-name" maxlength="120" autocomplete="off"></div></div>
        <div class="add-project-field"><label class="add-project-label" for="add-project-directory">工作文件夹</label><div class="add-project-input-row"><input class="add-project-input" id="add-project-directory" autocomplete="off"><button class="add-project-pick" id="add-project-directory-choose" type="button" aria-label="选择文件夹">选择…</button></div></div>
      </div>
      <div class="add-project-panel" id="add-project-panel-git" role="tabpanel" aria-labelledby="add-project-tab-git" data-add-project-panel="git" hidden>
        <div class="add-project-field"><label class="add-project-label" for="add-project-remote">仓库地址</label><div class="add-project-input-row"><input class="add-project-input is-mono" id="add-project-remote" autocomplete="off" spellcheck="false"></div></div>
        <div class="add-project-field"><label class="add-project-label" for="add-project-destination">克隆到</label><div class="add-project-input-row"><input class="add-project-input is-mono" id="add-project-destination" autocomplete="off" spellcheck="false"><button class="add-project-pick" id="add-project-destination-choose" type="button" aria-label="选择文件夹">选择…</button></div></div>
        <div class="add-project-field"><label class="add-project-label" for="add-project-branch">分支 <span class="add-project-optional">可选</span></label><div class="add-project-input-row"><input class="add-project-input is-mono" id="add-project-branch" autocomplete="off" placeholder="默认分支" spellcheck="false"></div></div>
      </div>
      <p class="add-project-state" id="add-project-state" role="status" hidden></p>
      <div class="add-project-footer"><button class="add-project-button" id="add-project-cancel" type="button">取消</button><button class="add-project-button is-primary" id="add-project-submit" type="submit">添加项目</button></div>
    </form>
  </section>`;

  const $ = (selector) => panel.querySelector(selector);
  const nameInput = () => $("#add-project-name");
  const directoryInput = () => $("#add-project-directory");
  const remoteInput = () => $("#add-project-remote");
  const destinationInput = () => $("#add-project-destination");
  const branchInput = () => $("#add-project-branch");
  const submitButton = () => $("#add-project-submit");
  const stateRow = () => $("#add-project-state");

  function hideState() {
    const row = stateRow();
    row.hidden = true;
    row.textContent = "";
    row.removeAttribute("role");
  }

  function showState(kind, message) {
    const row = stateRow();
    row.hidden = false;
    row.className = `add-project-state is-${kind}`;
    row.setAttribute("role", kind === "error" ? "alert" : "status");
    row.innerHTML = `${icon(kind === "progress" ? "loader-circle" : "circle-alert")}<span>${esc(message)}</span>`;
  }

  function showProgress(progress) {
    const row = stateRow();
    const label = `克隆中 · ${Math.round(progress)}%`;
    // Rewriting the row would restart the spinner every poll; only the label moves.
    if (!row.hidden && row.classList.contains("is-progress")) {
      row.querySelector("span").textContent = label;
      return;
    }
    showState("progress", label);
  }

  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function setSource(next) {
    if (busy) return;
    source = next;
    for (const button of panel.querySelectorAll("[data-add-project-source]")) {
      const selected = button.dataset.addProjectSource === next;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle("is-selected", selected);
    }
    for (const view of panel.querySelectorAll("[data-add-project-panel]"))
      view.hidden = view.dataset.addProjectPanel !== next;
    submitButton().textContent = next === "git" ? ui("克隆并添加") : ui("添加项目");
    hideState();
  }

  function setBusy(next, { cancellable = false } = {}) {
    busy = next;
    $("section.add-project-dialog").setAttribute("aria-busy", next ? "true" : "false");
    for (const control of panel.querySelectorAll("input, button")) control.disabled = next;
    if (next) {
      $("#add-project-cancel").disabled = !cancellable;
      $(".add-project-close").disabled = !cancellable;
    }
  }

  function resetForm() {
    for (const input of panel.querySelectorAll("input")) input.value = "";
    hideState();
    setSource("local");
  }

  function closeWithCancel() {
    // `onClose` cancels the running clone, whether the dialog was dismissed by
    // this button, the close control, Escape or a click on the backdrop.
    dialog?.close();
  }

  async function chooseDirectory() {
    const desktop = globalThis.window?.bookmanDesktop;
    if (desktop?.chooseProject) return desktop.chooseProject();
    return (await api("/api/projects/choose-directory", { method: "POST" })).projectDirectory;
  }

  async function pickFolder(input, { forClone = false } = {}) {
    const button = forClone ? $("#add-project-destination-choose") : $("#add-project-directory-choose");
    button.disabled = true;
    try {
      const selected = await chooseDirectory();
      if (!selected || panel.hidden) return;
      const name = forClone ? repositoryName(remoteInput().value) : "";
      input.value = name ? joinPath(selected, name) : selected;
    } catch (failure) {
      showState("error", failure.message);
    } finally {
      if (!panel.hidden) button.disabled = false;
    }
  }

  function complete(project) {
    cloneId = undefined;
    stopPolling();
    setBusy(false);
    resetForm();
    dialog.close();
    // A catalog refresh failure leaves the project on the backend; report it
    // instead of dropping the person back to the sidebar without knowing.
    void Promise.resolve()
      .then(() => onCreated(project))
      .catch((error) => showToast(error.message));
  }

  async function poll(runEpoch) {
    const id = cloneId;
    if (!id || runEpoch !== epoch) return;
    let clone;
    try {
      ({ clone } = await api(`/api/project-clones/${encodeURIComponent(id)}`));
    } catch (failure) {
      if (runEpoch !== epoch) return;
      cloneId = undefined;
      setBusy(false);
      showState("error", failure.message);
      return;
    }
    if (runEpoch !== epoch) return;
    if (clone.state === "cloning") {
      showProgress(clone.progress);
      timer = setTimeout(() => void poll(runEpoch), POLL_MS);
      return;
    }
    cloneId = undefined;
    if (clone.state === "completed") {
      complete(clone.project);
      return;
    }
    setBusy(false);
    if (clone.state === "failed") showState("error", `${ui("克隆失败：")}${clone.error || ui("未知原因")}`);
    else showState("error", ui("克隆已取消"));
  }

  async function startClone() {
    const remoteUrl = remoteInput().value.trim();
    const destination = destinationInput().value.trim();
    const branch = branchInput().value.trim();
    if (!remoteUrl || !destination) {
      showState("error", ui("请填写仓库地址和克隆位置"));
      return;
    }
    setBusy(true, { cancellable: true });
    showProgress(0);
    const runEpoch = epoch;
    let clone;
    try {
      ({ clone } = await api("/api/project-clones", {
        method: "POST",
        json: {
          remoteUrl,
          destination,
          ...(branch ? { branch } : {}),
          operationId: operationId()
        }
      }));
    } catch (failure) {
      if (runEpoch !== epoch) return;
      setBusy(false);
      showState("error", failure.message);
      return;
    }
    if (runEpoch !== epoch) {
      // The dialog closed while the start request was in flight; the clone it
      // just started must not keep running unseen.
      void api(`/api/project-clones/${encodeURIComponent(clone.cloneId)}/cancel`, {
        method: "POST"
      }).catch((error) => showToast(error.message));
      return;
    }
    cloneId = clone.cloneId;
    showProgress(clone.progress);
    timer = setTimeout(() => void poll(runEpoch), POLL_MS);
  }

  async function createLocalProject() {
    const projectName = nameInput().value.trim();
    const projectDirectory = directoryInput().value.trim();
    if (!projectName || !projectDirectory) {
      showState("error", ui("请填写项目名称并选择工作文件夹"));
      return;
    }
    setBusy(true);
    try {
      const result = await command("/api/projects", {
        method: "POST",
        body: { projectName, projectDirectory }
      });
      complete(result.project);
    } catch (failure) {
      setBusy(false);
      showState("error", failure.message);
    }
  }

  function ensureDialog() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "add-project-modal";
    panel.className = "modal-backdrop app-dialog-backdrop add-project-backdrop";
    panel.hidden = true;
    panel.innerHTML = markup;
    document.body.appendChild(panel);
    const closeButton = panel.querySelector(".add-project-close");
    dialog = createModal(panel, closeButton, {
      onClose: () => {
        const running = cloneId;
        cloneId = undefined;
        stopPolling();
        epoch++;
        busy = false;
        hideState();
        if (running)
          void api(`/api/project-clones/${encodeURIComponent(running)}/cancel`, {
            method: "POST"
          }).catch((error) => showToast(error.message));
      }
    });
    for (const button of panel.querySelectorAll("[data-add-project-source]"))
      button.addEventListener("click", () => setSource(button.dataset.addProjectSource));
    panel.querySelector(".add-project-sources").addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setSource(source === "local" ? "git" : "local");
      panel.querySelector(`[data-add-project-source="${source}"]`).focus();
    });
    $("#add-project-cancel").addEventListener("click", closeWithCancel);
    $("#add-project-directory-choose").addEventListener("click", () => void pickFolder(directoryInput()));
    $("#add-project-destination-choose").addEventListener(
      "click",
      () => void pickFolder(destinationInput(), { forClone: true })
    );
    $("#add-project-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      if (source === "git") void startClone();
      else void createLocalProject();
    });
  }

  return {
    open() {
      ensureDialog();
      epoch++;
      setBusy(false);
      const useGit = source === "git" && Boolean(remoteInput().value.trim());
      setSource(useGit ? "git" : "local");
      dialog.open();
      (useGit ? remoteInput() : nameInput()).focus();
    },
    close: () => dialog?.close()
  };
}
