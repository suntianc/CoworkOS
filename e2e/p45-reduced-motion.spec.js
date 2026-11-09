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

test("reduced motion keeps panel, drawer and list entrances on opacity and stops the loader", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await expect(page.locator("#composer-input")).toBeVisible();

    const normal = await motion(page);
    expect(normal.reduced).toBe(false);
    expect(normal.panelAnimation).toBe("formicand-panel-in");
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
    expect(reduced.panelAnimation).toBe("formicand-fade-in");
    expect(reduced.drawerAnimation).toBe("formicand-fade-in");
    expect(reduced.listAnimation).toBe("formicand-fade-in");
    expect(reduced.panelTransform).toBe("none");
    expect(reduced.drawerTransform).toBe("none");
    // The fade keyframes carry opacity only; the displacement keyframes stay unused.
    const fade = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of rules)
          if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === "formicand-fade-in")
            return [...rule.cssRules].map((frame) => frame.style.cssText);
      }
      return null;
    });
    expect(fade).not.toBeNull();
    expect(fade.join(" ")).toContain("opacity");
    expect(fade.join(" ")).not.toContain("transform");

    const controls = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "ui-panel";
      probe.style.cssText = "position:fixed;left:-100px;top:0;width:10px;height:10px";
      document.body.append(probe);
      const drawer = document.createElement("div");
      drawer.className = "ui-drawer";
      document.body.append(drawer);
      const spinner = document.createElement("span");
      spinner.className = "thinking-spinner";
      spinner.dataset.motionProbe = "";
      document.querySelector(".composer").append(spinner);
      const read = getComputedStyle(probe);
      const result = {
        transition: read.transitionProperty,
        transform: read.transform,
        drawerTransition: getComputedStyle(drawer).transitionProperty,
        spinnerAnimation: getComputedStyle(spinner).animationName,
        spinnerContent: getComputedStyle(spinner, "::after").content,
        spinnerBorder: getComputedStyle(spinner).borderTopWidth
      };
      probe.remove();
      drawer.remove();
      return result;
    });
    expect(controls.transition).toBe("opacity");
    expect(controls.transform).toBe("none");
    expect(controls.drawerTransition).toBe("opacity");
    expect(controls.spinnerAnimation).toBe("none");
    expect(controls.spinnerContent).toBe('"…"');
    expect(controls.spinnerBorder).toBe("0px");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(async () => (await motion(page)).panelAnimation).toBe("formicand-panel-in");
  } finally {
    await dashboard.stop();
  }
});
