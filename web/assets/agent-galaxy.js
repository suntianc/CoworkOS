import { createOrbitLayout, isWorking } from "./agent-room.js";
import {
  createGalaxyPainter,
  DEFAULT_GALAXY_VIEW,
  galaxyCamera,
  orbitalPoint,
  projectGalaxyPoint
} from "./galaxy-space.js";

const TAU = Math.PI * 2;

export function createAgentGalaxy(root, { onSelect, nameFor, stateFor, keyFor }) {
  root.innerHTML = `<canvas class="galaxy-canvas" aria-hidden="true"></canvas>
    <svg class="galaxy-guides" aria-hidden="true"><path></path></svg>
    <div class="galaxy-eyebrow" aria-hidden="true"><span>FORMICAND <b>GALAXY</b></span><span class="galaxy-count"></span></div>
    <div class="galaxy-system"></div>`;
  let canvas = root.querySelector("canvas");
  const system = root.querySelector(".galaxy-system");
  const guide = root.querySelector(".galaxy-guides path");
  const painter = createGalaxyPainter(canvas, requestRender);
  canvas = painter.canvas;
  root.dataset.renderer = painter.type;
  root.dataset.particles = String(painter.particleCount);
  const nodes = new Map();
  let taskKey,
    selected = "main",
    hovered;
  let layout = createOrbitLayout();
  let width = 0,
    height = 0,
    tilt = DEFAULT_GALAXY_VIEW.tilt,
    roll = DEFAULT_GALAXY_VIEW.roll;
  let frame = 0,
    elapsed = 0,
    lastTick = 0,
    lastPaint = 0,
    dirty = true;
  let visible = true,
    pageActive = true,
    pointerInside = false,
    dragging = null,
    disposed = false;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const forcedColors = matchMedia("(forced-colors: active)");
  const motionAllowed = () =>
    !forcedColors.matches &&
    (document.documentElement.dataset.skyMotion
      ? document.documentElement.dataset.skyMotion === "running"
      : !reducedMotion.matches);
  const isVisible = () => !disposed && visible && pageActive && !document.hidden && width > 0 && height > 0;

  function requestRender() {
    dirty = true;
    if (!frame && isVisible()) frame = requestAnimationFrame(tick);
  }
  function suspend() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTick = 0;
  }
  function tick(now) {
    frame = 0;
    if (!isVisible()) {
      lastTick = 0;
      return;
    }
    const moving = motionAllowed();
    const delta = moving && lastTick ? Math.min((now - lastTick) / 1000, 0.1) : 0;
    lastTick = now;
    elapsed += delta;
    if (!pointerInside && !dragging && !root.contains(document.activeElement)) {
      for (const node of nodes.values())
        if (node.orbit && node.working) node.angle = (node.angle + (delta * TAU) / node.orbit.period) % TAU;
    }
    // Limit painting and DOM projection to 30 fps. The scene sleeps completely
    // when hidden, offscreen or paused, and resumes without elapsed-time jumps.
    if (dirty || now - lastPaint >= (painter.type === "webgl" ? 32 : 65)) {
      paint();
      lastPaint = now;
      dirty = false;
    }
    if (moving) frame = requestAnimationFrame(tick);
    else lastTick = 0;
  }
  function paint() {
    const camera = galaxyCamera(width, height, tilt, roll);
    const stars = [],
      labels = [];
    for (const [key, node] of nodes) {
      const point = node.orbit ? orbitalPoint(node.orbit, node.angle) : { x: 0, y: 0, z: 0 };
      const position = projectGalaxyPoint(point, camera);
      node.button.style.left = `${position.x.toFixed(2)}px`;
      node.button.style.top = `${position.y.toFixed(2)}px`;
      node.button.style.zIndex = String(5 + Math.round((position.depth + 1.5) * 10));
      const main = !node.orbit;
      const highlight = key === selected || key === hovered;
      const color = node.color;
      stars.push({
        ...point,
        color,
        alpha: node.dim ? 0.72 : 1,
        size: main ? 72 : highlight ? 44 : 36,
        phase: main ? 0 : node.orbit.slot,
        kind: 2
      });
      stars.push({
        ...point,
        color: main ? [0.68, 0.72, 0.78] : color,
        alpha: main ? 0.12 : highlight ? 0.1 : 0.05,
        size: main ? 96 : highlight ? 56 : 48,
        phase: 0,
        kind: 0
      });
      labels.push({ node, position, main, highlight });
    }
    painter.draw(camera, elapsed, stars);
    // Keep every name visible. Move labels around crowded stars rather than
    // hiding all unselected members when the team grows past seven agents.
    const occupied = [];
    for (const { node, position, main, highlight } of labels.sort(
      (a, b) => Number(b.main) - Number(a.main) || Number(b.highlight) - Number(a.highlight)
    )) {
      const w = main ? 116 : Math.max(66, Math.min(112, node.name.textContent.length * 7 + 14));
      const h = 24;
      const distance = main ? 41 : 30;
      const offsets = [
        [0, distance],
        [0, -distance],
        [w / 2 + 29, 0],
        [-w / 2 - 29, 0],
        [0, distance + 38],
        [0, -distance - 38]
      ];
      const candidates = offsets.map(([x, y]) => {
        const cx = Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, position.x + x));
        const cy = Math.max(53 + h / 2, Math.min(height - 38 - h / 2, position.y + y));
        const box = { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
        const overlap = occupied.reduce(
          (sum, other) =>
            sum +
            Math.max(0, Math.min(box.right, other.right) - Math.max(box.left, other.left)) *
              Math.max(0, Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top)),
          0
        );
        return { box, cx, cy, overlap };
      });
      const chosen =
        candidates.find((candidate) => candidate.overlap === 0) ||
        candidates.sort((a, b) => a.overlap - b.overlap)[0];
      occupied.push(chosen.box);
      node.button.style.setProperty("--label-x", `${(chosen.cx - position.x).toFixed(1)}px`);
      node.button.style.setProperty("--label-y", `${(chosen.cy - position.y).toFixed(1)}px`);
    }
    const focused = nodes.get(hovered || selected);
    const orbit = focused?.orbit;
    guide.setAttribute(
      "d",
      orbit
        ? Array.from({ length: 81 }, (_, i) => {
            const p = projectGalaxyPoint(orbitalPoint(orbit, (i / 80) * TAU), camera);
            return `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
          }).join(" ")
        : ""
    );
  }
  function resize() {
    const box = root.getBoundingClientRect();
    width = root.clientWidth;
    height = root.clientHeight;
    const density = Math.min(devicePixelRatio || 1, 1.75);
    const nextWidth = Math.max(1, Math.round(width * density));
    const nextHeight = Math.max(1, Math.round(height * density));
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
    visible = box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    if (!isVisible()) suspend();
    else requestRender();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(root);
  const intersection = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) requestRender();
    else suspend();
  });
  intersection.observe(root);
  const motionObserver = new MutationObserver(() => {
    suspend();
    requestRender();
  });
  motionObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-sky-motion", "data-theme"]
  });
  function visibilityChange() {
    suspend();
    if (!document.hidden) requestRender();
  }
  function pageHide() {
    pageActive = false;
    suspend();
  }
  function pageShow() {
    pageActive = true;
    resize();
  }
  function preferenceChange() {
    suspend();
    requestRender();
  }
  document.addEventListener("visibilitychange", visibilityChange);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  reducedMotion.addEventListener("change", preferenceChange);
  forcedColors.addEventListener("change", preferenceChange);

  function pointerEnter() {
    pointerInside = true;
  }
  function pointerLeave() {
    pointerInside = false;
    hovered = null;
    requestRender();
  }
  function pointerDown(event) {
    if (event.button !== 0 || event.target.closest("button") || event.pointerType === "touch") return;
    dragging = { x: event.clientX, y: event.clientY, tilt, roll, id: event.pointerId };
    root.setPointerCapture(event.pointerId);
    root.classList.add("dragging");
  }
  function pointerMove(event) {
    if (!dragging) return;
    roll = dragging.roll + (event.clientX - dragging.x) * 0.007;
    tilt = Math.max(-1.18, Math.min(1.18, dragging.tilt + (event.clientY - dragging.y) * 0.008));
    requestRender();
  }
  function pointerUp(event) {
    if (!dragging) return;
    if (root.hasPointerCapture(dragging.id)) root.releasePointerCapture(dragging.id);
    dragging = null;
    root.classList.remove("dragging");
    pointerInside = root.matches(":hover");
    requestRender();
  }
  const listeners = {
    pointerenter: pointerEnter,
    pointerleave: pointerLeave,
    pointerdown: pointerDown,
    pointermove: pointerMove,
    pointerup: pointerUp,
    pointercancel: pointerUp,
    lostpointercapture: pointerUp
  };
  for (const [event, listener] of Object.entries(listeners)) root.addEventListener(event, listener);
  const update = ({ task, members, selected: nextSelected }) => {
    selected = nextSelected;
    if (taskKey !== task) {
      taskKey = task;
      layout = createOrbitLayout();
      nodes.clear();
      system.replaceChildren();
      guide.setAttribute("d", "");
      hovered = null;
    }
    const orbits = new Map(layout(members).map((orbit) => [keyFor(orbit.member), orbit]));
    const keys = new Set(members.map(keyFor));
    for (const [key, node] of nodes)
      if (!keys.has(key)) {
        node.button.remove();
        nodes.delete(key);
      }
    for (const member of members) {
      const key = keyFor(member);
      const main = member.__main || member.agentId === "main";
      let node = nodes.get(key);
      if (!node) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `galaxy-star galaxy-star-${main ? "main" : "satellite"}`;
        button.dataset.agent = key;
        button.innerHTML = '<span class="star-label"><strong></strong></span>';
        button.addEventListener("click", () => onSelect(key));
        button.addEventListener("pointerenter", () => {
          hovered = key;
          requestRender();
        });
        button.addEventListener("pointerleave", () => {
          hovered = null;
          requestRender();
        });
        const orbit = orbits.get(key);
        node = {
          button,
          orbit,
          angle: orbit ? (-orbit.delay / orbit.period) * TAU : 0,
          name: button.querySelector("strong"),
          color: [0.95, 0.96, 1]
        };
        button.style.setProperty(
          "--node-base-color",
          `rgb(${node.color.map((value) => Math.round(value * 255)).join(" ")})`
        );
        nodes.set(key, node);
        system.append(button);
      }
      const name = nameFor(member),
        status = stateFor(member.status);
      node.working = isWorking(member);
      node.dim = ["cancelled", "interrupted"].includes(member.status);
      node.button.dataset.status = member.status || "idle";
      node.button.classList.toggle("working", node.working);
      node.button.classList.toggle("selected", selected === key);
      node.button.setAttribute("aria-pressed", String(selected === key));
      node.button.setAttribute("aria-label", `查看 ${name} 的执行轨迹`);
      node.button.setAttribute("aria-description", `${main ? "主智能体 · " : ""}${status}`);
      node.button.title = name;
      if (node.name.textContent !== name) node.name.textContent = name;
    }
    root.querySelector(".galaxy-count").textContent =
      `${members.length} ${members.length === 1 ? "STAR" : "STARS"}`;
    requestRender();
  };
  update.destroy = () => {
    disposed = true;
    suspend();
    painter.destroy();
    resizeObserver.disconnect();
    intersection.disconnect();
    motionObserver.disconnect();
    document.removeEventListener("visibilitychange", visibilityChange);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
    reducedMotion.removeEventListener("change", preferenceChange);
    forcedColors.removeEventListener("change", preferenceChange);
    for (const [event, listener] of Object.entries(listeners)) root.removeEventListener(event, listener);
  };
  resize();
  return update;
}
