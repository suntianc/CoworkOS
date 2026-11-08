import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { readFixtureRequestBody } from "../test/http-request-body-fixture.mjs";
import { protocolStream } from "../test/model-protocol-fixture.mjs";

/**
 * One person's session across the whole P3 surface.
 *
 * The page talks to a real Dashboard with the default SQLite project data; the
 * only substitute is a local fake model. The flow deliberately crosses the
 * views — project, ledger, board, Main sessions, external capacity, model
 * settings — because the risk this covers is the composition, not each view on
 * its own: a draft, an attachment, a run and a saved override must stay with
 * the project and session they belong to while the person switches around.
 *
 * Set `P3_EVIDENCE_DIR` to also drop the screenshots and the action log outside
 * the repository; `testInfo.attach` always keeps them with the Playwright run.
 */

const evidenceRoot = process.env.P3_EVIDENCE_DIR;

async function modelService() {
  const requests = [];
  const held = new Set();
  const waiters = new Map();
  const tagOf = (body) => {
    const text = (body.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      )
      .join("\n");
    return [...text.matchAll(/\[tag:([a-z0-9-]+)\]/g)].at(-1)?.[1];
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    const body = JSON.parse(await readFixtureRequestBody(request));
    const tag = tagOf(body);
    requests.push({ tag, model: body.model, messages: body.messages?.length });
    if (tag && held.has(tag))
      await new Promise((resolve) => {
        const list = waiters.get(tag) ?? [];
        list.push(resolve);
        waiters.set(tag, list);
      });
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(protocolStream("openai-completions", { text: `模型回复 ${tag ?? ""}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    hold(tag) {
      held.add(tag);
    },
    release(tag) {
      held.delete(tag);
      for (const resolve of waiters.get(tag) ?? []) resolve();
      waiters.delete(tag);
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  };
}

const projectGroup = (page, projectId) => page.locator(`.project-group[data-project="${projectId}"]`);
const conversation = (page, taskId) => page.locator(`.conversation-item[data-task="${taskId}"]`);
const dialogNamed = (page, name) => page.getByRole("dialog", { name, exact: true });

test("a person moves between project, ledger, board, sessions, capacity and model settings without losing drafts or run ownership", async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const model = await modelService();
  // A host with a configured connection: the page edits it like a person
  // would, so no launch-environment connection overrides those settings.
  const dashboard = await startDashboard({
    defaultProject: false,
    config: { mainCapacity: { resident: 2, continuation: 0 } }
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const actions = [];
  const shot = async (name) => {
    const png = await page.screenshot({ fullPage: false });
    await testInfo.attach(name, { body: png, contentType: "image/png" });
    if (evidenceRoot) await writeFile(join(evidenceRoot, `${name}.png`), png);
  };
  const record = (name, detail = {}) => actions.push({ name, url: page.url(), ...detail });
  const api = async (path, body) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data: body });
    expect(response.status(), `${path} ${JSON.stringify(body)}`).toBeLessThan(300);
    return response.json();
  };
  const identity = async () => {
    const data = await (await page.request.get(`${dashboard.base}/api/project-data`)).json();
    return { pid: dashboard.child.pid, root: dashboard.root, ...data };
  };

  try {
    const projects = [];
    for (const [name, slug] of [
      ["登录项目", "login"],
      ["报表项目", "report"]
    ]) {
      const directory = join(dashboard.root, `project-${slug}`);
      await mkdir(directory, { recursive: true });
      const created = await api("/api/projects", { projectName: name, projectDirectory: directory });
      projects.push(created.project);
    }
    const [login, report] = projects;
    await api("/api/model-settings", {
      profileName: "主机默认",
      baseUrl: model.base,
      model: "fixture-model",
      api: "openai-completions",
      apiKey: "fixture-host-key",
      supportsImages: false,
      supportsReasoningEffort: true,
      reasoningEffort: "low"
    });
    await api("/api/model-settings", {
      profileId: "",
      profileName: "项目覆盖",
      baseUrl: model.base,
      model: "model-project",
      api: "openai-completions",
      apiKey: "fixture-project-key",
      supportsImages: false,
      supportsReasoningEffort: true,
      reasoningEffort: "low"
    });

    // External demands arrive through the controlled entry; the page shows them.
    const externalOne = (
      await api(`/api/projects/${encodeURIComponent(login.projectId)}/main-sessions`, {
        action: "create",
        title: "外部需求一",
        entryKind: "external"
      })
    ).session;
    const externalTwo = (
      await api(`/api/projects/${encodeURIComponent(report.projectId)}/main-sessions`, {
        action: "create",
        title: "外部需求二",
        entryKind: "external"
      })
    ).session;

    await page.goto(dashboard.base);
    await expect(projectGroup(page, login.projectId)).toBeVisible();
    record("projects", {
      projects: projects.map((project) => [project.projectId, project.projectDirectory]),
      identity: await identity()
    });

    // Ledger: an internal need is recorded and visible for its project.
    await page.locator("#ledger-nav").click();
    let ledger = dialogNamed(page, "需求台账");
    await ledger.getByLabel("台账项目").selectOption(login.projectId);
    await ledger.getByLabel("需求标题").fill("登录记住设备");
    await ledger.getByLabel("需求内容").fill("同一台设备 30 天内不再验证，敏感操作仍需确认。");
    await ledger.getByRole("button", { name: "记录需求", exact: true }).click();
    await expect(ledger.locator("[data-requirement]")).toHaveCount(1);
    await expect(ledger.locator("[data-requirement]")).toContainText("登录记住设备");
    await ledger.locator("[data-requirement]").click();
    await expect(ledger.locator("[data-detail]")).toContainText("敏感操作仍需确认");
    await shot("01-ledger");
    record("ledger", { requirements: await ledger.locator("[data-requirement]").count() });
    await ledger.getByRole("button", { name: "关闭需求台账" }).click();

    // Board: the internal need is not there; an external publish is claimed.
    await page.locator("#board-nav").click();
    const board = dialogNamed(page, "需求看板");
    await board.getByLabel("看板项目").selectOption(login.projectId);
    await expect(board.locator("[data-list]")).toContainText("没有看板需求");
    await shot("02-board-internal-only");
    await board.getByLabel("看板需求标题").fill("开放登录问题");
    await board.getByLabel("看板需求内容").fill("外部渠道报告：部分设备无法登录。");
    await board.getByLabel("外部来源").fill("外部渠道");
    await board.getByRole("button", { name: "发布需求", exact: true }).click();
    await expect(board.locator("[data-board]")).toHaveCount(1);
    await expect(board.locator("[data-board]")).toContainText("待认领");
    await board.locator("[data-board]").click();
    await expect(board.locator("[data-assignee]")).toContainText("尚未认领");
    await board.getByRole("button", { name: "认领", exact: true }).click();
    await expect(board.locator("[data-assignee]")).toContainText("归属：用户");
    await expect(board.locator("[data-board]")).toContainText("已认领");
    await shot("03-board-claimed");
    const boardEntry = (
      await (
        await page.request.get(`${dashboard.base}/api/projects/${encodeURIComponent(login.projectId)}/board`)
      ).json()
    ).entries[0];
    record("board", { boardId: boardEntry.boardId, state: boardEntry.state });
    await board.getByRole("button", { name: "关闭需求看板" }).click();

    // Main sessions: creating one on the page opens its conversation.
    await page.locator("#main-sessions-nav").click();
    let sessions = dialogNamed(page, "Main 会话");
    await sessions.getByLabel("会话项目").selectOption(login.projectId);
    await sessions.getByLabel("新会话名称").fill("登录改造");
    await sessions.getByRole("button", { name: "新建会话", exact: true }).click();
    await expect(sessions).toBeHidden();
    const listed = await (
      await page.request.get(
        `${dashboard.base}/api/projects/${encodeURIComponent(login.projectId)}/main-sessions`
      )
    ).json();
    const loginSession = listed.sessions.find((entry) => entry.title === "登录改造");
    expect(loginSession).toBeTruthy();
    await expect(page.locator("#topbar-task")).toHaveText("登录改造");
    // The list keeps the session, and a saved session is not a running one.
    await page.locator("#main-sessions-nav").click();
    sessions = dialogNamed(page, "Main 会话");
    const listedSession = sessions.locator(`[data-session="${loginSession.sessionId}"]`);
    await expect(listedSession).toContainText("登录改造");
    await expect(listedSession).toContainText("内部");
    await expect(listedSession).toContainText("常规");
    await shot("04-main-sessions");
    await sessions.getByRole("button", { name: "关闭 Main 会话" }).click();
    record("main-session", { sessionId: loginSession.sessionId, taskId: loginSession.taskId });

    // A draft and an attachment belong to this conversation's project.
    await page.locator("#composer-input").fill("登录改造的未发送草稿 [tag:login-draft]");
    await page
      .locator("#file-input")
      .setInputFiles({ name: "登录说明.txt", mimeType: "text/plain", buffer: Buffer.from("登录约束") });
    await expect(page.locator("#attachment-strip")).toContainText("登录说明.txt");
    await conversation(page, externalTwo.taskId).click();
    await expect(page.locator("#topbar-task")).toHaveText("外部需求二");
    await expect(page.locator("#composer-input")).toHaveValue("");
    await page.locator("#composer-input").fill("报表项目的独立草稿");
    await conversation(page, loginSession.taskId).click();
    await expect(page.locator("#topbar-task")).toHaveText("登录改造");
    await expect(page.locator("#composer-input")).toHaveValue("登录改造的未发送草稿 [tag:login-draft]");
    await expect(page.locator("#attachment-strip")).toContainText("登录说明.txt");
    await shot("05-draft-restored");
    record("draft", { attachment: "登录说明.txt" });

    // Model settings: the page saves the project's Main override and reads back
    // which source is in effect.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator("#desktop-model-settings").click();
    const modelDialog = dialogNamed(page, "连接模型");
    await expect(modelDialog.locator("[data-role-host]")).toBeVisible();
    await modelDialog.getByLabel("Main 角色默认连接").selectOption({ label: "主机默认" });
    await expect(modelDialog.locator("[data-role-effective]")).toContainText("主机默认");
    await expect(modelDialog.locator("[data-role-effective]")).toContainText("（主机默认）");
    await modelDialog.getByLabel("当前项目的 Main 模型连接").selectOption({ label: "项目覆盖" });
    await expect(modelDialog.locator("[data-role-effective]")).toContainText("model-project");
    await expect(modelDialog.locator("[data-role-effective]")).toContainText("（项目覆盖）");
    await shot("06-model-roles");
    record("model-roles", { effective: await modelDialog.locator("[data-role-effective]").innerText() });
    // Opening the model page replaced the settings overview, so closing it
    // returns to the page, not to a second close button.
    await modelDialog.getByRole("button", { name: "关闭设置" }).click();
    await expect(modelDialog).toBeHidden();
    await expect(page.locator("#profile-modal")).toBeHidden();

    // Capacity: the page saves the fixed slots the external service will have.
    await page.locator("#main-capacity-nav").click();
    let capacity = dialogNamed(page, "外部容量");
    await capacity.getByLabel("常驻 Main 配额").fill("1");
    await capacity.getByLabel("接续 Main 配额").fill("0");
    await capacity.getByRole("button", { name: "保存", exact: true }).click();
    await expect(capacity.getByLabel("常驻 Main 配额")).toHaveValue("1");
    await expect(capacity.locator("[data-running]")).toContainText("没有运行中的外部 Main");
    await shot("07-capacity");
    await capacity.getByRole("button", { name: "关闭外部容量" }).click();

    // One running demand fills the only slot; the demand from the other
    // project waits. The page reports both from the real service.
    model.hold("run-one");
    await conversation(page, externalOne.taskId).click();
    await page.locator("#composer-input").fill("处理外部需求一 [tag:run-one]");
    await page.locator("#send-button").click();
    await expect(conversation(page, externalOne.taskId).locator(".conversation-activity")).toHaveAttribute(
      "data-state",
      "running"
    );
    await page.locator("#main-capacity-nav").click();
    capacity = dialogNamed(page, "外部容量");
    await expect(capacity.locator("[data-running]")).toContainText(externalOne.taskId);
    await page.getByRole("button", { name: "关闭外部容量" }).click();

    // Switching projects while the Run is in flight must not move its owner.
    await conversation(page, externalTwo.taskId).click();
    await page.locator("#composer-input").fill("处理外部需求二 [tag:run-two]");
    await page.locator("#send-button").click();
    await page.locator("#main-capacity-nav").click();
    capacity = dialogNamed(page, "外部容量");
    await expect(capacity.locator("[data-running]")).toContainText(externalOne.taskId);
    await expect(capacity.locator("[data-queued]")).toContainText("报表项目");
    await expect(capacity.locator("[data-queued]")).toContainText("第 1 位");
    await expect(capacity.locator("[data-queued]")).toContainText("页面");
    await shot("08-capacity-queue");
    const inFlight = await (
      await page.request.get(`${dashboard.base}/api/tasks/${encodeURIComponent(externalOne.taskId)}`)
    ).json();
    expect(inFlight.projectId).toBe(login.projectId);
    expect(inFlight.runtime.active).toBe(true);
    expect(inFlight.task.activeRunId).toBeTruthy();
    record("in-flight-ownership", {
      taskId: externalOne.taskId,
      projectId: inFlight.projectId,
      runId: inFlight.task.activeRunId,
      queued: externalTwo.taskId
    });
    await page.getByRole("button", { name: "关闭外部容量" }).click();

    // Returning to the first project shows its Run still there and the other
    // project's conversation has no borrowed answer.
    await conversation(page, externalOne.taskId).click();
    await expect(conversation(page, externalOne.taskId).locator(".conversation-activity")).toHaveAttribute(
      "data-state",
      "running"
    );
    await expect(page.locator("#conversation")).not.toContainText("模型回复 run-two");

    // Finishing the running demand advances the queued one, in order.
    model.release("run-one");
    await expect(page.locator("#conversation")).toContainText("模型回复 run-one", { timeout: 60_000 });
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${dashboard.base}/api/main-capacity`)).json()).running.length,
        { timeout: 60_000 }
      )
      .toBe(0);
    await conversation(page, externalTwo.taskId).click();
    await expect(page.locator("#conversation")).toContainText("模型回复 run-two", { timeout: 60_000 });
    await page.locator("#main-capacity-nav").click();
    capacity = dialogNamed(page, "外部容量");
    await expect(capacity.locator("[data-running]")).toContainText("没有运行中的外部 Main");
    await expect(capacity.locator("[data-queued]")).toContainText("没有排队的 Main");
    await shot("09-capacity-drained");
    await capacity.getByRole("button", { name: "关闭外部容量" }).click();

    // The two conversations keep their own history, and the run that waited
    // saw only its own prompt.
    await conversation(page, externalOne.taskId).click();
    await expect(page.locator("#conversation")).toContainText("处理外部需求一");
    await expect(page.locator("#conversation")).not.toContainText("处理外部需求二");
    await conversation(page, externalTwo.taskId).click();
    await expect(page.locator("#conversation")).toContainText("处理外部需求二");
    await expect(page.locator("#conversation")).not.toContainText("处理外部需求一");
    await shot("10-history-separation");
    record("model-requests", {
      tags: model.requests.map((entry) => entry.tag),
      identity: await identity()
    });

    expect(errors).toEqual([]);
    if (evidenceRoot)
      await writeFile(join(evidenceRoot, "ui-actions.json"), JSON.stringify({ actions }, null, 2));
  } finally {
    await dashboard.stop();
    await model.stop();
  }
});
