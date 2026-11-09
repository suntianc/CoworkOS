import { limitToolContent, truncateToolText } from "./tool-output.js";

interface CommandReceipt {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
  stdoutReadPath?: string;
  stderrReadPath?: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLogBytes?: number;
  stderrLogBytes?: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  failed?: boolean;
  isError?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  logLimitExceeded?: boolean;
  logPathBase?: "agent";
  error?: string;
}

/** Render only built-in command receipts; their complete diagnostic object stays in details. */
export function commandOutputFeedback(name: string, value: unknown, maxChars: number): string | undefined {
  if ((name !== "run_command" && name !== "run_tests") || !isCommandReceipt(value)) return undefined;
  const status = commandStatus(value, maxChars);
  let remaining = maxChars - status.length;
  const metadata: string[] = [];
  let omitted = false;
  const add = (line: string): boolean => {
    if (line.length > remaining) {
      omitted = true;
      return false;
    }
    metadata.push(line);
    remaining -= line.length;
    return true;
  };
  const addExcerpt = (label: string, text: string, limit: number) => {
    const available = Math.min(limit, remaining - label.length - 1);
    if (available < Math.min(32, text.length)) {
      omitted = true;
      return;
    }
    add(`${label}${truncateToolText(text, available)}\n`);
  };
  if (value.error) addExcerpt("Error: ", value.error, Math.min(1024, Math.floor(remaining / 3)));
  for (const stream of ["stdout", "stderr"] as const) {
    const bytes = value[`${stream}Bytes`];
    const logged = value[`${stream}LogBytes`];
    const amount =
      logged === undefined
        ? `${bytes} bytes`
        : `${bytes} bytes observed; ${logged} bytes logged${logged < bytes ? "; log incomplete" : ""}`;
    const truncated = value[`${stream}Truncated`] ? "; preview truncated" : "";
    if (
      !add(
        `${stream}: ${amount}${truncated}; log (${value.logPathBase === "agent" ? "read_file" : "browse_workspace"}): ${JSON.stringify(value[`${stream}Path`])}\n`
      )
    )
      add(`${stream}: ${amount}; log path omitted (budget).\n`);
  }
  // A huge command cannot consume the log references or either stream's whole budget.
  const cwd = JSON.stringify(value.cwd);
  const cwdBudget = Math.min(cwd.length, 1024) + "Working directory: \n".length;
  addExcerpt(
    "Command: ",
    [JSON.stringify(value.command), ...value.args.map((arg) => JSON.stringify(arg))].join(" "),
    Math.min(2048, remaining - cwdBudget - "Command: \n".length)
  );
  addExcerpt("Working directory: ", cwd, 1024);
  for (const stream of ["stdout", "stderr"] as const) {
    const path = value[`${stream}ReadPath`];
    if (path && path !== value[`${stream}Path`]) add(`${stream} log (read_file): ${JSON.stringify(path)}\n`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- omitted 只由上面的 add/addExcerpt 闭包在预算不足时置为 true，TS 在读取处看不到闭包里的赋值
  if (omitted) add("...[metadata omitted: budget]...\n");

  const streams = (["stdout", "stderr"] as const).filter((stream) => value[stream].length > 0);
  const labels = streams.map((stream) => `\n${stream}:\n`);
  const labelChars = labels.reduce((sum, label) => sum + label.length, 0);
  if (remaining <= labelChars) return status + metadata.join("");
  const previews = limitToolContent(
    streams.map((stream) => ({ type: "text" as const, text: value[stream] })),
    remaining - labelChars
  );
  return (
    status +
    metadata.join("") +
    previews.map((block, index) => labels[index] + (block.type === "text" ? block.text : "")).join("")
  );
}

function commandStatus(receipt: CommandReceipt, maxChars: number): string {
  const states = [
    ...(receipt.timedOut ? ["timed out"] : []),
    ...(receipt.cancelled ? ["cancelled"] : []),
    ...(receipt.logLimitExceeded ? ["log limit exceeded"] : [])
  ];
  if (
    receipt.failed ||
    receipt.isError ||
    receipt.error?.trim() ||
    (receipt.exitCode !== null && receipt.exitCode !== 0)
  )
    states.push("failed");
  if (!states.length) states.push(receipt.exitCode === 0 ? "completed" : "completion unknown");
  const line = `Exit code: ${receipt.exitCode}; ${states.join("; ")}\n`;
  if (line.length <= maxChars) return line;
  // PiSession accepts budgets >=64. Even at that minimum keep all interruption
  // flags and the exact safe-integer exit code; omit the redundant failed label.
  return `exit=${receipt.exitCode};${states.filter((state) => state !== "failed").join(";")}\n`;
}

function isCommandReceipt(value: unknown): value is CommandReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.command === "string" &&
    Array.isArray(receipt.args) &&
    receipt.args.every((arg) => typeof arg === "string") &&
    typeof receipt.cwd === "string" &&
    (receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode)) &&
    (receipt.error === undefined || typeof receipt.error === "string") &&
    (receipt.logPathBase === undefined || receipt.logPathBase === "agent") &&
    ["failed", "isError", "timedOut", "cancelled", "logLimitExceeded"].every(
      (key) => receipt[key] === undefined || typeof receipt[key] === "boolean"
    ) &&
    (["stdout", "stderr"] as const).every(
      (stream) =>
        typeof receipt[stream] === "string" &&
        typeof receipt[`${stream}Path`] === "string" &&
        (receipt[`${stream}Path`] as string).length > 0 &&
        Number.isSafeInteger(receipt[`${stream}Bytes`]) &&
        (receipt[`${stream}Bytes`] as number) >= 0 &&
        (receipt[`${stream}LogBytes`] === undefined ||
          (Number.isSafeInteger(receipt[`${stream}LogBytes`]) &&
            (receipt[`${stream}LogBytes`] as number) >= 0)) &&
        typeof receipt[`${stream}Truncated`] === "boolean" &&
        (receipt[`${stream}ReadPath`] === undefined || typeof receipt[`${stream}ReadPath`] === "string")
    )
  );
}
