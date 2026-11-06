/** Import into an empty instance; failures keep its empty state available for retry. */
export function mountLocalFileOpener(host, { accept, read, api, taskId, instance, before }) {
  const group = document.createElement("div");
  group.className = "local-file-opener";
  group.innerHTML = `<button class="app-button" type="button" data-local-open>${window.bookmanDesktop?.pathForFile ? "打开已有文件" : "导入已有文件"}</button><input type="file" data-local-file hidden><p data-local-status role="status" hidden></p>`;
  if (before) before.before(group);
  else host.append(group);
  const input = group.querySelector("input");
  const status = group.querySelector("[data-local-status]");
  input.accept = accept;
  let disposed = false;
  let busy = false;
  const controller = new AbortController();
  group.querySelector("button").onclick = () => input.click();
  const openFile = async (file) => {
    if (!file || busy || disposed) return;
    busy = true;
    const navigation = api.captureNavigation?.();
    const controls = [...host.querySelectorAll("button")].filter((button) => !button.disabled);
    controls.forEach((button) => {
      button.disabled = true;
    });
    status.hidden = false;
    status.textContent = "正在打开文件…";
    try {
      const document = await readLocalDocument(file, read);
      if (disposed || (navigation && !navigation.current())) return;
      await api.createInApplication(taskId, instance.appInstanceId, document, controller.signal);
      if (!disposed) await api.onDocumentCreated?.();
    } catch (error) {
      if (!disposed) status.textContent = `打开失败：${error.message}`;
    } finally {
      busy = false;
      controls.forEach((button) => {
        button.disabled = false;
      });
    }
  };
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = "";
    void openFile(file);
  };
  const dragover = (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const drop = (event) => {
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (files.length !== 1) {
      status.hidden = false;
      status.textContent = "请一次导入一个文件；原文件已保留。";
      return;
    }
    void openFile(files[0]);
  };
  const dropTarget = host.closest(".application-home") || host.closest("[data-workbench-view]") || host;
  dropTarget.addEventListener("dragover", dragover);
  dropTarget.addEventListener("drop", drop);
  return {
    dispose() {
      disposed = true;
      controller.abort();
      dropTarget.removeEventListener("dragover", dragover);
      dropTarget.removeEventListener("drop", drop);
      group.remove();
    }
  };
}

/** Preserve native file identity for validated original-file saves, including temporary workspaces. */
export async function readLocalDocument(file, read) {
  const sourcePath = window.bookmanDesktop?.pathForFile?.(file);
  const digest = sourcePath ? await crypto.subtle.digest("SHA-256", await file.arrayBuffer()) : undefined;
  const document = await read(file);
  if (sourcePath)
    document.sourceFile = {
      path: sourcePath,
      contentVersion: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    };
  return document;
}

export async function readLocalText(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error("文本文件不能超过 2 MiB");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error("请使用 UTF-8 编码的文本文件");
  }
}
