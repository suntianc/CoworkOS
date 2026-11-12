const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const paths = {
  mac: '<rect x="3" y="4" width="26" height="18" rx="3"/><path d="M12 28h8m-4-6v6"/>',
  terminal: '<rect x="3" y="5" width="26" height="22" rx="4"/><path d="m9 12 4 4-4 4m8 0h6"/>',
  model: '<path d="m16 3 12 7v12l-12 7-12-7V10Z"/><path d="m4 10 12 7 12-7m-12 7v12M10 6.5l12 7"/>',
  text: '<path d="M19 3H8a3 3 0 0 0-3 3v20a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V11Z"/><path d="M19 3v8h8M11 17h10m-10 5h10"/>',
  presentation:
    '<rect x="3" y="4" width="26" height="20" rx="3"/><path d="M16 24v5m-5 0h10M9 17l4-5 4 3 6-7"/>',
  blender:
    '<path d="m4 10 10 1-6-7m6 7-11 7h8"/><ellipse cx="20" cy="18" rx="10" ry="9"/><ellipse cx="20" cy="18" rx="5" ry="4"/>',
  freecad: '<path d="M5 28V4h19M5 15h13m3 3 8 4v7l-8-4-7 4v-7Z"/><path d="m14 22 7 4 8-4m-8 4v3"/>',
  file: '<path d="M19 3H8a3 3 0 0 0-3 3v20a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3V11Z"/><path d="M19 3v8h8M11 18h10m-10 5h7"/>',
  download: '<path d="M16 3v17m-6-6 6 6 6-6M5 22v4a3 3 0 0 0 3 3h16a3 3 0 0 0 3-3v-4"/>'
};
const icon = (name) =>
  `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const arrow = '<span class="card-arrow" aria-hidden="true">↗</span>';

function sections(html, depth) {
  const pattern = new RegExp(`<h${depth} id="([^"]+)">([\\s\\S]*?)<\\/h${depth}>`, "g");
  const matches = [...html.matchAll(pattern)];
  return {
    prefix: matches.length ? html.slice(0, matches[0].index) : html,
    items: matches.map((match, index) => ({
      id: match[1],
      title: match[2],
      heading: match[0],
      body: html.slice(match.index + match[0].length, matches[index + 1]?.index ?? html.length)
    }))
  };
}

function tabs(name, items, label, className = "") {
  const buttons = items
    .map(
      (item, i) =>
        `<button type="button" role="tab" id="${name}-tab-${i}" aria-controls="${name}-panel-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${escape(item.label)}</button>`
    )
    .join("");
  const panels = items
    .map(
      (item, i) =>
        `<section class="docs-tab-panel" id="${name}-panel-${i}" role="tabpanel" aria-labelledby="${name}-tab-${i}" tabindex="0" data-tab-panel>${item.html}</section>`
    )
    .join("");
  return `<div class="docs-tabs ${className}" data-tabs><div class="docs-tab-list" role="tablist" aria-label="${escape(label)}" hidden>${buttons}</div>${panels}</div>`;
}

function home(html, en) {
  return html.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/, (_match, contents) => {
    const items = contents.replace(
      /<li>\s*<a ([^>]+)>([\s\S]*?)<\/a>\s*<\/li>/g,
      (_item, attributes, title) => {
        const kind = /cli-quickstart/.test(attributes)
          ? "terminal"
          : /configuration/.test(attributes)
            ? "model"
            : "mac";
        const install = kind !== "model";
        const meta =
          kind === "mac"
            ? "macOS 14+ · Apple Silicon"
            : kind === "terminal"
              ? "macOS / Linux · Node.js 22.19+"
              : "";
        return `<li${install ? "" : ' class="entry-settings"'}><a ${attributes} class="entry-card ${install ? "entry-install" : "entry-route"}"><span class="entry-symbol">${icon(kind)}</span><strong>${title}</strong>${meta ? `<span class="entry-meta">${meta}</span>` : ""}${arrow}</a></li>`;
      }
    );
    return `<ul class="start-options entry-grid" aria-label="${en ? "Get started" : "开始使用"}">${items}</ul>`;
  });
}

function steps(html) {
  const { prefix, items } = sections(html, 2);
  if (!items.length) return html;
  return (
    prefix +
    `<ol class="setup-steps">${items
      .map(
        (item, i) =>
          `<li class="setup-step"><span class="step-number" aria-hidden="true">${i + 1}</span><div class="step-body">${item.heading}${item.body}</div></li>`
      )
      .join("")}</ol>`
  );
}

function downloads(html) {
  return html.replace(/<ul>([\s\S]*?)<\/ul>/g, (original, contents) => {
    if (!/\.tgz/.test(contents) || !/\.sha256/.test(contents)) return original;
    return `<ul class="download-files">${contents.replace(
      /<li>\s*<a ([^>]+)>([\s\S]*?)<\/a>\s*<\/li>/g,
      (_item, attributes, name) =>
        `<li><a ${attributes}><span class="download-file-icon">${icon(/sha256/.test(name) ? "file" : "download")}</span><span>${name}</span>${arrow}</a></li>`
    )}</ul>`;
  });
}

function configuration(html, en) {
  const { prefix, items } = sections(html, 2);
  const selected = items.filter((item) => /^(?:cli-|app-)/.test(item.id));
  if (selected.length !== 2) return html;
  selected.sort((a, b) => Number(a.id.startsWith("cli-")) - Number(b.id.startsWith("cli-")));
  const group = tabs(
    "connection",
    selected.map((item) => ({
      label: item.id.startsWith("cli-") ? "CLI" : "App / Web",
      html: `<div class="panel-heading">${item.heading}</div>${item.body}`
    })),
    en ? "Connection setup" : "连接设置",
    "connection-tabs"
  );
  let inserted = false;
  return (
    prefix +
    items
      .map((item) => {
        if (!selected.includes(item)) return item.heading + item.body;
        if (inserted) return "";
        inserted = true;
        return group;
      })
      .join("")
  );
}

// Source Markdown stays readable on GitHub. Enhance only the maintained user entry pages.
export function decorateArticle(page, html) {
  const file = page.file.replace(/^docs\/en\//, "docs/");
  if (file === "docs/README.md") return home(html, page.english);
  if (file === "docs/configuration.md") return configuration(html, page.english);
  if (["docs/getting-started.md", "docs/cli-quickstart.md"].includes(file)) return steps(downloads(html));
  return html;
}
