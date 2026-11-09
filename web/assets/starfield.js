// Static stars paint on resize. Meteor wakes render at 30 fps only during
// bounded showers; the canvas sleeps completely between them.
function startNightSky() {
  const sky = document.querySelector("#night-sky");
  const canvas = document.querySelector("#starfield-background");
  const context = canvas?.getContext("2d");
  const toggle = document.querySelector("#starfield-motion-toggle");
  const description = document.querySelector("#starfield-motion-description");
  if (!sky || !context) return;
  const meteorCanvas = document.createElement("canvas");
  meteorCanvas.className = "meteor-canvas";
  meteorCanvas.setAttribute("aria-hidden", "true");
  sky.append(meteorCanvas);
  const brush = meteorCanvas.getContext("2d");
  if (!brush) return;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const forcedColors = matchMedia("(forced-colors: active)");
  const preferenceKey = "atria.background.motion";
  let preference = null;
  try {
    const saved = localStorage.getItem(preferenceKey) ?? localStorage.getItem("atria.galaxy.motion");
    if (saved === "on" || saved === "off") preference = saved;
    // eslint-disable-next-line no-restricted-syntax -- 受限环境读取 localStorage 抛出，动效偏好退化为跟随系统设置
  } catch {
    /* Session-only preference. */
  }
  const motionEnabled = () =>
    !forcedColors.matches && (preference ? preference === "on" : !reducedMotion.matches);
  let pageActive = true;
  const canAnimate = () => motionEnabled() && pageActive && !document.hidden;
  let timer = 0,
    frame = 0,
    lastPaint = 0;
  let meteors = [],
    firstShower = true;
  let width = 0,
    height = 0,
    density = 0,
    palette = "";
  const isLight = () => document.documentElement.dataset.theme === "light";
  let seed = 92417;
  const randomStar = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const stars = Array.from({ length: 560 }, () => {
    const x = randomStar(),
      y = randomStar(),
      depth = randomStar(),
      tint = randomStar();
    const bright = depth > 0.86;
    return {
      x,
      y,
      bright,
      radius: bright ? 1.55 + randomStar() * 1.05 : 0.45 + Math.pow(randomStar(), 2) * 0.85,
      alpha: bright ? 0.88 + randomStar() * 0.12 : 0.38 + randomStar() * 0.4,
      color: tint < 0.14 ? "255, 195, 148" : tint < 0.4 ? "157, 206, 239" : "221, 230, 245"
    };
  });

  function paintStars() {
    const nextWidth = window.innerWidth,
      nextHeight = window.innerHeight;
    const nextDensity = Math.min(window.devicePixelRatio || 1, 1.5);
    const nextPalette = isLight() ? "light" : "dark";
    if (width === nextWidth && height === nextHeight && density === nextDensity && palette === nextPalette)
      return;
    palette = nextPalette;
    width = nextWidth;
    height = nextHeight;
    density = nextDensity;
    for (const target of [canvas, meteorCanvas]) {
      target.width = Math.round(width * density);
      target.height = Math.round(height * density);
    }
    context.setTransform(density, 0, 0, density, 0, 0);
    brush.setTransform(density, 0, 0, density, 0, 0);
    const count = Math.min(stars.length, Math.max(100, Math.round((width * height) / 2700)));
    for (const star of stars.slice(0, count)) {
      const x = star.x * width,
        y = star.y * height;
      const color = isLight() ? (star.color.startsWith("255") ? "133, 86, 99" : "68, 83, 143") : star.color;
      const centre = isLight() ? color : "255, 253, 248";
      if (star.bright || star.radius > 1) {
        // A white-hot centre with a wide, faint coloured halo gives the bright
        // stars photographic bloom while leaving most of the sky black.
        const radius = star.radius * (star.bright ? 7.5 : 4);
        const glow = context.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, `rgba(${color}, ${star.alpha * 0.5})`);
        glow.addColorStop(0.15, `rgba(${color}, ${star.alpha * 0.26})`);
        glow.addColorStop(0.42, `rgba(${color}, ${star.alpha * 0.075})`);
        glow.addColorStop(1, `rgba(${color}, 0)`);
        context.fillStyle = glow;
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      const core = context.createRadialGradient(x, y, 0, x, y, star.radius);
      core.addColorStop(0, `rgba(${centre}, ${star.alpha})`);
      core.addColorStop(
        0.4,
        `rgba(${isLight() ? color : star.bright ? "250, 249, 247" : color}, ${star.alpha})`
      );
      core.addColorStop(1, `rgba(${color}, ${star.alpha * 0.12})`);
      context.fillStyle = core;
      context.beginPath();
      context.arc(x, y, star.radius, 0, Math.PI * 2);
      context.fill();
    }
  }
  function clearShower() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastPaint = 0;
    meteors = [];
    brush.clearRect(0, 0, width, height);
    sky.dataset.phase = "quiet";
    sky.dataset.meteors = "0";
  }
  function scheduleShower() {
    if (!canAnimate() || timer || meteors.length) return;
    timer = window.setTimeout(
      launchShower,
      firstShower ? 3500 + Math.random() * 3000 : 9000 + Math.random() * 6000
    );
  }
  function launchShower() {
    timer = 0;
    if (!canAnimate()) return;
    firstShower = false;
    const bounds = document.querySelector(".chat-pane")?.getBoundingClientRect();
    const left = bounds?.left || 0,
      availableWidth = bounds?.width || width;
    const count = (width < 700 ? 6 : 9) + Math.floor(Math.random() * 4);
    const now = performance.now(),
      radiant = 2.35 + Math.random() * 0.12;
    // Common radiant; independent depth, speed, onset and burn-out.
    meteors = Array.from({ length: count }, (_, index) => {
      const near = index % 4 === 0;
      const angle = radiant + (Math.random() - 0.5) * 0.17;
      return {
        born: now + (index === 0 ? 0 : 180 + Math.random() * 2350),
        x: left + availableWidth * (0.2 + Math.random() * 1.1),
        y: Math.max(65, height * (0.09 + Math.random() * 0.4)),
        dx: Math.cos(angle),
        dy: Math.sin(angle),
        speed:
          Math.min(780, Math.max(380, availableWidth * 1.1)) * (near ? 1.12 : 0.65 + Math.random() * 0.35),
        burn: 0.85 + Math.random() * 0.7,
        wake: near ? 0.62 : 0.32 + Math.random() * 0.17,
        thickness: near ? 1.65 : 0.7 + Math.random() * 0.5,
        alpha: near ? 0.94 : 0.48 + Math.random() * 0.28,
        phase: Math.random() * Math.PI * 2
      };
    });
    sky.dataset.phase = "meteor";
    sky.dataset.meteors = String(meteors.length);
    frame = requestAnimationFrame(paintShower);
  }
  function paintMeteor(meteor, age) {
    if (age <= 0) return;
    const end = Math.min(age, meteor.burn),
      start = Math.max(0, age - meteor.wake);
    if (end <= start) return;
    const position = (time, drift = 0) => {
      const travel = meteor.speed * (time + 0.13 * time * time);
      return {
        x: meteor.x + meteor.dx * travel - meteor.dy * drift,
        y: meteor.y + meteor.dy * travel + meteor.dx * drift
      };
    };
    // Light remains at its emission position and disperses after the head
    // burns out. A tapered wake grows and disappears instead of sliding whole.
    for (let i = 0; i < 32; i++) {
      const t = end - ((end - start) * i) / 32,
        next = end - ((end - start) * (i + 1)) / 32;
      const wakeAge = (age - t) / meteor.wake,
        fresh = Math.max(0, 1 - wakeAge);
      const burn = Math.pow(Math.max(0, Math.sin((Math.PI * t) / meteor.burn)), 0.45);
      const alpha = meteor.alpha * burn * fresh * fresh;
      const drift = Math.sin(t * 23 + meteor.phase) * wakeAge * wakeAge * 1.1;
      const a = position(t, drift),
        b = position(next, drift);
      brush.beginPath();
      brush.moveTo(a.x, a.y);
      brush.lineTo(b.x, b.y);
      brush.lineWidth = meteor.thickness * (1 + wakeAge * 4);
      brush.strokeStyle = `rgba(200, 181, 168, ${alpha * 0.16})`;
      brush.stroke();
      brush.lineWidth = Math.max(0.25, meteor.thickness * (0.18 + fresh * 0.82));
      brush.strokeStyle = `rgba(${isLight() ? "89, 83, 139" : "244, 237, 229"}, ${alpha})`;
      brush.stroke();
    }
    if (age >= meteor.burn) return;
    const point = position(age),
      strength = Math.pow(Math.sin((Math.PI * age) / meteor.burn), 0.45) * meteor.alpha;
    brush.save();
    brush.translate(point.x, point.y);
    brush.rotate(Math.atan2(meteor.dy, meteor.dx));
    const halo = brush.createRadialGradient(0, 0, 0, 0, 0, 9);
    halo.addColorStop(0, `rgba(255, 243, 225, ${strength * 0.52})`);
    halo.addColorStop(0.25, `rgba(236, 220, 204, ${strength * 0.16})`);
    halo.addColorStop(1, "rgba(236, 220, 204, 0)");
    brush.fillStyle = halo;
    brush.fillRect(-9, -9, 18, 18);
    brush.fillStyle = `rgba(255, 251, 243, ${strength})`;
    brush.beginPath();
    brush.ellipse(-1.5, 0, meteor.thickness * 3.2, meteor.thickness * 0.7, 0, 0, Math.PI * 2);
    brush.fill();
    brush.restore();
  }
  function paintShower(now) {
    frame = 0;
    if (!canAnimate()) {
      clearShower();
      return;
    }
    if (now - lastPaint >= 32) {
      lastPaint = now;
      brush.clearRect(0, 0, width, height);
      brush.globalCompositeOperation = isLight() ? "source-over" : "lighter";
      brush.lineCap = "round";
      meteors = meteors.filter((meteor) => (now - meteor.born) / 1000 < meteor.burn + meteor.wake);
      for (const meteor of meteors) paintMeteor(meteor, (now - meteor.born) / 1000);
      brush.globalCompositeOperation = "source-over";
      sky.dataset.meteors = String(meteors.length);
    }
    if (meteors.length) frame = requestAnimationFrame(paintShower);
    else {
      sky.dataset.phase = "quiet";
      scheduleShower();
    }
  }
  function syncMotion() {
    window.clearTimeout(timer);
    timer = 0;
    clearShower();
    sky.dataset.motion = canAnimate() ? "running" : "paused";
    document.documentElement.dataset.skyMotion = sky.dataset.motion;
    if (toggle) {
      toggle.disabled = forcedColors.matches;
      toggle.setAttribute("aria-checked", String(motionEnabled()));
    }
    if (description)
      description.textContent = forcedColors.matches
        ? "跟随系统高对比度设置"
        : motionEnabled()
          ? "流星雨划过夜空，协作星缓慢公转"
          : !preference && reducedMotion.matches
            ? "已跟随系统减少动态效果"
            : "已暂停流星雨与公转，保留静谧夜空";
    if (pageActive && !document.hidden) paintStars();
    scheduleShower();
  }
  toggle?.addEventListener("click", () => {
    preference = motionEnabled() ? "off" : "on";
    try {
      localStorage.setItem(preferenceKey, preference);
      // eslint-disable-next-line no-restricted-syntax -- 存储被禁用或已满时 setItem 抛出，本次会话内偏好仍然生效
    } catch {
      /* Session-only preference. */
    }
    syncMotion();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    preference = event.newValue === "on" || event.newValue === "off" ? event.newValue : null;
    syncMotion();
  });
  window.addEventListener("resize", paintStars, { passive: true });
  window.addEventListener("atria:appearance", () => {
    paintStars();
    clearShower();
    scheduleShower();
  });
  reducedMotion.addEventListener("change", syncMotion);
  forcedColors.addEventListener("change", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
  window.addEventListener("pagehide", () => {
    pageActive = false;
    syncMotion();
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    syncMotion();
  });
  syncMotion();
}
startNightSky();
