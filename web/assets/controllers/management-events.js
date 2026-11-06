/**
 * The shared client for the management snapshot and event stream.
 *
 * Every client of a backend — the Web UI now, the Wails host and future
 * entries later — reconciles the same way: take a snapshot, adopt its cursor,
 * then follow the events from that cursor. This module owns that handoff so a
 * screen never has to reason about duplicates, ordering or stale connections
 * itself.
 *
 * Rules it enforces, in order of what they protect:
 *  - Only this backend's records count. A record or snapshot carrying another
 *    `backendId` is dropped, which is what makes a late message from the
 *    backend the user switched away from harmless.
 *  - Sequence is the truth. `seq` at or below the applied cursor is a
 *    duplicate and never reaches the consumer; a gap stops the stream and
 *    reconnects from the applied cursor so the missed records arrive in order.
 *  - Revisions guard the object. An event whose object revision is not newer
 *    than the one already applied is stale (an old snapshot plus replay) and is
 *    ignored, so applying is idempotent.
 *  - An expired or unknown cursor needs a snapshot. The server refuses it with
 *    `cursor_expired`/`cursor_unknown` (or a `stream.reset` frame), and the
 *    client resets and takes a new snapshot instead of skipping events.
 *
 * It never sends a command. Reconnecting replays events; it does not re-run an
 * operation. Change commands belong to the command layer, where an
 * `operationId` and its saved receipt make a retry idempotent.
 */

const SNAPSHOT_PATH = "/api/events/snapshot";
const STREAM_PATH = "/api/events/stream";

const objectKey = (record) => `${record.scope}:${record.objectId}`;

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Read one SSE body, handing each complete `data:` frame to the caller. */
export async function readEventStream(body, onRecord) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let record;
        try {
          record = JSON.parse(data);
        } catch {
          continue;
        }
        if (!record || typeof record !== "object") continue;
        if (onRecord(record)) return;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/**
 * @param {object} options
 * @param {string} options.backendId  the backend identity this client is bound to
 * @param {string} [options.baseUrl]  backend origin; empty for the page's own
 * @param {typeof fetch} [options.fetch]
 * @param {object|(() => object)} [options.headers]  the session credential, read per request
 * @param {number} [options.retryDelayMs]
 * @param {(snapshot: object) => void} [options.onSnapshot]  replace the local view
 * @param {(event: object) => void} [options.onEvent]        apply one newer change
 * @param {(reset: {reason: string, backendId: string}) => void} [options.onReset]
 * @param {(status: string, detail?: unknown) => void} [options.onStatus]
 */
export function createManagementEventClient({
  backendId,
  baseUrl = "",
  fetch: fetchImpl = globalThis.fetch,
  headers = {},
  retryDelayMs = 250,
  onSnapshot = () => {},
  onEvent = () => {},
  onReset = () => {},
  onStatus = () => {}
} = {}) {
  if (typeof backendId !== "string" || !backendId) throw new Error("事件客户端需要绑定后端身份 backendId");
  let identity = { backendId, baseUrl: String(baseUrl).replace(/\/+$/, "") };
  let cursor = 0;
  let revisions = new Map();
  let disposed = false;
  /** The current connection; starting or switching replaces it and retires the old one. */
  let connection;

  const url = (path) => `${identity.baseUrl}${path}`;
  const authHeaders = (extra = {}) => ({
    ...(typeof headers === "function" ? headers() : headers),
    ...extra
  });

  function open() {
    connection?.abort();
    connection = new AbortController();
    return connection;
  }

  /** A refused credential is final: retrying would replace the caller's status with noise. */
  const unauthorized = (status) => status === 401 || status === 403;

  async function readSnapshot(active) {
    const response = await fetchImpl(url(SNAPSHOT_PATH), {
      method: "GET",
      headers: authHeaders({ accept: "application/json" }),
      signal: active.signal,
      cache: "no-store"
    });
    if (unauthorized(response.status)) {
      const error = new Error(`快照请求未获授权（HTTP ${response.status}）`);
      error.auth = true;
      throw error;
    }
    if (!response.ok) throw new Error(`快照请求失败（HTTP ${response.status}）`);
    return response.json();
  }

  /**
   * Adopt one authoritative snapshot.
   *
   * @returns {boolean} whether the client still owns it; a snapshot from another
   *   backend identity is rejected instead of being merged into this view.
   */
  function applySnapshot(snapshot, { notify = true } = {}) {
    if (!snapshot || snapshot.backendId !== identity.backendId) {
      onReset({ reason: "backend_mismatch", backendId: identity.backendId });
      return false;
    }
    cursor = Number.isInteger(snapshot.cursor) ? snapshot.cursor : 0;
    revisions = new Map(Object.entries(snapshot.revisions || {}));
    if (notify) onSnapshot(snapshot);
    return true;
  }

  /** Apply one record; returns how it was treated so the stream can act on a gap. */
  function applyRecord(record) {
    if (record.backendId !== identity.backendId) return "foreign";
    if (record.type === "stream.reset") return "reset";
    if (!Number.isInteger(record.seq) || typeof record.scope !== "string") return "invalid";
    if (record.seq <= cursor) return "duplicate";
    if (record.seq !== cursor + 1) return "gap";
    cursor = record.seq;
    const key = objectKey(record);
    const revision = Number(record.revision || 0);
    if (revision <= (revisions.get(key) || 0)) return "stale";
    revisions.set(key, revision);
    onEvent(record);
    return "applied";
  }

  /**
   * Drop the applied position and take a fresh snapshot.
   *
   * Called when the server says the cursor is gone: skipping the missing events
   * would leave the view wrong, and a snapshot is the only thing that can
   * repair it. The signal is reused because the refused request is already
   * finished; only `stop()` and a backend switch abort one.
   *
   * @returns {Promise<boolean>} false when this connection is no longer current
   */
  async function reset(active, reason) {
    cursor = 0;
    revisions = new Map();
    onReset({ reason, backendId: identity.backendId });
    let snapshot;
    try {
      snapshot = await readSnapshot(active);
    } catch (error) {
      if (error?.auth) {
        onStatus("unauthorized", error);
        return false;
      }
      throw error;
    }
    if (disposed || active !== connection) return false;
    return applySnapshot(snapshot);
  }

  async function follow() {
    while (!disposed) {
      const active = connection;
      if (!active) return;
      try {
        const response = await fetchImpl(url(`${STREAM_PATH}?cursor=${cursor}`), {
          method: "GET",
          headers: authHeaders({ accept: "text/event-stream" }),
          signal: active.signal,
          cache: "no-store"
        });
        if (disposed || active !== connection) return;
        if (unauthorized(response.status)) {
          // The session ended; the owner reauthorizes or shows the refusal.
          onStatus("unauthorized");
          return;
        }
        if (response.status === 409) {
          let code = "cursor_expired";
          try {
            const body = await response.json();
            if (body && typeof body.code === "string") code = body.code;
          } catch {
            /* still a refusal: resnapshot rather than skip events */
          }
          if (!(await reset(active, code))) return;
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`事件流请求失败（HTTP ${response.status}）`);
        onStatus("connected");
        let stop = "eof";
        await readEventStream(response.body, (record) => {
          if (disposed || active !== connection) {
            stop = "stale";
            return true;
          }
          const outcome = applyRecord(record);
          if (outcome === "gap" || outcome === "reset") {
            // Reconnect from the applied cursor: the server replays the
            // records that were skipped, in order, and refuses the cursor if
            // they are no longer retained.
            stop = outcome;
            return true;
          }
          return false;
        });
        if (stop === "stale" || disposed || active !== connection) return;
        if (stop === "reset" && !(await reset(active, "stream_reset"))) return;
      } catch (error) {
        if (disposed || active !== connection) return;
        if (error?.name === "AbortError") return;
        onStatus("retrying", error);
      }
      if (disposed || active !== connection) return;
      await delay(retryDelayMs);
    }
  }

  /**
   * Take the first snapshot, then follow in the background.
   *
   * The returned promise reports the handoff point: once it resolves the view is
   * authoritative and later changes arrive through callbacks. The stream itself
   * lives until `stop()` or a backend switch, so awaiting it would never return.
   * A failed first snapshot (a backend still starting, a revoked session) is
   * reported through `onStatus("failed")`; the caller decides whether to call
   * `start()` again.
   */
  function start() {
    disposed = false;
    const active = open();
    const handedOff = readSnapshot(active).then((snapshot) => {
      if (disposed || active !== connection) return;
      if (!applySnapshot(snapshot)) return;
      onStatus("snapshot");
      void follow().catch((error) => onStatus("failed", error));
    });
    return handedOff.catch((error) => {
      if (disposed || active !== connection) return;
      onStatus(error?.auth ? "unauthorized" : "failed", error);
    });
  }

  return {
    /** First snapshot, then follow events until `stop()`. */
    start,
    /**
     * Read the authoritative catalog now and keep its cursor, without replaying
     * the snapshot into the view: the caller that asked for it applies it.
     */
    async snapshot() {
      const active = connection ?? open();
      const value = await readSnapshot(active);
      if (disposed || active !== connection) return undefined;
      applySnapshot(value, { notify: false });
      return value;
    },
    /** Follow a different backend: old connection closed, old view not reused. */
    async switchBackend(next) {
      if (!next || typeof next.backendId !== "string" || !next.backendId)
        throw new Error("切换后端需要新的 backendId");
      const target = { backendId: next.backendId, baseUrl: String(next.baseUrl ?? "").replace(/\/+$/, "") };
      connection?.abort();
      identity = target;
      cursor = 0;
      revisions = new Map();
      onReset({ reason: "backend_switched", backendId: target.backendId });
      return start();
    },
    stop() {
      disposed = true;
      connection?.abort();
      connection = undefined;
      onStatus("stopped");
    },
    /** The applied position; `revisions` is what a re-applied event compares against. */
    state() {
      return {
        backendId: identity.backendId,
        cursor,
        revisions: Object.fromEntries(revisions)
      };
    }
  };
}
