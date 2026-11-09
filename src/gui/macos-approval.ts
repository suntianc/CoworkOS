import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

/** The backend chooses the installed helper and receives its answer over its own pipe. */
export function createMacComputerApproval(projectRoot: string) {
  const executable = resolve(projectRoot, "dist/src/gui/atria-computer-use");
  return async (identity: { backendId: string }, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    if (process.platform !== "darwin") throw new Error("local authentication unavailable");
    await access(executable, constants.X_OK);
    signal.throwIfAborted();
    const backend = identity.backendId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (!backend) throw new Error("invalid backend identity");
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].includes(name)
      )
    );
    return new Promise<boolean>((done, reject) => {
      const child = spawn(executable, [], { env: environment, stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;
      const abort = () => {
        failure = new Error("local authentication cancelled");
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8192) {
          failure = new Error("invalid local authentication response");
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      });
      child.stdin.on("error", () => {});
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (failure || signal.aborted) return reject(failure ?? new Error("local authentication cancelled"));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            approved?: unknown;
            errorCode?: unknown;
          };
          if (code === 0 && result.approved === true) return done(true);
          if (result.errorCode === "approval_denied") return done(false);
          reject(new Error("local authentication unavailable"));
          // eslint-disable-next-line no-restricted-syntax -- 子进程返回的 JSON 解析失败只对外暴露固定的无效响应，原始 SyntaxError 不进入调用方诊断
        } catch {
          reject(new Error("invalid local authentication response"));
        }
      });
      child.stdin.end(JSON.stringify({ operation: "host-approval", backendId: backend }));
      if (signal.aborted) abort();
    });
  };
}
