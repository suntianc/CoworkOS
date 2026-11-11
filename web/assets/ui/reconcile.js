// Patch only changed nodes. Stable disclosure, text and animation nodes keep
// their focus, reading position and animation phase during streaming updates.
const key = (node) =>
  node.nodeType === 1
    ? node.getAttribute("data-view-key") ||
      node.getAttribute("data-activity-key") ||
      node.getAttribute("data-history-key") ||
      node.getAttribute("data-recovery-task") ||
      ""
    : "";
const matches = (left, right) =>
  left && left.nodeType === right.nodeType && left.nodeName === right.nodeName && key(left) === key(right);

function patchChildren(parent, source) {
  let current = parent.firstChild;
  for (const next of [...source.childNodes]) {
    if (!matches(current, next)) {
      const found = key(next) && [...parent.childNodes].find((node) => matches(node, next));
      if (found) parent.insertBefore(found, current);
      else parent.insertBefore(next.cloneNode(true), current);
      current = found || (current ? current.previousSibling : parent.lastChild);
    }
    patchNode(current, next);
    current = current.nextSibling;
  }
  while (current) {
    const next = current.nextSibling;
    current.remove();
    current = next;
  }
}

function patchNode(node, source) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== source.nodeValue) node.nodeValue = source.nodeValue;
    return;
  }
  // A rich block whose source is unchanged keeps what the reader did with it
  // (wrap, view, expanded rows) and what the page drew into it (a diagram).
  const owned = node.getAttribute("data-ui-owned");
  if (owned && owned === source.getAttribute("data-ui-owned")) return;
  const keepOpen = node.nodeName === "DETAILS" && node.hasAttribute("data-activity-key");
  for (const attribute of [...node.attributes]) {
    if (keepOpen && attribute.name === "open") continue;
    if (!source.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
  }
  for (const attribute of [...source.attributes]) {
    if (node.getAttribute(attribute.name) !== attribute.value)
      node.setAttribute(attribute.name, attribute.value);
  }
  patchChildren(node, source);
}

export function reconcileMarkup(parent, markup) {
  const template = parent.ownerDocument.createElement("template");
  template.innerHTML = markup;
  patchChildren(parent, template.content);
}
