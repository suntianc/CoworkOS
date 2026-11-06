import { useApplicationInConversation } from "./workbench-menu-helper.js";
import { openSaveCopy } from "./application-file-helper.js";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

async function dropFile(page, selector, name, text, type = "text/plain") {
  // Browser-generated DataTransfer exercises routing/import; this is not native OS file drag.
  await page.locator(selector).evaluate(
    (target, { name, text, type }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([text], name, { type }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
    },
    { name, text, type }
  );
}

test("composer drop without a project creates a real temporary Main run and restores its attachment and draft ownership", async ({
  page
}) => {
  const model = await modelProtocolFixture("openai-completions");
  const d = await startDashboard({
    modelEndpoint: model.baseUrl,
    model: "protocol-fixture",
    defaultProject: false
  });
  try {
    await page.goto(d.base);
    await dropFile(page, ".composer", "input.txt", "Retained attachment\n");
    await expect(page.locator("#attachment-strip")).toContainText("input.txt");
    await expect(
      page.getByText("请将文件拖入对话输入区或应用编辑区；当前内容已保留。", { exact: true })
    ).toHaveCount(0);
    await page.locator("#composer-input").fill("Process the attached file");
    await page.locator("#send-button").click();
    await expect(page.locator("#project-modal")).toHaveCount(0);
    await expect
      .poll(async () => (await (await page.request.get(d.base + "/api/tasks")).json()).tasks[0]?.status, {
        timeout: 30_000
      })
      .toBe("completed");
    expect(model.requests.length).toBeGreaterThan(0);
    const listing = await (await page.request.get(d.base + "/api/tasks")).json();
    expect(listing.projects).toEqual([]);
    expect(listing.tasks).toHaveLength(1);
    const task = listing.tasks[0];
    expect(task.projectId).toBeNull();
    expect(task.temporaryWorkspaceRoot).toBeTruthy();
    expect(JSON.stringify(model.requests)).toContain("input.txt");
    await page.locator("#composer-input").fill("Unsent follow-up draft");
    // Web drafts are origin scoped; native port changes use the preload mirror.
    await d.restart();
    await page.goto(d.base);
    await page.locator(`#project-list button[data-task="${task.taskId}"]`).click();
    await expect(page.locator("#composer-input")).toHaveValue("Unsent follow-up draft");
    const inputRoot = join(d.workspaceRoot, task.taskId, "inputs");
    const entries = await readdir(inputRoot);
    expect(entries.filter((entry) => entry.startsWith("upload-"))).toHaveLength(1);
    const uploadId = entries.find((entry) => entry.startsWith("upload-"));
    expect(await readFile(join(inputRoot, uploadId, "original.txt"), "utf8")).toBe("Retained attachment\n");
  } finally {
    await d.stop();
    await model.close();
  }
});
