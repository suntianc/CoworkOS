/**
 * Marks an area `is-scrolling` while it scrolls and for a moment after, so
 * its scrollbar shows only then (`styles/scrollbars.css`). Scroll events do
 * not bubble; one capturing listener on the document sees every area.
 */
const SETTLE_MS = 900;

export function revealScrollbarsWhileScrolling(doc = document) {
  const timers = new WeakMap();
  doc.addEventListener(
    "scroll",
    (event) => {
      const area = event.target === doc ? doc.scrollingElement : event.target;
      if (!(area instanceof Element)) return;
      area.classList.add("is-scrolling");
      clearTimeout(timers.get(area));
      timers.set(
        area,
        setTimeout(() => area.classList.remove("is-scrolling"), SETTLE_MS)
      );
    },
    { capture: true, passive: true }
  );
}
