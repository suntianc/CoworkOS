import { ui } from "../ui/language.js";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const uploadedFileIds = (files) =>
  files.filter((file) => typeof file.uploadId === "string").map((file) => file.uploadId);

/** The page's own backend and no header; the shared client supplies the real transport. */
export function defaultUpload(file, { name = file.name, signal, onProgress: progress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("POST", `/api/uploads?name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      signal.removeEventListener("abort", abort);
      let result;
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(ui("附件上传响应无效")));
        return;
      }
      xhr.status >= 200 && xhr.status < 300
        ? resolve(result)
        : reject(new Error(result.error || ui("附件上传失败")));
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error(ui("附件上传连接中断，请重试")));
    };
    xhr.onabort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error(ui("附件上传已取消")));
    };
    xhr.send(file);
  });
}
export function createFileUpload({
  getContext,
  getFiles,
  setFiles,
  onStatus,
  onBusy,
  onError,
  upload = defaultUpload
}) {
  let controller,
    retryFiles = [];
  async function add(files) {
    if (!files.length) return;
    if (controller) throw new Error(ui("请等待当前上传完成，或先取消上传"));
    if (files.length + getFiles().length > MAX_FILES) throw new Error(ui("每条消息最多添加10个文件"));
    if (files.some((file) => file.size > MAX_FILE_BYTES)) throw new Error(ui("单个文件不能超过25 MB"));
    if ([...files, ...getFiles()].reduce((size, file) => size + (file.size || 0), 0) > 100 * 1024 * 1024)
      throw new Error(ui("附件合计不能超过100 MB"));
    const context = getContext();
    const active = new AbortController();
    controller = active;
    retryFiles = [];
    onBusy(true);
    const current = () => getContext() === context && !active.signal.aborted;
    try {
      for (let index = 0; index < files.length; index++) {
        if (!current()) break;
        const file = files[index];
        onStatus({ name: file.name, progress: 0, index: index + 1, total: files.length });
        try {
          const result = await upload(file, {
            name: file.name,
            signal: active.signal,
            onProgress: (progress) => {
              if (current()) onStatus({ name: file.name, progress, index: index + 1, total: files.length });
            }
          });
          if (!current()) break;
          if (
            !getFiles().some((previous) => previous.name === result.name && previous.sha256 === result.sha256)
          )
            setFiles([...getFiles(), result]);
        } catch (error) {
          if (current()) {
            retryFiles.push(file);
            onError(`${file.name}：${error.message}`);
          }
        }
      }
    } finally {
      if (controller === active) {
        controller = undefined;
        onBusy(false);
        onStatus(retryFiles.length && getContext() === context ? { failed: retryFiles.length } : null);
      }
    }
  }
  return {
    add,
    retry: () => add([...retryFiles]),
    cancel() {
      controller?.abort();
      retryFiles = [];
      onStatus(null);
    },
    navigate() {
      controller?.abort();
      retryFiles = [];
      onStatus(null);
    }
  };
}
