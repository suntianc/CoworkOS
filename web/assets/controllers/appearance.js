// Runs before styles for the first paint, then attaches only the settings control.
(() => {
  const key = "atria.appearance";
  const materialKey = "atria.window-material";
  const host = window.bookmanDesktop?.appearance;
  const windowMaterial = window.bookmanDesktop?.windowMaterial?.material;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = (value) => ["system", "light", "dark"].includes(value);
  const validTheme = (value) => ["light", "dark"].includes(value);
  const materialAvailable = typeof windowMaterial === "string" && windowMaterial !== "none";
  let materialPreference = "on";
  try {
    const saved = localStorage.getItem(materialKey);
    if (saved === "on" || saved === "off") materialPreference = saved;
    // eslint-disable-next-line no-restricted-syntax -- a blocked store keeps the host material visible, which is the platform default
  } catch {
    /* The host material stays on. */
  }
  // New Web sessions start in the product's dark workspace; an existing
  // explicit preference still wins immediately below.
  let preference = "dark";
  let hostEffective;
  let effective;
  let pending = 0;
  let revision = 0;
  let hostRevision = 0;
  try {
    const saved = host ? host.initial : { preference: localStorage.getItem(key) };
    if (valid(saved?.preference)) preference = saved.preference;
    if (validTheme(saved?.effective)) hostEffective = saved.effective;
    // eslint-disable-next-line no-restricted-syntax -- localStorage.getItem throws in a storage-restricted session; the page must still paint with the system theme
  } catch {
    // Storage-unavailable sessions retain the system fallback, so a browser
    // privacy restriction never locks the page to an unchangeable theme.
    preference = "system";
  }
  let confirmedPreference = preference;
  function paintMaterial() {
    // A host window material replaces the painted backdrop; the browser keeps it.
    document.documentElement.dataset.windowMaterial =
      materialAvailable && materialPreference === "on" ? windowMaterial : "none";
    const toggle = document.querySelector("#window-material-toggle");
    if (toggle) toggle.setAttribute("aria-checked", String(materialAvailable && materialPreference === "on"));
    const row = document.querySelector("#window-material-row");
    if (row) row.hidden = !materialAvailable;
  }
  function paint() {
    effective = preference === "system" ? (hostEffective ?? (media.matches ? "dark" : "light")) : preference;
    document.documentElement.dataset.appearance = preference;
    document.documentElement.dataset.theme = effective;
    paintMaterial();
    document.documentElement.style.colorScheme = effective;
    for (const button of document.querySelectorAll("[data-appearance-value]"))
      button.setAttribute("aria-checked", String(button.dataset.appearanceValue === preference));
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.removeAttribute("media");
      meta.content = effective === "dark" ? "#0b0b0c" : "#f2f2f4";
    });
    window.dispatchEvent(new CustomEvent("atria:appearance", { detail: { preference, effective } }));
  }
  paint();
  host?.onChange((value) => {
    if (valid(value?.preference)) {
      hostRevision++;
      confirmedPreference = value.preference;
      hostEffective = validTheme(value.effective) ? value.effective : undefined;
      if (!pending) {
        preference = value.preference;
        paint();
      } else if (preference === "system" && value.preference === "system") paint();
    }
  });
  media.addEventListener("change", () => {
    if (preference === "system") paint();
  });
  window.addEventListener("storage", (event) => {
    if (!host && (event.key === key || event.key === null)) {
      preference = valid(event.newValue) ? event.newValue : "system";
      confirmedPreference = preference;
      paint();
    }
  });
  async function choose(next) {
    if (!valid(next)) return;
    const currentRevision = ++revision;
    pending++;
    preference = next;
    paint();
    const status = document.querySelector("#appearance-status");
    try {
      if (host) {
        const beforeSave = hostRevision;
        const saved = await host.set(preference);
        // A native update received during the save is newer than its returned snapshot.
        if (hostRevision === beforeSave) {
          confirmedPreference = saved.preference;
          hostEffective = validTheme(saved.effective) ? saved.effective : undefined;
        }
        if (currentRevision === revision) {
          preference = confirmedPreference;
          paint();
        }
      } else localStorage.setItem(key, preference);
      if (currentRevision === revision && status) status.textContent = "";
      // eslint-disable-next-line no-restricted-syntax -- saving the theme fails in private or full-storage sessions; the status line reports it and the previous preference is restored
    } catch {
      if (host && currentRevision === revision) {
        preference = confirmedPreference;
        paint();
      }
      if (currentRevision === revision && status)
        status.textContent = "外观偏好无法保存，请检查本机存储空间。";
    } finally {
      pending--;
    }
  }
  window.atriaAppearance = { preference: () => preference, set: (next) => void choose(next) };
  window.atriaWindowMaterial = {
    available: () => materialAvailable,
    enabled: () => materialAvailable && materialPreference === "on",
    set(value) {
      materialPreference = value ? "on" : "off";
      try {
        localStorage.setItem(materialKey, materialPreference);
        // eslint-disable-next-line no-restricted-syntax -- a blocked store keeps the material visible for this session; the platform default is the safe outcome
      } catch {
        /* The host material stays on. */
      }
      paintMaterial();
    }
  };
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      paint();
      const status = document.querySelector("#appearance-status");
      if (host?.initial?.warning && status) status.textContent = host.initial.warning;
      for (const button of document.querySelectorAll("[data-appearance-value]"))
        button.addEventListener("click", () => void choose(button.dataset.appearanceValue));
      document
        .querySelector("#window-material-toggle")
        ?.addEventListener("click", () =>
          window.atriaWindowMaterial.set(!window.atriaWindowMaterial.enabled())
        );
    },
    { once: true }
  );
})();
