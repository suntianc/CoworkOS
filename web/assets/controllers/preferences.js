// Applies the two accessibility/format preferences before the first paint, then
// owns their changes. A page that never opens settings still reads them here.
(() => {
  const motionKey = "atria.reduced-motion";
  const formatKey = "atria.time-format";
  const motionValues = ["system", "on", "off"];
  const formatValues = ["relative", "absolute"];
  const listeners = new Set();
  let motion = "system";
  let format = "relative";

  const read = (key) => {
    try {
      return localStorage.getItem(key);
      // eslint-disable-next-line no-restricted-syntax -- a blocked store still paints a usable default; the preference stays in memory for this session
    } catch {
      return null;
    }
  };
  const stored = read(motionKey);
  if (motionValues.includes(stored)) motion = stored;
  const storedFormat = read(formatKey);
  if (formatValues.includes(storedFormat)) format = storedFormat;

  function paint() {
    // "system" leaves the attribute off so the media query stays in charge.
    if (motion === "system") delete document.documentElement.dataset.reducedMotion;
    else document.documentElement.dataset.reducedMotion = motion === "on" ? "reduce" : "off";
    document.documentElement.dataset.timeFormat = format;
    for (const button of document.querySelectorAll("[data-reduced-motion-value]"))
      button.setAttribute("aria-checked", String(button.dataset.reducedMotionValue === motion));
    for (const button of document.querySelectorAll("[data-time-format-value]"))
      button.setAttribute("aria-checked", String(button.dataset.timeFormatValue === format));
    for (const listener of listeners) listener({ motion, format });
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, value);
      // eslint-disable-next-line no-restricted-syntax -- saving is optional; a full or blocked store keeps the choice in memory for this session
    } catch {
      /* The session keeps the chosen preference. */
    }
  }

  paint();
  window.atriaPreferences = {
    motion: () => motion,
    format: () => format,
    setMotion(value) {
      if (!motionValues.includes(value) || value === motion) return;
      motion = value;
      save(motionKey, value);
      paint();
    },
    setFormat(value) {
      if (!formatValues.includes(value) || value === format) return;
      format = value;
      save(formatKey, value);
      paint();
    },
    onChange(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  window.addEventListener("storage", (event) => {
    if (event.key === motionKey && motionValues.includes(event.newValue)) {
      motion = event.newValue;
      paint();
    } else if (event.key === formatKey && formatValues.includes(event.newValue)) {
      format = event.newValue;
      paint();
    }
  });
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      for (const button of document.querySelectorAll("[data-reduced-motion-value]"))
        button.addEventListener("click", () =>
          window.atriaPreferences.setMotion(button.dataset.reducedMotionValue)
        );
      for (const button of document.querySelectorAll("[data-time-format-value]"))
        button.addEventListener("click", () =>
          window.atriaPreferences.setFormat(button.dataset.timeFormatValue)
        );
      paint();
    },
    { once: true }
  );
})();
