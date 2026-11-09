import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signalProcessGroup } from "./process-group.js";

// Executable entry point only. Do not import it into a service: these handlers
// belong to the command's dedicated Unix process group, not the Main process.
function runCommandHost(): void {
  const options = JSON.parse(process.argv[2] ?? "") as {
    command: string;
    args: string[];
    cwd: string;
    shell: boolean;
  };
  let stopping = false;
  const signalGroup = (signal: NodeJS.Signals): void => {
    void signalProcessGroup(process.pid, signal).catch((error: unknown) => {
      process.stderr.write(`Foreground command cleanup failed: ${String(error)}\n`);
    });
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // The owner keeps stdin open for our lifetime. EOF includes abrupt owner
    // death, so a detached foreground group cannot escape Task shutdown.
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), 1000);
  };
  process.on("SIGTERM", stop);
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  process.stdin.resume();

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    shell: options.shell,
    // The command has no input provider: fd 0 is /dev/null so a command that
    // reads to EOF ends itself. It must not inherit the owner's lifecycle pipe,
    // and an open pipe would make real readers wait for cancellation.
    // Ordinary descendants inherit this host's process group instead.
    stdio: ["ignore", "inherit", "inherit"]
  });
  let failedToStart = false;
  child.on("error", (error) => {
    failedToStart = true;
    process.stderr.write(String(error));
  });
  child.on("close", (code, signal) => {
    try {
      // The parent receives the command's real result before it kills this
      // host and any unregistered descendants left by a successful wrapper.
      // fd 3 is private to this host, separate from the command's output.
      writeSync(3, `${JSON.stringify({ code: failedToStart ? 1 : code, signal })}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
      stop();
    }
    // Keep the lifecycle pipe open until parent cleanup. If the parent dies
    // immediately after the result, EOF still drains the entire group.
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCommandHost();
