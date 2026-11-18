const blocks = new Set([
  "ADDRESS",
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
  "SECTION",
  "TR"
]);
const ignored = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** A template's inert contents never enter the document or load clipboard resources. */
export function clipboardHtmlText(html, document) {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  let text = "";
  const newline = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const visit = (node) => {
    if (node.nodeType === 3) {
      text += node.textContent;
      return;
    }
    if (ignored.has(node.tagName)) return;
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    if (blocks.has(node.tagName)) newline();
    for (const child of node.childNodes) visit(child);
    if (blocks.has(node.tagName)) newline();
  };
  visit(template.content);
  return text.trim() ? text.replace(/\n$/, "") : "";
}

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * A pasted screenshot arrives as `image.png` every time, so two of them read
 * as one file to the person and to Main, and pasting the same picture again
 * looked like adding a file that is already there. Each such image gets the
 * next number the draft has not used: `image-1.png`, `image-2.png`. A copied
 * file that has a name of its own keeps it.
 */
export function numberPastedImages(images, attachedNames) {
  const used = new Set(
    attachedNames.map((name) => Number(/^image-(\d+)\.[a-z]+$/.exec(name)?.[1])).filter(Boolean)
  );
  let next = 1;
  return images.map((image) => {
    // A copied file keeps its own name; only the browser's generic name for
    // clipboard picture data is replaced.
    if (image.name && !/^image\.[a-z0-9]+$/i.test(image.name)) return image;
    while (used.has(next)) next += 1;
    used.add(next);
    const extension = EXTENSIONS[image.type] || image.type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png";
    return new File([image], `image-${next}.${extension}`, {
      type: image.type,
      lastModified: image.lastModified
    });
  });
}

/** Prefer editable text over a rich-text source's image representation. */
export function createComposerClipboard({ input, addFiles, attachedNames = () => [] }) {
  const paste = (event) => {
    if (event.defaultPrevented || event.clipboardData?.getData("text/plain")) return;
    const text = clipboardHtmlText(event.clipboardData?.getData("text/html"), input.ownerDocument);
    if (text) {
      event.preventDefault();
      input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const images = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!images.length) return;
    event.preventDefault();
    void addFiles(numberPastedImages(images, attachedNames()));
  };
  input.addEventListener("paste", paste);
  return { dispose: () => input.removeEventListener("paste", paste) };
}
