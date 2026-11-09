import { language, LANGUAGE_KEY, validLanguage, ui } from "../ui/language.js";

/** Reuse the existing document/draft close gate before reloading translated chrome. */
export function installLanguageSettings({ prepareClose, storage, reload = () => location.reload() }) {
  const select = document.querySelector("#language-select");
  const status = document.querySelector("#language-status");
  const reset = () => {
    const option = [...select.options].find((entry) => entry.value === language);
    if (option) option.selected = true;
  };
  reset();
  let changing = false;
  select.addEventListener("change", async () => {
    const next = select.value;
    if (changing || !validLanguage(next) || next === language) return;
    changing = true;
    select.disabled = true;
    status.textContent = ui("正在切换语言…");
    try {
      if (!(await prepareClose())) {
        status.textContent = ui("请先保存当前修改后再切换语言。");
        return;
      }
      if (window.bookmanDesktop?.language) await window.bookmanDesktop.language.set(next);
      else storage.setItem(LANGUAGE_KEY, next);
      reload();
      // eslint-disable-next-line no-restricted-syntax -- setItem throws when storage is blocked or full; the status line reports it and the select is reset
    } catch {
      status.textContent = ui("语言偏好无法保存，请检查本机存储空间。");
    } finally {
      reset();
      select.disabled = false;
      changing = false;
    }
  });
}
