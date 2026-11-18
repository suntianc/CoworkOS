import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { containsFilePath, resolveFileTarget, resolveProtectedTarget } from "./file-path.js";

/**
 * Where this harness is installed.
 *
 * Derived from the module's own location so it holds however CoworkOS was
 * started, and used as an absolute protected root: an Agent improving a
 * pipeline must not edit the runtime that records whether the pipeline
 * improved. `dist/src/tools/` is three levels below the install root.
 */
export function atriaInstallRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

/**
 * Paths an Agent must not write, even where it is otherwise allowed to.
 *
 * Self-improvement work needs an Agent that can edit the project it is
 * optimizing. That makes a boundary necessary rather than optional: an Agent
 * optimizing a score must not be able to edit the thing that produces the
 * score, and one improving this harness must not be able to edit the ledger
 * that records whether it improved anything.
 *
 * The guard is enforced in the file tools, not requested in a prompt, and it
 * applies to Main as much as to a Subagent — both are participants in the loop.
 *
 * It is NOT a sandbox. `bash` spawns real processes, and a process can
 * write wherever the OS lets it. This stops a tool call from casually editing
 * the referee; keeping a determined one out needs filesystem permissions (read
 * -only mode bits, or a directory the Agent's user cannot write).
 */

/**
 * Fallback patterns used when the user has not said where scoring lives.
 *
 * These are a guess at a conventional layout, and a guess is the weak part of
 * this guard: evaluation code named `scripts/evaluate.py` or `src/eval/` is not
 * matched by any of them, and a miss fails silently in the worst direction —
 * the agent edits the scorer, the number rises, and the ledger records it.
 * `COWORK_EVAL_PATHS` is the reliable way to say what the referee is;
 * `guessedProtection` reports when this fallback is all that is in effect.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  // The scorer and its fixtures: whoever is being scored must not own them.
  "eval/",
  "evals/",
  "evaluation/",
  "benchmarks/",
  "benchmark/",
  "bench/",
  // Not test/ or tests/: in ordinary development the tests are what the agent
  // is asked to write, and locking them sent every Executor back to the user.
  // A project whose tests are its scorer declares them in COWORK_EVAL_PATHS.
  // Version-control metadata, so history and hooks stay outside the loop.
  ".git/"
];

export interface ProtectedPathOptions {
  /** Root the patterns are relative to. Usually the user's project directory. */
  root: string;
  /** Overrides the defaults entirely when provided. */
  patterns?: readonly string[];
  /**
   * Absolute directories protected wherever they sit. The harness install goes
   * here: an Agent improving a pipeline must not edit the runtime recording
   * whether the pipeline improved, and that install is usually not inside the
   * project at all.
   */
  protectedRoots?: readonly string[];
}

export class ProtectedPaths {
  private readonly root: string;
  private readonly patterns: string[];
  private readonly roots: string[];

  constructor(options: ProtectedPathOptions) {
    this.root = resolve(options.root);
    this.patterns = [...(options.patterns ?? DEFAULT_PROTECTED_PATHS)]
      .map((pattern) => pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, ""))
      .filter(Boolean);
    this.roots = [...(options.protectedRoots ?? [])].filter(Boolean).map((entry) => resolve(entry));
  }

  /** The pattern that protects this path, or undefined when it is writable. */
  match(candidate: string): string | undefined {
    const absolute = resolve(candidate);
    // An absolute protected root applies wherever the path lives, including
    // outside the project — the harness install usually is.
    for (const root of this.roots) {
      if (containsFilePath(root, absolute)) return root;
    }
    const rel = relative(this.root, absolute).replaceAll(sep, "/");
    // Outside the guarded root entirely; a different check owns that path.
    if (!containsFilePath(this.root, absolute)) return undefined;
    if (!rel) return undefined;
    for (const pattern of this.patterns) {
      if (pattern.endsWith("/")) {
        const directory = pattern.slice(0, -1);
        if (rel === directory || rel.startsWith(`${directory}/`)) return pattern;
      } else if (rel === pattern || rel.startsWith(`${pattern}/`)) {
        return pattern;
      }
    }
    return undefined;
  }

  /**
   * The first pattern whose path currently exists under the guarded root.
   *
   * A relative write after a directory change we cannot follow could land on
   * any of them. Only patterns inside the project count: an absolute protected
   * root such as the harness install is not a plausible target of a relative
   * shell path, and blocking every relative write for it would stop ordinary
   * work in a project that is not the harness.
   */
  firstExistingPattern(): string | undefined {
    return this.patterns.find((pattern) => existsSync(resolve(this.root, pattern)));
  }

  /** Throw when a write would land on a protected path. */
  assertWritable(candidate: string): void {
    const pattern = this.match(candidate);
    if (!pattern) return;
    const absolute = resolve(candidate);
    const rel = relative(this.root, absolute).replaceAll(sep, "/");
    const shown = containsFilePath(this.root, absolute) ? rel : absolute;
    throw new Error(
      `${shown} is read-only for agents (protected by "${pattern}"). ` +
        `Evaluation code, the CoworkOS runtime and version-control metadata stay outside the optimization loop so results remain trustworthy. ` +
        `Change the thing being measured instead, or ask the user to adjust COWORK_PROTECTED_PATHS.`
    );
  }

  /** Apply the guard to targets reached through aliases and linked parents. */
  async assertWritableTarget(candidate: string): Promise<void> {
    this.assertWritable(candidate);
    const target = await resolveFileTarget(candidate);
    const root = await resolveProtectedTarget(this.root);
    const roots = await Promise.all(this.roots.map(resolveProtectedTarget));
    const resolved = new ProtectedPaths({ root, patterns: this.patterns, protectedRoots: roots });
    resolved.assertWritable(target);
    // A protected directory may itself be a symlink. Its target stays
    // protected even when accessed through a different project path.
    for (const pattern of this.patterns) {
      const protectedTarget = await resolveProtectedTarget(resolve(this.root, pattern));
      if (containsFilePath(protectedTarget, target)) {
        throw new Error(`${candidate} is read-only for agents (protected by "${pattern}").`);
      }
    }
  }

  get describe(): string {
    return [...this.patterns, ...this.roots].join(", ");
  }
}

/**
 * Read the guard from the environment.
 *
 * `COWORK_EVAL_PATHS` names the scorer and its fixtures. It is additive and is
 * the setting that actually makes this guard reliable, because only the user
 * knows where evaluation lives. `COWORK_PROTECTED_PATHS` replaces the guessed
 * fallback wholesale, and an empty value drops it; neither can unprotect a
 * declared eval path or `protectedRoots`, since the referee and the runtime
 * recording the results are never legitimate targets of the loop.
 */
export function configuredProtectedPaths(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  protectedRoots: readonly string[] = [],
  granted: readonly string[] = []
): ProtectedPaths {
  const declared = [...granted, ...splitPatterns(env.COWORK_EVAL_PATHS)];
  const raw = env.COWORK_PROTECTED_PATHS;
  const fallback = raw === undefined ? [...DEFAULT_PROTECTED_PATHS] : splitPatterns(raw);
  return new ProtectedPaths({ root, patterns: [...declared, ...fallback], protectedRoots });
}

/**
 * Whether the scorer is protected only by a guess at the project's layout.
 *
 * Worth surfacing at startup: an agent optimizing a score has a reason to
 * reach for the scorer, and a guess that misses looks exactly like a guess
 * that holds until the results are already untrustworthy.
 */
export function guessedProtection(env: NodeJS.ProcessEnv = process.env): boolean {
  return splitPatterns(env.COWORK_EVAL_PATHS).length === 0;
}

function splitPatterns(raw: string | undefined): string[] {
  return raw === undefined
    ? []
    : raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/**
 * The operator preset for project writes.
 *
 * Capabilities are normally granted on the Task, after the work is understood.
 * This is the escape hatch for a run configured ahead of time — a benchmark
 * harness, an unattended job — and it grants nothing unless set, because an
 * ordinary task has no reason to hold permission over the user's code.
 */
export function projectWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.COWORK_PROJECT_WRITE?.trim();
  if (value === undefined || value === "") return false;
  return value !== "0" && value !== "false";
}
