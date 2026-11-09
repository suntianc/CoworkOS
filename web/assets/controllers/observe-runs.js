import { agentDisplayName } from "../agent-names.js";
import { escapeHtml as esc } from "../workbench/html.js";
import { icon } from "../ui/icons.js";
import { ui } from "../ui/language.js";
import { formatStamp } from "../ui/time-format.js";

/**
 * The observation entry's Runs view: one pulse lane per running Main.
 *
 * Everything on screen is a read. Lanes, Subagent branches and external
 * capacity groups come from the nodes' own snapshots; a session's title and
 * requirement are read per project, and a requirement's development stage is
 * read only when it can add a phase the activity samples cannot express. The
 * view never holds a connection and never opens a session.
 *
 * Activity samples are minute slices from `task.activity`. The current stage
 * starts at a recorded fact (`stageChangedAt`, or the requirement record); the
 * stretch before it is painted from the samples themselves, so a lane that
 * developed and then went quiet shows that shape instead of one flat colour.
 * When a node publishes no activity the same timeline is drawn as solid stage
 * blocks, and the header says the metrics are not ready.
 */

export const RUNS_WINDOWS = [5, 30, 120];
/** A Main whose writes stopped this long ago is highlighted as stalled. */
export const STALL_THRESHOLD_MS = 10 * 60_000;
const SLICE_MS = 60_000;
const WAVE_WIDTH = 748;

const STAGE_LABEL = {
  dev: "开发",
  review: "审查",
  merge: "合入",
  wait: "等待",
  idle: "空闲"
};

const AGENT_STATE_LABEL = {
  queued: "排队中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时"
};

const NODE_STATUS_LABEL = {
  connecting: "连接中",
  offline: "离线",
  unauthorized: "未授权",
  failed: "不可用",
  disconnected: "已断开"
};

const PROGRESS_STATE = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  unknown: "unknown"
};

const VIEW_STAGE = {
  developing: { key: "dev" },
  reviewing: { key: "review" },
  merge_pending: { key: "wait", label: "等待合入" },
  merged: { key: "merge" },
  delivered: { key: "merge" }
};

const WORK_ROLE_LABEL = { executor: "Executor", reviewer: "Reviewer" };

const nowMsOf = (value) => {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A compact span: minutes below an hour, whole hours above it. */
export function formatSpan(ms) {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / SLICE_MS));
  return minutes < 60 ? ui`${minutes} 分` : ui`${Math.floor(minutes / 60)} 小时`;
}

/** How long a lane has gone without a written record. */
export function formatStall(ms) {
  const minutes = Math.max(1, Math.floor(Math.max(0, ms) / SLICE_MS));
  return minutes < 60 ? ui`${minutes} 分无进展` : ui`${Math.floor(minutes / 60)} 小时无进展`;
}

function percentOf(value, start, end) {
  if (!(end > start)) return 0;
  return Math.min(100, Math.max(0, ((value - start) / (end - start)) * 100));
}

function sampleScore(sample) {
  if (!sample) return 0;
  const calls = Number(sample.toolCalls) || 0;
  const bytes = Number(sample.outputBytes) || 0;
  return calls * 4 + bytes / 60;
}

function sampleActive(sample) {
  return sampleScore(sample) > 0;
}

/** When an agent's first still-visible record was written. */
function firstActiveMs(agent, activity, windowStart) {
  const sliceMs = activity?.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity?.from);
  if (fromMs === undefined) return undefined;
  const samples = agent?.samples ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    if (!sampleActive(samples[index])) continue;
    const start = fromMs + index * sliceMs;
    if (start >= windowStart) return start;
  }
  return undefined;
}

/** How many minute slices of a trace fall inside the selected window. */
function visibleSlices(activity, windowStart, windowEnd) {
  const sliceMs = activity?.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity?.from);
  if (fromMs === undefined) return 0;
  const first = Math.max(0, Math.floor((windowStart - fromMs) / sliceMs));
  const last = Math.ceil((windowEnd - fromMs) / sliceMs);
  return Math.max(0, Math.min(activity.agents?.[0]?.samples?.length ?? last, last) - first);
}

function combinedSamples(activity) {
  const agents = activity?.agents ?? [];
  const length = Math.max(0, ...agents.map((agent) => agent.samples?.length ?? 0));
  return Array.from({ length }, (_, index) => {
    let toolCalls = 0;
    let outputBytes = 0;
    for (const agent of agents) {
      const sample = agent.samples?.[index];
      if (!sample) continue;
      toolCalls += Number(sample.toolCalls) || 0;
      outputBytes += Number(sample.outputBytes) || 0;
    }
    return { toolCalls, outputBytes };
  });
}

function pushSegment(list, kind, from, to) {
  if (!(to > from)) return;
  const last = list.at(-1);
  if (last && last.kind === kind && Math.abs(last.to - from) < 1) last.to = to;
  else list.push({ kind, from, to });
}

/**
 * The same stage the delivery view reports, rebuilt from the read-only lists.
 *
 * `deliveryStage` in the dashboard service compares the newest delivery, any
 * merged/waiting merge, and the newest review. Reading the lists keeps that
 * rule without replaying the delivery outbox or diffing a checkout.
 */
function stageViewFor(records, requirementId) {
  const development = records.developments.find((entry) => entry.requirementId === requirementId);
  if (!development) return undefined;
  const reviews = records.reviews.filter((entry) => entry.developmentId === development.developmentId);
  const merges = records.merges.filter((entry) => entry.developmentId === development.developmentId);
  const delivery = records.deliveries
    .filter((entry) => entry.developmentId === development.developmentId)
    .at(-1);
  const stage =
    delivery?.state === "synced"
      ? "delivered"
      : delivery?.state === "pending" || merges.some((entry) => entry.state === "merged")
        ? "merged"
        : merges.some((entry) => ["waiting", "applying"].includes(entry.state))
          ? "merge_pending"
          : reviews.at(-1)?.state === "in_review"
            ? "reviewing"
            : "developing";
  return { stage, development, reviews, merges, delivery };
}

/** The phase a Main is in, the moment it began, and whether it is stalled. */
function resolveStage({ activity, main, subs, view, now, windowStart, fallbackStart }) {
  const stage = view?.stage;
  if (stage && VIEW_STAGE[stage]) {
    const mapped = VIEW_STAGE[stage];
    const latestReview = [...(view.reviews ?? [])].at(-1);
    const latestMerge = [...(view.merges ?? [])].at(-1);
    const start =
      mapped.key === "review"
        ? (nowMsOf(latestReview?.createdAt) ?? nowMsOf(view.development?.createdAt))
        : mapped.key === "wait"
          ? (nowMsOf(latestMerge?.createdAt) ?? nowMsOf(view.development?.updatedAt))
          : mapped.key === "merge"
            ? (nowMsOf(latestMerge?.mergedAt) ?? nowMsOf(view.delivery?.updatedAt))
            : nowMsOf(view.development?.createdAt);
    return {
      key: mapped.key,
      label: mapped.label ?? STAGE_LABEL[mapped.key],
      startMs: start ?? windowStart
    };
  }
  const lastProgress = nowMsOf(main?.lastProgressAt);
  const stalled = lastProgress !== undefined && now - lastProgress > STALL_THRESHOLD_MS;
  const reviewer = subs.find(
    (agent) => agent.workRole === "reviewer" && ["queued", "running"].includes(agent.state)
  );
  if (reviewer) {
    // A running Reviewer's stage is its active stretch, not the idle moment
    // after its last record: `stageChangedAt` would put review at the end.
    const reviewStart =
      firstActiveMs(reviewer, activity, windowStart) ??
      nowMsOf(reviewer.stageChangedAt) ??
      lastProgress ??
      windowStart;
    return { key: "review", label: STAGE_LABEL.review, startMs: reviewStart };
  }
  if (main?.stage === "waiting")
    return {
      key: "wait",
      label: STAGE_LABEL.wait,
      startMs: nowMsOf(main.stageChangedAt) ?? lastProgress ?? windowStart
    };
  if (main?.stage === "idle" || stalled) {
    if (stalled) return { key: "wait", label: STAGE_LABEL.wait, startMs: lastProgress };
    return {
      key: "idle",
      label: STAGE_LABEL.idle,
      startMs: nowMsOf(main?.stageChangedAt) ?? lastProgress ?? windowStart
    };
  }
  return {
    key: "dev",
    label: STAGE_LABEL.dev,
    // Without a single record the lane still began when its session did.
    startMs: nowMsOf(main?.stageChangedAt) ?? nowMsOf(activity?.from) ?? fallbackStart ?? windowStart
  };
}

/** Stage-coloured stretches across the visible window. */
function laneSegments({ activity, samples, stage, windowStart, windowEnd, degraded }) {
  const segments = [];
  if (degraded || !activity) {
    const start = Math.min(Math.max(stage.startMs ?? windowStart, windowStart), windowEnd);
    pushSegment(segments, stage.key, start, windowEnd);
    return segments;
  }
  const sliceMs = activity.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity.from) ?? windowStart;
  const activityStart = Math.min(Math.max(fromMs, windowStart), windowEnd);
  // The stage begins at a slice edge so the stretch before it is made of whole
  // slices; a record in the stage's first slice belongs to that stage.
  const stageStart = Math.min(
    Math.max(fromMs + Math.ceil((stage.startMs - fromMs) / sliceMs) * sliceMs, activityStart),
    windowEnd
  );
  let at = activityStart;
  while (at < stageStart) {
    const index = Math.floor((at - fromMs) / sliceMs);
    const sliceEnd = Math.min(stageStart, fromMs + (index + 1) * sliceMs);
    pushSegment(segments, sampleActive(samples[index]) ? "dev" : "idle", at, sliceEnd);
    at = sliceEnd;
  }
  pushSegment(segments, stage.key, stageStart, windowEnd);
  return segments;
}

/**
 * Stage blocks when the node publishes no samples.
 *
 * The durable work items still say when an Executor and a Reviewer ran, so the
 * lane keeps the development / quiet / review shape instead of one flat bar.
 */
function degradedLaneSegments(lane, windowStart, windowEnd) {
  const segments = [];
  const start = Math.min(Math.max(lane.startedAt ?? windowStart, windowStart), windowEnd);
  const reviewer = lane.subs.find(
    (agent) => agent.workRole === "reviewer" && nowMsOf(agent.startedAt) !== undefined
  );
  const executors = lane.subs.filter(
    (agent) => agent.workRole === "executor" && nowMsOf(agent.endedAt) !== undefined
  );
  const devEnd = Math.min(
    windowEnd,
    Math.max(
      start,
      executors.length
        ? Math.max(...executors.map((agent) => agent.endedAt))
        : (nowMsOf(reviewer?.startedAt) ?? windowEnd)
    )
  );
  pushSegment(segments, "dev", start, devEnd);
  const reviewStart = nowMsOf(reviewer?.startedAt);
  if (reviewStart !== undefined && reviewStart > devEnd) {
    const boundary = Math.min(windowEnd, reviewStart);
    pushSegment(segments, "idle", devEnd, boundary);
    pushSegment(segments, "review", boundary, windowEnd);
  } else {
    const stageStart = Math.min(Math.max(lane.stage.startMs ?? devEnd, devEnd), windowEnd);
    pushSegment(segments, lane.stage.key, stageStart, windowEnd);
  }
  return segments;
}

/** A finished Subagent's branch ends where its last record did. */
function subSegments({ activity, agent, windowStart, windowEnd }) {
  const samples = agent.samples ?? [];
  const sliceMs = activity.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity.from) ?? windowStart;
  let first;
  let last;
  samples.forEach((sample, index) => {
    if (!sampleActive(sample)) return;
    const start = fromMs + index * sliceMs;
    if (start < windowStart) return;
    if (first === undefined) first = start;
    last = start + sliceMs;
  });
  if (first === undefined) return [];
  const color = agent.workRole === "reviewer" ? "review" : agent.workRole === "executor" ? "dev" : "dev";
  const end = agent.state === "running" ? windowEnd : Math.min(windowEnd, last);
  const segments = [];
  let at = Math.max(first, windowStart);
  while (at < end) {
    const index = Math.floor((at - fromMs) / sliceMs);
    const sliceEnd = Math.min(end, Math.max(at + 1, fromMs + (index + 1) * sliceMs));
    pushSegment(segments, sampleActive(samples[index]) ? color : "idle", at, sliceEnd);
    at = sliceEnd;
  }
  return segments;
}

/** A jagged line across one stage segment; quiet slices sit on the baseline. */
function pulsePath({ samples, activity, segment, windowStart, windowEnd, height, maxScore }) {
  const baseline = height / 2;
  const x0 = percentOf(segment.from, windowStart, windowEnd) * (WAVE_WIDTH / 100);
  const x1 = percentOf(segment.to, windowStart, windowEnd) * (WAVE_WIDTH / 100);
  if (segment.kind === "idle" || maxScore <= 0)
    return `M${x0.toFixed(1)} ${baseline} L${x1.toFixed(1)} ${baseline}`;
  const sliceMs = activity.sliceMs || SLICE_MS;
  const fromMs = nowMsOf(activity.from) ?? windowStart;
  const amp = Math.max(4, baseline - 3);
  const points = [];
  let segmentMax = 0;
  for (let at = segment.from; at < segment.to; at += Math.min(sliceMs, Math.max(1, segment.to - at))) {
    const index = Math.floor((at - fromMs) / sliceMs);
    segmentMax = Math.max(segmentMax, sampleScore(samples[index]));
  }
  if (segmentMax <= 0) return `M${x0.toFixed(1)} ${baseline} L${x1.toFixed(1)} ${baseline}`;
  for (let at = segment.from; at < segment.to; at += Math.min(sliceMs, Math.max(1, segment.to - at))) {
    const index = Math.floor((at - fromMs) / sliceMs);
    const score = sampleScore(samples[index]);
    const rise = score <= 0 ? 0 : Math.max(2, amp * (0.45 + 0.55 * (score / segmentMax)));
    const width = (Math.min(sliceMs, segment.to - at) / (windowEnd - windowStart)) * WAVE_WIDTH;
    const next = percentOf(at, windowStart, windowEnd) * (WAVE_WIDTH / 100) + width;
    // Two points per slice keep the line jagged at a one-minute sample rate.
    const lead = percentOf(at, windowStart, windowEnd) * (WAVE_WIDTH / 100);
    points.push(`${(lead + (next - lead) * 0.3).toFixed(1)} ${(baseline - rise * 0.55).toFixed(1)}`);
    points.push(`${(lead + (next - lead) * 0.75).toFixed(1)} ${(baseline - rise).toFixed(1)}`);
  }
  const endX = percentOf(segment.to, windowStart, windowEnd) * (WAVE_WIDTH / 100);
  points.push(`${endX.toFixed(1)} ${baseline}`);
  return `M${x0.toFixed(1)} ${baseline} L${points.join(" L")}`;
}

function laneDuration(task, capacityEntry, now) {
  const started = nowMsOf(capacityEntry?.startedAt) ?? nowMsOf(task?.createdAt);
  return started === undefined ? 0 : Math.max(0, now - started);
}

function sameFilter(left, right) {
  return left.nodeOrigin === right.nodeOrigin && left.projectId === right.projectId;
}

export function createObserveRuns({
  root,
  header,
  data,
  now = () => Date.now(),
  refreshMs = 10_000,
  reducedRefreshMs = 5_000,
  readIntervalMs = 10_000,
  developmentReadMs = 60_000
} = {}) {
  if (!root) return { render() {}, dispose() {} };
  const sessions = new Map();
  const developmentData = new Map();
  const capacities = new Map();
  const details = new Map();
  let minutes = 30;
  let filter = { nodeOrigin: "", projectId: "" };
  let disposed = false;
  let timer;
  let hydrating = false;
  let dirty = false;
  let motion = false;

  const sessionsFor = (origin, projectId) => {
    const key = `${origin}|${projectId}`;
    const cached = sessions.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < readIntervalMs) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    entry.promise = data
      .read(origin, `/api/projects/${encodeURIComponent(projectId)}/main-sessions`, {
        cache: "no-store"
      })
      .then((result) => {
        entry.value = Array.isArray(result?.sessions) ? result.sessions : [];
        entry.at = Date.now();
        return entry.value;
      })
      .catch((error) => {
        entry.value = entry.value ?? [];
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    sessions.set(key, entry);
    return entry.promise;
  };

  // Stage facts come from the project's read-only lists. The delivery view
  // endpoint is deliberately not used: it replays the outbox and reads diffs,
  // which would turn an observation page into periodic work on the remote host.
  const developmentDataFor = (origin, projectId) => {
    const key = `${origin}|${projectId}`;
    const cached = developmentData.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < developmentReadMs) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    // One unavailable list (an older node without a route) keeps the others.
    const read = (path) =>
      data
        .read(origin, path, { cache: "no-store" })
        .then((result) => result ?? {})
        .catch((error) => {
          entry.error = error?.message || "";
          return {};
        });
    entry.promise = Promise.all([
      read(`/api/projects/${encodeURIComponent(projectId)}/developments`),
      read(`/api/projects/${encodeURIComponent(projectId)}/reviews`),
      read(`/api/projects/${encodeURIComponent(projectId)}/merges`),
      read(`/api/projects/${encodeURIComponent(projectId)}/deliveries`)
    ])
      .then(([developments, reviews, merges, deliveries]) => {
        entry.value = {
          developments: Array.isArray(developments.developments) ? developments.developments : [],
          reviews: Array.isArray(reviews.reviews) ? reviews.reviews : [],
          merges: Array.isArray(merges.merges) ? merges.merges : [],
          deliveries: Array.isArray(deliveries.deliveries) ? deliveries.deliveries : []
        };
        entry.at = Date.now();
        return entry.value;
      })
      .catch((error) => {
        entry.value = entry.value ?? undefined;
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    developmentData.set(key, entry);
    return entry.promise;
  };

  const capacityFor = (origin) => {
    const cached = capacities.get(origin);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < readIntervalMs) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    entry.promise = data
      .read(origin, "/api/main-capacity", { cache: "no-store" })
      .then((view) => {
        entry.value = view;
        entry.at = Date.now();
        return view;
      })
      .catch((error) => {
        entry.value = entry.value ?? null;
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    capacities.set(origin, entry);
    return entry.promise;
  };

  // A node that publishes no activity still has durable Subagent progress;
  // the Task detail is read only for those lanes, and not on every paint.
  const detailFor = (origin, taskId) => {
    const key = `${origin}|${taskId}`;
    const cached = details.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && Date.now() - cached.at < readIntervalMs * 3) return null;
    const entry = { at: Date.now(), value: cached?.value, promise: undefined };
    entry.promise = data
      .read(origin, `/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" })
      .then((detail) => {
        entry.value = detail;
        entry.at = Date.now();
        return detail;
      })
      .catch((error) => {
        entry.value = entry.value ?? null;
        entry.error = error?.message || "";
        entry.at = Date.now();
        return entry.value;
      })
      .finally(() => {
        entry.promise = undefined;
      });
    details.set(key, entry);
    return entry.promise;
  };

  /* -------------------------------------------------------------- timeline */

  function collectLanes(node, scopedProjects, scopedTasks, at) {
    const sessionList = [];
    for (const project of scopedProjects)
      sessionList.push(...(sessions.get(`${node.origin}|${project.projectId}`)?.value ?? []));
    const sessionByTask = new Map(sessionList.map((session) => [session.taskId, session]));
    const capacity = node.role === "external" ? capacities.get(node.origin)?.value : undefined;
    const runningByTask = new Map((capacity?.running ?? []).map((entry) => [entry.taskId, entry]));
    const lanes = scopedTasks
      .filter((task) => ["running", "waiting"].includes(task.status))
      .map((task) => {
        const session = sessionByTask.get(task.taskId);
        const project = scopedProjects.find((entry) => entry.projectId === task.projectId);
        const activity = task.activity;
        const agents = activity?.agents ?? [];
        const main = agents.find((agent) => agent.role === "main");
        const detail = activity ? undefined : details.get(`${node.origin}|${task.taskId}`)?.value;
        const progress = (detail?.progress?.agents ?? []).filter(
          (agent) => agent.role === "executor" || agent.role === "reviewer"
        );
        const subs = activity
          ? agents.filter((agent) => agent.role !== "main")
          : progress.map((agent) => ({
              agentId: agent.agentId,
              name: agent.name,
              role: "subagent",
              workRole: agent.role,
              state: PROGRESS_STATE[agent.status] ?? "unknown",
              stage: agent.status === "running" ? "working" : "completed",
              degraded: true,
              startedAt:
                nowMsOf(agent.updatedAt) !== undefined && Number.isFinite(agent.elapsedMs)
                  ? nowMsOf(agent.updatedAt) - agent.elapsedMs
                  : undefined,
              endedAt: nowMsOf(agent.updatedAt),
              samples: []
            }));
        const requirementId = session?.currentRequirementId;
        const projectData = project
          ? developmentData.get(`${node.origin}|${project.projectId}`)?.value
          : undefined;
        const view = requirementId && projectData ? stageViewFor(projectData, requirementId) : undefined;
        const stage = resolveStage({
          activity,
          main,
          subs,
          view,
          now: at,
          windowStart: at - minutes * SLICE_MS,
          fallbackStart: nowMsOf(task.createdAt)
        });
        // A Reviewer writing during review is progress for the Main lane too.
        const progressTimes = agents
          .map((agent) => nowMsOf(agent.lastProgressAt))
          .filter((value) => value !== undefined);
        const lastProgress = progressTimes.length ? Math.max(...progressTimes) : undefined;
        const degraded = !activity;
        const capacityEntry = runningByTask.get(task.taskId);
        const kind = session?.kind ?? "regular";
        return {
          task,
          session,
          project,
          requirementId,
          activity,
          degraded,
          main,
          subs,
          stage,
          kind,
          capacityEntry,
          duration: laneDuration(task, capacityEntry, at),
          // The tag always names the real silence; a moment outside the
          // selected window is anchored at the window edge instead of hidden.
          stalled: !degraded && lastProgress !== undefined && at - lastProgress > STALL_THRESHOLD_MS,
          lastProgress,
          startedAt:
            nowMsOf(capacityEntry?.startedAt) ?? nowMsOf(task.createdAt) ?? nowMsOf(activity?.from) ?? at,
          title: session?.title || task.title || task.goal || task.taskId,
          requirementTitle: session?.currentRequirementTitle ?? "",
          orderAt: nowMsOf(session?.createdAt) ?? nowMsOf(task.createdAt) ?? nowMsOf(activity?.from) ?? at
        };
      })
      .sort(
        (left, right) =>
          left.orderAt - right.orderAt || String(left.task.taskId).localeCompare(String(right.task.taskId))
      );
    return { lanes, capacity };
  }

  function collect() {
    filter = data.filter();
    const at = now();
    const nodes = data.nodes().filter((node) => !filter.nodeOrigin || node.origin === filter.nodeOrigin);
    const online = nodes.filter((node) => node.status === "online");
    const offline = nodes.filter((node) => node.status !== "online");
    const cards = online.map((node) => {
      const scoped = data.scoped({ nodeOrigin: node.origin, projectId: filter.projectId });
      return {
        node,
        ...collectLanes(node, scoped.projects ?? [], scoped.tasks ?? [], at)
      };
    });
    return { at, cards, offline, windowStart: at - minutes * SLICE_MS };
  }

  function pendingReads(plan) {
    if (!visible()) return [];
    const reads = [];
    for (const card of plan.cards) {
      const projects =
        data.scoped({
          nodeOrigin: card.node.origin,
          projectId: filter.projectId
        }).projects ?? [];
      for (const project of projects) {
        const pending = sessionsFor(card.node.origin, project.projectId);
        if (pending) reads.push(pending);
        const lanes = card.lanes.filter((lane) => lane.project?.projectId === project.projectId);
        if (lanes.some((lane) => lane.requirementId)) {
          const facts = developmentDataFor(card.node.origin, project.projectId);
          if (facts) reads.push(facts);
        }
      }
      if (card.node.role === "external") {
        const pending = capacityFor(card.node.origin);
        if (pending) reads.push(pending);
      }
      for (const lane of card.lanes) {
        if (!lane.degraded) continue;
        const pending = detailFor(card.node.origin, lane.task.taskId);
        if (pending) reads.push(pending);
      }
    }
    return reads;
  }

  /* ------------------------------------------------------------------ paint */

  function renderHeader(plan) {
    if (!header) return;
    header.hidden = false;
    const degraded = plan.cards.some((card) => card.lanes.some((lane) => lane.degraded));
    const live = header.querySelector("[data-runs-live]");
    const missing = header.querySelector("[data-runs-degraded]");
    if (live) live.hidden = degraded;
    if (missing) missing.hidden = !degraded;
    for (const button of header.querySelectorAll("[data-runs-window]"))
      button.setAttribute("aria-pressed", String(Number(button.dataset.runsWindow) === minutes));
  }

  function axisMarkup() {
    const ticks =
      minutes === 120 ? [-120, -90, -60, -30] : minutes === 30 ? [-30, -20, -10] : [-5, -4, -3, -2, -1];
    return `<div class="runs-axis" aria-hidden="true">
      <span class="runs-axis-label"></span>
      <div class="runs-axis-track">
        ${ticks.map((value) => `<span class="runs-axis-tick">${ui`${value} 分`}</span>`).join("")}
        <span class="runs-axis-tick is-now">${ui("现在")}</span>
      </div>
      <span class="runs-axis-end"></span>
    </div>`;
  }

  function stagePill(stage) {
    return `<span class="runs-pill is-${stage.key}">${esc(ui(stage.label))}</span>`;
  }

  function subline(lane) {
    const requirement = lane.requirementTitle || ui("等新需求");
    if (!lane.project?.projectName) return lane.requirementTitle ? esc(lane.requirementTitle) : "";
    return `${esc(lane.project.projectName)} · ${esc(requirement)}`;
  }

  function waveMarkup({
    segments,
    samples,
    activity,
    windowStart,
    windowEnd,
    height,
    degraded,
    stage,
    extra = ""
  }) {
    const maxScore = Math.max(0, ...samples.map((sample) => sampleScore(sample)));
    const slices = visibleSlices(activity, windowStart, windowEnd);
    if (degraded) {
      return `<div class="runs-wave is-degraded" data-degraded="true" data-slices="${slices}">
        <span class="runs-flat is-baseline"></span>
        ${segments
          .map((segment) => {
            const left = percentOf(segment.from, windowStart, windowEnd);
            const width = percentOf(segment.to, windowStart, windowEnd) - left;
            return `<span class="runs-block is-${segment.kind}" style="left:${left.toFixed(
              2
            )}%;width:${Math.max(0.6, width).toFixed(2)}%"></span>`;
          })
          .join("")}
        ${extra}
      </div>`;
    }
    return `<div class="runs-wave" data-slices="${slices}">
      <svg class="runs-spark" viewBox="0 0 ${WAVE_WIDTH} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <line class="runs-baseline" x1="0" y1="${height / 2}" x2="${WAVE_WIDTH}" y2="${height / 2}" />
        ${segments
          .map(
            (segment) =>
              `<path class="runs-pulse is-${segment.kind}" vector-effect="non-scaling-stroke" d="${pulsePath({
                samples,
                activity,
                segment,
                windowStart,
                windowEnd,
                height,
                maxScore
              })}" />`
          )
          .join("")}
      </svg>
      ${stage && stage.key !== "idle" ? `<span class="runs-head is-${stage.key}"></span>` : ""}
      ${extra}
    </div>`;
  }

  function laneMarkup(lane, plan) {
    const { at } = plan;
    const windowStart = at - minutes * SLICE_MS;
    const windowEnd = at;
    const degraded = lane.degraded;
    const samples = combinedSamples(lane.activity);
    const segments = degraded
      ? degradedLaneSegments(lane, windowStart, windowEnd)
      : laneSegments({
          activity: lane.activity,
          samples,
          stage: lane.stage,
          windowStart,
          windowEnd,
          degraded: false
        });
    const stallLeft = lane.stalled
      ? Math.min(percentOf(lane.lastProgress, windowStart, windowEnd), 82)
      : undefined;
    const wave = waveMarkup({
      segments,
      samples,
      activity: lane.activity,
      windowStart,
      windowEnd,
      height: 40,
      degraded,
      stage: lane.stage,
      extra: lane.stalled
        ? `<span class="runs-stall" data-runs-stall style="left:calc(${stallLeft.toFixed(2)}% + 20px)">${esc(
            formatStall(at - lane.lastProgress)
          )}</span>`
        : ""
    });
    return `<div class="runs-lane${lane.stalled ? " is-stalled" : ""}" data-runs-lane="${esc(
      lane.task.taskId
    )}" data-stage="${lane.stage.key}" data-stalled="${lane.stalled}" data-degraded="${degraded}">
      <div class="runs-lane-label">
        <div class="runs-lane-head">
          <span class="runs-session">${esc(lane.title)}</span>
          ${stagePill(lane.stage)}
        </div>
        <div class="runs-lane-sub">${subline(lane)}</div>
      </div>
      ${wave}
      <div class="runs-lane-right">
        <span class="runs-duration">${esc(formatSpan(lane.duration))}</span>
      </div>
    </div>
    ${lane.subs.map((agent) => subLaneMarkup(lane, agent, plan)).join("")}`;
  }

  function subLaneMarkup(lane, agent, plan) {
    const { at } = plan;
    const windowStart = at - minutes * SLICE_MS;
    const windowEnd = at;
    const role = WORK_ROLE_LABEL[agent.workRole] ?? "Subagent";
    const name = agent.name || agentDisplayName(agent.agentId);
    const stateLabel = AGENT_STATE_LABEL[agent.state] ?? "";
    const color = agent.workRole === "reviewer" ? "review" : "dev";
    const degraded = Boolean(agent.degraded);
    const segments = degraded ? [] : subSegments({ activity: lane.activity, agent, windowStart, windowEnd });
    const samples = agent.samples ?? [];
    const end = degraded
      ? agent.state === "running"
        ? windowEnd
        : Math.min(windowEnd, agent.endedAt ?? windowEnd)
      : segments.at(-1)?.to;
    const start = degraded
      ? Math.max(windowStart, Math.min(agent.startedAt ?? lane.startedAt ?? end, end))
      : undefined;
    const left = end === undefined ? 100 : percentOf(end, windowStart, windowEnd);
    const head =
      agent.state === "running"
        ? `<span class="runs-head is-${degraded ? color : (segments.at(-1)?.kind ?? "dev")}" style="left:${left.toFixed(
            2
          )}%"></span>`
        : agent.state === "completed" && end !== undefined
          ? `<span class="runs-done" style="left:${left.toFixed(2)}%">${icon("check")}</span>`
          : "";
    const wave = degraded
      ? `<div class="runs-wave is-sub is-degraded" data-degraded="true" data-state="${esc(agent.state)}">
          <span class="runs-flat is-baseline"></span>
          ${
            end === undefined || start === undefined
              ? ""
              : `<span class="runs-block is-${color}" style="left:${percentOf(
                  start,
                  windowStart,
                  windowEnd
                ).toFixed(2)}%;width:${Math.max(
                  0.8,
                  percentOf(end, windowStart, windowEnd) - percentOf(start, windowStart, windowEnd)
                ).toFixed(2)}%"></span>`
          }
          ${head}
        </div>`
      : `<div class="runs-wave is-sub" data-state="${esc(agent.state)}">
          <svg class="runs-spark" viewBox="0 0 ${WAVE_WIDTH} 22" preserveAspectRatio="none" aria-hidden="true">
            <line class="runs-baseline" x1="0" y1="11" x2="${WAVE_WIDTH}" y2="11" />
            ${segments
              .map(
                (segment) =>
                  `<path class="runs-pulse is-${segment.kind}" vector-effect="non-scaling-stroke" d="${pulsePath(
                    {
                      samples,
                      activity: lane.activity,
                      segment,
                      windowStart,
                      windowEnd,
                      height: 22,
                      maxScore: Math.max(0, ...samples.map((sample) => sampleScore(sample)))
                    }
                  )}" />`
              )
              .join("")}
          </svg>
          ${head}
        </div>`;
    return `<div class="runs-sublane" data-runs-agent="${esc(agent.agentId)}" data-state="${esc(agent.state)}">
      <div class="runs-sublane-label">
        <span class="runs-branch" aria-hidden="true"></span>
        <span class="runs-role">${esc(role)}</span>
        <span class="runs-agent">${esc(name)}</span>
      </div>
      ${wave}
      <div class="runs-lane-right">${
        stateLabel ? `<span class="runs-kid-state is-${esc(agent.state)}">${esc(ui(stateLabel))}</span>` : ""
      }</div>
    </div>`;
  }

  function slotMarkup(label, quota, used, tone) {
    const slots = Math.min(Math.max(quota, 1), 8);
    const filled = Math.min(used, slots);
    return `<div class="runs-slot" data-runs-slot="${tone}">
      <span class="runs-slot-label">${esc(label)}</span>
      <span class="runs-slot-bar">${Array.from(
        { length: slots },
        (_, index) => `<span class="runs-slot-seg${index < filled ? ` is-${tone}` : ""}"></span>`
      ).join("")}</span>
      <span class="runs-slot-value${tone === "continuation" ? " is-warn" : ""}">${used}/${quota}</span>
    </div>`;
  }

  function emptyLaneMarkup(label) {
    return `<div class="runs-lane is-empty" data-runs-empty="${esc(label)}">
      <div class="runs-lane-label"><span class="runs-session">${esc(label)}</span></div>
      <div class="runs-wave"><span class="runs-flat"></span></div>
      <div class="runs-lane-right"></div>
    </div>`;
  }

  function nodeMarkup(card, plan) {
    const { node, lanes, capacity } = card;
    const external = node.role === "external";
    const settings = capacity?.settings;
    const running = capacity?.running ?? [];
    const usedByKind = {
      regular: running.filter((entry) => entry.kind === "regular").length,
      continuation: running.filter((entry) => entry.kind === "continuation").length
    };
    let body = "";
    if (external && settings) {
      for (const [kind, label, tone] of [
        ["regular", ui("常驻"), "regular"],
        ["continuation", ui("接续"), "continuation"]
      ]) {
        const quota = Number(settings[kind === "regular" ? "resident" : "continuation"]) || 0;
        const kindLanes = lanes.filter((lane) => lane.kind === kind);
        // Occupancy is what the host's slots say, not what the current filter
        // happens to show: hiding a lane must not free its place.
        const used = usedByKind[kind];
        body += slotMarkup(label, quota, used, tone);
        body += kindLanes.map((lane) => laneMarkup(lane, plan)).join("");
        for (let index = used; index < quota; index += 1) body += emptyLaneMarkup(`${label} ${index + 1}`);
      }
      const rest = lanes.filter((lane) => !["regular", "continuation"].includes(lane.kind));
      body += rest.map((lane) => laneMarkup(lane, plan)).join("");
    } else {
      body = lanes.map((lane) => laneMarkup(lane, plan)).join("");
    }
    return `<section class="runs-node" data-runs-node="${esc(node.origin)}" data-role="${
      external ? "external" : "internal"
    }">
      <header class="runs-node-head">
        ${icon(node.local ? "laptop" : "server")}
        <span class="runs-node-name">${esc(node.name)}</span>
        <span class="runs-role-chip">${esc(ui(external ? "对外" : "对内"))}</span>
        <span class="runs-node-dot is-ok" aria-hidden="true"></span>
      </header>
      ${body}
    </section>`;
  }

  function offlineMarkup(node, at) {
    const status = ui(NODE_STATUS_LABEL[node.status] ?? "离线");
    const seen = node.lastSeen ? `${status} · ${formatStamp(node.lastSeen, "relative", at)}` : status;
    return `<section class="runs-node is-offline" data-runs-node="${esc(node.origin)}">
      ${icon("server")}
      <span class="runs-node-name">${esc(node.name)}</span>
      <span class="runs-node-dot" aria-hidden="true"></span>
      <span class="runs-spacer"></span>
      <span class="runs-offline">${esc(seen)}</span>
    </section>`;
  }

  function paint(plan) {
    renderHeader(plan);
    const empty = !plan.cards.some((card) => card.lanes.length) && plan.cards.length === 0;
    root.dataset.window = String(minutes);
    root.dataset.renderedAt = String(plan.at);
    root.dataset.motion = motion ? "reduced" : "live";
    root.dataset.refreshMs = String(motion ? reducedRefreshMs : refreshMs);
    root.innerHTML = `${axisMarkup()}<div class="runs-nodes">${plan.cards
      .map((card) => nodeMarkup(card, plan))
      .join("")}${plan.offline.map((node) => offlineMarkup(node, plan.at)).join("")}${
      empty ? `<p class="runs-empty">${esc(ui("没有运行中的 Main"))}</p>` : ""
    }</div>`;
  }

  async function hydrate() {
    if (disposed) return;
    if (hydrating) {
      dirty = true;
      return;
    }
    hydrating = true;
    try {
      for (let round = 0; round < 5; round += 1) {
        const reads = pendingReads(collect());
        if (!reads.length) break;
        await Promise.all(reads);
      }
    } finally {
      hydrating = false;
    }
    if (!disposed) paint(collect());
    if (dirty) {
      dirty = false;
      void hydrate();
    }
  }

  function render() {
    if (disposed || !visible()) return;
    const plan = collect();
    paint(plan);
    void hydrate();
  }

  function visible() {
    return !root.closest("[hidden]");
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(
      () => {
        if (visible()) render();
      },
      motion ? reducedRefreshMs : refreshMs
    );
    timer?.unref?.();
  }

  function reducedMotion() {
    const preference = globalThis.window?.atriaPreferences?.motion?.();
    if (preference === "on") return true;
    if (preference === "off") return false;
    return Boolean(globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }

  function applyMotion() {
    motion = reducedMotion();
    restartTimer();
    render();
  }

  function buildHeader() {
    if (!header) return;
    header.innerHTML = `<span class="runs-live" data-runs-live>
        <span class="runs-live-dot" aria-hidden="true"></span>${ui("实时")}
      </span>
      <span class="runs-degraded" data-runs-degraded role="status" hidden>${ui("指标未就绪")}</span>
      <span class="runs-spacer"></span>
      <span class="runs-legend" role="group" aria-label="${esc(ui("阶段"))}">
        ${[
          ["dev", "开发", "accent"],
          ["review", "审查", "review"],
          ["merge", "合入", "ok"],
          ["wait", "等待", "warn"],
          ["idle", "空闲", "muted"]
        ]
          .map(
            ([key, label, tone]) =>
              `<span class="runs-key"><span class="runs-swatch is-${tone}"></span>${esc(ui(label))}</span>`
          )
          .join("")}
      </span>
      <span class="runs-window" role="group" aria-label="${esc(ui("时间窗口"))}">
        ${RUNS_WINDOWS.map(
          (value) =>
            `<button type="button" data-runs-window="${value}" aria-pressed="${
              value === minutes
            }">${value === 120 ? ui("2 小时") : ui`${value} 分`}</button>`
        ).join("")}
      </span>`;
  }

  const onHeaderClick = (event) => {
    const button = event.target.closest("[data-runs-window]");
    if (!button) return;
    const next = Number(button.dataset.runsWindow);
    if (!RUNS_WINDOWS.includes(next) || next === minutes) return;
    minutes = next;
    render();
  };
  header?.addEventListener("click", onHeaderClick);

  const unsubscribe = data.subscribe(() => {
    const next = data.filter();
    if (motion && sameFilter(next, filter)) return;
    filter = next;
    render();
  });

  // A hidden panel does no reads. The store flips the hidden attribute on the
  // pane (entry switch) and on this view (view switch), so watch both.
  const Observer = globalThis.window?.MutationObserver;
  const visibilityObserver = Observer
    ? new Observer(() => {
        if (visible()) render();
      })
    : undefined;
  for (const node of new Set([root, root.closest("[data-entry-panel]")]))
    if (node && visibilityObserver)
      visibilityObserver.observe(node, { attributes: true, attributeFilter: ["hidden"] });

  const media = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const onMedia = () => applyMotion();
  media?.addEventListener?.("change", onMedia);
  const stopPreferences = globalThis.window?.atriaPreferences?.onChange?.(() => applyMotion());

  buildHeader();
  motion = reducedMotion();
  restartTimer();
  render();

  return {
    render,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      visibilityObserver?.disconnect();
      header?.removeEventListener("click", onHeaderClick);
      media?.removeEventListener?.("change", onMedia);
      stopPreferences?.();
      unsubscribe();
    }
  };
}
