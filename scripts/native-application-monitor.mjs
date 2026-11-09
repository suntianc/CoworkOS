import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { once } from "node:events";

/** Observe LaunchServices and poll short-lived registrations without touching Dock. */
export async function startNativeApplicationMonitor(directory, { moduleCacheDirectory } = {}) {
  const executable = join(directory, "mac-application-monitor");
  await promisify(execFile)(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-module-cache-path",
      moduleCacheDirectory ?? join(directory, "swift-module-cache"),
      fileURLToPath(new URL("../test/fixtures/mac-application-monitor.swift", import.meta.url)),
      "-o",
      executable
    ],
    // A fresh AppKit module cache can exceed 30s while CAD/browser regression
    // workers are active. This is compilation, not the monitor ready deadline.
    { timeout: 120_000 }
  );
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const registrations = [];
  const pending = new Map();
  let nextId = 0;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let newline; (newline = buffer.indexOf("\n")) !== -1;) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.event === "ready") resolveReady(message);
      if (message.event === "regular-app") registrations.push(message.application);
      if (message.event === "snapshot") pending.get(message.id)?.(message.applications);
    }
  });
  child.stderr.resume();
  child.on("error", rejectReady);
  const readyTimer = setTimeout(() => rejectReady(new Error("Native application monitor timed out")), 5000);
  let initial;
  try {
    initial = await ready;
  } catch (error) {
    child.kill("SIGTERM");
    // eslint-disable-next-line no-restricted-syntax -- 关掉监视器子进程后等其退出，要抛的是原始启动错误而不是退出探测的失败
    await closed.catch(() => {});
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
  return {
    initial,
    registrations,
    snapshot() {
      return new Promise((resolve, reject) => {
        const id = String(++nextId);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Native application snapshot timed out"));
        }, 3000);
        pending.set(id, (applications) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(applications);
        });
        child.stdin.write(`${JSON.stringify({ id })}\n`);
      });
    },
    async stop() {
      child.kill("SIGTERM");
      await closed;
    }
  };
}
