/**
 * Motion shared by the page (#12). The durations and curves live as tokens in
 * formicand.css (`--motion-*`, `--ease-*`); this module reads the reduced
 * motion choice and moves a selection's background between options.
 */

/** Settings can force reduced motion on or off; otherwise the system decides. */
export function reducedMotion() {
  const choice = document.documentElement.dataset.reducedMotion;
  if (choice === "reduce") return true;
  if (choice === "off") return false;
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** A token's duration in milliseconds, so scripted motion keeps the CSS timing. */
export function motionDuration(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return value.endsWith("ms") ? number : number * 1000;
}

/**
 * Where a selection glides. `host` scopes the options and stays in the page
 * while its rows re-render; `item` is the selected option's visible surface;
 * `key` tells options apart across re-renders; `layer` is the stable ancestor
 * the moving surface is drawn in (the host unless its children are replaced
 * wholesale); `clip` skips the glide when either end is scrolled out of the
 * host.
 */
export const SELECTION_GROUPS = [
  {
    name: "segmented",
    host: ".ui-segmented, .settings-segmented",
    item: ':is(.ui-segmented, .settings-segmented) > :is([aria-selected="true"], [aria-checked="true"], [aria-pressed="true"])'
  },
  { name: "settings-nav", host: ".settings-nav-items", item: '.settings-nav-item[aria-current="page"]' },
  { name: "observe-views", host: ".observe-views", item: '.nav-item[aria-current="page"]' },
  {
    name: "observe-filter",
    host: ".observe-group",
    item: '.observe-item[aria-pressed="true"]',
    key: (node) => node.dataset.observeNode || node.dataset.observeProject || node.textContent
  },
  {
    name: "requirement-tabs",
    host: ".observe-tabs",
    item: '.or-tab[aria-selected="true"]',
    layer: (host) => host.parentElement,
    key: (node) => node.dataset.observeTab
  },
  {
    name: "conversations",
    host: "#project-list",
    item: ".conversation-row:has(> .conversation-item.active)",
    layer: (host) => host.parentElement,
    key: (node) => node.querySelector(".conversation-item")?.dataset.task,
    clip: true
  }
];

const TRIGGER_KEYS = new Set([
  "Enter",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End"
]);
// A selection that follows a click may wait on a request before the row
// re-renders; past this the change is not the click's and appears in place.
const WATCH_MS = 900;
const COPIED = [
  "backgroundColor",
  "backgroundImage",
  "boxShadow",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderStyle",
  "borderWidth",
  "borderColor",
  "outlineStyle",
  "outlineWidth",
  "outlineColor",
  "outlineOffset"
];

const lerp = (from, to, share) => from + (to - from) * share;

/** The surface at a moment between two rects, its leading edge ahead of its trailing one. */
function stretched(from, to) {
  const axis = (start, end, size) => {
    const forward = to[start] + to[size] / 2 >= from[start] + from[size] / 2;
    const near = lerp(from[start], to[start], forward ? 0.3 : 0.8);
    const far = lerp(from[start] + from[size], to[start] + to[size], forward ? 0.8 : 0.3);
    return [near, Math.max(far - near, Math.min(from[size], to[size]))];
  };
  const [x, width] = axis("x", "x", "width");
  const [y, height] = axis("y", "y", "height");
  return { x, y, width, height };
}

const frame = ({ x, y, width, height }, origin) => ({
  transform: `translate(${x - origin.x}px, ${y - origin.y}px)`,
  width: `${width}px`,
  height: `${height}px`
});

const inside = (rect, bounds) =>
  rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && rect.height > 0;

/**
 * Moves the selected option's background to the next option instead of
 * letting it jump. Only a user's click or key starts a glide; selections the
 * page makes itself, and any selection under reduced motion, appear in place.
 * The real option keeps its own selected style; it is hidden only while the
 * moving copy is in flight, so a re-render in the middle never loses it.
 */
export function installSelectionGlide({ root = document, groups = SELECTION_GROUPS } = {}) {
  const style = document.createElement("style");
  style.dataset.selectionGlide = "";
  style.textContent = groups
    .map(
      (group) =>
        `[data-gliding~="${group.name}"] :is(${group.item}) { background: transparent !important; box-shadow: none !important; border-color: transparent !important; outline-color: transparent !important; transition: none !important; }`
    )
    .join("\n");
  document.head.append(style);
  const flights = new Map();
  const keyOf = (group, node) => (group.key ? group.key(node) : node);
  const selected = (group, host) =>
    [...host.querySelectorAll(group.item)].find((node) => node.closest(group.host) === host);

  function settle(host, group) {
    const flight = flights.get(host);
    if (!flight) return;
    flights.delete(host);
    flight.ghost.remove();
    const names = (host.dataset.gliding || "").split(" ").filter((name) => name && name !== group.name);
    if (names.length) host.dataset.gliding = names.join(" ");
    else delete host.dataset.gliding;
  }

  function glide(group, host, from, target) {
    const layer = group.layer?.(host) || host;
    const to = target.getBoundingClientRect();
    if (group.clip) {
      const bounds = host.getBoundingClientRect();
      if (!inside(from, bounds) || !inside(to, bounds)) return;
    }
    if (!to.width || !to.height || (from.x === to.x && from.y === to.y)) return;
    const look = getComputedStyle(target);
    const ghost = document.createElement("div");
    ghost.className = "selection-glide";
    ghost.setAttribute("aria-hidden", "true");
    for (const property of COPIED) ghost.style[property] = look[property];
    layer.prepend(ghost);
    const origin = ghost.getBoundingClientRect();
    host.dataset.gliding = [host.dataset.gliding, group.name].filter(Boolean).join(" ");
    const animation = ghost.animate(
      [frame(from, origin), frame(stretched(from, to), origin), frame(to, origin)],
      {
        duration: motionDuration("--motion-glide", 280),
        easing:
          getComputedStyle(document.documentElement).getPropertyValue("--ease-glide").trim() || "ease-out",
        fill: "both"
      }
    );
    flights.set(host, { ghost, animation });
    const done = () => {
      if (flights.get(host)?.animation === animation) settle(host, group);
    };
    animation.finished.then(done, done);
  }

  function watch(group, host) {
    const flight = flights.get(host);
    const current = selected(group, host);
    // A second choice mid-flight starts where the moving surface is now.
    const from = flight ? flight.ghost.getBoundingClientRect() : current?.getBoundingClientRect();
    if (!from || !current) return;
    const before = keyOf(group, current);
    const until = performance.now() + WATCH_MS;
    const check = () => {
      if (!host.isConnected) return;
      const next = selected(group, host);
      if (next && keyOf(group, next) !== before) {
        if (flights.has(host)) {
          flights.get(host).animation.cancel();
          settle(host, group);
        }
        glide(group, host, from, next);
      } else if (performance.now() < until) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  const start = (event) => {
    if (event.type === "keydown" && !TRIGGER_KEYS.has(event.key)) return;
    if (event.type === "pointerdown" && event.button !== 0) return;
    if (reducedMotion() || !event.target?.closest) return;
    for (const group of groups) {
      const host = event.target.closest(group.host);
      if (host) watch(group, host);
    }
  };
  root.addEventListener("pointerdown", start, true);
  root.addEventListener("keydown", start, true);
  return {
    destroy() {
      root.removeEventListener("pointerdown", start, true);
      root.removeEventListener("keydown", start, true);
      style.remove();
    }
  };
}

let layoutTimer;
/**
 * Runs a change that opens or closes the sidebar or the side panel (`part`)
 * with the grid easing between its columns. The columns only animate inside
 * this window, so a divider being dragged or a window being resized still
 * follows at once.
 */
export function animateLayout(change, { part, body = document.body } = {}) {
  if (reducedMotion()) {
    change();
    window.dispatchEvent(new Event("resize"));
    return;
  }
  clearTimeout(layoutTimer);
  body.dataset.layoutAnimating = part;
  change();
  layoutTimer = setTimeout(
    () => {
      delete body.dataset.layoutAnimating;
      window.dispatchEvent(new Event("resize"));
    },
    motionDuration("--motion-layout", 240) + 40
  );
}
