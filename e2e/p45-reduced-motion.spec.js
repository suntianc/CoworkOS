import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const motion = (page) =>
  page.evaluate(() => {
    const style = (selector) => getComputedStyle(document.querySelector(selector));
    return {
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      panelAnimation: style(".agent-pane").animationName,
      drawerAnimation: style(".artifact-drawer").animationName,
      listAnimation: style(".project-list").animationName,
      panelTransform: style(".agent-pane").transform,
      drawerTransform: style(".artifact-drawer").transform
    };
  });

const keyframes = (page, name) =>
  page.evaluate((animationName) => {
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === animationName)
          return [...rule.cssRules].map((frame) => frame.keyText);
      }
    }
    return null;
  }, name);

test("reduced motion stops every rendered animation while keeping opacity transitions", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    const normal = await motion(page);
    expect(normal.reduced).toBe(false);
    // The side panel is a layout column with no entrance of its own (#22);
    // other panels (.ui-panel) still use the entrance keyframes checked below.
    expect(normal.panelAnimation).toBe("none");
    expect(normal.drawerAnimation).toBe("formicand-drawer-in");
    expect(normal.listAnimation).toBe("formicand-list-in");
    expect(await keyframes(page, "formicand-panel-in")).toEqual(["0%", "100%"]);
    const entrance = await page.evaluate(() => {
      const frames = [...document.styleSheets].flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      });
      const rule = frames.find(
        (item) => item.type === CSSRule.KEYFRAMES_RULE && item.name === "formicand-panel-in"
      );
      return [...rule.cssRules].map((frame) => frame.style.transform);
    });
    expect(entrance.some((value) => value.includes("translateY"))).toBe(true);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await motion(page)).reduced).toBe(true);

    const reduced = await motion(page);
    expect(reduced.panelAnimation).toBe("none");
    expect(reduced.drawerAnimation).toBe("none");
    expect(reduced.listAnimation).toBe("none");
    expect(reduced.panelTransform).toBe("none");
    expect(reduced.drawerTransform).toBe("none");

    const controls = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.innerHTML = `<span class="conversation-activity" data-state="running"></span><span class="conversation-activity" data-state="leased"></span><div class="modal-card app-dialog"><div class="dialog-actions"><button type="button" aria-busy="true">保存</button></div></div><span class="future-loader" style="animation: ui-spin 1s linear infinite"></span>`;
      probe.style.cssText = "position:fixed;left:-400px;top:0;width:10px;height:10px";
      document.body.append(probe);
      const panel = document.createElement("div");
      panel.className = "ui-panel";
      document.body.append(panel);
      const drawer = document.createElement("div");
      drawer.className = "ui-drawer";
      document.body.append(drawer);
      const spinner = document.createElement("span");
      spinner.className = "thinking-spinner";
      document.querySelector(".composer").append(spinner);
      const animation = (selector, pseudo) =>
        getComputedStyle(probe.querySelector(selector), pseudo).animationName;
      const result = {
        runningActivity: animation('[data-state="running"]'),
        leasedActivity: animation('[data-state="leased"]'),
        dialogBusyButton: animation('button[aria-busy="true"]', "::before"),
        futureLoader: animation(".future-loader"),
        panelTransition: getComputedStyle(panel).transitionProperty,
        panelTransform: getComputedStyle(panel).transform,
        drawerTransition: getComputedStyle(drawer).transitionProperty,
        spinnerAnimation: getComputedStyle(spinner).animationName,
        spinnerContent: getComputedStyle(spinner, "::after").content,
        spinnerBorder: getComputedStyle(spinner).borderTopWidth
      };
      probe.remove();
      panel.remove();
      drawer.remove();
      spinner.remove();
      return result;
    });
    expect(controls.runningActivity).toBe("none");
    expect(controls.leasedActivity).toBe("none");
    expect(controls.dialogBusyButton).toBe("none");
    expect(controls.futureLoader).toBe("none");
    expect(controls.panelTransition).toBe("opacity");
    expect(controls.panelTransform).toBe("none");
    expect(controls.drawerTransition).toBe("opacity");
    expect(controls.spinnerAnimation).toBe("none");
    expect(controls.spinnerContent).toBe('"…"');
    expect(controls.spinnerBorder).toBe("0px");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(async () => (await motion(page)).drawerAnimation).toBe("formicand-drawer-in");
  } finally {
    await dashboard.stop();
  }
});
