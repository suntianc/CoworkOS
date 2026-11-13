import { resolve } from "node:path";
import type { ProtectedPaths } from "./protected-paths.js";

/**
 * The protected-path rule at the tool-call boundary.
 *
 * Main enforces the rule on Pi's native write/edit tools; a delegated process
 * loads the same extension but runs as its own Pi session, so it needs the same
 * decision and the same refusal text. This module holds both, so a change to
 * what is protected cannot reach one process and miss the other.
 *
 * A shell command can write through redirection or a file-moving command
 * without either write tool. Those targets are extracted here too; a command
 * that opens a protected path from inside an interpreter is outside what a
 * tool-call check can see, which is why the paths are also kept away from the
 * agent by convention and permissions.
 */

export interface ProtectedCallRefusal {
  /** The write target as the model wrote it. */
  path: string;
  /** The pattern that protects it. */
  pattern: string;
  reason: string;
}

/** The refusal Main and a delegated process both return for one protected write. */
export function protectedPathReason(path: string, pattern: string): string {
  return (
    `${path} is read-only for agents (protected by "${pattern}"). ` +
    `Evaluation code, the CoworkOS runtime and version-control metadata stay outside the optimization loop so results remain trustworthy. ` +
    `Change what is being measured instead, or ask the user to change what is protected.`
  );
}

/**
 * Decide whether one tool call writes a protected path.
 *
 * The candidate is matched as the model wrote it (relative paths resolve from
 * the process's project directory), so the refusal names the path the model
 * used and not an internal absolute one.
 */
export function protectedCallRefusal(
  toolName: string,
  input: unknown,
  guard: ProtectedPaths,
  projectDirectory: string
): ProtectedCallRefusal | undefined {
  for (const path of writeTargets(toolName, input)) {
    const pattern = guard.match(resolve(projectDirectory, path));
    if (pattern) return { path, pattern, reason: protectedPathReason(path, pattern) };
  }
  return undefined;
}

function writeTargets(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as { path?: unknown; file_path?: unknown; command?: unknown };
  if (toolName === "write" || toolName === "edit") {
    const path = value.path ?? value.file_path;
    return typeof path === "string" && path ? [path] : [];
  }
  if (toolName === "bash") return typeof value.command === "string" ? shellWriteTargets(value.command) : [];
  return [];
}

type ShellToken = { kind: "word" | "op"; value: string };

const OPERATORS = [
  ">>",
  "&>>",
  ">|",
  "&>",
  "&&",
  "||",
  "<<<",
  "<<",
  "<&",
  ">&",
  ">",
  "<",
  "|",
  ";",
  "&",
  "(",
  ")",
  "\n"
];
const SEGMENT_BREAKS = new Set(["|", "&&", "||", ";", "&", "(", ")", "\n"]);
const REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);

/** Split a shell command into words and operators, keeping quoted words whole. */
function tokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (word) tokens.push({ kind: "word", value: word });
    word = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      word += command[++index];
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      continue;
    }
    const operator = OPERATORS.find((candidate) => command.startsWith(candidate, index));
    if (!operator) {
      word += char;
      continue;
    }
    flush();
    // A number immediately before a redirection is the descriptor, not a word.
    if (/^\d+$/.test(tokens.at(-1)?.value ?? "") && tokens.at(-1)?.kind === "word" && /^[<>]/.test(operator))
      tokens.pop();
    tokens.push({ kind: "op", value: operator });
    index += operator.length - 1;
  }
  flush();
  return tokens;
}

/** Write targets named by one shell command: redirections and file-writing commands. */
export function shellWriteTargets(command: string): string[] {
  return collectShellTargets(tokenize(command));
}

function collectShellTargets(tokens: ShellToken[]): string[] {
  const targets: string[] = [];
  let segment: ShellToken[] = [];
  const endSegment = () => {
    if (segment.length) targets.push(...segmentTargets(segment));
    segment = [];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "op" && SEGMENT_BREAKS.has(token.value)) {
      endSegment();
      continue;
    }
    if (token.kind === "op") {
      const next = index + 1 < tokens.length ? tokens[index + 1] : undefined;
      if (!next || next.kind !== "word" || !next.value || next.value.startsWith("&")) continue;
      if (REDIRECTS.has(token.value)) targets.push(next.value);
      index += 1;
      continue;
    }
    segment.push(token);
  }
  endSegment();
  return targets.filter(isWritableToken);
}

function isWritableToken(token: string): boolean {
  return Boolean(
    token &&
    !token.startsWith("&") &&
    !token.startsWith("/dev/") &&
    !token.includes("$") &&
    !token.startsWith("~") &&
    token !== "-"
  );
}

/** Non-option arguments of a command, after any leading assignments and wrappers. */
function argumentsOf(tokens: ShellToken[]): { command: string; args: string[] } {
  const words = tokens.flatMap((token) => (token.kind === "word" ? [token.value] : []));
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (["sudo", "command", "env", "nice", "timeout", "xargs"].includes(word)) {
      index += 1;
      // sudo/env options and timeout durations are not the command itself.
      while (index < words.length && (words[index].startsWith("-") || /^\d+[smh]?$/.test(words[index])))
        index += 1;
      continue;
    }
    break;
  }
  const command = (words[index] ?? "").split("/").at(-1) ?? "";
  return { command, args: words.slice(index + 1) };
}

function segmentTargets(tokens: ShellToken[]): string[] {
  const { command, args } = argumentsOf(tokens);
  const targets: string[] = [];
  const nonOptions = (values: string[]) => values.filter((value) => value && !value.startsWith("-"));
  if (["bash", "sh", "zsh", "dash", "eval"].includes(command)) {
    const flag = args.indexOf("-c");
    const script = flag >= 0 ? args[flag + 1] : command === "eval" ? args.join(" ") : undefined;
    if (script) targets.push(...shellWriteTargets(script));
    else targets.push(...nonOptions(args));
  } else if (command === "tee") targets.push(...nonOptions(args));
  else if (
    ["rm", "rmdir", "unlink", "shred", "touch", "mkdir", "truncate", "chmod", "chown", "chgrp"].includes(
      command
    )
  )
    targets.push(...nonOptions(args));
  else if (command === "mv") targets.push(...args.filter((value) => !value.startsWith("-")));
  else if (["cp", "install", "ln", "rsync"].includes(command)) {
    const values = nonOptions(args);
    if (values.length) targets.push(values.at(-1)!);
  } else if (command === "dd") {
    for (const value of args) if (value.startsWith("of=")) targets.push(value.slice(3));
  } else if (command === "curl" || command === "wget") {
    const flagIndex = args.findIndex(
      (value) => value === "-o" || value === "--output" || value === "-O" || value === "--output-document"
    );
    if (flagIndex >= 0 && args[flagIndex + 1]) targets.push(args[flagIndex + 1]);
  } else if (command === "sed" || command === "perl") {
    const inPlace = args.some(
      (value) => value === "-i" || value.startsWith("-i.") || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(value)
    );
    if (inPlace) targets.push(...nonOptions(args));
  }
  return targets;
}
