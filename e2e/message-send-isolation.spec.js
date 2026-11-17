import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

async function select(page, taskId) {
  await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
  await expect(page.locator(`.conversation-item[data-task="${taskId}"]`)).toHaveClass(/active/);
}

async function seed(page, dashboard) {
  for (const taskId of ["task-a", "task-b"])
    expect(
      (
        await page.request.post(`${dashboard.base}/api/tasks`, {
          data: { taskId, goal: taskId }
        })
      ).ok()
    ).toBe(true);
  await page.goto(dashboard.base);
}

for (const failed of ["task-a", "task-b"])
  test(`independent sends stay gated by their own conversation when ${failed} fails`, async ({ page }) => {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    const gates = { "task-a": deferred(), "task-b": deferred() };
    const calls = { "task-a": 0, "task-b": 0 };
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.route("**/run", async (route) => {
        const taskId = new URL(route.request().url()).pathname.split("/")[3];
        calls[taskId] += 1;
        await gates[taskId].promise;
        await route.fulfill({
          status: taskId === failed ? 500 : 202,
          json: taskId === failed ? { error: "本地测试拒绝" } : { runId: `accepted-${taskId}` }
        });
      });
      await seed(page, dashboard);
      await select(page, "task-a");
      await page.locator("#composer-input").fill("A 的待返回请求");
      await page.locator("#send-button").click();
      await expect.poll(() => calls["task-a"]).toBe(1);
      await select(page, "task-b");
      await page.locator("#composer-input").fill("B 的独立请求");
      await expect(page.locator("#send-button")).toBeEnabled({ timeout: 2500 });
      await page.locator("#send-button").click();
      await expect.poll(() => calls["task-b"]).toBe(1);
      await expect(page.locator("#send-button")).toBeDisabled();
      await select(page, "task-a");
      await expect(page.locator("#send-button")).toBeDisabled();
      await page.locator("#composer-input").press("Enter");
      expect(calls["task-a"]).toBe(1);
      await select(page, "task-b");
      const aResponse = page.waitForResponse((response) => response.url().endsWith("/task-a/run"));
      gates["task-a"].resolve();
      await (await aResponse).finished();
      await select(page, "task-a");
      await expect(page.locator("#send-button")).toBeEnabled();
      await select(page, "task-b");
      await expect(page.locator("#send-button")).toBeDisabled();
      await page.locator("#composer-input").press("Enter");
      expect(calls["task-b"]).toBe(1);
      gates["task-b"].resolve();
      await expect(page.locator("#send-button")).toBeEnabled();
      // Navigation keeps the original draft; this gate change does not alter
      // the existing background-send draft retention contract.
      await expect(page.locator("#composer-input")).toHaveValue("B 的独立请求");
      expect(errors).toEqual([]);
    } finally {
      Object.values(gates).forEach((gate) => gate.resolve());
      await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      await dashboard.stop();
    }
  });

test("new drafts keep separate send identities across navigation and task creation", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const creationGates = [deferred(), deferred()];
  const runGates = [deferred(), deferred()];
  const creations = [];
  const runs = [];
  try {
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const index = creations.length;
      creations.push(route.request().postDataJSON());
      await creationGates[index].promise;
      await route.fulfill({ response: await route.fetch() });
    });
    await page.route("**/run", async (route) => {
      const body = route.request().postDataJSON();
      const index = body.prompt === "第一份新草稿" ? 0 : 1;
      runs.push({ ...body, taskId: new URL(route.request().url()).pathname.split("/")[3] });
      await runGates[index].promise;
      await route.fulfill({ status: 202, json: { runId: `new-draft-run-${index}` } });
    });
    await seed(page, dashboard);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("第一份新草稿");
    await page.locator("#send-button").click();
    await expect.poll(() => creations.length).toBe(1);
    await select(page, "task-b");
    await expect(page.locator("#send-button")).toBeEnabled({ timeout: 2500 });
    await page.locator("#new-conversation").click();
    await expect(page.locator("#composer-input")).toHaveValue("第一份新草稿");
    await expect(page.locator("#send-button")).toBeDisabled();
    await page.locator("#composer-input").press("Enter");
    expect(creations).toHaveLength(1);
    await page.locator("#new-conversation").click();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("第二份新草稿");
    await expect(page.locator("#send-button")).toBeEnabled();
    await page.locator("#send-button").click();
    await expect.poll(() => creations.length).toBe(2);
    creationGates[1].resolve();
    await expect.poll(() => runs.length).toBe(1);
    expect(runs[0].taskId).toBe(creations[1].taskId);
    await expect(page.locator("#send-button")).toBeDisabled();
    await select(page, "task-b");
    await select(page, creations[1].taskId);
    await expect(page.locator("#send-button")).toBeDisabled();
    await page.locator("#composer-input").press("Enter");
    expect(runs).toHaveLength(1);
    creationGates[0].resolve();
    await expect.poll(() => runs.length).toBe(2);
    expect(runs[1].taskId).toBe(creations[0].taskId);
    runGates[0].resolve();
    await expect(page.locator(`.conversation-item[data-task="${creations[0].taskId}"]`)).toBeVisible();
    await select(page, creations[0].taskId);
    await expect(page.locator("#send-button")).toBeEnabled();
    await select(page, creations[1].taskId);
    await expect(page.locator("#send-button")).toBeDisabled();
    runGates[1].resolve();
    await expect(page.locator("#send-button")).toBeEnabled();
  } finally {
    [...creationGates, ...runGates].forEach((gate) => gate.resolve());
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("a new draft is independent after the previous draft becomes a task", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const gate = deferred();
  const runs = [];
  try {
    await page.route("**/run", async (route) => {
      const body = route.request().postDataJSON();
      runs.push({ ...body, taskId: new URL(route.request().url()).pathname.split("/")[3] });
      if (body.prompt === "已创建任务的第一份草稿") await gate.promise;
      await route.fulfill({ status: 202, json: { runId: `independent-run-${runs.length}` } });
    });
    await seed(page, dashboard);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("已创建任务的第一份草稿");
    await page.locator("#send-button").click();
    await expect.poll(() => runs.length).toBe(1);
    await expect(page.locator(`.conversation-item[data-task="${runs[0].taskId}"]`)).toHaveClass(/active/);
    await page.locator("#new-conversation").click();
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("创建之后的独立新草稿");
    await expect(page.locator("#send-button")).toBeEnabled({ timeout: 2500 });
    await page.locator("#send-button").click();
    await expect.poll(() => runs.length).toBe(2);
    expect(runs[1].taskId).not.toBe(runs[0].taskId);
    await select(page, runs[0].taskId);
    await expect(page.locator("#send-button")).toBeDisabled();
    await page.locator("#composer-input").press("Enter");
    expect(runs).toHaveLength(2);
    gate.resolve();
    await expect(page.locator("#send-button")).toBeEnabled();
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("a server-created task stays gated before its creation response reaches the composer", async ({
  page
}) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const gate = deferred();
  let createdTask;
  const runs = [];
  try {
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      createdTask = await response.json();
      await gate.promise;
      await route.fulfill({ response });
    });
    await page.route("**/run", async (route) => {
      runs.push({ url: route.request().url(), ...route.request().postDataJSON() });
      await route.fulfill({ status: 202, json: { runId: "created-before-response-run" } });
    });
    await seed(page, dashboard);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("创建回包前的原始请求");
    await page.locator("#send-button").click();
    await expect.poll(() => createdTask?.taskId).toBeTruthy();
    // The real server has committed the Task. Its ordinary catalog poll can
    // expose it even though the POST response is still held back.
    await expect(page.locator(`.conversation-item[data-task="${createdTask.taskId}"]`)).toBeVisible();
    await select(page, createdTask.taskId);
    await page.locator("#composer-input").fill("创建还未回包时不能重复发送");
    await page.locator("#composer-input").press("Enter");
    await expect(page.locator("#send-button")).toBeDisabled();
    expect(runs).toHaveLength(0);
    gate.resolve();
    await expect.poll(() => runs.length).toBe(1);
    expect(new URL(runs[0].url).pathname).toBe(`/api/tasks/${createdTask.taskId}/run`);
    expect(runs[0].prompt).toBe("创建回包前的原始请求");
    await expect(page.locator("#send-button")).toBeEnabled();
    await expect(page.locator("#composer-input")).toHaveValue("创建还未回包时不能重复发送");
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await dashboard.stop();
  }
});

test("late creation preserves the newer saved task draft and a deliberate clear after reload", async ({
  page
}) => {
  for (const nextDraft of ["创建回包前写的下一条", ""]) {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    const gate = deferred();
    let createdTask;
    const runs = [];
    try {
      await page.route("**/api/tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        createdTask = await response.json();
        await gate.promise;
        await route.fulfill({ response });
      });
      await page.route("**/run", async (route) => {
        runs.push(route.request().postDataJSON());
        await route.fulfill({ status: 202, json: { runId: "late-created-draft-run" } });
      });
      await seed(page, dashboard);
      await page.locator("#new-conversation").click();
      await page.locator("#composer-input").fill("原始请求不得覆盖后续草稿");
      await page.locator("#send-button").click();
      await expect.poll(() => createdTask?.taskId).toBeTruthy();
      await expect(page.locator(`.conversation-item[data-task="${createdTask.taskId}"]`)).toBeVisible();
      await select(page, createdTask.taskId);
      await page.locator("#composer-input").fill("人工写入的后续草稿");
      await page.locator("#composer-input").fill(nextDraft);
      gate.resolve();
      await expect.poll(() => runs.length).toBe(1);
      expect(runs[0].prompt).toBe("原始请求不得覆盖后续草稿");
      await expect(page.locator("#send-button")).toBeEnabled();
      // A normal pagehide saves the still-correct DOM again. Check the actual
      // durable draft first so that this cannot conceal the stale overwrite.
      const persisted = await page.evaluate((taskId) => {
        // Drafts are namespaced by backend identity; find this Task's slot.
        const key = Object.keys(localStorage).find(
          (entry) => entry.startsWith("atria.composer.v1:") && entry.endsWith(`:${taskId}`)
        );
        const draft = key ? localStorage.getItem(key) : null;
        return draft === null ? "" : JSON.parse(draft).text;
      }, createdTask.taskId);
      expect(persisted).toBe(nextDraft);
      await page.reload();
      await expect(page.locator(`.conversation-item[data-task="${createdTask.taskId}"]`)).toHaveClass(
        /active/
      );
      await expect(page.locator("#composer-input")).toHaveValue(nextDraft);
    } finally {
      gate.resolve();
      await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      await dashboard.stop();
    }
  }
});

test("a message on its way leaves the composer looking empty and a failure shows it again", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  const gates = [deferred(), deferred()];
  let calls = 0;
  try {
    await page.route("**/run", async (route) => {
      const index = calls++;
      await gates[index].promise;
      await route.fulfill(
        index === 0
          ? { status: 500, json: { error: "本地测试拒绝" } }
          : { status: 202, json: { runId: "accepted-after-retry" } }
      );
    });
    await seed(page, dashboard);
    await select(page, "task-a");
    const input = page.locator("#composer-input");
    await input.fill("正在发送的消息");
    await page.locator("#send-button").click();
    await expect.poll(() => calls).toBe(1);
    await expect(input).toHaveClass(/is-sent/);
    await expect(input).toHaveValue("正在发送的消息");
    gates[0].resolve();
    await expect(input).not.toHaveClass(/is-sent/);
    await expect(input).toHaveValue("正在发送的消息");
    await page.locator("#send-button").click();
    await expect.poll(() => calls).toBe(2);
    await expect(input).toHaveClass(/is-sent/);
    gates[1].resolve();
    await expect(input).toHaveValue("");
    await expect(input).not.toHaveClass(/is-sent/);
  } finally {
    gates.forEach((gate) => gate.resolve());
    await dashboard.stop();
  }
});
