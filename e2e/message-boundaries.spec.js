import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function finishNavigationResponse(page, response) {
  await response.finished();
  // Wait for the renderer's response continuation and the resulting paint.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

async function seedConversations(page, dashboard) {
  for (const taskId of ["task-a", "task-b"])
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal: taskId === "task-a" ? "原会话 A" : "另一会话 B" }
    });
}

async function select(page, taskId) {
  await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
  await expect(page.locator(`.conversation-item[data-task="${taskId}"]`)).toHaveClass(/active/);
}

async function attach(page, name, text) {
  await page.locator("#file-input").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(text)
  });
  await expect(page.locator("#attachment-strip")).toContainText(name);
}

for (const status of [200, 409])
  test(`late steering response ${status} stays with the original conversation and complete message`, async ({
    page
  }) => {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    const gate = deferred();
    const errors = [];
    const runs = [];
    let steering;
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await seedConversations(page, dashboard);
      const original = await (await page.request.get(`${dashboard.base}/api/tasks/task-a`)).json();
      await page.route("**/api/tasks/task-a", (route) =>
        route.fulfill({
          json: { ...original, task: { ...original.task, status: "running" }, runtime: { active: true } }
        })
      );
      await page.route("**/interject", async (route) => {
        steering = { url: route.request().url(), ...route.request().postDataJSON() };
        await gate.promise;
        await route.fulfill({
          status,
          json: status === 200 ? { messageId: "accepted-steer" } : { error: "当前没有正在运行的 Main" }
        });
      });
      await page.route("**/run", (route) => {
        runs.push({ url: route.request().url(), ...route.request().postDataJSON() });
        return route.fulfill({ status: 202, json: { runId: "fallback-run", model: "response-model-a" } });
      });
      await page.goto(dashboard.base);
      await select(page, "task-a");
      await expect(page.locator("#stop-button")).toBeVisible();
      await page.locator("#composer-input").fill("A 的原始补充");
      await attach(page, "source.txt", "ORIGINAL_ATTACHMENT_END");
      await page.locator("#send-button").click();
      await expect.poll(() => steering?.attachmentIds?.length).toBe(1);
      await page.locator("#composer-input").fill("A 等待期间写的下一条");
      await select(page, "task-b");
      await expect(page.locator("#composer-input")).toHaveValue("");
      await page.locator("#composer-input").fill("B 的独立未发送草稿");
      await attach(page, "b.txt", "B_ATTACHMENT");
      gate.resolve();
      await expect(page.locator("#send-button")).toBeEnabled();
      await expect(page.locator('.conversation-item[data-task="task-b"]')).toHaveClass(/active/);
      await expect(page.locator("#composer-input")).toHaveValue("B 的独立未发送草稿");
      await expect(page.locator("#attachment-strip")).toContainText("b.txt");
      await expect(page.locator("#conversation")).not.toContainText("A 的原始补充");
      await expect(page.locator("#model-select")).not.toContainText("response-model-a");
      expect(new URL(steering.url).pathname).toBe("/api/tasks/task-a/interject");
      expect(runs).toHaveLength(status === 409 ? 1 : 0);
      if (status === 409) {
        expect(new URL(runs[0].url).pathname).toBe("/api/tasks/task-a/run");
        expect(runs[0].prompt).toBe(steering.message);
        expect(runs[0].model).toBe("browser-fixture");
        expect(runs[0].resume).toBe(false);
      }
      await select(page, "task-a");
      await expect(page.locator("#composer-input")).toHaveValue("A 等待期间写的下一条");
      await expect(page.locator("#attachment-strip")).toContainText("source.txt");
      expect(errors).toEqual([]);
    } finally {
      gate.resolve();
      await dashboard.stop();
    }
  });

test("late follow-up 409 after completed cancellation cannot restart its task or consume either conversation's draft", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const gate = deferred();
  const errors = [];
  const runs = [];
  let active = true;
  let followUp;
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await seedConversations(page, dashboard);
    const original = await (await page.request.get(`${dashboard.base}/api/tasks/task-a`)).json();
    await page.route("**/api/tasks", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          tasks: body.tasks.map((task) =>
            task.taskId === "task-a" ? { ...task, status: active ? "running" : "cancelled" } : task
          )
        }
      });
    });
    await page.route("**/api/tasks/task-a", (route) =>
      route.fulfill({
        json: {
          ...original,
          task: { ...original.task, status: active ? "running" : "cancelled" },
          runtime: { active }
        }
      })
    );
    await page.route("**/api/tasks/task-a/interject", async (route) => {
      followUp = route.request().postDataJSON();
      await gate.promise;
      await route.fulfill({ status: 409, json: { error: "当前没有正在运行的 Main" } });
    });
    await page.route("**/api/tasks/task-a/action", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ action: "cancel" });
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      active = false;
      await route.fulfill({ response });
    });
    await page.route("**/run", (route) => {
      runs.push({ url: route.request().url(), ...route.request().postDataJSON() });
      return route.fulfill({ status: 202, json: { runId: "unexpected-restart" } });
    });
    await page.goto(dashboard.base);
    await select(page, "task-a");
    await page.locator("#composer-input").fill("停止后必须保留的原始补充");
    await attach(page, "cancelled-follow-up.txt", "FOLLOW_UP_ATTACHMENT_END");
    // ⌥Enter queues the message until the round ends.
    await page.locator("#composer-input").press("Alt+Enter");
    await expect.poll(() => followUp?.attachmentIds?.length).toBe(1);
    expect(followUp.delivery).toBe("followUp");

    await select(page, "task-b");
    await page.locator("#composer-input").fill("B 的独立未发送草稿");
    await attach(page, "independent-b.txt", "B_ATTACHMENT_END");
    await page.locator('[data-task="task-a"]').hover();
    await page.locator('.conversation-item[data-task="task-a"]').click({ button: "right" });
    const cancelled = page.waitForResponse((response) => response.url().endsWith("/api/tasks/task-a/action"));
    await page.locator('[data-session-action="stop"]').click();
    await finishNavigationResponse(page, await cancelled);
    // This toast is set only after stopTask's refresh finishes. Release the
    // interjection after the cancellation request and its local guard settle.
    await expect(page.locator("#toast")).toContainText("任务已停止");
    expect((await (await page.request.get(`${dashboard.base}/api/tasks/task-a`)).json()).task.status).toBe(
      "cancelled"
    );

    const rejected = page.waitForResponse((response) =>
      response.url().endsWith("/api/tasks/task-a/interject")
    );
    gate.resolve();
    await finishNavigationResponse(page, await rejected);
    await expect(page.locator("#send-button")).toBeEnabled();
    expect(runs).toEqual([]);
    await expect(page.locator('.conversation-item[data-task="task-b"]')).toHaveClass(/active/);
    await expect(page.locator("#composer-input")).toHaveValue("B 的独立未发送草稿");
    await expect(page.locator("#attachment-strip")).toContainText("independent-b.txt");

    await select(page, "task-a");
    await expect(page.locator("#composer-input")).toHaveValue("停止后必须保留的原始补充");
    await expect(page.locator("#attachment-strip")).toContainText("cancelled-follow-up.txt");
    await page.reload();
    await expect(page.locator("#composer-input")).toHaveValue("停止后必须保留的原始补充");
    await expect(page.locator("#attachment-strip")).toContainText("cancelled-follow-up.txt");
    expect(errors).toEqual([]);
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("late creation and run responses preserve navigation, independent drafts and original request settings", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const creationGate = deferred();
  const runGate = deferred();
  const errors = [];
  let creation, run;
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await seedConversations(page, dashboard);
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      creation = route.request().postDataJSON();
      await creationGate.promise;
      await route.fulfill({ response: await route.fetch() });
    });
    await page.route("**/run", async (route) => {
      run = { url: route.request().url(), ...route.request().postDataJSON() };
      await runGate.promise;
      await route.fulfill({ status: 202, json: { runId: "late-run", model: "late-response-model" } });
    });
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("新任务的原始指令");
    await attach(page, "new.txt", "NEW_ATTACHMENT_END");
    await page.locator("#send-button").click();
    await expect.poll(() => creation?.goal).toBe("新任务的原始指令");
    await page.keyboard.press("Meta+k");
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("慢请求期间新建的第二份草稿");
    await select(page, "task-b");
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("B 不可被创建回调覆盖");
    await attach(page, "b.txt", "B_FILE");
    creationGate.resolve();
    await expect.poll(() => run?.attachmentIds?.length).toBe(1);
    expect(new URL(run.url).pathname).toBe(`/api/tasks/${creation.taskId}/run`);
    expect(run.model).toBe("browser-fixture");
    expect(run.resume).toBe(false);
    await expect(page.locator('.conversation-item[data-task="task-b"]')).toHaveClass(/active/);
    await expect(page.locator("#composer-input")).toHaveValue("B 不可被创建回调覆盖");
    runGate.resolve();
    await expect(page.locator("#send-button")).toBeEnabled();
    await expect(page.locator('.conversation-item[data-task="task-b"]')).toHaveClass(/active/);
    await expect(page.locator("#composer-input")).toHaveValue("B 不可被创建回调覆盖");
    await expect(page.locator("#attachment-strip")).toContainText("b.txt");
    await expect(page.locator("#model-select")).not.toContainText("late-response-model");
    await expect(page.locator("#conversation")).not.toContainText("新任务的原始指令");
    await select(page, creation.taskId);
    await expect(page.locator("#composer-input")).toHaveValue("新任务的原始指令");
    await expect(page.locator("#attachment-strip")).toContainText("new.txt");
    await page.keyboard.press("Meta+k");
    await expect(page.locator("#composer-input")).toHaveValue("慢请求期间新建的第二份草稿");
    await expect(page.locator("#attachment-strip")).toBeHidden();
    await select(page, "task-b");
    await expect(page.locator("#composer-input")).toHaveValue("B 不可被创建回调覆盖");
    expect(errors).toEqual([]);
  } finally {
    creationGate.resolve();
    runGate.resolve();
    await dashboard.stop();
  }
});

test("attachment reading blocks premature sends and retires stale selection or conversation reads", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const errors = [];
  let runCount = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await seedConversations(page, dashboard);
    const releases = new Map();
    await page.route("**/api/uploads?name=*", async (route) => {
      const name = new URL(route.request().url()).searchParams.get("name");
      await new Promise((resolve) => releases.set(name, resolve));
      await route.continue().catch(() => {});
    });
    await page.route("**/run", (route) => {
      runCount += 1;
      return route.fulfill({ status: 202, json: { runId: "unexpected-run" } });
    });
    await page.goto(dashboard.base);
    await select(page, "task-a");
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("等待完整附件后才能发送");
    const pick = (name) =>
      page.locator("#file-input").setInputFiles({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from(name)
      });
    const release = async (name) => {
      await expect.poll(() => releases.has(name)).toBe(true);
      releases.get(name)();
    };
    await pick("old.txt");
    await expect(page.locator("#send-button")).toBeDisabled();
    await page.locator("#composer-input").press("Enter");
    await page.locator("[data-upload-cancel]").click();
    await release("old.txt");
    await expect(page.locator("#send-button")).toBeEnabled();
    await pick("new.txt");
    await release("new.txt");
    await expect(page.locator("#attachment-strip")).toContainText("new.txt");
    await expect(page.locator("#send-button")).toBeEnabled();
    await expect(page.locator("#attachment-strip")).toContainText("new.txt");
    await expect(page.locator("#attachment-strip")).not.toContainText("old.txt");
    expect(runCount).toBe(0);
    await pick("late-a.txt");
    await expect(page.locator("#send-button")).toBeDisabled();
    await select(page, "task-b");
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.locator("#send-button")).toBeEnabled();
    await page.locator("#composer-input").fill("B 的干净草稿");
    await release("late-a.txt");
    await expect(page.locator("#attachment-strip")).toBeHidden();
    await expect(page.locator("#composer-input")).toHaveValue("B 的干净草稿");
    await select(page, "task-a");
    await expect(page.locator("#attachment-strip")).toContainText("new.txt");
    await expect(page.locator("#attachment-strip")).not.toContainText("late-a.txt");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("sending during delayed conversation loading uses the selected task's model and running state", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const detailGate = deferred();
  let detailStarted = false,
    run,
    interjectCount = 0;
  try {
    await seedConversations(page, dashboard);
    const original = await (await page.request.get(`${dashboard.base}/api/tasks/task-a`)).json();
    await page.route("**/api/tasks/task-a", (route) =>
      route.fulfill({
        json: {
          ...original,
          task: { ...original.task, status: "running", model: "model-for-a" },
          runtime: { active: true, model: "model-for-a" },
          messages: [{ role: "user", content: "A 的既有历史不属于 B" }]
        }
      })
    );
    await page.route("**/interject", (route) => {
      interjectCount += 1;
      return route.fulfill({ json: { messageId: "wrong-steer" } });
    });
    await page.route("**/run", (route) => {
      run = { url: route.request().url(), ...route.request().postDataJSON() };
      return route.fulfill({ status: 202, json: { runId: "b-run", model: "browser-fixture" } });
    });
    await page.goto(dashboard.base);
    await select(page, "task-a");
    await expect(page.locator("#stop-button")).toBeVisible();
    await expect(page.locator("#model-select")).toContainText("model-for-a");
    await page.route("**/api/tasks/task-b", async (route) => {
      detailStarted = true;
      await detailGate.promise;
      await route.continue();
    });
    await select(page, "task-b");
    await expect.poll(() => detailStarted).toBe(true);
    await expect(page.locator("#stop-button")).toBeHidden();
    await expect(page.locator("#model-select")).toContainText("browser-fixture");
    await expect(page.locator("#conversation")).not.toContainText("A 的既有历史");
    await page.locator("#composer-input").fill("在 B 尚未载入时发送");
    await page.locator("#send-button").click();
    await expect.poll(() => run?.prompt).toBe("在 B 尚未载入时发送");
    expect(new URL(run.url).pathname).toBe("/api/tasks/task-b/run");
    expect(run.model).toBe("browser-fixture");
    expect(interjectCount).toBe(0);
    detailGate.resolve();
    await expect(page.locator("#send-button")).toBeEnabled();
  } finally {
    detailGate.resolve();
    await dashboard.stop();
  }
});

for (const destination of ["new", "task-b"])
  test(`a delayed tab activation PATCH cannot replace later navigation to ${destination}`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    const gate = deferred();
    let started = false;
    try {
      await seedConversations(page, dashboard);
      await page.goto(dashboard.base);
      await expect(page.locator('.conversation-item[data-task="task-b"]')).toBeVisible();
      await page.route("**/api/workbench/tabs", async (route) => {
        if (
          route.request().method() !== "PATCH" ||
          route.request().postDataJSON().tabId !== "conversation:task-a"
        )
          return route.continue();
        started = true;
        await gate.promise;
        await route.fulfill({ response: await route.fetch() });
      });
      await select(page, "task-a");
      await expect.poll(() => started).toBe(true);
      if (destination === "new") await page.locator("#new-conversation").click();
      else await select(page, destination);
      await page.locator("#composer-input").fill("后来选择的位置必须保留");
      const expectedActive = destination === "new" ? undefined : "conversation:task-b";
      const persistedActive = async () =>
        (await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json()).activeTabId;
      await expect.poll(persistedActive).toBe(expectedActive);
      const response = page.waitForResponse(
        (result) =>
          result.request().method() === "PATCH" &&
          result.request().postDataJSON()?.tabId === "conversation:task-a"
      );
      gate.resolve();
      await finishNavigationResponse(page, await response);
      await expect.poll(persistedActive).toBe(expectedActive);
      await expect(page.locator("#composer-input")).toHaveValue("后来选择的位置必须保留");
      if (destination === "new") await expect(page.locator(".conversation-item.active")).toHaveCount(0);
      else await expect(page.locator('.conversation-item[data-task="task-b"]')).toHaveClass(/active/);
      // Pin the obsolete server selection through the next explicit refresh as
      // well; a poll must not undo a local conversation or draft choice.
      await page.route("**/api/workbench/tabs", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const result = await (await route.fetch()).json();
        await route.fulfill({ json: { ...result, activeTabId: "conversation:task-a" } });
      });
      const refresh = page.waitForResponse(
        (result) => result.url().endsWith("/api/workbench/tabs") && result.request().method() === "GET"
      );
      await finishNavigationResponse(page, await refresh);
      await expect(page.locator("#composer-input")).toHaveValue("后来选择的位置必须保留");
      if (destination === "new") await expect(page.locator(".conversation-item.active")).toHaveCount(0);
      else await expect(page.locator('.conversation-item[data-task="task-b"]')).toHaveClass(/active/);
    } finally {
      gate.resolve();
      await dashboard.stop();
    }
  });
