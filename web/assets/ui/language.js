export const LANGUAGE_KEY = "atria.language";
export const validLanguage = (value) => value === "zh-CN" || value === "en";
export function readLanguage(storage) {
  try {
    const value = storage?.getItem(LANGUAGE_KEY);
    return validLanguage(value) ? value : "zh-CN";
  } catch {
    return "zh-CN";
  }
}
let storage;
try {
  storage = globalThis.localStorage;
} catch {
  // Restricted storage retains the existing Chinese default.
}
const desktopLanguage = globalThis.window?.bookmanDesktop?.language?.initial;
export const language = validLanguage(desktopLanguage) ? desktopLanguage : readLanguage(storage);
// Chinese sessions do not download or parse the English catalog.
const english = language === "en" ? (await import("./language-en.js")).default : {};
const templates = new WeakMap();
const phrases = /[^<>"'`\n{}]*\p{Script=Han}[^<>"'`\n{}]*/gu;
function translate(source) {
  if (language !== "en") return source;
  if (Object.hasOwn(english, source)) return english[source];
  return source.replace(phrases, (part) => {
    const key = part.trim();
    return Object.hasOwn(english, key) ? part.replace(key, english[key]) : part;
  });
}

/** Translate source literals only; interpolated names, messages and HTML stay untouched. */
export function ui(source, ...values) {
  if (typeof source === "string") return translate(source);
  let parts = templates.get(source);
  if (!parts) {
    parts = source.map(translate);
    templates.set(source, parts);
  }
  return parts.reduce(
    (result, part, index) => result + part + (index < values.length ? values[index] : ""),
    ""
  );
}

/** Called once on the static shell, before any conversation or document is rendered. */
export function localizeShell(root) {
  root.ownerDocument.documentElement.lang = language;
  if (language !== "en") return;
  const visit = (node) => {
    if (node.nodeType === 3) node.textContent = translate(node.textContent);
    else if (node.nodeType === 1 && !["SCRIPT", "STYLE", "SVG"].includes(node.tagName)) {
      for (const name of ["aria-label", "title", "placeholder", "data-prompt"]) {
        if (node.hasAttribute(name)) node.setAttribute(name, translate(node.getAttribute(name)));
      }
      if (node.tagName !== "TEXTAREA") for (const child of node.childNodes) visit(child);
    }
  };
  visit(root);
}

const builtinApplicationNames = {};
export function applicationLabel(type, fallback) {
  return language === "en" && builtinApplicationNames[type] ? ui(builtinApplicationNames[type]) : fallback;
}
