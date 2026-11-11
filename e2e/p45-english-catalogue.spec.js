import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startConfiguredDashboard, startDashboard } from "../test/dashboard-fixture.mjs";
import { configureMerge, seedArtifact, seedRequirement, seedRun } from "./p45-requirement-fixture.js";
import { createProject, createTask, markTaskRunning } from "./p45-work-helpers.js";
import { pulseClock, seedCapacitySlots, seedPulseLane } from "./p45-pulse-fixture.js";

/**
 * The English interface: the P4.5 surfaces read English, and the Chinese
 * interface is untouched.
 *
 * Every page is seeded with ASCII project and requirement names, so any Han
 * character left on screen or in an accessible name is interface text that the
 * English catalogue does not cover.
 */
const HAN = /[\u3400-\u9fff]/;
/** A configured connection whose profile name is ASCII, like any name a person types. */
const MODEL_CONFIG = {
  modelConnections: {
    version: 1,
    activeId: "fixture",
    profiles: [
      {
        id: "fixture",
        name: "Fixture",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "browser-fixture",
        supportsImages: false,
        reasoningEffort: "off",
        supportsReasoningEffort: true,
        apiKey: "local-fixture"
      }
    ]
  }
};
const IGNORED_TAGS = ["SCRIPT", "STYLE", "TEXTAREA"];
const NAMES = ["aria-label", "title", "placeholder", "aria-placeholder", "alt"];

async function english(page, dataSelectors = []) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  return page.evaluate(
    ({ han, ignored, attributeNames, dataSelectors }) => {
      const pattern = new RegExp(han);
      const issues = [];
      const described = (element) =>
        `<${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
          typeof element.className === "string" && element.className.trim()
            ? `.${element.className.trim().split(/\s+/).join(".")}`
            : ""
        }>`;
      const shown = (element) => {
        if (!element || !element.isConnected || element.closest("[hidden]")) return false;
        if (dataSelectors.length && element.closest(dataSelectors.join(","))) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent.trim();
        const owner = node.parentElement;
        if (!text || !pattern.test(text) || !owner || ignored.includes(owner.tagName)) continue;
        if (!shown(owner)) continue;
        issues.push(`text ${JSON.stringify(text)} in ${described(owner)}`);
      }
      for (const element of document.body.querySelectorAll(
        attributeNames.map((name) => `[${name}]`).join(",")
      )) {
        if (!shown(element)) continue;
        for (const name of attributeNames) {
          const value = element.getAttribute(name);
          if (value && pattern.test(value))
            issues.push(`${name} ${JSON.stringify(value)} on ${described(element)}`);
        }
      }
      return issues;
    },
    { han: HAN.source, ignored: IGNORED_TAGS, attributeNames: NAMES, dataSelectors }
  );
}

async function expectEnglish(page, where, dataSelectors) {
  const issues = await english(page, dataSelectors);
  if (issues.length) throw new Error(`${where} still shows Chinese in English mode:\n${issues.join("\n")}`);
}

async function openEnglish(page, base, path = "") {
  // Only the first load needs the preference; a later choice must survive its reload.
  await page.addInitScript(() => {
    if (!localStorage.getItem("atria.language")) localStorage.setItem("atria.language", "en");
  });
  await page.goto(`${base}${path}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

async function openSettings(page) {
  await page.locator("#user-menu-button").click();
  await expect(page.locator("#settings-entry")).toBeVisible();
}

async function closeDialog(page, name) {
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name })).toBeHidden();
}

test("the work entry, sidebar, new session and add-project dialog read English", async ({ page }) => {
  const dashboard = await startConfiguredDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "alpha");
    await mkdir(directory, { recursive: true });
    await createProject(page, dashboard, "Alpha", directory);
    await openEnglish(page, dashboard.base);

    await expect(page.getByRole("tab", { name: "Work", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Observe", exact: true })).toBeVisible();
    await expect(page.locator("#new-conversation")).toContainText("New session");
    await expect(page.locator(".project-name")).toHaveText("Alpha");
    // The project action reads as one phrase: a single space either side of the name.
    await expect(page.locator(".project-create")).toHaveAttribute(
      "aria-label",
      "In Alpha · new conversation"
    );
    await expectEnglish(page, "the work sidebar");

    await page.locator("#new-project").click();
    const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
    await expect(dialog.getByRole("tab", { name: "Local folder" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Working folder" })).toBeVisible();
    await expect(dialog.locator("#add-project-branch")).toHaveAttribute("placeholder", "Default branch");
    await expectEnglish(page, "the add-project dialog");
    await dialog.getByRole("tab", { name: "Git address" }).click();
    await expect(dialog.getByRole("textbox", { name: "Repository URL" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Clone into" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Clone and add" })).toBeVisible();
    await expectEnglish(page, "the add-project Git dialog");
    await closeDialog(page, "Add project");

    await page.locator("#new-conversation").click();
    await expect(page.locator(".new-session-start")).toBeVisible();
    await expect(page.locator(".new-session-title")).toHaveText("What do you want to do, and where?");
    await expectEnglish(page, "the new-session surface");
  } finally {
    await dashboard.stop();
  }
});

test("all six settings sections and their dialogs read English", async ({ page }) => {
  const dashboard = await startDashboard({ config: MODEL_CONFIG });
  // The host's real computer-use state (a locked screen, granted permissions)
  // carries its own native wording; this catalogue check pins a neutral one.
  await page.route("**/api/computer/status", (route) =>
    route.fulfill({ json: { available: false, controlAvailable: false } })
  );
  try {
    await openEnglish(page, dashboard.base);
    await openSettings(page);
    const sections = [
      ["general", "General"],
      ["nodes", "Node connections"],
      ["models", "Models and roles"],
      ["capacity", "Runtime capacity"],
      ["members", "Members and channels"],
      ["tools", "Tools"]
    ];
    for (const [name, title] of sections) {
      await page.locator(`[data-settings-section="${name}"]`).click();
      const panel = page.locator(`[data-settings-panel="${name}"]`);
      await expect(panel.getByRole("heading", { level: 1 })).toHaveText(title);
      await expectEnglish(page, `the ${name} settings section`);
    }

    // A host without the built native driver reports a Chinese reason; the panel
    // translates known reasons, so English never depends on what was built here.
    await page.route("**/api/computer/status", (route) =>
      route.fulfill({
        json: {
          available: false,
          screenRecording: false,
          accessibility: false,
          windows: [],
          reason: "未找到 Computer Use 原生驱动，请运行 npm run build:computer-use"
        }
      })
    );
    await page.locator('[data-settings-section="tools"]').click();
    await expect(page.locator("[data-computer-permissions]")).toContainText(
      "The Computer Use native driver is missing"
    );
    await expectEnglish(page, "a host reason for window access");
    await page.unroute("**/api/computer/status");

    await page.locator('[data-settings-section="nodes"]').click();
    await page.locator("#settings-node-add").click();
    const node = page.getByRole("dialog", { name: "Add node", exact: true });
    await expect(node.getByRole("textbox", { name: "Address", exact: true })).toBeVisible();
    await expect(node.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
    await expect(node.getByRole("radio", { name: "Internal", exact: true })).toBeVisible();
    await expectEnglish(page, "the add-node dialog");
    await node.locator("#node-address").fill("ftp://example.test");
    await node.locator("#node-submit").click();
    await expect(node.locator("#node-error")).toHaveText("Only http:// and https:// addresses are supported");
    await expectEnglish(page, "a rejected node address");
    await closeDialog(page, "Add node");

    await page.locator('[data-settings-section="models"]').click();
    await page.locator("#settings-model-add").click();
    const model = page.getByRole("dialog", { name: "Connect model", exact: true });
    await expect(model.getByRole("button", { name: "Save connection", exact: true })).toBeVisible();
    await expectEnglish(page, "the model connection dialog");
    await model.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(model).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("run controls, notifications, the requirement panel and the preview drawer read English", async ({
  page
}) => {
  const dashboard = await startConfiguredDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "beta");
    await mkdir(directory, { recursive: true });
    const project = await createProject(page, dashboard, "Beta", directory);
    await configureMerge(page, dashboard, project, directory);
    const records = await seedRequirement(page, dashboard, project, {
      phase: "review",
      title: "Preview and usage",
      content: "Preview the change and its attachments.",
      criteria: ["summarize.sh prints 30", "exit code 1 when the file is missing"]
    });
    await seedArtifact(
      page,
      dashboard,
      records.session.taskId,
      "record.md",
      "# Record\n\nThree criteria passed.\n"
    );
    await seedRun(page, dashboard, records.session.taskId);
    await createTask(page, dashboard, {
      taskId: "beta-notice",
      goal: "Notice",
      projectId: project.projectId
    });
    await markTaskRunning(dashboard, { taskId: records.session.taskId, runId: "run_live" });
    // The run bar paints for an active runtime; a recorded run without a live
    // model stream still has the same controls and labels.
    const detail = await (
      await page.request.get(`${dashboard.base}/api/tasks/${records.session.taskId}`)
    ).json();
    await page.route(`**/api/tasks/${encodeURIComponent(records.session.taskId)}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              ...detail,
              task: { ...detail.task, status: "running" },
              runtime: { ...detail.runtime, active: true }
            }
          })
        : route.fallback()
    );

    await openEnglish(page, dashboard.base, `?task=${encodeURIComponent(records.session.taskId)}`);
    const bar = page.locator("#run-control");
    await expect(bar.locator("[data-run-label]")).toContainText("Main is");
    await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Cancel run", exact: true })).toBeVisible();
    await expectEnglish(page, "a running conversation");

    await page.locator("#output-pane-toggle").click();
    const panel = page.locator("[data-requirement-panel]");
    await expect(panel.locator(".rp-title")).toHaveText("Preview and usage");
    await expect(panel.getByRole("heading", { name: "Requirement progress" })).toBeVisible();
    await expectEnglish(page, "the requirement panel");

    await panel.getByRole("button", { name: "View diff" }).click();
    const drawer = page.locator("#artifact-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".artifact-drawer-title")).toContainText("Change");
    // The diff body is repository content, not interface text.
    await expectEnglish(page, "the change preview", [".drawer-lines"]);
    await drawer.getByRole("button", { name: "Close preview" }).click();
    await expect(drawer).toBeHidden();

    await panel.locator("#output-list .rp-attachment").first().click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".artifact-drawer-title")).toContainText("record.md");
    await expectEnglish(page, "the attachment preview", [".drawer-content"]);
    await drawer.getByRole("button", { name: "Close preview" }).click();
    await expect(drawer).toBeHidden();

    // Leaving a running Main announces it once, in the toast.
    await page.locator('.conversation-item[data-task="beta-notice"]').click();
    const toast = page.locator(".toast-card").last();
    await expect(toast).toContainText("Switched to");
    await expect(toast).toContainText("is still running in the background");
    await expectEnglish(page, "the background-run notification");
  } finally {
    await dashboard.stop();
  }
});

test("observation overview, requirements, detail and runs read English", async ({ page }) => {
  test.setTimeout(180_000);
  const dashboard = await startConfiguredDashboard({ defaultProject: false });
  try {
    const directory = join(dashboard.root, "gamma");
    await mkdir(directory, { recursive: true });
    const project = await createProject(page, dashboard, "Gamma", directory);
    await configureMerge(page, dashboard, project, directory);
    await seedRequirement(page, dashboard, project, {
      phase: "merged",
      title: "Export format",
      content: "Agree on the export format.",
      criteria: ["the export opens", "the columns match"]
    });
    const development = await seedRequirement(page, dashboard, project, {
      phase: "development",
      title: "Score totals",
      content: "Total the scores in one file.",
      criteria: ["the total matches"]
    });
    const published = await page.request.post(
      `${dashboard.base}/api/projects/${encodeURIComponent(project.projectId)}/board`,
      {
        data: {
          action: "publish",
          requestId: "gamma-need",
          title: "Login issue",
          content: "Reset the login form.",
          source: { kind: "external" }
        }
      }
    );
    expect(published.status()).toBeLessThan(300);
    const clock = pulseClock();
    await seedPulseLane(dashboard, {
      taskId: development.session.taskId,
      runId: "run-gamma",
      clock,
      createdAt: clock.ago(-40),
      title: "Score totals",
      main: { from: -40, to: 0 }
    });
    await seedCapacitySlots(dashboard, [
      {
        taskId: development.session.taskId,
        projectId: project.projectId,
        sessionId: development.session.sessionId,
        runId: "run-gamma",
        kind: "regular",
        requirementId: development.requirement.requirementId,
        startedAt: clock.ago(-40)
      }
    ]);

    await openEnglish(page, dashboard.base);
    await page.locator("#entry-observe").click();
    await expect(page.locator("#observe-entry")).toBeVisible();
    await expect(page.locator("#observe-title")).toHaveText("Overview");
    await expect(page.locator("[data-observe-node-card]")).toHaveCount(1);
    await expectEnglish(page, "the observation overview");

    await page.locator('[data-observe-view="requirements"]').click();
    await expect(page.locator('[data-observe-tab="all"]')).toBeVisible();
    await expectEnglish(page, "the observation requirement list");

    await page.locator("[data-observe-requirement]").first().click();
    await expect(page.locator("#observe-detail")).toBeVisible();
    await expectEnglish(page, "the observation requirement detail");

    await page.locator('[data-observe-view="runs"]').click();
    await expect(page.locator("[data-runs-node]").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-runs-lane]").first()).toBeVisible({ timeout: 20_000 });
    await expectEnglish(page, "the observation runs view");
  } finally {
    await dashboard.stop();
  }
});

test("a fresh install reads English first use and empty observation, and Chinese returns", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    await openEnglish(page, dashboard.base);
    await expect(page.locator(".first-use")).toBeVisible();
    await expect(page.locator(".first-use-title")).toHaveText("Welcome to Formicand");
    await expect(page.locator("#topbar-task")).toHaveText("Get started");
    await expect(page.locator(".sidebar-empty-state")).toHaveText("No projects yet");
    await expect(page.locator("#composer-input")).toHaveAttribute(
      "placeholder",
      "Connect a model and add a project to start…"
    );
    await expectEnglish(page, "the first-use guide");

    await page.locator("#entry-observe").click();
    await expect(page.locator("#observe-title")).toHaveText("Overview");
    await expectEnglish(page, "an empty observation overview");
    for (const view of ["requirements", "runs"]) {
      await page.locator(`[data-observe-view="${view}"]`).click();
      await expect(page.locator(`[data-observe-panel="${view}"]`)).toBeVisible();
      await expectEnglish(page, `empty observation ${view}`);
    }

    // The same surface returns to Chinese when the interface language does.
    await page.locator("#entry-work").click();
    await openSettings(page);
    await page.locator("#language-select").selectOption("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.locator("#new-conversation")).toContainText("新会话");
    await expect(page.locator(".first-use-title")).toHaveText("欢迎使用 Formicand");
  } finally {
    await dashboard.stop();
  }
});
