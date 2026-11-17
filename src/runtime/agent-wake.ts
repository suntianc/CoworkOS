import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The local wake channel Main and delegated processes share.
 *
 * The durable record is the truth: whatever arrives here only says "read your
 * records again", and the receiver re-reads the whole Inbox or question record
 * instead of trusting the notification. A channel that cannot be reached — the
 * process already exited, a socket file was left behind, the process was
 * started without one — costs promptness, never a message: the writer's durable
 * write already succeeded and its caller must not depend on this.
 *
 * The endpoint is registered in the process record, so a backend that restarts
 * and adopts a still-running process finds the same channel. The socket's name
 * is derived from the launch token, so a leftover file from a dead process can
 * never shadow a live one. It lives in the user's temporary directory, or in
 * the fixed short one when that directory is too deep for the operating
 * system's socket address (104 bytes on macOS).
 */

/** How long a nudge may take to fail; a wake that hangs must not hold a writer. */
const WAKE_CONNECT_TIMEOUT_MS = 2_000;

/** What one bound channel is, for the process that owns it. */
export interface AgentWakeListener {
  endpoint: string;
  close(): Promise<void>;
}

/** Waits in this process that want to re-check their own condition on a wake. */
const processWakeListeners = new Set<() => void>();

/**
 * Subscribe to this process's wake notifications.
 *
 * A blocking wait (`ask_main`) is not an Inbox reader, so it registers here and
 * re-reads the record it is waiting on when the process is nudged.
 */
export function onProcessWake(listener: () => void): () => void {
  processWakeListeners.add(listener);
  return () => {
    processWakeListeners.delete(listener);
  };
}

/**
 * The endpoint one launched process listens on.
 *
 * Derived from the agent's own directory and the launch token the backend
 * generates for it, so two launches of the same agent never share an endpoint
 * and a stale file cannot be mistaken for a live listener.
 */
export function agentWakeEndpoint(processDirectory: string, token: string): string {
  const digest = createHash("sha256")
    .update(`${resolve(processDirectory)}\u0000${token}`)
    .digest("hex")
    .slice(0, 24);
  // Windows has no filesystem socket name; its named pipe is the same
  // process-local, same-user channel under the same digest.
  if (process.platform === "win32") return `\\\\.\\pipe\\cowork-wake-${digest}`;
  const name = `wake-${digest}.sock`;
  const { preferred, fallback } = wakeDirectories();
  const endpoint = join(preferred, name);
  // A temporary directory can be deep enough that this name no longer fits the
  // OS address. The process record is what a writer reads, so the reader follows
  // this choice instead of recomputing one of its own.
  return Buffer.byteLength(endpoint) <= MAX_SOCKET_PATH_BYTES ? endpoint : join(fallback, name);
}

/**
 * The longest endpoint path a filesystem socket accepts, in bytes.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux, both counting
 * the terminator. A longer name is not a clean failure: Electron's Node answers
 * `listen` with EINVAL and binds nothing, while plain Node truncates the name
 * silently, so the socket lands at a path the process record does not name and
 * the mode change after it fails. Either way the process wakes only through the
 * best-effort file watch, and a message can wait in its durable Inbox for an OS
 * event that never comes.
 */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Tell one agent process that its durable records changed.
 *
 * Best effort by construction: the caller has already written the record that
 * matters, and delivery must neither fail nor delay that write. An unreachable
 * endpoint is the ordinary case of a process that has ended.
 */
export function notifyAgentProcess(processDirectory: string): void {
  void nudge(processDirectory);
}

/** The one channel this process binds; a session restart reuses it. */
let binding: Promise<AgentWakeListener | undefined> | undefined;

/**
 * Bind this process's wake endpoint, when the backend registered one.
 *
 * `COWORK_WAKE_ENDPOINT` is written by the backend at launch and recorded with
 * the process, so the receiver binds exactly the endpoint a writer reads from
 * the record — one decision, not two computations that could disagree. One
 * binding per process: a second session must not unlink the first one's socket
 * and take its place.
 */
export function startAgentWake(): Promise<AgentWakeListener | undefined> {
  binding ??= openWakeChannel();
  return binding;
}

/** Release this process's channel, if it bound one. */
export async function stopAgentWake(): Promise<void> {
  const pending = binding;
  binding = undefined;
  const listener = await pending;
  await listener?.close();
}

async function openWakeChannel(): Promise<AgentWakeListener | undefined> {
  const endpoint = process.env.COWORK_WAKE_ENDPOINT;
  if (!endpoint) return undefined;
  if (process.platform !== "win32") {
    await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
    // A file left at this name belongs to an earlier launch: the digest
    // carries this launch's token, so nothing else can be listening there.
    await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
      // Nothing left to remove is the ordinary case; anything else means this
      // process cannot own the name, which the bind below then reports.
      if (error.code !== "ENOENT") throw error;
    });
  }
  const server = createServer((socket) => {
    // The nudge carries no content the receiver trusts; the payload is ignored
    // and every subscriber re-reads its whole record.
    socket.on("error", () => {
      /* a peer that disconnects mid-nudge said nothing the receiver needs */
    });
    socket.end();
    for (const listener of processWakeListeners) listener();
  });
  await new Promise<void>((bound, failed) => {
    server.once("error", failed);
    server.listen(endpoint, () => {
      server.off("error", failed);
      bound();
    });
  });
  // A one-shot process must still exit when its turn is over: the channel is a
  // wake for a process that is already waiting, never a reason to stay alive.
  server.unref();
  // Only this user may connect; the directory is already private to them and
  // the mode is set immediately after the bind created the socket file.
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  return { endpoint, close: () => closeWakeListener(server, endpoint) };
}

async function closeWakeListener(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((closed) => server.close(() => closed()));
  if (process.platform !== "win32")
    await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
      // The file is already gone when another process cleaned the directory.
      if (error.code !== "ENOENT") throw error;
    });
}

/** The endpoint recorded for an agent, if it registered one. */
async function recordedEndpoint(processDirectory: string): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(join(processDirectory, "process.json"), "utf8")) as {
      wakeEndpoint?: unknown;
    };
    return typeof record.wakeEndpoint === "string" && record.wakeEndpoint ? record.wakeEndpoint : undefined;
    // eslint-disable-next-line no-restricted-syntax -- 没有记录、记录损坏或记录里还没有端点时就是没有可通知的通道，持久记录本身仍是权威
  } catch {
    return undefined;
  }
}

async function nudge(processDirectory: string): Promise<void> {
  const endpoint = await recordedEndpoint(processDirectory);
  if (!endpoint) return;
  await new Promise<void>((done) => {
    const socket = connect(endpoint);
    const finish = () => {
      socket.destroy();
      done();
    };
    socket.setTimeout(WAKE_CONNECT_TIMEOUT_MS, finish);
    socket.once("error", finish);
    socket.once("connect", () => socket.end());
    socket.once("close", finish);
  });
}

/**
 * Where wake sockets live, longest-preferred first.
 *
 * The user's own temporary directory keeps the sockets with everything else
 * that run leaves behind. When that directory is too deep to name a socket in,
 * the fixed short one is used instead: the socket carries no data, only "read
 * your records again", and only its bind and its writer need to agree on the
 * location.
 */
function wakeDirectories(): { preferred: string; fallback: string } {
  // Per-user on Linux (a shared /tmp) and already per-user under macOS
  // `$TMPDIR`; the socket mode is the second lock on the same door.
  const uid = process.getuid?.();
  const name = uid === undefined ? "cowork-wake" : `cowork-wake-${uid}`;
  return { preferred: join(tmpdir(), name), fallback: join("/tmp", name) };
}
