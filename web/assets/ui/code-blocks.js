import { ui } from "./language.js";
import { icon } from "./icons.js";

/** Writes text to the clipboard; false when the browser refuses. */
export async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
    // eslint-disable-next-line no-restricted-syntax -- the browser refuses clipboard writes outside a secure context or without permission; the caller reports that copy is unavailable
  } catch {
    return false;
  }
}

/** A copy button says 已复制 for a moment, then returns to its label. */
export function confirmCopied(button, label) {
  const target = label || button;
  const previous = button.dataset.copyLabel ?? target.textContent;
  button.dataset.copyLabel = previous;
  button.classList.add("is-copied");
  if (label) target.textContent = ui("已复制");
  clearTimeout(Number(button.dataset.copyTimer));
  button.dataset.copyTimer = String(
    setTimeout(() => {
      button.classList.remove("is-copied");
      if (label) target.textContent = previous;
      delete button.dataset.copyLabel;
      delete button.dataset.copyTimer;
    }, 1500)
  );
}

/** A rendered table back to Markdown, cell text only. */
function tableMarkdown(table) {
  const cell = (node) => node.textContent.trim().replace(/\|/g, "\\|").replace(/\n+/g, " ");
  const rows = [...table.rows].map((row) => `| ${[...row.cells].map(cell).join(" | ")} |`);
  if (!rows.length) return "";
  const columns = table.rows[0].cells.length;
  return [rows[0], `| ${Array(columns).fill("---").join(" | ")} |`, ...rows.slice(1)].join("\n");
}

function blockText(block) {
  const table = block.querySelector("table");
  if (table) return tableMarkdown(table);
  const code = block.querySelector("[data-copy-text]") || block.querySelector("code");
  return code?.dataset.copyText ?? code?.textContent ?? "";
}

/* Mermaid ------------------------------------------------------------------ */

let mermaidLoad;
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/assets/mermaid/generated/mermaid.min.js";
    script.async = true;
    script.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error("Mermaid missing")));
    script.onerror = () => {
      mermaidLoad = undefined;
      reject(new Error("Mermaid failed to load"));
    };
    document.head.append(script);
  });
  return mermaidLoad;
}

let diagramSequence = 0;
let configuredTheme;
async function drawDiagram(canvas) {
  const block = canvas.closest(".diagram-block");
  const source = block?.querySelector("[data-copy-text]")?.dataset.copyText;
  if (!block || source === undefined) return;
  canvas.dataset.drawn = "pending";
  block.classList.remove("is-failed");
  try {
    const mermaid = await loadMermaid();
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    if (configuredTheme !== theme) {
      // Diagrams take the page's own tokens, so they read as part of the reply.
      const token = (name) => getComputedStyle(block).getPropertyValue(name).trim();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: getComputedStyle(block).fontFamily,
        themeVariables: {
          darkMode: theme === "dark",
          fontSize: "13px",
          background: token("--ui-raised"),
          primaryColor: token("--ui-panel"),
          primaryTextColor: token("--ui-text"),
          primaryBorderColor: token("--ui-border-hover"),
          secondaryColor: token("--ui-raised"),
          tertiaryColor: token("--ui-raised"),
          lineColor: token("--ui-muted"),
          textColor: token("--ui-text"),
          mainBkg: token("--ui-panel"),
          nodeBorder: token("--ui-border-hover"),
          clusterBkg: token("--ui-raised"),
          edgeLabelBackground: token("--ui-raised")
        },
        flowchart: { curve: "basis", padding: 12 }
      });
      configuredTheme = theme;
    }
    const { svg } = await mermaid.render(`formicand-diagram-${++diagramSequence}`, source);
    if (!canvas.isConnected) return;
    canvas.innerHTML = svg;
    canvas.dataset.drawn = theme;
    // eslint-disable-next-line no-restricted-syntax -- a diagram the model wrote may not parse; the block falls back to its source and says so
  } catch {
    if (!canvas.isConnected) return;
    canvas.dataset.drawn = "failed";
    canvas.innerHTML = `<p class="diagram-error">${icon("triangle-alert")}<span>${ui("图无法绘制，已显示源码")}</span></p>`;
    block.classList.add("is-failed");
  }
}

function drawPendingDiagrams(root) {
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  for (const canvas of root.querySelectorAll("[data-diagram-canvas]")) {
    const drawn = canvas.dataset.drawn;
    if (drawn === "pending" || drawn === "failed" || drawn === theme) continue;
    void drawDiagram(canvas);
  }
}

/* Zoom --------------------------------------------------------------------- */

function zoom(block) {
  const content = block.querySelector(".table-scroll, [data-diagram-canvas]");
  if (!content) return;
  const dialog = document.createElement("dialog");
  dialog.className = "block-zoom";
  dialog.setAttribute("aria-label", ui("放大查看"));
  dialog.innerHTML = `<div class="block-zoom-head"><span>${block.querySelector(".code-block-language")?.textContent || ""}</span><button type="button" class="code-block-action is-icon" data-zoom-close title="${ui("关闭")}" aria-label="${ui("关闭")}">${icon("close")}</button></div><div class="block-zoom-body"></div>`;
  const copy = content.cloneNode(true);
  copy.removeAttribute("data-diagram-canvas");
  dialog.querySelector(".block-zoom-body").append(copy);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-zoom-close]")) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Behaviour for the blocks rendered Markdown carries (see rich-blocks.js):
 * copying, wrapping, expanding terminal output, switching and folding diffs,
 * showing a diagram's source, zooming, and drawing diagrams once they appear.
 * One listener serves every block wherever Markdown was rendered.
 */
export function installCodeBlockActions(root, { showToast, openFile } = {}) {
  root.addEventListener("click", async (event) => {
    const file = event.target.closest?.("[data-file-ref]");
    if (file) {
      openFile?.(file.dataset.fileRef, Number(file.dataset.fileLine) || undefined);
      return;
    }
    const button = event.target.closest?.(
      "[data-code-copy], [data-code-wrap], [data-terminal-more], [data-diff-view], [data-diff-collapse], [data-diagram-source], [data-block-zoom]"
    );
    const block = button?.closest(".code-block, .table-block");
    if (!block || button.tagName !== "BUTTON") return;
    if (button.hasAttribute("data-code-wrap")) {
      button.setAttribute("aria-pressed", String(block.classList.toggle("is-wrapped")));
    } else if (button.hasAttribute("data-terminal-more")) {
      const rest = block.querySelector("[data-terminal-rest]");
      const label = button.querySelector("span");
      button.dataset.moreLabel ??= label.textContent;
      rest.hidden = !rest.hidden;
      button.setAttribute("aria-expanded", String(!rest.hidden));
      label.textContent = rest.hidden ? button.dataset.moreLabel : ui("收起");
    } else if (button.hasAttribute("data-diff-view")) {
      const view = button.dataset.diffView;
      block.dataset.diffView = view;
      block.querySelector(".diff-inline").hidden = view !== "inline";
      block.querySelector(".diff-split").hidden = view !== "split";
      for (const option of block.querySelectorAll("button[data-diff-view]"))
        option.setAttribute("aria-pressed", String(option === button));
    } else if (button.hasAttribute("data-diff-collapse")) {
      const collapsed = block.classList.toggle("is-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
      button.title = collapsed ? ui("展开改动") : ui("折叠改动");
    } else if (button.hasAttribute("data-diagram-source")) {
      button.setAttribute("aria-pressed", String(block.classList.toggle("shows-source")));
    } else if (button.hasAttribute("data-block-zoom")) {
      zoom(block);
    } else if (await copyText(blockText(block))) {
      confirmCopied(button, button.querySelector("[data-code-copy-label]"));
    } else showToast?.(ui("当前环境不支持复制"));
  });
  // Diagrams are drawn after their block lands in the page, wherever that is.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      drawPendingDiagrams(root);
    });
  };
  const target = root.body || root;
  new MutationObserver(schedule).observe(target, { childList: true, subtree: true });
  new MutationObserver(schedule).observe(document.documentElement, { attributeFilter: ["data-theme"] });
  schedule();
}
