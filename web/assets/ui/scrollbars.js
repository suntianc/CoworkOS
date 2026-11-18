import { animate } from "./motion.js";

/**
 * Shows an area's scrollbar while the person scrolls it and fades it out a
 * moment after (`styles/scrollbars.css` reads `--scroll-reveal`, 0–1).
 *
 * Only scrolling the person caused reveals it: a panel opening beside the
 * conversation reflows it and moves its scroll position without anyone
 * touching it, and that must not flash a scrollbar. A scroll counts when it
 * follows a wheel, touch or scroll key within INPUT_MS, or happens while a
 * pointer is held down (dragging the scrollbar).
 *
 * The fade runs through the Web Animations API on a registered,
 * non-inheriting custom property, so it never replaces an element's own CSS
 * transitions or animations and a nested area keeps its own value. Scroll
 * events do not bubble; one capturing listener on the document sees every area.
 */
const SETTLE_MS = 900;
const INPUT_MS = 1000;
const FADE_IN_MS = 120;
const FADE_OUT_MS = 360;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function revealScrollbarsWhileScrolling(doc = document) {
  const view = doc.defaultView;
  const timers = new WeakMap();
  const fades = new WeakMap();
  let inputAt = -Infinity;
  let pressed = false;

  const fade = (area, to, duration) => {
    const from = Number(view.getComputedStyle(area).getPropertyValue("--scroll-reveal")) || 0;
    fades.get(area)?.cancel();
    if (from === to) {
      area.style.setProperty("--scroll-reveal", String(to));
      return;
    }
    area.style.setProperty("--scroll-reveal", String(to));
    fades.set(
      area,
      animate(area, [{ "--scroll-reveal": from }, { "--scroll-reveal": to }], {
        duration: duration * Math.abs(to - from),
        easing: "ease-out"
      })
    );
  };

  const touched = () => {
    inputAt = view.performance.now();
  };
  for (const type of ["wheel", "touchmove"])
    doc.addEventListener(type, touched, { capture: true, passive: true });
  doc.addEventListener(
    "keydown",
    (event) => {
      if (SCROLL_KEYS.has(event.key)) touched();
    },
    { capture: true, passive: true }
  );
  // A press counts only while it is held, which is how a scrollbar is
  // dragged: the click that opens a panel ends before the reflow it causes.
  doc.addEventListener("pointerdown", () => (pressed = true), { capture: true, passive: true });
  for (const type of ["pointerup", "pointercancel"])
    doc.addEventListener(type, () => (pressed = false), { capture: true, passive: true });

  doc.addEventListener(
    "scroll",
    (event) => {
      const area = event.target === doc ? doc.scrollingElement : event.target;
      if (!(area instanceof view.Element)) return;
      const byPerson = pressed || view.performance.now() - inputAt < INPUT_MS;
      if (!byPerson && !timers.has(area)) return;
      if (!timers.has(area)) fade(area, 1, FADE_IN_MS);
      clearTimeout(timers.get(area));
      timers.set(
        area,
        setTimeout(() => {
          timers.delete(area);
          fade(area, 0, FADE_OUT_MS);
        }, SETTLE_MS)
      );
    },
    { capture: true, passive: true }
  );
}
