import { requirementStage } from "../requirement-stages.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { formatStamp } from "../ui/time-format.js";
import { createVisiblePoll } from "../ui/visible-poll.js";
import { escapeHtml as esc } from "../workbench/html.js";
import { formatSpan } from "./observe-runs.js";

/**
 * The observation overview: what every connected node is doing, read-only.
 *
 * One card per node from that node's own role and records, one phase matrix per
 * project, the reasons a person may be needed, and the Mains running right now.
 * Everything comes through the observation data port: the page keeps one
 * read-only connection per node, and this view only reads the projects, Tasks
 * and requirement lists that connection already holds.
 *
 * The phase is the shared mapping's (`requirement-stages.js`), fed by the
 * project's recorded lists rather than a delivery view: replaying the delivery
 * outbox or reading a checkout would turn watching another host into work on
 * it. A development without a recorded review still reads its plan, so a
 * self-checked channel is not mistaken for an unreviewed one.
 *
 * Reads happen only while the view is visible and are cached for a short while;
 * a node that stops answering keeps the card the others already painted, and
 * only its own last-seen time remains.
 */

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
/** How long an unclaimed need waits before it is worth a person's attention. */
const CLAIM_STALE_MS = DAY;
const READ_MS = 15_000;
const PLAN_READ_MS = 60_000;

/**
 * The five columns the design draws, and the phases folded into each.
 *
 * A delivered or withdrawn requirement is settled history, so the matrix does
 * not count it. A recorded requirement without a development is being worked
 * on, which reads as development rather than as an unclaimed need.
 */
const MATRIX_COLUMNS = [
  { id: "pending", label: "待认领", stages: ["pending"], tone: "accent" },
  { id: "development", label: "开发", stages: ["requirement", "development"], tone: "accent" },
  { id: "review", label: "审查", stages: ["review", "rework"], tone: "accent" },
  { id: "merge", label: "待合入", stages: ["merge", "merged"], tone: "warn" },
  { id: "release", label: "待发布", stages: ["release"], tone: "ok" }
];

const STAGE_COLUMN = new Map();
for (const column of MATRIX_COLUMNS) for (const stage of column.stages) STAGE_COLUMN.set(stage, column.id);

const PILL_TONE = {
  development: "accent",
  requirement: "accent",
  review: "accent",
  rework: "review",
  merge: "warn",
  merged: "warn",
  release: "ok",
  delivered: "ok",
  withdrawn: "muted",
  pending: "muted"
};

const ATTENTION = {
  waiting: { icon: "message-circle-question", tone: "warn", order: 0 },
  review: { icon: "circle-x", tone: "danger", order: 1 },
  pending: { icon: "inbox", tone: "accent", order: 2 },
  offline: { icon: "wifi-off", tone: "muted", order: 3 }
};

const RUNNING_COLUMNS = [
  { id: "requirement", label: "需求" },
  { id: "project", label: "项目" },
  { id: "node", label: "节点" },
  { id: "session", label: "Main 会话" },
  { id: "stage", label: "阶段" },
  { id: "duration", label: "时长" }
];

const timeOf = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const projectPath = (projectId, suffix) => `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
const cellLevel = (count) => (count >= 3 ? 3 : count);

/**
 * @param {object} options
 * @param {HTMLElement} options.root      the overview section
 * @param {object} options.data          the read-only observation port
 * @param {(view: string) => void} [options.onOpenView]
 * @param {() => number} [options.now]
 */
export function createObserveOverview({ root, data, onOpenView = () => {}, now = () => Date.now() } = {}) {
  if (!root) return { applyEntry() {}, render() {}, refresh() {}, dispose() {} };
  /** origin|projectId → the project's recorded lists */
  const listsByProject = new Map();
  /** origin → the external node's capacity view */
  const capacities = new Map();
  /** origin|projectId|developmentId → the review plan recorded before a review */
  const plans = new Map();
  let disposed = false;
  let hydrating = false;
  let dirty = false;

  function cached(map, key, load, ttl) {
    const existing = map.get(key);
    if (existing?.promise) return existing.promise;
    if (existing && now() - existing.at < ttl) return null;
    const entry = { at: now(), value: existing?.value, promise: undefined };
    entry.promise = load()
      .then((value) => {
        entry.value = value;
        entry.at = now();
        return value;
      })
      .catch((error) => {
        entry.error = error?.message || "";
        entry.at = now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    map.set(key, entry);
    return entry.promise;
  }

  /**
   * One project's read-only lists.
   *
   * A list that cannot be read contributes nothing; the project's other records
   * still describe it, and the next visible read retries the missing one.
   */
  function listsFor(origin, projectId) {
    return cached(
      listsByProject,
      `${origin}|${projectId}`,
      async () => {
        const read = async (suffix, key) => {
          try {
            const result = await data.read(origin, projectPath(projectId, suffix), { cache: "no-store" });
            return Array.isArray(result?.[key]) ? result[key] : [];
            // eslint-disable-next-line no-restricted-syntax -- 读不到一份记录集只少这一项，项目的其余记录仍要显示
          } catch {
            // A record set this node cannot list leaves the project's other
            // facts intact instead of failing the whole project.
            return [];
          }
        };
        const [board, sessions, developments, reviews, merges, deliveries] = await Promise.all([
          read("/board", "entries"),
          read("/main-sessions", "sessions"),
          read("/developments", "developments"),
          read("/reviews", "reviews"),
          read("/merges", "merges"),
          read("/deliveries", "deliveries")
        ]);
        return { board, sessions, developments, reviews, merges, deliveries };
      },
      READ_MS
    );
  }

  function capacityFor(origin) {
    return cached(
      capacities,
      origin,
      async () => {
        try {
          return (await data.read(origin, "/api/main-capacity", { cache: "no-store" })) ?? null;
          // eslint-disable-next-line no-restricted-syntax -- 旧节点没有名额接口时不显示名额，节点其余信息仍然可读
        } catch {
          // A host without the capacity route has no quotas to report; its node
          // card still shows the rest of what the node publishes.
          return null;
        }
      },
      READ_MS
    );
  }

  function planFor(origin, projectId, developmentId) {
    return cached(
      plans,
      `${origin}|${projectId}|${developmentId}`,
      async () => {
        try {
          const result = await data.read(
            origin,
            `${projectPath(projectId, "/reviews")}?developmentId=${encodeURIComponent(developmentId)}`,
            { cache: "no-store" }
          );
          return result?.plan ?? null;
          // eslint-disable-next-line no-restricted-syntax -- 计划读取失败时沿用已记录的事实判断阶段，不因读取失败改变结论
        } catch {
          // A plan that cannot be read leaves the development where its
          // recorded facts put it; no phase is invented from a failure.
          return null;
        }
      },
      PLAN_READ_MS
    );
  }

  /* ---------------------------------------------------------------- records */

  function records() {
    const filter = data.filter();
    return data
      .nodes()
      .filter((node) => !filter.nodeOrigin || node.origin === filter.nodeOrigin)
      .map((node) => {
        const scope = data.scoped({ nodeOrigin: node.origin, projectId: filter.projectId });
        const lists = new Map(
          scope.projects.map((project) => [
            project.projectId,
            listsByProject.get(`${node.origin}|${project.projectId}`)?.value
          ])
        );
        return { node, scope, lists };
      });
  }

  function requirementFacts(record, requirement) {
    const lists = record.lists.get(requirement.projectId);
    if (!lists) return { requirement };
    const board = lists.board.find((entry) => entry.requirementId === requirement.requirementId);
    const development = lists.developments.find((entry) => entry.requirementId === requirement.requirementId);
    if (!development) return { requirement, board };
    const reviews = lists.reviews.filter((entry) => entry.developmentId === development.developmentId);
    const merges = lists.merges.filter((entry) => entry.developmentId === development.developmentId);
    const delivery = lists.deliveries
      .filter((entry) => entry.developmentId === development.developmentId)
      .at(-1);
    const plan = reviews.length
      ? undefined
      : plans.get(`${record.node.origin}|${requirement.projectId}|${development.developmentId}`)?.value;
    return {
      requirement,
      board,
      development,
      plan: plan ?? undefined,
      reviews,
      merges,
      delivery
    };
  }

  function sessionsOf(record) {
    const byTask = new Map();
    const byRequirement = new Map();
    for (const lists of record.lists.values())
      for (const session of lists?.sessions ?? []) {
        byTask.set(session.taskId, session);
        if (session.currentRequirementId) byRequirement.set(session.currentRequirementId, session);
      }
    return { byTask, byRequirement };
  }

  /* -------------------------------------------------------------- summaries */

  function pendingClaims(record) {
    const seen = new Set();
    let count = 0;
    for (const lists of record.lists.values())
      for (const entry of lists?.board ?? []) {
        if (entry.state !== "pending" || seen.has(entry.requirementId)) continue;
        seen.add(entry.requirementId);
        count += 1;
      }
    return count;
  }

  function mergedThisWeek(record, at) {
    let count = 0;
    for (const lists of record.lists.values())
      for (const merge of lists?.merges ?? []) {
        if (merge.state !== "merged") continue;
        const when = timeOf(merge.receipt?.mergedAt ?? merge.updatedAt);
        if (when !== undefined && at - when <= WEEK) count += 1;
      }
    return count;
  }

  function capacityUse(record, projectId) {
    const view = capacities.get(record.node.origin)?.value;
    const running = (view?.running ?? []).filter((entry) => !projectId || entry.projectId === projectId);
    const resident = running.filter((entry) => entry.kind === "regular").length;
    const continuation = running.filter((entry) => entry.kind === "continuation").length;
    const settings = view?.settings;
    return {
      resident,
      continuation,
      residentQuota: Number(settings?.resident) || 0,
      continuationQuota: Number(settings?.continuation) || 0
    };
  }

  function runningOf(record) {
    return record.scope.tasks.filter((task) => ["running", "waiting"].includes(task.status)).length;
  }

  function cardStats(record, at, projectId) {
    if (record.node.role === "external") {
      const use = capacityUse(record, projectId);
      return [
        { key: "resident", label: "常驻", value: `${use.resident}/${use.residentQuota}` },
        { key: "continuation", label: "接续", value: `${use.continuation}/${use.continuationQuota}` },
        { key: "pending", label: "待认领", value: String(pendingClaims(record)) }
      ];
    }
    return [
      { key: "running", label: "运行中", value: String(runningOf(record)) },
      {
        key: "waiting",
        label: "等待你",
        value: String(record.scope.tasks.filter((task) => task.pendingQuestion).length)
      },
      { key: "merged", label: "本周合入", value: String(mergedThisWeek(record, at)) }
    ];
  }

  function matrixRows(onlineRecords) {
    const seen = new Set();
    const projects = new Map();
    for (const record of onlineRecords) {
      for (const project of record.scope.projects) {
        if (!projects.has(project.projectId))
          projects.set(project.projectId, {
            projectId: project.projectId,
            projectName: project.projectName,
            counts: {}
          });
      }
      for (const requirement of record.scope.requirements) {
        const key = `${requirement.projectId}:${requirement.requirementId}`;
        if (seen.has(key)) continue;
        // A project whose lists could not be read contributes no phase; the
        // zeros it shows are the columns this node cannot describe, not a claim
        // that nothing is there.
        if (!record.lists.get(requirement.projectId)) continue;
        seen.add(key);
        const column = STAGE_COLUMN.get(requirementStage(requirementFacts(record, requirement)).stage);
        if (!column) continue;
        const row = projects.get(requirement.projectId);
        if (!row) continue;
        row.counts[column] = (row.counts[column] ?? 0) + 1;
      }
    }
    return [...projects.values()];
  }

  function attentionItems(onlineRecords, offlineRecords, at) {
    const items = [];
    const seen = new Set();
    for (const record of onlineRecords) {
      const { byRequirement } = sessionsOf(record);
      const tasks = new Map(record.scope.tasks.map((task) => [task.taskId, task]));
      for (const requirement of record.scope.requirements) {
        const key = `${requirement.projectId}:${requirement.requirementId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const facts = requirementFacts(record, requirement);
        const session = byRequirement.get(requirement.requirementId);
        const waiting = Boolean(session && tasks.get(session.taskId)?.pendingQuestion);
        if (waiting) {
          items.push({
            kind: "waiting",
            title: requirement.title,
            detail: `${ui("等待回复")} · ${record.node.name}`
          });
          continue;
        }
        if (requirementStage(facts).stage === "rework") {
          items.push({
            kind: "review",
            title: requirement.title,
            detail: `${ui("审查未通过")} · ${record.node.name}`
          });
          continue;
        }
        if (facts.board?.state !== "pending") continue;
        const created = timeOf(facts.board.createdAt);
        const age = created === undefined ? 0 : at - created;
        if (age < CLAIM_STALE_MS) continue;
        items.push({
          kind: "pending",
          title: requirement.title,
          detail: `${ui("待认领")} ${ui`${Math.floor(age / DAY)} 天`} · ${record.node.name}`
        });
      }
    }
    for (const record of offlineRecords) {
      const seenAt = record.node.lastSeen
        ? `${ui("离线")} ${formatStamp(record.node.lastSeen, "relative", at)}`
        : ui("离线");
      items.push({ kind: "offline", title: record.node.name, detail: seenAt });
    }
    return items.sort(
      (left, right) =>
        ATTENTION[left.kind].order - ATTENTION[right.kind].order ||
        String(left.title).localeCompare(String(right.title))
    );
  }

  function runningRows(onlineRecords, at) {
    const rows = [];
    for (const record of onlineRecords) {
      const { byTask } = sessionsOf(record);
      const requirementById = new Map(
        record.scope.requirements.map((requirement) => [requirement.requirementId, requirement])
      );
      const projectById = new Map(record.scope.projects.map((project) => [project.projectId, project]));
      const runningSlots = new Map(
        (capacities.get(record.node.origin)?.value?.running ?? []).map((slot) => [slot.taskId, slot])
      );
      for (const task of record.scope.tasks) {
        if (!["running", "waiting"].includes(task.status)) continue;
        const session = byTask.get(task.taskId);
        const requirement = session?.currentRequirementId
          ? requirementById.get(session.currentRequirementId)
          : undefined;
        const started = timeOf(runningSlots.get(task.taskId)?.startedAt) ?? timeOf(task.createdAt);
        rows.push({
          node: record.node,
          task,
          session,
          requirement,
          project: projectById.get(task.projectId),
          stage: requirement ? requirementStage(requirementFacts(record, requirement)) : undefined,
          duration: started === undefined ? undefined : Math.max(0, at - started),
          started
        });
      }
    }
    return rows.sort(
      (left, right) =>
        (right.started ?? 0) - (left.started ?? 0) ||
        String(left.task.taskId).localeCompare(String(right.task.taskId))
    );
  }

  function collect() {
    const at = now();
    const filter = data.filter();
    const all = records();
    const online = all.filter((record) => record.node.status === "online");
    const offline = all.filter((record) => record.node.status !== "online");
    return {
      at,
      filter,
      all,
      online,
      offline,
      matrix: matrixRows(online),
      attention: attentionItems(online, offline, at),
      running: runningRows(online, at)
    };
  }

  /* ------------------------------------------------------------------ paint */

  function cardMarkup(record, plan) {
    const { node } = record;
    const offline = node.status !== "online";
    const external = node.role === "external";
    const stats = offline
      ? [{ key: "lastSeen", label: "最后在线", value: formatStamp(node.lastSeen, "relative", plan.at) }]
      : cardStats(record, plan.at, plan.filter.projectId);
    return `<section class="oo-card${offline ? " is-offline" : ""}" data-observe-node-card="${esc(
      node.origin
    )}" data-role="${external ? "external" : "internal"}" data-status="${offline ? "offline" : "online"}">
      <header class="oo-card-head">${icon(node.local ? "laptop" : "server")}<span class="oo-card-name">${esc(
        node.name
      )}</span><span class="oo-role">${esc(ui(external ? "对外" : "对内"))}</span><span class="oo-spacer"></span><span class="oo-dot${
        offline ? "" : " is-ok"
      }" aria-hidden="true"></span></header>
      <div class="oo-card-stats">${stats
        .map(
          (entry) =>
            `<div class="oo-stat" data-stat="${entry.key}"><span class="oo-stat-value">${esc(
              entry.value
            )}</span><span class="oo-stat-key">${esc(ui(entry.label))}</span></div>`
        )
        .join("")}</div>
    </section>`;
  }

  function matrixMarkup(rows) {
    return `<section class="oo-panel oo-progress" data-observe-progress>
      <header class="oo-panel-head"><h2>${esc(ui("需求进展"))}</h2><span class="oo-spacer"></span><button type="button" class="oo-link" data-observe-open="requirements">${esc(
        ui("查看全部")
      )}</button></header>
      <div class="oo-matrix" role="table" aria-label="${esc(ui("需求进展"))}">
        <div class="oo-matrix-row is-head" role="row"><span class="oo-matrix-project" role="columnheader"></span>${MATRIX_COLUMNS.map(
          (column) => `<span class="oo-matrix-stage" role="columnheader">${esc(ui(column.label))}</span>`
        ).join("")}</div>
        ${
          rows.length
            ? rows
                .map(
                  (row) =>
                    `<div class="oo-matrix-row" role="row" data-observe-matrix-project="${esc(
                      row.projectId
                    )}"><span class="oo-matrix-project" role="cell">${icon(
                      "folder"
                    )}<span class="oo-matrix-name">${esc(row.projectName)}</span></span>${MATRIX_COLUMNS.map(
                      (column) => {
                        const count = row.counts[column.id] ?? 0;
                        return `<span class="oo-cell" role="cell" data-matrix-stage="${column.id}" data-tone="${
                          column.tone
                        }" data-level="${cellLevel(count)}">${count > 0 ? count : "·"}</span>`;
                      }
                    ).join("")}</div>`
                )
                .join("")
            : `<p class="oo-empty">${esc(ui("没有项目"))}</p>`
        }
      </div>
    </section>`;
  }

  function attentionMarkup(items) {
    return `<section class="oo-panel oo-attention" data-observe-attention>
      <header class="oo-panel-head"><h2>${esc(ui("需要处理"))}</h2><span class="oo-badge"${
        items.length ? "" : " hidden"
      }>${items.length}</span></header>
      ${
        items.length
          ? items
              .map((item) => {
                const style = ATTENTION[item.kind];
                return `<div class="oo-attention-item" data-observe-attention-item data-attention="${
                  item.kind
                }"><span class="oo-attention-icon is-${style.tone}">${icon(
                  style.icon
                )}</span><span class="oo-attention-text"><span class="oo-attention-title">${esc(
                  item.title
                )}</span><span class="oo-attention-detail">${esc(item.detail)}</span></span><span class="oo-attention-chevron">${icon(
                  "chevron-right"
                )}</span></div>`;
              })
              .join("")
          : `<p class="oo-empty">${esc(ui("没有需要处理"))}</p>`
      }
    </section>`;
  }

  function runningMarkup(rows) {
    const cell = (column, value, extra = "") =>
      `<span class="oo-cell oo-col-${column}" role="cell" data-column="${column}">${extra}${value}</span>`;
    return `<section class="oo-panel oo-running" data-observe-running>
      <header class="oo-panel-head"><h2>${esc(ui("正在运行"))}</h2><span class="oo-spacer"></span><button type="button" class="oo-link" data-observe-open="runs">${esc(
        ui("全部运行")
      )}</button></header>
      <div class="oo-table" role="table" aria-label="${esc(ui("正在运行"))}">
        <div class="oo-row oo-row-head" role="row">${RUNNING_COLUMNS.map(
          (column) =>
            `<span class="oo-cell oo-col-${column.id}" role="columnheader">${esc(ui(column.label))}</span>`
        ).join("")}</div>
        ${
          rows.length
            ? rows
                .map((row) => {
                  const title =
                    row.requirement?.title ||
                    row.session?.title ||
                    row.task.title ||
                    row.task.goal ||
                    row.task.taskId;
                  const stage = row.stage;
                  return `<div class="oo-row" role="row" data-observe-running-row data-task-id="${esc(
                    row.task.taskId
                  )}" data-node="${esc(row.node.origin)}">
                    ${cell("requirement", `<span class="oo-run-title">${esc(title)}</span>`)}
                    ${cell("project", esc(row.project?.projectName ?? "—"))}
                    ${cell("node", esc(row.node.name), icon(row.node.local ? "laptop" : "server"))}
                    ${cell("session", esc(row.session?.title ?? "—"))}
                    ${cell(
                      "stage",
                      stage
                        ? `<span class="oo-pill is-${PILL_TONE[stage.stage] ?? "muted"}">${esc(ui(stage.label))}</span>`
                        : "—"
                    )}
                    ${cell("duration", row.duration === undefined ? "—" : esc(formatSpan(row.duration)))}
                  </div>`;
                })
                .join("")
            : `<p class="oo-empty">${esc(ui("没有运行中的 Main"))}</p>`
        }
      </div>
    </section>`;
  }

  function paint(plan) {
    root.dataset.renderedAt = String(plan.at);
    root.innerHTML = `<div class="oo-cards">${plan.all
      .map((record) => cardMarkup(record, plan))
      .join("")}</div><div class="oo-middle">${matrixMarkup(plan.matrix)}${attentionMarkup(
      plan.attention
    )}</div>${runningMarkup(plan.running)}`;
  }

  /* ------------------------------------------------------------- lifecycle */

  function visible() {
    return !root.hidden && !root.closest("[hidden]");
  }

  function pendingReads(plan) {
    if (!visible()) return [];
    const reads = [];
    for (const record of plan.online) {
      for (const project of record.scope.projects) {
        const pending = listsFor(record.node.origin, project.projectId);
        if (pending) reads.push(pending);
      }
      if (record.node.role === "external") {
        const pending = capacityFor(record.node.origin);
        if (pending) reads.push(pending);
      }
    }
    return reads;
  }

  /** Plans are second reads: they only exist for a development without a review. */
  function planReads() {
    const reads = [];
    for (const [key, lists] of listsByProject) {
      if (!lists.value) continue;
      const separator = key.indexOf("|");
      const origin = key.slice(0, separator);
      const projectId = key.slice(separator + 1);
      const reviewed = new Set(lists.value.reviews.map((review) => review.developmentId));
      for (const development of lists.value.developments) {
        if (reviewed.has(development.developmentId)) continue;
        const pending = planFor(origin, projectId, development.developmentId);
        if (pending) reads.push(pending);
      }
    }
    return reads;
  }

  async function hydrate() {
    if (disposed) return;
    if (hydrating) {
      dirty = true;
      return;
    }
    hydrating = true;
    try {
      for (let round = 0; round < 6; round += 1) {
        const primary = pendingReads(collect());
        // Plans describe developments, so they are read once the lists that
        // name those developments are here.
        const secondary = primary.length ? [] : planReads();
        if (!primary.length && !secondary.length) break;
        await Promise.all([...primary, ...secondary]);
      }
    } finally {
      hydrating = false;
    }
    if (disposed) return;
    paint(collect());
    if (dirty) {
      dirty = false;
      void hydrate();
    }
  }

  function render() {
    if (disposed) return;
    paint(collect());
    void hydrate();
  }

  function refresh({ force = false } = {}) {
    if (force) {
      for (const entry of listsByProject.values()) entry.at = 0;
      for (const entry of capacities.values()) entry.at = 0;
      for (const entry of plans.values()) entry.at = 0;
    }
    render();
    return undefined;
  }

  const onClick = (event) => {
    const target = event.target.closest("[data-observe-open]");
    if (target) onOpenView(target.dataset.observeOpen);
  };
  root.addEventListener("click", onClick);

  const unsubscribe = data.subscribe(() => {
    if (!visible()) return;
    render();
  });

  const poll = createVisiblePoll({
    run: () => refresh({ force: true }),
    intervalMs: READ_MS,
    active: false
  });

  // The entry and view switches hide this section; a view shown again paints
  // what the cache already knows and reads only what has gone stale.
  const Observer = globalThis.window?.MutationObserver;
  const visibilityObserver = Observer
    ? new Observer(() => {
        if (visible()) render();
      })
    : undefined;
  for (const node of new Set([root, root.closest("[data-entry-panel]")]))
    if (node && visibilityObserver)
      visibilityObserver.observe(node, { attributes: true, attributeFilter: ["hidden"] });

  if (visible()) render();

  return {
    /** The entry or view changed: read only while the overview is shown. */
    applyEntry({ mode, observeView } = {}) {
      const shown = mode === "observe" && observeView === "overview";
      poll.setActive(Boolean(shown));
      if (shown) render();
    },
    render,
    refresh,
    dispose() {
      disposed = true;
      poll.dispose();
      unsubscribe?.();
      visibilityObserver?.disconnect();
      root.removeEventListener("click", onClick);
    }
  };
}
