import { test, expect } from "@playwright/test";
import { startConfiguredDashboard as startDashboard } from "../test/dashboard-fixture.mjs";

async function bridge(page, mode, installMethod, options = {}) {
  await page.addInitScript(
    ({ mode, installMethod, options }) => {
      let listener;
      let state = {
        mode,
        installMethod,
        phase: "idle",
        currentVersion: "0.1.1",
        busy: false,
        ...options.initial
      };
      window.__updateCalls = [];
      window.__updateStatus = (value) => {
        state = { ...state, ...value };
        listener?.(state);
      };
      window.bookmanDesktop = {
        onPrepareClose: () => {},
        updateStatus: async () => state,
        onUpdateStatus: (callback) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        checkUpdates: async (input) => {
          window.__updateCalls.push(["check", input]);
          if (window.__checkError) throw new Error(window.__checkError);
          state = {
            ...state,
            phase: options.availableOnCheck === false ? "up-to-date" : "available",
            available: options.availableOnCheck !== false,
            version: "0.1.2"
          };
          listener?.(state);
          return state;
        },
        applyUpdate: () => {
          window.__updateCalls.push(["apply"]);
          if (window.__updateError) return Promise.reject(new Error(window.__updateError));
          const installing = ["native", "managed"].includes(installMethod) && state.downloaded;
          state = {
            ...state,
            phase: mode === "source" ? "updating" : installing ? "ready" : "downloading",
            busy: true,
            applying: installing
          };
          listener?.(state);
          if (window.__updateErrorAfterStart)
            return Promise.reject(new Error(window.__updateErrorAfterStart));
          return new Promise((resolve) => {
            window.__finishUpdate = () => {
              state = {
                ...state,
                phase: "ready",
                busy: false,
                downloaded: mode !== "source",
                available: mode !== "source",
                updated: mode === "source",
                needsRelaunch: mode === "source" || installing,
                installReady: Boolean(installing),
                applying: false
              };
              listener?.(state);
              resolve(state);
            };
          });
        }
      };
    },
    { mode, installMethod, options }
  );
}

test("installed App shows the local upgrade path without checking remotely", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "release", "manual", { initial: { phase: "manual", available: false } });
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await expect(page.locator("[data-update-message]")).toHaveText("请使用本地安装包手动升级。");
    await expect(page.locator("[data-update-action]")).toBeHidden();
    expect(await page.evaluate(() => window.__updateCalls)).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("source App checks once and updates with progress while keeping saved drafts protected", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "source", "source");
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("保留这份更新前的草稿");
    await page.locator("#user-menu-button").click();
    await expect(page.locator("[data-update-message]")).toContainText("发现新的开发提交");
    await expect(page.locator("[data-update-channel]")).toHaveCount(0);
    expect(await page.evaluate(() => window.__updateCalls)).toEqual([["check", {}]]);
    await page.locator("[data-update-apply]").click();
    await expect(page.locator("[data-update-progress]")).toBeVisible();
    await expect(page.locator("#profile-close")).toBeDisabled();
    expect(await page.locator(".app-shell").evaluate((node) => node.inert)).toBe(true);
    await page.keyboard.press("Escape");
    const overview = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(overview).toBeVisible();
    for (const [entry, title] of [
      ["管理模型连接", "连接模型"],
      ["管理联网搜索", "联网搜索"],
      ["管理科学环境", "科学计算"]
    ]) {
      await overview.getByRole("button", { name: entry, exact: true }).click();
      await expect(overview).toBeVisible();
      await expect(page.getByRole("dialog", { name: title, exact: true })).toBeHidden();
      await expect(page.getByRole("dialog")).toHaveCount(1);
    }
    await page.evaluate(() => window.__finishUpdate());
    await expect(page.locator("[data-update-message]")).toContainText("重新打开");
    await expect(overview.getByRole("button", { name: "关闭设置", exact: true })).toBeDisabled();
    await page.evaluate(() =>
      window.__updateStatus({ phase: "error", error: "无法重新打开，请重试", busy: false, applying: false })
    );
    await expect(overview.getByRole("button", { name: "关闭设置", exact: true })).toBeEnabled();
    await overview.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(overview).toBeHidden();
    await expect(page.locator("#composer-input")).toHaveValue("保留这份更新前的草稿");
  } finally {
    await dashboard.stop();
  }
});

test("release App has one update action and downloads without freezing editing", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "release", "managed");
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await expect(page.locator("[data-update-message]")).toContainText("0.1.2");
    await expect(page.locator("[data-update-channel]")).toHaveCount(0);
    await expect(page.locator(".desktop-updates button")).toHaveCount(1);
    expect(await page.evaluate(() => window.__updateCalls)).toEqual([["check", {}]]);
    await page.getByRole("button", { name: "下载更新", exact: true }).click();
    await page.evaluate(() => window.__updateStatus({ progress: { percent: 42 } }));
    await expect(page.locator("[data-update-progress]")).toBeVisible();
    await expect(page.locator("[data-update-progress]")).toHaveAttribute("value", "42");
    await expect(page.locator("#profile-close")).toBeEnabled();
    expect(await page.locator(".app-shell").evaluate((node) => node.inert)).toBe(false);
    await page.locator("#profile-close").click();
    await page.locator("#composer-input").fill("下载期间仍可编辑");
    await page.evaluate(() => window.__finishUpdate());
    await page.locator("[data-update-notice]").click();
    await expect(page.getByRole("button", { name: "重启并安装", exact: true })).toBeFocused();
    await expect(page.locator("[data-update-message]")).toContainText("重启即可安装");
    await expect(page.locator("#composer-input")).toHaveValue("下载期间仍可编辑");
  } finally {
    await dashboard.stop();
  }
});

test("a refused source update leaves the draft editable and offers retry", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "source", "source");
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("不能被失败更新丢掉");
    await page.locator("#user-menu-button").click();
    await expect(page.locator("[data-update-apply]")).toBeVisible();
    await page.evaluate(() => {
      window.__updateError = "请先结束正在运行的任务，再更新 CoworkOS";
    });
    await page.locator("[data-update-apply]").click();
    await expect(page.locator("[data-update-error]")).toContainText("正在运行的任务");
    await expect(page.locator("[data-update-apply]")).toBeEnabled();
    await expect(page.locator("#profile-close")).toBeEnabled();
    await page.locator("#profile-close").click();
    await page.locator("#composer-input").fill("失败后可以继续编辑");
    await expect(page.locator("#composer-input")).toHaveValue("失败后可以继续编辑");
  } finally {
    await dashboard.stop();
  }
});

test("Web mode keeps desktop updates out of settings", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await expect(page.locator("#profile-modal")).toBeVisible();
    await expect(page.locator("[data-update-check]")).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

test("a reloaded source App waits for backend recovery and then offers restart retry", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "source", "source");
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("恢复服务后保留的草稿");
    await page.locator("#user-menu-button").click();
    await expect(page.locator("[data-update-apply]")).toBeVisible();
    await page.evaluate(() => window.__updateStatus({ rebuildRequired: true }));
    await expect(page.locator("[data-update-message]")).toContainText("重新构建 App");
    await page.evaluate(() =>
      window.__updateStatus({
        phase: "error",
        updated: true,
        busy: true,
        applying: true,
        error: "无法启动重开助手，请重试"
      })
    );
    await expect(page.locator("#profile-close")).toBeDisabled();
    expect(await page.locator(".app-shell").evaluate((node) => node.inert)).toBe(true);
    await page.evaluate(() => window.__updateStatus({ busy: false, applying: false }));
    await expect(page.locator("#profile-close")).toBeEnabled();
    await expect(page.locator("[data-update-apply]")).toBeEnabled();
    await expect(page.locator("[data-update-error]")).toContainText("请重试");
    await page.locator("#profile-close").click();
    await expect(page.locator("#composer-input")).toHaveValue("恢复服务后保留的草稿");
  } finally {
    await dashboard.stop();
  }
});

for (const installMethod of ["managed", "native"]) {
  test(`${installMethod} App protects drafts only during a separate restart and install`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    try {
      await bridge(page, "release", installMethod);
      await page.goto(dashboard.base);
      await page.locator("#composer-input").fill("安装前保留的草稿");
      await page.locator("#user-menu-button").click();
      await expect(page.locator("[data-update-apply]")).toHaveText("下载更新");
      await page.locator("[data-update-apply]").click();
      await expect(page.locator("#profile-close")).toBeEnabled();
      await page.evaluate(() => window.__finishUpdate());
      await expect(page.locator("[data-update-apply]")).toHaveText("重启并安装");
      await expect(page.locator("#profile-close")).toBeEnabled();
      await page.locator("[data-update-apply]").click();
      await expect(page.locator("#profile-close")).toBeDisabled();
      expect(await page.locator(".app-shell").evaluate((node) => node.inert)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.locator("#profile-modal")).toBeVisible();
      await page.evaluate(() => window.__finishUpdate());
      await expect(page.locator("[data-update-message]")).toContainText("重新打开");
      await expect(page.locator("[data-update-notice]")).toBeHidden();
      await expect(page.locator("#composer-input")).toHaveValue("安装前保留的草稿");
    } finally {
      await dashboard.stop();
    }
  });
}

test("automatic update events show a circular reminder above settings with keyboard access", async ({
  page
}, testInfo) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "release", "managed", { availableOnCheck: false });
    await page.goto(dashboard.base);
    const notice = page.locator("[data-update-notice]");
    await expect(notice).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__updateCalls)).toEqual([["check", {}]]);
    await page.evaluate(() =>
      window.__updateStatus({
        phase: "available",
        available: true,
        version: "0.1.3"
      })
    );
    await expect(notice).toBeVisible();
    await expect(page.locator("#profile-modal")).toBeHidden();
    await expect(notice).toHaveAccessibleName("发现新版本 0.1.3，查看 CoworkOS 更新");
    await expect(notice).toHaveCSS("border-radius", "50%");
    await expect(notice).toHaveCSS("background-color", "rgb(238, 238, 238)");
    const reminderBox = await notice.boundingBox();
    const settingsBox = await page.locator("#user-menu-button").boundingBox();
    expect(reminderBox.width).toBe(32);
    expect(reminderBox.height).toBe(32);
    expect(reminderBox.y + reminderBox.height).toBeLessThanOrEqual(settingsBox.y);
    await page.screenshot({ path: testInfo.outputPath("sidebar-update-reminder.png") });
    await notice.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#profile-modal")).toBeVisible();
    await expect(page.getByRole("button", { name: "下载更新", exact: true })).toBeFocused();
    expect(await page.evaluate(() => window.__updateCalls)).toEqual([["check", {}]]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#profile-modal")).toBeHidden();
    await expect(notice).toBeFocused();
    await page.evaluate(() => window.__updateStatus({ phase: "up-to-date", available: false }));
    await expect(notice).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("idle settings offer a single check action and check failures remain retryable", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "release", "managed", { availableOnCheck: false });
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    const check = page.getByRole("button", { name: "检查更新", exact: true });
    await expect(check).toBeVisible();
    await expect(page.locator(".desktop-updates button")).toHaveCount(1);
    await page.evaluate(() => {
      window.__checkError = "网络暂时不可用，请重试";
    });
    await check.click();
    await expect(page.locator("[data-update-error]")).toContainText("网络暂时不可用");
    await expect(check).toBeEnabled();
    await expect(page.locator("[data-update-notice]")).toBeHidden();
    await page.evaluate(() => {
      window.__checkError = undefined;
    });
    await check.click();
    await expect(page.locator("[data-update-error]")).toBeHidden();
    await expect(page.locator("[data-update-message]")).toHaveText("已是最新版本。");
    expect(await page.evaluate(() => window.__updateCalls)).toEqual([
      ["check", {}],
      ["check", {}],
      ["check", {}]
    ]);
  } finally {
    await dashboard.stop();
  }
});

test("a ready update survives initial state loading and an installation failure unlocks drafts", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "release", "managed", {
      initial: {
        phase: "ready",
        downloaded: true,
        available: true,
        version: "0.1.3"
      }
    });
    await page.goto(dashboard.base);
    await expect(page.locator("[data-update-notice]")).toBeVisible();
    expect(await page.evaluate(() => window.__updateCalls)).toEqual([]);
    await page.locator("#composer-input").fill("失败后保留这份草稿");
    await page.locator("[data-update-notice]").click();
    await page.evaluate(() => {
      window.__updateError = "无法启动安装，请重试";
    });
    await page.getByRole("button", { name: "重启并安装", exact: true }).click();
    await expect(page.locator("[data-update-error]")).toContainText("无法启动安装");
    await expect(page.locator("#profile-close")).toBeEnabled();
    expect(await page.locator(".app-shell").evaluate((node) => node.inert)).toBe(false);
    await page.evaluate(() =>
      window.__updateStatus({ installReady: true, phase: "error", error: "安装失败，请重试" })
    );
    await expect(page.locator("#profile-close")).toBeEnabled();
    await expect(page.getByRole("button", { name: "重启并安装", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await page.locator("#composer-input").fill("安装失败后仍能编辑");
    await expect(page.locator("#composer-input")).toHaveValue("安装失败后仍能编辑");
  } finally {
    await dashboard.stop();
  }
});

test("a failed managed download clears transient busy state and can resume without losing a draft", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "release", "managed");
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("下载失败仍保留的草稿");
    await page.locator("[data-update-notice]").click();
    await page.evaluate(() => {
      window.__updateErrorAfterStart = "下载连接已断开，请重试";
    });
    const download = page.getByRole("button", { name: "下载更新", exact: true });
    await download.click();
    await expect(page.locator("[data-update-error]")).toContainText("下载连接已断开");
    await expect(download).toBeEnabled();
    await expect(page.locator("[data-update-progress]")).toBeHidden();
    await expect(page.locator("#profile-close")).toBeEnabled();
    expect(await page.locator(".app-shell").evaluate((node) => node.inert)).toBe(false);
    await page.evaluate(() => {
      window.__updateErrorAfterStart = undefined;
    });
    await download.click();
    await expect(page.locator("[data-update-error]")).toBeHidden();
    await expect(page.locator("[data-update-progress]")).toBeVisible();
    await page.evaluate(() => window.__finishUpdate());
    await expect(page.getByRole("button", { name: "重启并安装", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.locator("#composer-input")).toHaveValue("下载失败仍保留的草稿");
  } finally {
    await dashboard.stop();
  }
});

test("update details stay reachable on narrow screens", async ({ page }, testInfo) => {
  const dashboard = await startDashboard();
  try {
    await bridge(page, "release", "managed");
    await page.goto(dashboard.base);
    for (const width of [474, 320]) {
      await page.setViewportSize({ width, height: 600 });
      const settings = page.getByRole("button", { name: "设置", exact: true });
      if (!(await settings.isVisible()))
        await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
      await page.locator("[data-update-notice]").click();
      const dialog = page.getByRole("dialog", { name: "设置", exact: true });
      await expect(dialog).toBeVisible();
      const action = page.getByRole("button", { name: "下载更新", exact: true });
      await expect(action).toBeInViewport();
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(
        await page.locator(".desktop-updates").evaluate((node) => node.scrollWidth <= node.clientWidth)
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`updates-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator("[data-update-notice]")).toBeFocused();
    }
  } finally {
    await dashboard.stop();
  }
});
