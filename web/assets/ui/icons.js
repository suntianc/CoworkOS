import { escapeHtml } from "../ui/html.js";

const menuIcons = {
  pin: '<path d="m15 3 6 6-3 1-3 5-3-3-5 3-1-1 3-5-3-3Z"/><path d="m9 15-6 6"/>',
  eye: '<path d="M2.5 12s3.4-7 9.5-7 9.5 7 9.5 7-3.4 7-9.5 7S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  archive:
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 12h6"/>',
  external: '<path d="M14 3h7v7m0-7L11 13M11 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/>',
  link: '<path d="m10 13 4-4m-6 7-1 1a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m2 1 1-1a4.2 4.2 0 0 1 6 6l-4 4a4.2 4.2 0 0 1-6 0" transform="translate(1 1)"/>'
};

/** Icons share the shell's SVG sprite; decorative marks never change accessible names. */
export function icon(name, className = "") {
  const paths = menuIcons[name];
  return `<svg class="ui-icon ${escapeHtml(className)}"${paths ? ' viewBox="0 0 24 24"' : ""} aria-hidden="true" focusable="false">${paths || `<use href="#i-${escapeHtml(name)}"/>`}</svg>`;
}
