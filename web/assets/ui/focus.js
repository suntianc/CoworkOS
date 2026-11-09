/** Follow same-origin editor frames so shell dialogs can return to their trigger. */
export function focusedControl(root = document) {
  let control = root.activeElement;
  try {
    while (control?.localName === "iframe") {
      const nested = control.contentDocument?.activeElement;
      if (!nested || nested === control.contentDocument.body) break;
      control = nested;
    }
    // eslint-disable-next-line no-restricted-syntax -- 跨域 iframe 读取 contentDocument 抛 SecurityError，保留外层焦点元素
  } catch {
    // Cross-origin frames retain their outer focus target.
  }
  return control;
}
