import { createManagementClient, normalizeBackendUrl } from "./management-client.js";
import { readNodes, writeNodes } from "./node-registry.js";
import { ui } from "../ui/language.js";

/**
 * The observation entry's read-only data port.
 *
 * One client per connected node, each with its own session, catalog snapshot
 * and event stream. The work entry keeps using the page's own client; this
 * module never touches it beyond the local provider the page passes in.
 *
 * The port exposes what the three observation views need without letting them
 * hold a connection:
 *  - `nodes()` — the local node and every connected node with live status.
 *  - `scoped(filter)` — the projects, tasks and requirements in scope, with
 *    duplicates from nodes that read the same shared records merged.
 *  - `counts(filter)` — the view counts in the sidebar.
 *  - `read(origin, path)` — one authorized read from one node.
 *
 * A node that is offline, refused or removed only affects its own entry: the
 * others keep their snapshot and stream, and their tokens never travel to a
 * different origin.
 */

const LEDGER_PATH = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/ledger`;

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;
/**
 * What every request of this port carries: observation only watches nodes.
 *
 * The backend answers these reads from its stored records and leaves that
 * node's pending deliveries for its own work entry or periodic pass, so a
 * person watching a node never writes on it. The work entry's own client is a
 * different one and never sends this marker.
 */
const READ_ONLY_HEADERS = { "x-cowork-read-only": "1" };

/**
 * A node read is always a path on that node.
 *
 * The management client passes an absolute URL through to `fetch`, so an
 * absolute or protocol-relative value here would send this node's credential
 * to another origin. The port therefore accepts only a rooted, single-slash
 * path.
 */
function nodePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || ABSOLUTE_URL.test(path))
    throw new Error(ui("节点读取只接受相对路径"));
  return path;
}

function nodeStorage(base, origin) {
  const prefix = `cowork.node.${origin}:`;
  return {
    prefix,
    getItem: (key) => base?.getItem(`${prefix}${key}`) ?? null,
    setItem: (key, value) => base?.setItem(`${prefix}${key}`, String(value)),
    removeItem: (key) => base?.removeItem(`${prefix}${key}`)
  };
}

function clearStoredPrefix(base, prefix) {
  if (!base || typeof base.key !== "function") return;
  const keys = [];
  for (let index = 0; index < base.length; index += 1) {
    const key = base.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) base.removeItem(key);
}

function describeError(error) {
  return error?.message || ui("无法连接节点");
}

/**
 * @param {object} options
 * @param {Storage} [options.storage]         device-local node records
 * @param {Storage} [options.sessionStorage]  per-node session tokens
 * @param {object} [options.local]            the page's own node
 * @param {() => string} [options.local.status]
 * @param {() => {projects: object[], tasks: object[]}} [options.local.snapshot]
 * @param {(path: string, options?: object) => Promise<object>} [options.local.request]
 * @param {typeof createManagementClient} [options.createClient]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.retryDelayMs]
 * @param {number} [options.maxRetryDelayMs]
 * @param {() => Date} [options.now]
 */
export function createObserveData({
  storage,
  sessionStorage,
  local,
  createClient = createManagementClient,
  fetch: fetchImpl,
  retryDelayMs = 1_500,
  maxRetryDelayMs = 30_000,
  now = () => new Date()
} = {}) {
  /** @type {Map<string, object>} every entry, local included */
  const entries = new Map();
  const listeners = new Set();
  let filter = { nodeOrigin: "", projectId: "" };
  let disposed = false;

  function stamp() {
    return now().toISOString();
  }

  function notify() {
    if (disposed) return;
    const state = publicState();
    for (const listener of listeners) listener(state);
  }

  function publicEntry(entry) {
    return {
      origin: entry.origin,
      name: entry.name,
      role: entry.role,
      local: entry.local,
      status: entry.status,
      lastSeen: entry.lastSeen,
      error: entry.error
    };
  }

  function publicState() {
    return { ...scoped(filter), filter: { ...filter } };
  }

  function setStatus(entry, status, error = "") {
    const previous = entry.status;
    if (previous === status && entry.error === error) return;
    if (status === "offline" && previous === "online") entry.lastSeen = stamp();
    entry.status = status;
    entry.error = error;
    if (!entry.local && (status === "offline" || status === "disconnected")) remember(entry);
    notify();
  }

  function remember(entry) {
    const records = [...entries.values()]
      .filter((value) => !value.local)
      .map((value) => ({
        origin: value.origin,
        name: value.name,
        role: value.role,
        ...(value.lastSeen ? { lastSeen: value.lastSeen } : {})
      }));
    writeNodes(storage, records);
  }

  /* ------------------------------------------------------------- snapshots */

  function adoptSnapshot(entry, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.tasks)) return;
    entry.snapshot = { projects: snapshot.projects, tasks: snapshot.tasks };
    entry.snapshotSignature = snapshot.projects
      .map((project) => project.projectId)
      .filter(Boolean)
      .sort()
      .join(",");
    if (entry.status !== "online") setStatus(entry, "online");
    else notify();
    void loadRequirements(entry);
  }

  /**
   * Read every project's requirement ledger from this node.
   *
   * The sidebar counts requirements, not Main sessions, so the port reads the
   * records the requirement view will also use. A project whose ledger cannot
   * be read contributes no count instead of failing the node.
   */
  async function loadRequirements(entry, { force = false } = {}) {
    const projects = entry.snapshot?.projects ?? [];
    const signature = entry.snapshotSignature ?? "";
    if (!force && entry.requirementsSignature === signature && entry.requirementsLoaded) return;
    entry.requirementsLoaded = true;
    entry.requirementsSignature = signature;
    const next = new Map();
    let failed = false;
    await Promise.all(
      projects.map(async (project) => {
        if (!project?.projectId) return;
        try {
          const result = await readEntry(entry, LEDGER_PATH(project.projectId));
          next.set(project.projectId, Array.isArray(result?.requirements) ? result.requirements : []);
          // eslint-disable-next-line no-restricted-syntax -- one project's ledger may be unavailable on an older node; that project contributes no count and the other nodes still aggregate
        } catch {
          failed = true;
          next.set(project.projectId, []);
        }
      })
    );
    if (entry.disposed) return;
    entry.requirements = next;
    // A ledger that could not be read is retried by the next snapshot or
    // catalog change instead of being remembered as an empty list.
    if (failed) entry.requirementsLoaded = false;
    notify();
  }

  /* ------------------------------------------------------------ connection */

  function createRemoteEntry(record) {
    const store = nodeStorage(sessionStorage, record.origin);
    const entry = {
      origin: record.origin,
      name: record.name,
      role: record.role,
      local: false,
      status: "connecting",
      lastSeen: record.lastSeen,
      error: "",
      snapshot: undefined,
      requirements: new Map(),
      requirementsLoaded: false,
      requirementsSignature: "",
      wanted: true,
      disposed: false,
      retryDelay: retryDelayMs,
      store
    };
    entry.client = createClient({
      baseUrl: record.origin,
      clientName: "Formicand Observe",
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      storage: store,
      // The catalog snapshot and event stream are reads of the same port, so
      // they carry the marker too.
      transportHeaders: READ_ONLY_HEADERS,
      events: {
        onSnapshot: (snapshot) => adoptSnapshot(entry, snapshot),
        onEvent: (recordEvent) => applyEvent(entry, recordEvent),
        onReset: (reset) => {
          if (reset?.reason !== "backend_mismatch") return;
          void reconnectEntry(entry);
        },
        onStatus: (status) => {
          if (entry.disposed) return;
          if (status === "connected") {
            const wasOffline = entry.status !== "online";
            setStatus(entry, "online");
            // Events resume from the applied cursor; a fresh snapshot and a
            // requirement re-read close the gap the disconnected node could
            // not publish.
            if (wasOffline && entry.snapshot)
              void refreshSnapshot(entry).then((current) => {
                if (current) return loadRequirements(entry, { force: true });
                return undefined;
              });
            return;
          }
          if (status === "retrying" || status === "failed") {
            setStatus(entry, "offline", entry.error || "");
            // "retrying" means the event client is already reconnecting on its
            // own; a failed first snapshot needs the port to try again.
            if (status === "failed") scheduleRetry(entry);
            return;
          }
          if (status === "unauthorized") setStatus(entry, "unauthorized");
        }
      },
      onStateChange: (state) => {
        if (entry.disposed) return;
        if (state.status === "unauthorized" && entry.status !== "unauthorized")
          setStatus(entry, "unauthorized", state.error?.message || "");
        else if (state.status === "unsupported" || state.status === "incompatible")
          setStatus(entry, "failed", state.error?.message || "");
      }
    });
    return entry;
  }

  function applyEvent(entry, record) {
    if (!entry.snapshot || !record) return;
    if (record.scope === "task") {
      const tasks = entry.snapshot.tasks;
      const index = tasks.findIndex((task) => task.taskId === record.objectId);
      if (record.type === "task.deleted") {
        if (index >= 0) tasks.splice(index, 1);
      } else {
        const task = record.payload;
        if (!task || typeof task.taskId !== "string") return;
        if (index >= 0) tasks[index] = { ...tasks[index], ...task };
        else tasks.push(task);
      }
    } else if (record.scope === "project" && record.type === "project.changed") {
      const project = record.payload;
      if (!project || typeof project.projectId !== "string") return;
      const projects = entry.snapshot.projects;
      const index = projects.findIndex((item) => item.projectId === project.projectId);
      if (index >= 0) projects[index] = { ...projects[index], ...project };
      else projects.push(project);
      entry.snapshotSignature = projects
        .map((item) => item.projectId)
        .filter(Boolean)
        .sort()
        .join(",");
      void loadRequirements(entry);
    } else return;
    notify();
  }

  async function readEntry(entry, path, options = {}) {
    const target = nodePath(path);
    const request = { ...options, headers: { ...READ_ONLY_HEADERS, ...options.headers } };
    if (entry.local) return local.request(target, request);
    return entry.client.request(target, request);
  }

  async function connectEntry(entry, { reauthorize = false } = {}) {
    if (entry.disposed || disposed || !entry.wanted) return entry;
    clearRetry(entry);
    if (entry.status !== "unauthorized") setStatus(entry, "connecting");
    let state;
    try {
      state = await entry.client.connect({ baseUrl: entry.origin, reuse: !reauthorize });
    } catch (error) {
      if (!entry.disposed) setStatus(entry, "offline", describeError(error));
      scheduleRetry(entry);
      return entry;
    }
    if (entry.disposed || disposed) return entry;
    if (state?.status === "connected" || entry.client.state().status === "connected") {
      setStatus(entry, "online");
      entry.retryDelay = retryDelayMs;
      // A caller that just added or reconnected a node can show its records
      // only after the first snapshot; the live stream alone starts empty.
      if (!entry.snapshot) await refreshSnapshot(entry);
    } else if (state?.status === "unauthorized") {
      setStatus(entry, "unauthorized", state.error?.message || "");
    } else if (state?.status === "unsupported" || state?.status === "incompatible") {
      setStatus(entry, "failed", state.error?.message || "");
    } else {
      setStatus(entry, "offline", state?.error?.message || describeError());
      scheduleRetry(entry);
    }
    return entry;
  }

  async function refreshSnapshot(entry) {
    try {
      const snapshot = await entry.client.snapshot();
      if (!snapshot || entry.disposed) return false;
      adoptSnapshot(entry, snapshot);
      return true;
    } catch (error) {
      if (entry.disposed) return false;
      setStatus(entry, "offline", describeError(error));
      scheduleRetry(entry);
      return false;
    }
  }

  function clearRetry(entry) {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }

  function scheduleRetry(entry) {
    if (entry.disposed || disposed || !entry.wanted || entry.retryTimer) return;
    if (entry.status === "unauthorized" || entry.status === "failed") return;
    const delay = entry.retryDelay;
    entry.retryDelay = Math.min(maxRetryDelayMs, Math.round(delay * 1.7));
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      void connectEntry(entry);
    }, delay);
    entry.retryTimer?.unref?.();
  }

  async function reconnectEntry(entry) {
    if (entry.disposed) return entry;
    entry.client.stop();
    entry.snapshot = undefined;
    entry.requirementsLoaded = false;
    entry.retryDelay = retryDelayMs;
    return connectEntry(entry);
  }

  function stopEntry(entry) {
    clearRetry(entry);
    entry.wanted = false;
    entry.client?.stop();
    if (entry.status !== "disconnected") setStatus(entry, "disconnected");
  }

  /* ------------------------------------------------------------- providers */

  function adoptLocal() {
    const entry = entries.get(local.origin);
    if (!entry) return;
    const status = local.status();
    if (status !== "online") {
      if (status !== entry.status) setStatus(entry, status);
      return;
    }
    const snapshot = local.snapshot();
    if (snapshot) adoptSnapshot(entry, { projects: snapshot.projects || [], tasks: snapshot.tasks || [] });
    else if (entry.status !== status) setStatus(entry, status);
  }

  /* ---------------------------------------------------------- aggregation */

  function entryVisible(entry) {
    return entry.status === "online";
  }

  function scopedEntries(nodeOrigin) {
    const list = [...entries.values()].filter((entry) => entryVisible(entry));
    return nodeOrigin ? list.filter((entry) => entry.origin === nodeOrigin) : list;
  }

  function mergeProjects(list, filter) {
    const projects = new Map();
    for (const entry of list) {
      for (const project of entry.snapshot?.projects ?? []) {
        if (!project?.projectId) continue;
        if (filter.projectId && project.projectId !== filter.projectId) continue;
        const existing = projects.get(project.projectId);
        const newer =
          !existing ||
          String(project.updatedAt || "") > String(existing.project.updatedAt || "") ||
          (!existing.projectName && project.projectName);
        if (newer) projects.set(project.projectId, { ...project });
        const merged = projects.get(project.projectId);
        merged.origins ??= [];
        if (!merged.origins.includes(entry.origin)) merged.origins.push(entry.origin);
      }
    }
    return [...projects.values()];
  }

  function mergeTasks(list, filter) {
    const tasks = new Map();
    for (const entry of list) {
      for (const task of entry.snapshot?.tasks ?? []) {
        if (!task?.taskId) continue;
        if (filter.projectId && task.projectId !== filter.projectId) continue;
        if (!tasks.has(task.taskId)) tasks.set(task.taskId, { ...task });
      }
    }
    return [...tasks.values()];
  }

  function mergeRequirements(list, filter) {
    const requirements = new Map();
    for (const entry of list) {
      for (const [projectId, rows] of entry.requirements ?? []) {
        if (filter.projectId && projectId !== filter.projectId) continue;
        for (const requirement of rows) {
          if (!requirement?.requirementId) continue;
          const key = `${projectId}:${requirement.requirementId}`;
          if (!requirements.has(key))
            requirements.set(key, { ...requirement, projectId, origin: entry.origin });
        }
      }
    }
    return [...requirements.values()];
  }

  function nodesInScope() {
    return [...entries.values()].map(publicEntry);
  }

  function scoped(next = filter) {
    const list = scopedEntries(next.nodeOrigin);
    return {
      nodes: nodesInScope(),
      projects: mergeProjects(list, next),
      tasks: mergeTasks(list, next),
      requirements: mergeRequirements(list, next)
    };
  }

  function counts(next = filter) {
    const data = scoped(next);
    const projectCounts = new Map();
    for (const requirement of data.requirements)
      projectCounts.set(requirement.projectId, (projectCounts.get(requirement.projectId) || 0) + 1);
    return {
      requirements: data.requirements.length,
      runs: data.tasks.filter((task) => ["running", "waiting"].includes(task.status)).length,
      projects: projectCounts
    };
  }

  /* ------------------------------------------------------------- lifecycle */

  function start() {
    if (!entries.size) {
      const entry = {
        origin: local.origin,
        name: local.name,
        role: local.role ?? "internal",
        local: true,
        status: "connecting",
        lastSeen: undefined,
        error: "",
        snapshot: undefined,
        requirements: new Map(),
        requirementsLoaded: false,
        requirementsSignature: "",
        wanted: true,
        disposed: false
      };
      entries.set(entry.origin, entry);
      adoptLocal();
    }
    for (const record of readNodes(storage)) {
      if (entries.has(record.origin)) continue;
      const entry = createRemoteEntry(record);
      entries.set(entry.origin, entry);
      void connectEntry(entry);
    }
    notify();
    return publicState();
  }

  function dispose() {
    disposed = true;
    listeners.clear();
    for (const entry of entries.values()) {
      entry.disposed = true;
      clearRetry(entry);
      entry.client?.stop();
    }
    entries.clear();
  }

  return {
    start,
    dispose,
    /** The page's own catalog changed; re-read the local provider. */
    localChanged() {
      if (disposed) return publicState();
      adoptLocal();
      return publicState();
    },
    nodes: nodesInScope,
    /** All connected projects, deduplicated for nodes sharing the same records. */
    projects: () => scoped(filter).projects,
    scoped,
    counts,
    /** Observe every status, snapshot and filter change; returns the unsubscriber. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    filter: () => ({ ...filter }),
    setFilter(next = {}) {
      filter = {
        nodeOrigin: typeof next.nodeOrigin === "string" ? next.nodeOrigin : "",
        projectId: typeof next.projectId === "string" ? next.projectId : ""
      };
      notify();
      return publicState();
    },
    statusOf(origin) {
      return entries.get(origin)?.status ?? "absent";
    },
    async read(origin, path, options) {
      const entry = entries.get(origin);
      if (!entry) throw new Error(ui`未知节点：${origin}`);
      return readEntry(entry, path, options);
    },
    async refreshRequirements(origin) {
      const targets = origin ? [entries.get(origin)].filter(Boolean) : [...entries.values()];
      for (const entry of targets)
        if (entry.status === "online" && entry.snapshot) await loadRequirements(entry, { force: true });
    },
    async addNode({ baseUrl, name, role = "internal" } = {}) {
      const origin = normalizeBackendUrl(baseUrl);
      if (!origin) throw new Error("请填写节点地址");
      if (entries.has(origin) || origin === local.origin) throw new Error("该节点已经添加");
      const label = String(name ?? "").trim() || new URL(origin).host;
      const scope = role === "external" ? "external" : "internal";
      const entry = createRemoteEntry({ origin, name: label, role: scope });
      entries.set(origin, entry);
      remember(entry);
      notify();
      await connectEntry(entry);
      return publicEntry(entry);
    },
    renameNode(origin, name) {
      const entry = entries.get(origin);
      if (!entry || entry.local) throw new Error("找不到该节点");
      const label = String(name ?? "").trim();
      if (!label) throw new Error("节点名称不能为空");
      entry.name = label;
      remember(entry);
      notify();
      return publicEntry(entry);
    },
    async reauthorizeNode(origin) {
      const entry = entries.get(origin);
      if (!entry || entry.local) throw new Error("找不到该节点");
      entry.client.stop();
      entry.wanted = true;
      entry.snapshot = undefined;
      entry.requirementsLoaded = false;
      entry.retryDelay = retryDelayMs;
      return publicEntry(await connectEntry(entry, { reauthorize: true }));
    },
    async reconnectNode(origin) {
      const entry = entries.get(origin);
      if (!entry || entry.local) throw new Error("找不到该节点");
      entry.wanted = true;
      return publicEntry(await reconnectEntry(entry));
    },
    disconnectNode(origin) {
      const entry = entries.get(origin);
      if (!entry || entry.local) throw new Error("找不到该节点");
      stopEntry(entry);
      remember(entry);
      return publicEntry(entry);
    },
    removeNode(origin) {
      const entry = entries.get(origin);
      if (!entry || entry.local) throw new Error("找不到该节点");
      entry.disposed = true;
      clearRetry(entry);
      entry.client?.stop();
      entries.delete(origin);
      // Removing a node also drops this device's session for that origin.
      clearStoredPrefix(sessionStorage, entry.store.prefix);
      remember(entry);
      notify();
      return publicEntry(entry);
    }
  };
}
