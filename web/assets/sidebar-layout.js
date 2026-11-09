/** Sidebar sizing is presentation state, independent of the selected task. */
export function createSidebarLayout(
  layout,
  sidebar,
  divider,
  { sidebarToggle, outputPane, outputToggle } = {}
) {
  const storageKey = "atria.sidebar-share";
  let share,
    dragging = false;
  try {
    const stored = Number(localStorage.getItem(storageKey));
    if (stored > 0 && stored < 1) share = stored;
    // eslint-disable-next-line no-restricted-syntax -- 受限浏览器读取 localStorage 会抛出，份额回退为默认布局
  } catch {
    /* Storage may be unavailable in a restricted browser. */
  }
  const tasksOnLeft = () =>
    outputPane &&
    document.body.classList.contains("application-task-layout") &&
    !document.body.classList.contains("output-collapsed");
  const currentSidebar = () => (tasksOnLeft() ? outputPane : sidebar);
  const limits = () => ({ min: 180, max: Math.max(180, Math.min(420, layout.clientWidth - 480)) });
  const measure = () => {
    const pane = currentSidebar();
    const rect = pane.getBoundingClientRect();
    divider.style.left = `${rect.right - layout.getBoundingClientRect().left - 3}px`;
    const { min, max } = limits();
    divider.setAttribute("aria-valuemin", String(min));
    divider.setAttribute("aria-valuemax", String(max));
    divider.setAttribute("aria-valuenow", String(Math.round(rect.width)));
    divider.setAttribute("aria-valuetext", `${Math.round(rect.width)} 像素`);
    const label = tasksOnLeft() ? "任务面板" : "会话侧栏";
    divider.setAttribute("aria-label", `调整${label}宽度`);
    divider.setAttribute("aria-controls", pane.id);
    divider.title = `拖动调整${label}宽度，双击恢复默认`;
    sidebarToggle?.setAttribute("aria-expanded", String(rect.width > 0));
    sidebarToggle?.setAttribute("aria-controls", pane.id);
    if (outputToggle?.getAttribute("aria-controls") !== "workbench")
      outputToggle?.setAttribute("aria-expanded", String(outputPane?.getBoundingClientRect().width > 0));
  };
  const apply = () => {
    if (share && layout.clientWidth > 900) {
      const { min, max } = limits();
      layout.style.setProperty(
        "--sidebar-width",
        `${Math.max(min, Math.min(max, layout.clientWidth * share))}px`
      );
    }
    measure();
  };
  const setWidth = (width) => {
    const { min, max } = limits();
    share = Math.max(min, Math.min(max, width)) / layout.clientWidth;
    apply();
  };
  const save = () => {
    try {
      localStorage.setItem(storageKey, String(share));
      // eslint-disable-next-line no-restricted-syntax -- 配额耗尽或存储被禁用时 setItem 抛出，宽度仍保留在内存中
    } catch {
      /* Keep the in-memory size. */
    }
  };
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    divider.classList.add("is-dragging");
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-resizing");
    event.preventDefault();
  });
  divider.addEventListener("pointermove", (event) => {
    if (dragging) setWidth(event.clientX - layout.getBoundingClientRect().left);
  });
  const finish = () => {
    divider.classList.remove("is-dragging");
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("workspace-resizing");
    save();
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
    divider.addEventListener(event, finish);
  divider.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = limits();
    setWidth(
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max
          : currentSidebar().getBoundingClientRect().width + (event.key === "ArrowRight" ? 16 : -16)
    );
    save();
  });
  divider.addEventListener("dblclick", () => {
    share = undefined;
    layout.style.removeProperty("--sidebar-width");
    try {
      localStorage.removeItem(storageKey);
      // eslint-disable-next-line no-restricted-syntax -- 存储被禁用时 removeItem 抛出，双击只是恢复默认宽度
    } catch {
      /* Optional preference. */
    }
    measure();
  });
  const observer = new ResizeObserver(measure);
  observer.observe(sidebar);
  if (outputPane) observer.observe(outputPane);
  window.addEventListener("resize", apply);
  apply();
}
