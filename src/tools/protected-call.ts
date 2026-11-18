import { isAbsolute, join, resolve } from "node:path";
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
 * without either write tool. Those targets are extracted here too, following
 * `cd`/`pushd`/`popd` and `git -C`, because a relative path means
 * nothing without the directory it was resolved from. When that directory is
 * itself unknowable (`cd "$D"`), a relative write is treated as possibly
 * protected while any protected path exists in the project.
 *
 * This is best-effort recognition of common shell forms, not a sandbox. Known
 * gaps include writes from inside an interpreter, command substitution inside
 * quotes, backticks, `xargs`, `find -delete`, `git clean` and `curl -O` (the URL
 * is not the written file), a directory target such as `git restore .` or
 * `git checkout .`, and archives unpacked by `tar` or `unzip`. Keeping the paths
 * away from the agent still needs permissions and convention.
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
 * the directory the shell reached, starting at the process's project
 * directory), so the refusal names the path the model used and not an
 * internal absolute one.
 */
export function protectedCallRefusal(
  toolName: string,
  input: unknown,
  guard: ProtectedPaths,
  projectDirectory: string
): ProtectedCallRefusal | undefined {
  for (const write of writeTargets(toolName, input)) {
    const pattern = patternFor(write, guard, projectDirectory);
    if (!pattern) continue;
    // A relative write after `cd "$DIR"` is refused for where it might land,
    // not because the named file is protected; say so, or the model is told a
    // plain source file is read-only and goes looking for why.
    const reason =
      !isAbsolute(write.path) && write.unresolved
        ? `${write.path} is written after a directory change that cannot be followed (such as cd "$DIR"), so it might land in the protected "${pattern}". ` +
          `Use an absolute path, or cd to a literal directory, and run the command again.`
        : protectedPathReason(write.path, pattern);
    return { path: write.path, pattern, reason };
  }
  return undefined;
}

interface ShellWrite {
  /** The target as written in the command. */
  path: string;
  /** The directory the target resolves from, relative to the project or absolute. */
  directory?: string;
  /** The command's directory could not be determined; a relative target may be protected. */
  unresolved?: boolean;
}

interface ShellBase {
  directory?: string;
  unresolved: boolean;
}

interface ShellState extends ShellBase {
  /** Directory before the last determinate `cd`, for `cd -`. */
  previous?: string;
  /** `pushd` entries. */
  stack: ShellBase[];
}

function patternFor(write: ShellWrite, guard: ProtectedPaths, projectDirectory: string): string | undefined {
  if (!isAbsolute(write.path) && write.unresolved) return guard.firstExistingPattern();
  const absolute = write.directory
    ? resolve(projectDirectory, write.directory, write.path)
    : resolve(projectDirectory, write.path);
  return guard.match(absolute);
}

function writeTargets(toolName: string, input: unknown): ShellWrite[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as { path?: unknown; file_path?: unknown; command?: unknown };
  if (toolName === "write" || toolName === "edit") {
    const path = value.path ?? value.file_path;
    return typeof path === "string" && path ? [{ path }] : [];
  }
  if (toolName === "bash") return typeof value.command === "string" ? shellWrites(value.command) : [];
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
const SEGMENT_BREAKS = new Set(["|", "&&", "||", ";", "&", "\n"]);
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

/** Write target paths named by one shell command; the base directory alone is dropped. */
export function shellWriteTargets(command: string): string[] {
  return shellWrites(command).map((write) => write.path);
}

function shellWrites(command: string, initial: ShellBase = { unresolved: false }): ShellWrite[] {
  const state: ShellState = { ...initial, stack: [] };
  return parseTokens(tokenize(command), state);
}

function parseTokens(tokens: ShellToken[], state: ShellState): ShellWrite[] {
  const writes: ShellWrite[] = [];
  const groups: ShellState[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  const flush = () => {
    for (const path of redirects) {
      const target = shellWrite(path, state);
      if (target) writes.push(target);
    }
    redirects = [];
    if (!words.length) return;
    const segment = words;
    words = [];
    const { command, args } = argumentsOf(segment);
    if (command === "cd" || command === "pushd" || command === "popd") {
      changeDirectory(command, args, state);
      return;
    }
    const base = commandBase(command, args, state);
    writes.push(...commandWrites(command, args, base));
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "op" && token.value === "(") {
      flush();
      groups.push(copyState(state));
      continue;
    }
    if (token.kind === "op" && token.value === ")") {
      flush();
      const restored = groups.pop();
      if (restored) {
        state.directory = restored.directory;
        state.previous = restored.previous;
        state.unresolved = restored.unresolved;
        state.stack = restored.stack;
      }
      continue;
    }
    if (token.kind === "op" && SEGMENT_BREAKS.has(token.value)) {
      flush();
      continue;
    }
    if (token.kind === "op") {
      const next = index + 1 < tokens.length ? tokens[index + 1] : undefined;
      if (!next || next.kind !== "word" || !next.value || next.value.startsWith("&")) continue;
      if (REDIRECTS.has(token.value)) redirects.push(next.value);
      index += 1;
      continue;
    }
    // `{ ...; }` runs in the current shell, so its `cd` carries into the
    // following segment; only a standalone brace is a group marker.
    if ((token.value === "{" || token.value === "}") && words.length === 0) {
      flush();
      continue;
    }
    words.push(token.value);
  }
  flush();
  return writes;
}

function copyState(state: ShellState): ShellState {
  return {
    directory: state.directory,
    unresolved: state.unresolved,
    previous: state.previous,
    stack: [...state.stack]
  };
}

function shellWrite(path: string, base: ShellBase): ShellWrite | undefined {
  if (!isWritableToken(path)) return undefined;
  return {
    path,
    ...(base.directory ? { directory: base.directory } : {}),
    ...(base.unresolved ? { unresolved: true } : {})
  };
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
function argumentsOf(words: string[]): { command: string; args: string[] } {
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

/** The directory this one command's target arguments resolve from. */
function commandBase(command: string, args: string[], state: ShellState): ShellBase {
  if (command !== "git") return { ...state };
  let base: ShellBase = { directory: state.directory, unresolved: state.unresolved };
  // Git applies repeated -C options cumulatively: -C a -C b is a/b.
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-C") continue;
    base = combineDirectory(base, args[index + 1]);
    index += 1;
  }
  return base;
}

function combineDirectory(state: ShellBase, value: string | undefined): ShellBase {
  if (!value || isUnknownDirectory(value)) return { directory: state.directory, unresolved: true };
  if (isAbsolute(value)) return { directory: value, unresolved: false };
  if (state.unresolved) return { directory: state.directory, unresolved: true };
  return { directory: join(state.directory ?? ".", value), unresolved: false };
}

function isUnknownDirectory(value: string): boolean {
  return !value || value.includes("$") || value.includes("`") || value.startsWith("~") || /[*?]/.test(value);
}

/** Track a shell directory change across the following segments. */
function changeDirectory(command: string, args: string[], state: ShellState): void {
  if (command === "popd") {
    const previous = state.stack.pop();
    if (!previous) {
      state.unresolved = true;
      return;
    }
    state.previous = state.unresolved ? undefined : (state.directory ?? ".");
    state.directory = previous.directory;
    state.unresolved = previous.unresolved;
    return;
  }
  const value = args.find((argument) => argument === "-" || !argument.startsWith("-"));
  if (command === "pushd") {
    if (value === undefined) {
      state.unresolved = true;
      return;
    }
    state.stack.push({ directory: state.directory, unresolved: state.unresolved });
    cdTo(state, value);
    return;
  }
  cdTo(state, value);
}

function cdTo(state: ShellState, value: string | undefined): void {
  if (value === undefined) {
    state.previous = state.unresolved ? undefined : (state.directory ?? ".");
    state.unresolved = true;
    return;
  }
  if (value === "-") {
    const previous = state.previous;
    if (previous === undefined || state.unresolved) {
      state.unresolved = true;
      return;
    }
    state.previous = state.directory ?? ".";
    state.directory = previous;
    state.unresolved = false;
    return;
  }
  const combined = combineDirectory(state, value);
  state.previous = state.unresolved ? undefined : (state.directory ?? ".");
  state.directory = combined.directory;
  state.unresolved = combined.unresolved;
}

function commandWrites(command: string, args: string[], base: ShellBase): ShellWrite[] {
  const writes: ShellWrite[] = [];
  const add = (values: string[]) => {
    for (const value of values) {
      const target = shellWrite(value, base);
      if (target) writes.push(target);
    }
  };
  const nonOptions = (values: string[]) => values.filter((value) => value && !value.startsWith("-"));
  if (["bash", "sh", "zsh", "dash", "eval"].includes(command)) {
    const flag = args.indexOf("-c");
    const script = flag >= 0 ? args[flag + 1] : command === "eval" ? args.join(" ") : undefined;
    if (script) writes.push(...shellWrites(script, base));
    else add(nonOptions(args));
  } else if (command === "tee") add(nonOptions(args));
  else if (
    ["rm", "rmdir", "unlink", "shred", "touch", "mkdir", "truncate", "chmod", "chown", "chgrp"].includes(
      command
    )
  )
    add(nonOptions(args));
  else if (command === "mv") add(args.filter((value) => !value.startsWith("-")));
  else if (["cp", "install", "ln", "rsync"].includes(command)) {
    const destination = nonOptions(args).at(-1);
    if (destination) add([destination]);
  } else if (command === "dd") {
    add(args.filter((value) => value.startsWith("of=")).map((value) => value.slice(3)));
  } else if (command === "curl" || command === "wget") {
    const flagIndex = args.findIndex(
      (value) => value === "-o" || value === "--output" || value === "-O" || value === "--output-document"
    );
    if (flagIndex >= 0 && args[flagIndex + 1]) add([args[flagIndex + 1]]);
  } else if (command === "sed" || command === "perl") {
    const inPlace = args.some(
      (value) => value === "-i" || value.startsWith("-i.") || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(value)
    );
    if (inPlace) add(nonOptions(args));
  } else if (command === "git") {
    const rest = withoutDirectoryFlag(args);
    const subIndex = rest.findIndex((value) => !value.startsWith("-"));
    const subcommand = rest[subIndex];
    if (subcommand === "rm" || subcommand === "mv") add(nonOptions(rest.slice(subIndex + 1)));
    else if (subcommand === "checkout" || subcommand === "restore") {
      const tail = rest.slice(subIndex + 1);
      const separator = tail.indexOf("--");
      add(nonOptions(separator >= 0 ? tail.slice(separator + 1) : tail));
    }
  }
  return writes;
}

/** Remove `-C <directory>` from a command's arguments before reading its file targets. */
function withoutDirectoryFlag(args: string[]): string[] {
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-C") {
      index += 1;
      continue;
    }
    rest.push(args[index]);
  }
  return rest;
}
