/**
 * The shared client for one backend's management protocol.
 *
 * The browser and the desktop renderer both drive the same backend through
 * this module: authorize a local session, read the catalog snapshot, follow its
 * events, send change commands that stay idempotent across a lost response, and
 * switch to another backend without letting the old identity reach the new
 * view. It never touches Electron IPC and never reads backend files — only the
 * documented HTTP protocol.
 *
 * Identity is the spine of the whole file:
 *  - One bound `backendId` + `baseUrl`; every request, stream and stored
 *    session belongs to it.
 *  - Switching bumps an epoch and aborts every in-flight request. A response
 *    that still resolves afterwards is rejected as `stale_client` instead of
 *    being written into the new backend's screen.
 *  - Sessions are stored per backend origin, so the token minted by A is never
 *    presented to B.
 */

import { createManagementEventClient, readEventStream } from "./management-events.js";

export const CLIENT_PROTOCOL_VERSION = "1.0";
/** What the catalog view cannot work without; a backend without them is named, not guessed at. */
export const REQUIRED_CAPABILITIES = ["session.authorize", "events.snapshot", "events.stream"];

const SESSION_STORE = "cowork.management.sessions.v1";
const TARGET_STORE = "cowork.management.target.v1";
const SELF_KEY = "self";

/** A protocol outcome a caller may branch on instead of matching prose. */
export class ManagementClientError extends Error {
  constructor(message, { code, status, network = false, stale = false, operationId } = {}) {
    super(message);
    this.name = "ManagementClientError";
    this.code = code;
    this.status = status;
    this.network = network;
    this.stale = stale;
    if (operationId) this.operationId = operationId;
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
    // eslint-disable-next-line no-restricted-syntax -- a session or target record written by an older build may not parse; the caller starts from its fallback
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    // eslint-disable-next-line no-restricted-syntax -- best-effort persistence: blocked or full storage only loses the remembered value while the in-memory state stays authoritative
  } catch {
    /* storage may be disabled; the in-memory value is still authoritative */
  }
}

/** `""` means the page's own origin; otherwise an explicit backend origin. */
export function normalizeBackendUrl(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string")
    throw new ManagementClientError("后端地址必须是字符串", { code: "invalid_backend_url" });
  const raw = value.trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ManagementClientError("后端地址必须是完整的 http:// 地址", { code: "invalid_backend_url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ManagementClientError("后端地址只支持 http:// 或 https://", { code: "invalid_backend_url" });
  if (parsed.origin !== raw)
    throw new ManagementClientError("后端地址只填写协议、主机和端口，不要包含路径", {
      code: "invalid_backend_url"
    });
  return raw;
}

function parseProtocol(text) {
  if (typeof text !== "string") return undefined;
  const match = text.trim().match(/^(\d{1,4})\.(\d{1,4})$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

/**
 * @param {object} options
 * @param {string} [options.baseUrl]  initial backend origin; empty for the page's own
 * @param {string} [options.clientName]
 * @param {string} [options.protocolVersion]
 * @param {typeof fetch} [options.fetch]
 * @param {Storage} [options.storage]        session storage (per page lifetime)
 * @param {Storage} [options.targetStorage]  last selected backend (across reloads)
 * @param {object} [options.events]          onSnapshot/onEvent/onReset/onStatus/retryDelayMs
 * @param {(state: object) => void} [options.onStateChange]
 */
export function createManagementClient({
  baseUrl = "",
  clientName = "CoworkOS Web",
  protocolVersion = CLIENT_PROTOCOL_VERSION,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  authorizeSession,
  hostManagedSession = false,
  transportHeaders = {},
  storage = memoryStorage(),
  targetStorage = memoryStorage(),
  events = {},
  onStateChange = () => {}
} = {}) {
  let state = {
    status: "idle",
    backendId: null,
    pid: null,
    startedAt: null,
    baseUrl: "",
    protocol: null,
    capabilities: [],
    sessionId: null,
    clientName,
    missingCapabilities: [],
    error: null
  };
  /** Only shown to the transport; never copied into the public state. */
  let token;
  let epoch = 0;
  let eventsClient;
  const inflight = new Set();
  const sessions = hostManagedSession ? {} : readJson(storage, SESSION_STORE, {});
  if (hostManagedSession) {
    try {
      storage?.removeItem(SESSION_STORE);
      // eslint-disable-next-line no-restricted-syntax -- the desktop host owns this session; a storage that refuses the stale-record removal cannot affect it
    } catch {
      // An unavailable session store does not affect the host-owned session.
    }
  }

  const publicState = () => ({
    ...state,
    capabilities: [...state.capabilities],
    missingCapabilities: [...state.missingCapabilities],
    error: state.error ? { ...state.error } : null
  });

  function update(patch) {
    state = { ...state, ...patch };
    onStateChange(publicState());
  }

  function fail(error, patch = {}) {
    update({ status: "failed", error: { code: error?.code, message: error.message }, ...patch });
    return publicState();
  }

  function absoluteUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${state.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function authHeaders(extra = {}) {
    const headers = { ...transportHeaders, ...extra };
    if (typeof token === "string") headers["x-atria-token"] = token;
    return headers;
  }

  function abortInflight() {
    for (const controller of inflight) controller.abort();
    inflight.clear();
  }

  function stopEvents() {
    eventsClient?.stop();
    eventsClient = undefined;
  }

  function markUnauthorized(error) {
    if (state.status === "unauthorized") return;
    stopEvents();
    update({
      status: "unauthorized",
      error: { code: error?.code || "unauthorized", message: error?.message || "本地会话已失效" }
    });
  }

  function sessionKey(target) {
    return target || SELF_KEY;
  }

  function forgetSession(target) {
    const key = sessionKey(target);
    if (!(key in sessions)) return;
    delete sessions[key];
    writeJson(storage, SESSION_STORE, sessions);
  }

  /** The checked protocol is the backend's, not whatever the client hoped for. */
  function acceptProtocol(protocol) {
    const server = parseProtocol(protocol?.version);
    const minimum = parseProtocol(protocol?.minClientVersion);
    const client = parseProtocol(protocolVersion);
    if (!server || !minimum || !client)
      return {
        ok: false,
        message: `后端返回的协议版本无法识别（${protocol?.version ?? "缺失"}），请升级后端后再连接。`
      };
    const compatible =
      server.major === client.major && client.minor >= minimum.minor && client.minor <= server.minor;
    if (!compatible)
      return {
        ok: false,
        message: `客户端协议 ${protocolVersion} 与后端协议 ${protocol.version} 不兼容（后端支持客户端 ${protocol.minClientVersion}–${protocol.version}）；请升级较旧的一方后重试。`
      };
    return { ok: true };
  }

  function missingCapabilities(protocol) {
    const available = new Set(Array.isArray(protocol?.capabilities) ? protocol.capabilities : []);
    return REQUIRED_CAPABILITIES.filter((name) => !available.has(name));
  }

  /**
   * Bind this client to an authorized backend and start following its catalog.
   *
   * The protocol is checked before any endpoint is used, so an incompatible or
   * incomplete backend produces one actionable state instead of a 404 that
   * looks like a broken button.
   */
  function bind(session, backend, protocol) {
    const checked = acceptProtocol(protocol);
    if (!checked.ok) {
      stopEvents();
      update({
        status: "incompatible",
        backendId: backend?.backendId ?? null,
        protocol,
        capabilities: [],
        sessionId: session?.sessionId ?? null,
        error: { code: "protocol_incompatible", message: checked.message }
      });
      return publicState();
    }
    const missing = missingCapabilities(protocol);
    if (missing.length) {
      stopEvents();
      update({
        status: "unsupported",
        backendId: backend?.backendId ?? null,
        protocol,
        capabilities: [...protocol.capabilities],
        sessionId: session?.sessionId ?? null,
        missingCapabilities: missing,
        error: {
          code: "capability_missing",
          message: `此后端缺少${missing.join("、")}，无法同步项目与任务；请升级后端后重试。`
        }
      });
      return publicState();
    }
    update({
      status: "connected",
      backendId: backend?.backendId ?? null,
      pid: backend?.pid ?? null,
      startedAt: backend?.startedAt ?? null,
      protocol,
      capabilities: [...protocol.capabilities],
      sessionId: session?.sessionId ?? null,
      missingCapabilities: [],
      error: null
    });
    startEvents();
    return publicState();
  }

  function startEvents() {
    stopEvents();
    eventsClient = createManagementEventClient({
      backendId: state.backendId,
      baseUrl: state.baseUrl,
      fetch: fetchImpl,
      headers: () => authHeaders(),
      ...(events.retryDelayMs ? { retryDelayMs: events.retryDelayMs } : {}),
      onSnapshot: (snapshot) => events.onSnapshot?.(snapshot),
      onEvent: (record) => events.onEvent?.(record),
      onReset: (reset) => events.onReset?.(reset),
      onStatus: (status, detail) => {
        if (status === "unauthorized") {
          markUnauthorized(
            new ManagementClientError("本地会话已失效，已停止目录事件订阅；请重新授权后继续。", {
              code: "session_revoked",
              status: 401
            })
          );
          return;
        }
        events.onStatus?.(status, detail);
      }
    });
    void eventsClient.start();
  }

  async function parse(response) {
    // A Response always has `text`; a test double may only implement `json`.
    if (typeof response.text !== "function")
      return typeof response.json === "function" ? response.json() : {};
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ManagementClientError("后端返回了无法解析的响应", {
        code: "invalid_response",
        status: response.status
      });
    }
  }

  function requireHostSession() {
    if (authorizeSession && !token && (state.status === "idle" || state.status === "connecting"))
      throw new ManagementClientError("正在连接后端，请稍后重试", { code: "backend_connecting" });
  }

  function rejectCurrentSession(requestToken, error) {
    if (requestToken === token && state.status === "connected") markUnauthorized(error);
  }

  /** One request through the bound identity, with the epoch guard on the way out. */
  async function send(path, { json, headers, signal, method = "GET", body, ...rest } = {}) {
    requireHostSession();
    const requestToken = token;
    const at = epoch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    inflight.add(controller);
    const assertCurrent = () => {
      if (at !== epoch)
        throw new ManagementClientError("已切换后端，旧请求已作废", { code: "stale_client", stale: true });
      if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
    };
    try {
      let response;
      try {
        response = await fetchImpl(absoluteUrl(path), {
          ...rest,
          method,
          headers: authHeaders({
            ...(json === undefined ? {} : { "content-type": "application/json" }),
            ...headers
          }),
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          // The selected backend receives its host-managed transport header.
          credentials: "include",
          cache: "no-store"
        });
      } catch (error) {
        assertCurrent();
        if (error?.name === "AbortError") throw error;
        throw new ManagementClientError("无法联系后端，请确认本机后端仍在运行。", {
          code: "network",
          network: true
        });
      }
      assertCurrent();
      if (!response.ok) {
        let payload = {};
        try {
          payload = await parse(response);
        } catch (error) {
          assertCurrent();
          if (error?.name === "AbortError") throw error;
          /* the status still names the outcome */
        }
        assertCurrent();
        const detail = payload?.error;
        const error = new ManagementClientError(
          typeof detail === "string" ? detail : detail?.message || `请求失败（HTTP ${response.status}）`,
          {
            code: (typeof detail === "object" && detail?.code) || payload?.code || `http_${response.status}`,
            status: response.status
          }
        );
        if (typeof detail === "object" && detail) {
          // The editor uses structured revision and retry information.
          if (detail.details !== undefined) error.details = detail.details;
          if (detail.retryable !== undefined) error.retryable = Boolean(detail.retryable);
        }
        if (response.status === 401) rejectCurrentSession(requestToken, error);
        throw error;
      }
      let result;
      try {
        result = await parse(response);
      } catch (error) {
        assertCurrent();
        if (error?.name === "AbortError" || error instanceof ManagementClientError) throw error;
        throw new ManagementClientError("无法联系后端，请确认本机后端仍在运行。", {
          code: "network",
          network: true
        });
      }
      assertCurrent();
      return result;
    } finally {
      inflight.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function readBackend() {
    return send("/api/backend");
  }

  /**
   * Exchange the host credential for a named session.
   *
   * The page's own backend accepts the credential the host installed (the
   * desktop cookie) or, in local development without a token, no credential at
   * all. A revoked session is never silently replaced: the person sees the
   * refusal and reauthorizes.
   */
  async function authorize({ baseUrl: target = state.baseUrl, reuse = false } = {}) {
    epoch += 1;
    abortInflight();
    stopEvents();
    token = undefined;
    update({
      status: "connecting",
      baseUrl: target,
      backendId: null,
      pid: null,
      startedAt: null,
      protocol: null,
      capabilities: [],
      sessionId: null,
      missingCapabilities: [],
      error: null
    });
    try {
      const at = epoch;
      const result = authorizeSession
        ? await authorizeSession({
            clientName,
            protocolVersion,
            baseUrl: target,
            ...(hostManagedSession ? { reuse } : {})
          })
        : await send("/api/session", {
            method: "POST",
            json: { clientName, protocolVersion }
          });
      if (at !== epoch)
        throw new ManagementClientError("已切换后端，旧请求已作废", { code: "stale_client", stale: true });
      const session = result?.session;
      if (hostManagedSession ? !session?.sessionId : !session?.token || typeof session.token !== "string")
        throw new ManagementClientError("后端未返回有效的本地会话", { code: "session_invalid" });
      token = hostManagedSession ? true : session.token;
      if (!hostManagedSession) {
        sessions[sessionKey(target)] = {
          backendId: result.backend?.backendId,
          sessionId: session.sessionId,
          token: session.token,
          clientName,
          protocolVersion
        };
        writeJson(storage, SESSION_STORE, sessions);
      }
      return bind(session, result.backend, result.protocol);
    } catch (error) {
      if (error?.stale) return publicState();
      token = undefined;
      if (error?.status === 409 || error?.code === "protocol_required") {
        stopEvents();
        update({
          status: "incompatible",
          error: { code: error.code || "protocol_incompatible", message: error.message }
        });
        return publicState();
      }
      if (error?.status === 401 || error?.status === 403) {
        stopEvents();
        update({
          status: "unauthorized",
          error: { code: error.code || "unauthorized", message: error.message }
        });
        return publicState();
      }
      fail(error, { backendId: null });
      return publicState();
    }
  }

  /**
   * Use the stored session when the backend still accepts it, otherwise ask for
   * authorization. A stored session that was revoked is reported, not replaced.
   */
  async function connect({ baseUrl: next = state.baseUrl, reuse = true } = {}) {
    const target = normalizeBackendUrl(next);
    if (hostManagedSession) return authorize({ baseUrl: target, reuse });
    const stored = reuse ? sessions[sessionKey(target)] : undefined;
    if (!stored) return authorize({ baseUrl: target });
    epoch += 1;
    abortInflight();
    stopEvents();
    token = stored.token;
    update({
      status: "connecting",
      baseUrl: target,
      backendId: null,
      pid: null,
      startedAt: null,
      protocol: null,
      capabilities: [],
      sessionId: null,
      missingCapabilities: [],
      error: null
    });
    try {
      const current = await send("/api/session");
      if (current?.current?.sessionId && current.current.sessionId !== stored.sessionId)
        throw new ManagementClientError("后端返回的会话与本地记录不一致", { code: "session_mismatch" });
      const backend = await readBackend();
      if (stored.backendId && backend?.backendId !== stored.backendId) {
        // Same address, another data root: the old session does not belong here.
        forgetSession(target);
        token = undefined;
        return authorize({ baseUrl: target });
      }
      return bind({ sessionId: stored.sessionId }, backend, backend?.protocol);
    } catch (error) {
      if (error?.stale) return publicState();
      if (error?.status === 401 || error?.status === 403) {
        forgetSession(target);
        token = undefined;
        stopEvents();
        update({
          status: "unauthorized",
          error: {
            code: error.code || "session_revoked",
            message: "本地会话已失效，草稿与已提交内容保留；重新授权后可继续。"
          }
        });
        return publicState();
      }
      token = undefined;
      fail(error);
      return publicState();
    }
  }

  /** Follow a different backend: the old requests, stream and view are retired first. */
  async function switchBackend({ baseUrl: next }) {
    const target = normalizeBackendUrl(next);
    events.onReset?.({ reason: "backend_switched", backendId: null, nextBaseUrl: target });
    try {
      writeJson(targetStorage, TARGET_STORE, target);
      // eslint-disable-next-line no-restricted-syntax -- a disabled storage only loses the remembered backend choice; the switch itself still connects
    } catch {
      /* a disabled storage only loses the remembered choice */
    }
    return connect({ baseUrl: target, reuse: true });
  }

  /** The catalog snapshot, applied to the cursor but not to the caller's view. */
  async function snapshot() {
    if (eventsClient) return eventsClient.snapshot();
    return send("/api/events/snapshot");
  }

  function operationId() {
    const values = globalThis.crypto;
    if (values?.randomUUID) return values.randomUUID();
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Send a change command that may be retried safely.
   *
   * The operation id travels with the command; when the response is lost the
   * client asks for the saved receipt, and only a command the backend never
   * accepted is sent again. A retry with the same id and content cannot apply
   * the change twice.
   */
  async function command(path, { method = "POST", body = {}, operationId: given } = {}) {
    const id = given || body.operationId || operationId();
    const content = { ...body, operationId: id };
    try {
      return await send(path, { method, json: content });
    } catch (error) {
      if (error?.stale || !error?.network) throw error;
      const receipt = await readReceipt(id);
      if (receipt) return receipt.body;
      return send(path, { method, json: content });
    }
  }

  async function readReceipt(id, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await send(`/api/operations/${encodeURIComponent(id)}`);
      } catch (error) {
        if (error?.code === "operation_unknown") return undefined;
        if (!error?.network && error?.status < 500) return undefined;
        if (attempt === attempts - 1) return undefined;
        await new Promise((done) => setTimeout(done, 150 * (attempt + 1)));
      }
    }
    return undefined;
  }

  /** Fetch one backend file as bytes; downloads and previews share this path. */
  async function blob(path, { signal } = {}) {
    requireHostSession();
    const requestToken = token;
    const at = epoch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    inflight.add(controller);
    try {
      const response = await fetchImpl(absoluteUrl(path), {
        method: "GET",
        headers: authHeaders({ accept: "*/*" }),
        signal: controller.signal,
        cache: "no-store"
      });
      if (at !== epoch)
        throw new ManagementClientError("已切换后端，旧文件请求已作废", {
          code: "stale_client",
          stale: true
        });
      if (!response.ok) {
        const error = new ManagementClientError(`文件读取失败（HTTP ${response.status}）`, {
          code: `http_${response.status}`,
          status: response.status
        });
        if (response.status === 401) rejectCurrentSession(requestToken, error);
        throw error;
      }
      const disposition = response.headers.get("content-disposition") || "";
      const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const bytes = await response.blob();
      if (at !== epoch)
        throw new ManagementClientError("已切换后端，旧文件请求已作废", {
          code: "stale_client",
          stale: true
        });
      return {
        blob: bytes,
        mimeType: response.headers.get("content-type") || "application/octet-stream",
        fileName: encodedName ? decodeURIComponent(encodedName) : undefined
      };
    } finally {
      inflight.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Save a backend file through the same authorized identity as every other call. */
  async function download(path, name) {
    const { blob: bytes } = await blob(path);
    if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function")
      throw new ManagementClientError("当前环境不支持下载", { code: "download_unavailable" });
    const href = URL.createObjectURL(bytes);
    const anchor = document.createElement("a");
    // The page-wide interceptor must not intercept this click again, or the
    // synthetic download would recurse instead of reaching the browser.
    anchor.dataset.managedDownload = "1";
    anchor.href = href;
    anchor.download = name || "download";
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 2_000);
  }

  /** Upload bytes with the current session, keeping the existing progress UI. */
  function upload(file, { name, signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      requireHostSession();
      const requestToken = token;
      if (typeof XMLHttpRequest === "undefined") {
        reject(new ManagementClientError("当前环境不支持上传", { code: "upload_unavailable" }));
        return;
      }
      const at = epoch;
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      signal?.addEventListener("abort", abort, { once: true });
      xhr.open("POST", absoluteUrl(`/api/uploads?name=${encodeURIComponent(name || file.name || "file")}`));
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      for (const [header, value] of Object.entries(authHeaders())) xhr.setRequestHeader(header, value);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        signal?.removeEventListener("abort", abort);
        if (at !== epoch) {
          reject(
            new ManagementClientError("已切换后端，旧上传已作废", { code: "stale_client", stale: true })
          );
          return;
        }
        let result;
        try {
          result = JSON.parse(xhr.responseText);
          // eslint-disable-next-line no-restricted-syntax -- an upload response can be a proxy error page instead of JSON; the upload is rejected with invalid_response
        } catch {
          reject(new ManagementClientError("上传响应无效", { code: "invalid_response" }));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(100);
          resolve(result);
          return;
        }
        const error = new ManagementClientError(result?.error || "上传失败", {
          code: result?.code || `http_${xhr.status}`,
          status: xhr.status
        });
        if (xhr.status === 401) rejectCurrentSession(requestToken, error);
        reject(error);
      };
      xhr.onerror = () => {
        signal?.removeEventListener("abort", abort);
        reject(new ManagementClientError("上传连接中断，请重试", { code: "network", network: true }));
      };
      xhr.onabort = () => {
        signal?.removeEventListener("abort", abort);
        reject(new ManagementClientError("上传已取消", { code: "aborted" }));
      };
      xhr.send(file);
    });
  }

  /**
   * Follow one per-Task SSE stream through the bound identity.
   *
   * `EventSource` cannot carry the session header or leave this origin, so the
   * same reader the catalog client uses consumes the response instead.
   */
  async function openStream(path, { onRecord = () => {}, onOpen, signal } = {}) {
    requireHostSession();
    const requestToken = token;
    const at = epoch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    inflight.add(controller);
    try {
      const response = await fetchImpl(absoluteUrl(path), {
        method: "GET",
        headers: authHeaders({ accept: "text/event-stream" }),
        signal: controller.signal,
        cache: "no-store"
      });
      if (at !== epoch) return;
      if (response.status === 401 || response.status === 403) {
        rejectCurrentSession(
          requestToken,
          new ManagementClientError("本地会话已失效，任务事件订阅已停止。", {
            code: "session_revoked",
            status: response.status
          })
        );
        return;
      }
      if (!response.ok || !response.body) throw new Error(`事件流请求失败（HTTP ${response.status}）`);
      if (at !== epoch) return;
      onOpen?.();
      await readEventStream(response.body, (record) => {
        if (at !== epoch) return true;
        return onRecord(record) === true;
      });
    } finally {
      inflight.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }

  function stop() {
    epoch += 1;
    abortInflight();
    stopEvents();
    update({ status: "stopped" });
  }

  /** The last chosen backend, for a page booting with a remembered target. */
  function rememberedTarget() {
    const value = readJson(targetStorage, TARGET_STORE, "");
    return typeof value === "string" ? value : "";
  }

  return {
    state: publicState,
    connect,
    authorize,
    switchBackend,
    reconnect: () => connect({ baseUrl: state.baseUrl, reuse: true }),
    request: (path, options) => send(path, options),
    command,
    snapshot,
    blob,
    download,
    upload,
    openStream,
    stop,
    rememberedTarget,
    url: absoluteUrl,
    newOperationId: operationId
  };
}
