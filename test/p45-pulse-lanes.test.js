import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createObserveRuns } from "../web/assets/controllers/observe-runs.js";

/**
 * The Runs view against a fake observation port.
 *
 * The port is the only seam: these tests describe what a person sees for two
 * nodes with capacities and Subagents, and that a node without activity is
 * drawn as stage blocks. The browser specs cover the same view over real
 * backends and real activity logs.
 */

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const minute = 60_000;
const at = (offset) => new Date(NOW + offset * minute).toISOString();

const samples = (length, active) =>
  Array.from({ length }, (_, index) =>
    active.some(([from, to]) => index >= from && index < to)
      ? { toolCalls: 2, outputBytes: 900 }
      : { toolCalls: 0, outputBytes: 0 }
  );

const agent = (overrides) => ({
  agentId: "main",
  name: "Formicand",
  role: "main",
  state: "running",
  stage: "working",
  stageChangedAt: at(-30),
  lastProgressAt: at(-1),
  samples: samples(30, [[0, 30]]),
  ...overrides
});

const activity = ({ from = -30, length = 30, agents }) => ({
  version: 1,
  sliceMs: minute,
  windowMs: 2 * 60 * minute,
  from: at(from),
  active: true,
  agents
});

const task = (overrides) => ({
  taskId: "task-1",
  status: "running",
  createdAt: at(-24),
  updatedAt: at(-1),
  projectId: "project-1",
  ...overrides
});

const session = (overrides) => ({
  sessionId: "session-1",
  taskId: "task-1",
  title: "评分汇总验收",
  kind: "regular",
  currentRequirementId: "requirement-1",
  currentRequirementTitle: "按分数文件汇总总分",
  ...overrides
});

function fixture({ nodes, scoped, reads = async () => ({}), reducedMotion = false, visible = true }) {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    CSS: globalThis.CSS,
    matchMedia: globalThis.matchMedia
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.CSS = { escape: (value) => value };
  window.matchMedia = (query) => ({ matches: reducedMotion, media: query, addEventListener() {} });
  const listeners = new Set();
  let filter = { nodeOrigin: "", projectId: "" };
  const data = {
    nodes: () => nodes,
    filter: () => ({ ...filter }),
    scoped: (next) => scoped(next),
    read: (origin, path, options) => reads(origin, path, options),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFilter(next) {
      filter = { ...filter, ...next };
      for (const listener of listeners) listener();
    }
  };
  const root = document.querySelector('[data-observe-panel="runs"]');
  const pane = document.querySelector("#observe-entry");
  const header = document.querySelector("[data-observe-runs-controls]");
  if (visible) {
    pane.hidden = false;
    root.hidden = false;
  }
  const controller = createObserveRuns({ root, header, data, now: () => NOW });
  return {
    root,
    pane,
    header,
    data,
    controller,
    restore() {
      controller.dispose();
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.CSS = previous.CSS;
      globalThis.matchMedia = previous.matchMedia;
    }
  };
}

const online = (origin, name, role, local = false) => ({
  origin,
  name,
  role,
  local,
  status: "online",
  lastSeen: undefined,
  error: ""
});

test("runs renders Main lanes, Subagent branches and the stage colouring", async (t) => {
  const node = online("http://local.test", "本机", "internal", true);
  const main = agent({
    stage: "idle",
    stageChangedAt: at(-17),
    lastProgressAt: at(-18),
    samples: samples(30, [[0, 6]])
  });
  const executor = agent({
    agentId: "subagent_1",
    name: "Ara",
    role: "subagent",
    workRole: "executor",
    state: "completed",
    stage: "completed",
    lastProgressAt: at(-23),
    samples: samples(30, [[2, 8]])
  });
  const reviewer = agent({
    agentId: "subagent_3",
    name: "Circinus",
    role: "subagent",
    workRole: "reviewer",
    state: "running",
    stage: "working",
    stageChangedAt: at(-14),
    lastProgressAt: at(-1),
    samples: samples(30, [[16, 30]])
  });
  const lane = task({
    activity: activity({ agents: [main, executor, reviewer] })
  });
  const view = fixture({
    nodes: [node],
    scoped: ({ nodeOrigin }) =>
      nodeOrigin === node.origin
        ? {
            projects: [{ projectId: "project-1", projectName: "P4 验收示例项目" }],
            tasks: [lane],
            requirements: []
          }
        : { projects: [], tasks: [], requirements: [] },
    reads: async (origin, path) => {
      if (path.endsWith("/main-sessions")) return { sessions: [session({ title: "评分汇总验收" })] };
      if (path.endsWith("/deliveries")) {
        const error = new Error("no development");
        error.status = 404;
        throw error;
      }
      return {};
    }
  });
  t.after(() => view.restore());

  await delay(60);
  assert.equal(view.root.dataset.window, "30");
  assert.equal(view.root.dataset.slices ?? undefined, undefined);
  assert.match(view.header.textContent, /实时/);
  assert.equal(view.header.querySelector("[data-runs-degraded]").hidden, true);

  const card = view.root.querySelector('[data-runs-node="http://local.test"]');
  assert.match(card.textContent, /本机/);
  assert.match(card.textContent, /对内/);

  const row = card.querySelector('[data-runs-lane="task-1"]');
  assert.equal(row.dataset.stage, "review");
  assert.equal(row.dataset.stalled, "false");
  assert.equal(row.dataset.degraded, "false");
  assert.match(row.textContent, /评分汇总验收/);
  assert.match(row.textContent, /审查/);
  assert.match(row.textContent, /P4 验收示例项目 · 按分数文件汇总总分/);
  assert.match(row.textContent, /24 分/);
  assert.equal(row.querySelectorAll(".runs-pulse.is-dev").length, 1);
  assert.equal(row.querySelectorAll(".runs-pulse.is-idle").length, 1);
  assert.equal(row.querySelectorAll(".runs-pulse.is-review").length, 1);
  assert.equal(row.querySelector(".runs-wave").dataset.slices, "30");

  const sub = card.querySelector('[data-runs-agent="subagent_1"]');
  assert.match(sub.textContent, /Executor/);
  assert.match(sub.textContent, /Ara/);
  assert.match(sub.textContent, /已完成/);
  assert.ok(sub.querySelector(".runs-done"));
  assert.equal(sub.dataset.state, "completed");

  const reviewBranch = card.querySelector('[data-runs-agent="subagent_3"]');
  assert.match(reviewBranch.textContent, /Reviewer/);
  assert.match(reviewBranch.textContent, /Circinus/);
  assert.ok(reviewBranch.querySelector(".runs-head"));

  // The window narrows the drawn range as well as the axis labels.
  view.header.querySelector('[data-runs-window="5"]').click();
  assert.equal(view.root.dataset.window, "5");
  assert.equal(view.root.querySelector('[data-runs-lane="task-1"] .runs-wave').dataset.slices, "5");
  assert.match(view.root.querySelector(".runs-axis").textContent, /-5 分/);
  assert.match(view.root.querySelector(".runs-axis").textContent, /现在/);

  view.header.querySelector('[data-runs-window="120"]').click();
  assert.equal(view.root.dataset.window, "120");
  assert.match(view.root.querySelector(".runs-axis").textContent, /-120 分/);
});

test("external capacity groups show usage and empty slots, and an offline node collapses", async (t) => {
  const local = online("http://local.test", "本机", "internal", true);
  const cloud = online("http://cloud.test", "云端", "external");
  const offline = {
    origin: "http://stale.test",
    name: "测试机",
    role: "internal",
    local: false,
    status: "offline",
    lastSeen: at(-120),
    error: ""
  };
  const dev = agent({ samples: samples(30, [[0, 30]]), lastProgressAt: at(-1), stageChangedAt: at(-30) });
  const idle = agent({
    stage: "idle",
    stageChangedAt: at(-179),
    lastProgressAt: at(-180),
    samples: samples(30, [])
  });
  const stalled = agent({
    stage: "idle",
    stageChangedAt: at(-12),
    lastProgressAt: at(-12),
    samples: samples(30, [[0, 12]])
  });
  const tasks = [
    task({
      taskId: "resident-1",
      createdAt: at(-60),
      activity: activity({ agents: [dev] })
    }),
    task({
      taskId: "resident-2",
      createdAt: at(-180),
      activity: activity({ from: -120, length: 120, agents: [idle] })
    }),
    task({
      taskId: "continuation-1",
      createdAt: at(-26),
      activity: activity({ agents: [stalled] })
    }),
    task({
      taskId: "continuation-2",
      createdAt: at(-18),
      activity: activity({
        agents: [
          agent({
            stage: "working",
            stageChangedAt: at(-18),
            lastProgressAt: at(-1),
            samples: samples(30, [[18, 30]])
          })
        ]
      })
    })
  ];
  const sessions = [
    session({ sessionId: "s1", taskId: "resident-1", title: "常驻 1", kind: "regular" }),
    session({ sessionId: "s2", taskId: "resident-2", title: "常驻 2", kind: "regular" }),
    session({
      sessionId: "s3",
      taskId: "continuation-1",
      title: "结算页文案",
      kind: "continuation",
      currentRequirementId: "requirement-2",
      currentRequirementTitle: "结算页文案"
    }),
    session({
      sessionId: "s4",
      taskId: "continuation-2",
      title: "发票抬头",
      kind: "continuation",
      currentRequirementId: "requirement-3",
      currentRequirementTitle: "发票抬头修改"
    })
  ];
  const view = fixture({
    nodes: [local, cloud, offline],
    scoped: ({ nodeOrigin }) => {
      if (nodeOrigin === local.origin)
        return {
          projects: [{ projectId: "local-project", projectName: "Formicand" }],
          tasks: [],
          requirements: []
        };
      if (nodeOrigin === cloud.origin)
        return {
          projects: [{ projectId: "cloud-project", projectName: "官网" }],
          tasks,
          requirements: []
        };
      return { projects: [], tasks: [], requirements: [] };
    },
    reads: async (origin, path) => {
      if (origin === cloud.origin && path === "/api/main-capacity")
        return {
          configured: true,
          settings: { resident: 3, continuation: 2 },
          running: [
            { taskId: "resident-1", kind: "regular" },
            { taskId: "resident-2", kind: "regular" },
            { taskId: "continuation-1", kind: "continuation" },
            { taskId: "continuation-2", kind: "continuation" }
          ],
          queued: []
        };
      if (origin === cloud.origin && path.endsWith("/main-sessions"))
        return {
          sessions: sessions.map((entry) => ({
            ...entry,
            currentRequirementTitle: entry.currentRequirementTitle
          }))
        };
      if (path.endsWith("/deliveries")) {
        const error = new Error("no development");
        error.status = 404;
        throw error;
      }
      return { sessions: [] };
    }
  });
  t.after(() => view.restore());

  await delay(80);
  const cloudCard = view.root.querySelector('[data-runs-node="http://cloud.test"]');
  assert.match(cloudCard.textContent, /对外/);
  const regular = cloudCard.querySelector('[data-runs-slot="regular"]');
  assert.match(regular.textContent, /常驻/);
  assert.match(regular.textContent, /2\/3/);
  assert.equal(regular.querySelectorAll(".runs-slot-seg.is-regular").length, 2);
  const continuation = cloudCard.querySelector('[data-runs-slot="continuation"]');
  assert.match(continuation.textContent, /2\/2/);

  const empty = [...cloudCard.querySelectorAll("[data-runs-empty]")].map((entry) => entry.textContent.trim());
  assert.ok(empty.includes("常驻 3"));

  const idleLane = cloudCard.querySelector('[data-runs-lane="resident-2"]');
  assert.equal(idleLane.dataset.stage, "wait");
  // Its last record is outside the selected window, but the silence is real.
  assert.equal(idleLane.dataset.stalled, "true");
  assert.match(idleLane.textContent, /3 小时/);
  assert.match(idleLane.querySelector("[data-runs-stall]").textContent, /3 小时无进展/);
  view.header.querySelector('[data-runs-window="5"]').click();
  assert.equal(view.root.dataset.window, "5");
  assert.equal(idleLane.dataset.stalled, "true");
  assert.match(
    cloudCard.querySelector('[data-runs-lane="resident-2"] [data-runs-stall]').textContent,
    /3 小时无进展/
  );
  view.header.querySelector('[data-runs-window="30"]').click();

  const stalledLane = cloudCard.querySelector('[data-runs-lane="continuation-1"]');
  assert.equal(stalledLane.dataset.stage, "wait");
  assert.equal(stalledLane.dataset.stalled, "true");
  assert.match(stalledLane.querySelector("[data-runs-stall]").textContent, /12 分无进展/);

  const offlineCard = view.root.querySelector('[data-runs-node="http://stale.test"]');
  assert.ok(offlineCard.classList.contains("is-offline"));
  assert.match(offlineCard.textContent, /测试机/);
  assert.match(offlineCard.textContent, /离线 · 2 小时前/);
  assert.equal(offlineCard.querySelectorAll("[data-runs-lane]").length, 0);
});

test("a node without metrics draws stage blocks and marks metrics not ready", async (t) => {
  const node = online("http://local.test", "本机", "internal", true);
  const lane = task({ taskId: "task-1", activity: undefined });
  const view = fixture({
    nodes: [node],
    reducedMotion: true,
    scoped: ({ nodeOrigin }) =>
      nodeOrigin === node.origin
        ? {
            projects: [{ projectId: "project-1", projectName: "P4 验收示例项目" }],
            tasks: [lane],
            requirements: []
          }
        : { projects: [], tasks: [], requirements: [] },
    reads: async (origin, path) => {
      if (path.endsWith("/main-sessions")) return { sessions: [session({})] };
      if (path.endsWith("/deliveries")) {
        const error = new Error("no development");
        error.status = 404;
        throw error;
      }
      return {};
    }
  });
  t.after(() => view.restore());

  await delay(60);
  const degraded = view.header.querySelector("[data-runs-degraded]");
  assert.equal(degraded.hidden, false);
  assert.match(degraded.textContent, /指标未就绪/);
  assert.equal(view.header.querySelector("[data-runs-live]").hidden, true);

  const row = view.root.querySelector('[data-runs-lane="task-1"]');
  assert.equal(row.dataset.degraded, "true");
  assert.ok(row.querySelector(".runs-block.is-dev"));
  assert.equal(row.querySelectorAll(".runs-pulse").length, 0);
  assert.match(row.textContent, /24 分/);

  // Reduced motion turns the live view into a snapshot refreshed on a timer.
  assert.equal(view.root.dataset.motion, "reduced");
  assert.equal(view.root.dataset.refreshMs, "5000");
});

test("a hidden runs panel performs no observation reads until it becomes visible", async (t) => {
  const node = online("http://local.test", "本机", "internal", true);
  let reads = 0;
  const view = fixture({
    nodes: [node],
    visible: false,
    scoped: ({ nodeOrigin }) =>
      nodeOrigin === node.origin
        ? {
            projects: [{ projectId: "project-1", projectName: "P4 验收示例项目" }],
            tasks: [],
            requirements: []
          }
        : { projects: [], tasks: [], requirements: [] },
    reads: async (origin, path) => {
      reads += 1;
      if (path.endsWith("/main-sessions")) return { sessions: [] };
      return {};
    }
  });
  t.after(() => view.restore());

  await delay(40);
  assert.equal(reads, 0, "a hidden panel must not poll nodes");
  assert.equal(view.root.querySelector("[data-runs-node]"), null);

  view.pane.hidden = false;
  view.root.hidden = false;
  await delay(40);
  assert.ok(reads > 0, "opening the view starts the read");
  assert.ok(view.root.querySelector("[data-runs-node]"));
});

test("a requirement's stage comes from the project's read-only lists", async (t) => {
  const node = online("http://local.test", "本机", "internal", true);
  const requests = [];
  const lane = task({
    activity: activity({
      agents: [agent({ stage: "working", stageChangedAt: at(-40), lastProgressAt: at(-1) })]
    })
  });
  const view = fixture({
    nodes: [node],
    scoped: ({ nodeOrigin }) =>
      nodeOrigin === node.origin
        ? {
            projects: [{ projectId: "project-1", projectName: "P4 验收示例项目" }],
            tasks: [lane],
            requirements: []
          }
        : { projects: [], tasks: [], requirements: [] },
    reads: async (origin, path, options) => {
      requests.push({ path, options });
      if (path.endsWith("/main-sessions")) return { sessions: [session({})] };
      if (path.endsWith("/developments"))
        return {
          developments: [
            {
              developmentId: "development-1",
              requirementId: "requirement-1",
              createdAt: at(-40),
              updatedAt: at(-20)
            }
          ]
        };
      if (path.endsWith("/reviews"))
        return { reviews: [{ developmentId: "development-1", state: "passed", createdAt: at(-20) }] };
      if (path.endsWith("/merges"))
        return { merges: [{ developmentId: "development-1", state: "waiting", createdAt: at(-12) }] };
      if (path.endsWith("/deliveries")) return { deliveries: [] };
      return {};
    }
  });
  t.after(() => view.restore());

  await delay(80);
  const row = view.root.querySelector('[data-runs-lane="task-1"]');
  assert.equal(row.dataset.stage, "wait");
  assert.match(row.textContent, /等待合入/);
  // The same read-only lists the dashboard derives its stage from; no POST
  // delivery view that would replay the outbox or inspect a checkout.
  const paths = requests.map((request) => request.path);
  assert.ok(paths.some((path) => path.endsWith("/developments")));
  assert.ok(paths.some((path) => path.endsWith("/merges")));
  assert.ok(requests.every((request) => request.method === undefined || request.method === "GET"));
});
