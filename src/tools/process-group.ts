import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function liveGroupMembers(groupPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 8 * 1024 * 1024
  });
  const members: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
    if (match && Number(match[2]) === groupPid && !match[3].startsWith("Z")) {
      members.push(Number(match[1]));
    }
  }
  // The host uses this helper too. Signal its descendants before itself.
  return members.sort((left, right) => Number(left === process.pid) - Number(right === process.pid));
}

/** macOS can report EPERM for a group containing only unreaped zombies. */
export async function signalProcessGroup(groupPid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(-groupPid, signal);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code !== "EPERM") throw error;
  }
  // EPERM can also mean a live group member could not be signalled. Enumerate
  // this exact group instead of treating a permission error as successful cleanup.
  const failures = new Map<number, unknown>();
  for (const pid of await liveGroupMembers(groupPid)) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.set(pid, error);
    }
  }
  if (failures.size === 0) return;
  // A member may exit or become a zombie between ps and kill.
  for (const pid of await liveGroupMembers(groupPid)) {
    if (failures.has(pid)) {
      throw new Error(`Unable to send ${signal} to foreground process ${pid} in group ${groupPid}`, {
        cause: failures.get(pid)
      });
    }
  }
}
