import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createObserveOverview } from "../web/assets/controllers/observe-overview.js";

/**
 * The overview controller's own rules, at its seam: a fake read-only port
 * supplies the recorded facts and the controller paints one card per node, the
 * phase matrix, the attention list and the running table from them.
 *
 * The phase comes from the shared requirement mapping, so a self-checked
 * development is under review, a failed review is rework and a delivered
 * requirement leaves the matrix. Reads only happen while the view is shown.
 */

const NOW = Date.parse("2026-11-10T08:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const project = { projectId: "p1", projectName: "官网" };

function fixture() {
  const now = new Date(NOW).toISOString();
  const board = [
    {
      requirementId: "r1",
      state: "pending",
      createdAt: new Date(NOW - 3 * DAY).toISOString(),
      updatedAt: new Date(NOW - 3 * DAY).toISOString()
    }
  ];
  const requirements = [
    {
      requirementId: "r1",
      projectId: "p1",
      title: "报表导出 CSV",
      status: "open",
      revision: 1,
      updatedAt: now
    },
    {
      requirementId: "r2",
      projectId: "p1",
      title: "已经交付",
      status: "delivered",
      revision: 3,
      updatedAt: now
    },
    {
      requirementId: "r3",
      projectId: "p1",
      title: "自检的需求",
      status: "open",
      revision: 1,
      updatedAt: now
    },
    {
      requirementId: "r4",
      projectId: "p1",
      title: "等待回复的需求",
      status: "open",
      revision: 1,
      updatedAt: now
    },
    {
      requirementId: "r5",
      projectId: "p1",
      title: "审查未通过的需求",
      status: "open",
      revision: 2,
      updatedAt: now
    }
  ];
  const developments = [
    { developmentId: "d3", requirementId: "r3" },
    { developmentId: "d4", requirementId: "r4" },
    { developmentId: "d5", requirementId: "r5" }
  ];
  const reviews = [{ reviewId: "v5", developmentId: "d5", state: "failed" }];
  const sessions = [
    {
      sessionId: "s4",
      taskId: "t4",
      title: "等待回复的会话",
      currentRequirementId: "r4",
      createdAt: now
    }
  ];
  const tasks = [
    {
      taskId: "t4",
      projectId: "p1",
      title: "等待回复的会话",
      status: "running",
      pendingQuestion: true,
      createdAt: now
    }
  ];
  const read = (path) => {
    if (path.endsWith("/board")) return { entries: board };
    if (path.endsWith("/main-sessions")) return { sessions };
    if (path.endsWith("/developments")) return { developments };
    if (path.endsWith("/reviews")) return { reviews };
    if (path.endsWith("/merges")) return { merges: [] };
    if (path.endsWith("/deliveries")) return { deliveries: [] };
    if (path.includes("developmentId=d3")) return { plan: { channel: "self" } };
    if (path.includes("developmentId=d4")) return { plan: { channel: "independent" } };
    throw new Error(`unexpected read ${path}`);
  };
  return { board, requirements, developments, reviews, sessions, tasks, read };
}

async function mount() {
  const facts = fixture();
  const calls = [];
  const nodes = [
    {
      origin: "http://local.test",
      name: "本机",
      role: "internal",
      local: true,
      status: "online"
    },
    {
      origin: "http://gone.test",
      name: "测试机",
      role: "internal",
      local: false,
      status: "offline",
      lastSeen: new Date(NOW - 2 * 60 * 60_000).toISOString()
    }
  ];
  const data = {
    nodes: () => nodes,
    filter: () => ({ nodeOrigin: "", projectId: "" }),
    scoped: ({ nodeOrigin } = {}) =>
      nodeOrigin === "http://gone.test"
        ? { projects: [], tasks: [], requirements: [] }
        : { projects: [project], tasks: facts.tasks, requirements: facts.requirements },
    subscribe: () => () => {},
    read: async (origin, path) => {
      calls.push({ origin, path });
      return facts.read(path);
    }
  };
  const { document, window } = parseHTML(
    '<html><body><section data-observe-panel="overview"></section></body></html>'
  );
  globalThis.document = document;
  globalThis.window = window;
  const root = document.querySelector('[data-observe-panel="overview"]');
  root.hidden = true;
  const overview = createObserveOverview({ root, data, now: () => NOW });
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) await new Promise((done) => setTimeout(done, 1));
  };
  const show = (state) => {
    root.hidden = !(state.mode === "observe" && state.observeView === "overview");
    overview.applyEntry(state);
  };
  return { root, overview, calls, settle, facts, window, show };
}

test("the overview folds recorded phases into the design's five columns", async () => {
  const { root, overview, settle, show } = await mount();
  try {
    show({ mode: "observe", observeView: "overview" });
    await settle();
    const cells = Object.fromEntries(
      [...root.querySelectorAll("[data-matrix-stage]")].map((cell) => [
        cell.dataset.matrixStage,
        cell.textContent
      ])
    );
    // The unclaimed need is pending, the self-check and the failed review are
    // both under review, the running requirement is in development, and the
    // delivered requirement is settled history that the matrix does not count.
    assert.deepEqual(cells, {
      pending: "1",
      development: "1",
      review: "2",
      merge: "·",
      release: "·"
    });
    overview.dispose();
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test("the overview names what needs attention and what is running, and reads only while shown", async () => {
  const { root, overview, calls, settle, show } = await mount();
  try {
    // The work entry is showing: nothing is read.
    show({ mode: "work", observeView: "overview" });
    await settle();
    assert.equal(calls.length, 0);

    show({ mode: "observe", observeView: "overview" });
    await settle();
    assert.ok(calls.length > 0, "showing the view reads the node's projects");

    const attention = [...root.querySelectorAll("[data-observe-attention-item]")].map((item) => [
      item.dataset.attention,
      item.textContent.replace(/\s+/g, " ")
    ]);
    assert.deepEqual(
      attention.map(([kind]) => kind),
      ["waiting", "review", "pending", "offline"]
    );
    assert.match(attention[0][1], /等待回复的需求/);
    assert.match(attention[0][1], /等待回复/);
    assert.match(attention[1][1], /审查未通过/);
    assert.match(attention[2][1], /待认领 3 天/);
    assert.match(attention[3][1], /测试机/);
    assert.match(attention[3][1], /离线/);

    const row = root.querySelector("[data-observe-running-row]");
    assert.equal(row.dataset.taskId, "t4");
    assert.equal(row.querySelector('[data-column="project"]').textContent, "官网");
    assert.equal(row.querySelector('[data-column="node"]').textContent, "本机");
    assert.equal(row.querySelector('[data-column="session"]').textContent, "等待回复的会话");
    assert.equal(row.querySelector('[data-column="stage"]').textContent, "开发中");
    assert.match(row.querySelector('[data-column="duration"]').textContent, /分|小时/);

    // The offline node keeps a card with its last-seen mark and no stats.
    const offline = root.querySelector('[data-observe-node-card="http://gone.test"]');
    assert.equal(offline.dataset.status, "offline");
    assert.equal(offline.querySelector('[data-stat="lastSeen"] .oo-stat-key').textContent, "最后在线");
    assert.match(offline.querySelector('[data-stat="lastSeen"] .oo-stat-value').textContent, /小时前/);
    assert.equal(offline.querySelector('[data-stat="resident"]'), null);

    overview.dispose();
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});
