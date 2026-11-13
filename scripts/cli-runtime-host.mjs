import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Own only the launched SDK process. The readiness handshake cannot start a
// supervisor until the child has verified and loaded the reviewed UI target.
export async function runCliProcess({
  executable,
  bootstrap,
  args,
  env,
  projectDirectory,
  uiCompatibility = false,
  onSdkReady,
  onStop
}) {
  const token = uiCompatibility ? randomUUID() : undefined;
  // A resident Main outlives the backend that started it. The backend's pipe
  // is therefore not this process's lifeline: the wrapper keeps Pi's stdin
  // open itself, and relays stdout/stderr while the backend is there, so a
  // backend restart neither ends the Main nor crashes it with a closed pipe.
  const resident = !token && env.COWORK_MAIN_RESIDENT === "1";
  const child = spawn(process.execPath, [...(bootstrap ? [bootstrap] : []), executable, ...args], {
    cwd: projectDirectory,
    env: { ...env, ...(token ? { ATRIA_CLI_UI_READY_TOKEN: token } : {}) },
    stdio: resident ? ["pipe", "pipe", "pipe"] : token ? ["inherit", "inherit", "inherit", "ipc"] : "inherit"
  });
  let ready = false;
  let stopping = false;
  const stop = () => {
    stopping = true;
    onStop?.();
    child.kill("SIGTERM");
  };
  const acknowledge = (message) => {
    if (!ready && !stopping && message?.type === "atria.cli.uiReady" && message.token === token) {
      ready = true;
      onSdkReady?.();
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (token) child.on("message", acknowledge);
  if (resident) relayResident(child);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    child.off("message", acknowledge);
  }
}

/**
 * Keep a resident child's channels alive without the backend.
 *
 * The child owns its stdin through this wrapper, so it stays available between
 * turns. Output is relayed while a backend is reading; when that pipe is gone
 * the relay discards instead of letting a failed write end the Main.
 */
function relayResident(child) {
  let discarded = false;
  const discard = () => {
    discarded = true;
  };
  // The backend going away makes the inherited pipe unwritable. That is the
  // expected restart case, not a reason to end the process.
  process.stdout.on("error", discard);
  process.stderr.on("error", discard);
  child.stdin?.on("error", () => {
    /* stdin only keeps Pi available; stop() ends the process */
  });
  for (const [source, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr]
  ]) {
    source?.on("data", (chunk) => {
      if (discarded) return;
      target.write(chunk, (error) => {
        // The backend that was reading this pipe is gone; keep the Main alive.
        if (error) discarded = true;
      });
    });
  }
}
