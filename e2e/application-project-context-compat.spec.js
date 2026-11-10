import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const api = async (dashboard, path, body) => {
  const response = await fetch(dashboard.base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
};

test("orphaned legacy projects stay hidden after restart while explicit empty projects remain", async ({
  page
}) => {
  const evidence = test.info().outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    const explicitDirectory = join(dashboard.root, "legitimate-empty");
    const oldDirectory = join(dashboard.root, "atria-reasoning-launcher-repro");
    await mkdir(explicitDirectory);
    await mkdir(oldDirectory);
    const { project: explicit } = await api(dashboard, "/api/projects", {
      projectName: "用户创建的空项目",
      projectDirectory: explicitDirectory
    });
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    await store.createTask("isolated-old-task", {
      goal: "隔离模拟旧测试历史",
      projectDirectory: oldDirectory
    });
    const registered = await api(dashboard, "/api/tasks");
    const old = registered.projects.find((project) => project.projectDirectory === oldDirectory);
    expect(old.legacy).toBe(true);
    expect(old.tasks).toHaveLength(1);
    await store.updateTask("isolated-old-task", { archived: true });
    await page.goto(dashboard.base);
    await expect(page.locator(`.project-group[data-project="${old.projectId}"]`)).toHaveCount(0);
    await expect(page.locator(`.project-group[data-project="${explicit.projectId}"]`)).toContainText(
      "还没有对话"
    );
    // Remove only the task created in this test's mkdtemp directory.
    await rm(join(dashboard.workspaceRoot, "isolated-old-task"), { recursive: true, force: true });
    const orphaned = await api(dashboard, "/api/tasks");
    expect(orphaned.tasks).toHaveLength(0);
    expect(orphaned.projects.some((project) => project.projectId === old.projectId)).toBe(false);
    const catalog = JSON.parse(await readFile(join(dashboard.root, "projects.json"), "utf8"));
    expect(catalog.projects.some((project) => project.projectId === old.projectId)).toBe(true);
    await page.reload();
    await expect(page.locator(`.project-group[data-project="${old.projectId}"]`)).toHaveCount(0);
    await dashboard.restart();
    await page.reload();
    await expect(page.locator(`.project-group[data-project="${old.projectId}"]`)).toHaveCount(0);
    await expect(page.locator(`.project-group[data-project="${explicit.projectId}"]`)).toContainText(
      "用户创建的空项目"
    );
    await page.screenshot({ path: join(evidence, "legacy-empty-project.png"), fullPage: true });
    await writeFile(
      join(evidence, "legacy-empty-project.json"),
      JSON.stringify(
        {
          scenario:
            "orphaned legacy records are hidden without removing their indexes or explicit empty projects",
          registered,
          orphaned,
          persistedAfterRestart: true,
          explicitEmptyProjectPreserved: true,
          limitation:
            "This reproduces the migration/display mechanism, not the origin of the real user screenshot data."
        },
        null,
        2
      )
    );
  } finally {
    await dashboard.stop();
  }
});
