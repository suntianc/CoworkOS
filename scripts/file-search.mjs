import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import ignore from "ignore";
import { minimatch } from "minimatch";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULTS = 20_000;
const normalize = (path) => path.split(sep).join("/");

function resultLimit(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS)
    throw new Error(`Search limit must be an integer between 1 and ${MAX_RESULTS}.`);
  return limit;
}

function assertPattern(value) {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Search pattern must be a string of at most 4096 characters.");
  return value;
}

async function readRules(directory) {
  const matcher = ignore();
  for (const name of [".gitignore", ".ignore"]) {
    try {
      matcher.add(await readFile(resolve(directory, name), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { directory, matcher };
}

async function ancestorRules(directory) {
  const ancestors = [];
  for (let current = dirname(directory); ; current = dirname(current)) {
    ancestors.push(current);
    try {
      await stat(resolve(current, ".git"));
      return Promise.all(ancestors.reverse().map(readRules));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) return [];
  }
}

function ignored(path, isDirectory, rules) {
  let excluded = false;
  for (const { directory, matcher } of rules) {
    const local = normalize(relative(directory, path)) + (isDirectory ? "/" : "");
    if (!local || local.startsWith("../") || isAbsolute(local)) continue;
    const result = matcher.test(local);
    if (result.ignored) excluded = true;
    else if (result.unignored) excluded = false;
  }
  return excluded;
}

async function* entriesIn(directory, rules = [], options = {}, depth = 1, ancestors = new Set()) {
  const actual = await realpath(directory);
  if (ancestors.has(actual)) return;
  const visited = new Set([...ancestors, actual]);
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedRepository = rules.length > 0 && entries.some((entry) => entry.name === ".git");
  const localRules = [...(nestedRepository ? [] : rules), await readRules(directory)];
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    let info = entry;
    if (entry.isSymbolicLink()) {
      if (!options.follow) continue;
      try {
        info = await stat(path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
    }
    if (ignored(path, info.isDirectory(), localRules)) continue;
    const local = normalize(relative(options.root || directory, path));
    if (options.exclude?.some((pattern) => globMatches(local, pattern))) continue;
    if (info.isDirectory()) {
      yield { path, directory: true };
      if (depth < (options.maxDepth ?? Infinity))
        yield* entriesIn(path, localRules, options, depth + 1, visited);
    } else if (info.isFile()) yield { path, directory: false };
  }
}

async function* files(directory, rules = []) {
  for await (const entry of entriesIn(directory, rules)) if (!entry.directory) yield entry.path;
}

function globMatches(path, pattern) {
  return minimatch(pattern.includes("/") ? path : basename(path), pattern, { dot: true });
}

async function searchRoot(path, cwd) {
  const root = resolve(cwd, path || ".");
  try {
    return { root, info: await stat(root) };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Path not found: ${root}`);
    throw error;
  }
}

/** Portable file-name search, used by both doctor and the Pi tool override. */
export async function findFiles(parameters, cwd = process.cwd()) {
  const pattern = assertPattern(parameters.pattern);
  const limit = resultLimit(parameters.limit, 1000);
  const { root, info } = await searchRoot(parameters.path, cwd);
  if (!info.isDirectory()) throw new Error(`Search path must be a directory: ${root}`);
  const paths = [];
  for await (const path of files(root, await ancestorRules(root))) {
    const local = normalize(relative(root, path));
    if (!globMatches(local, pattern)) continue;
    if (paths.length === limit) return { paths, limitReached: true };
    paths.push(local);
  }
  return { paths, limitReached: false };
}

/** Pi file autocomplete's fd-compatible subset; not a general fd replacement. */
export async function autocompleteFiles(parameters, cwd = process.cwd()) {
  const limit = resultLimit(parameters.limit, 100);
  const { root, info } = await searchRoot(parameters.path, cwd);
  if (!info.isDirectory()) throw new Error(`Search path must be a directory: ${root}`);
  const pattern = assertPattern(parameters.pattern ?? "");
  const expression = parameters.glob ? undefined : new RegExp(pattern, "u");
  const types = parameters.types ?? ["f", "d"];
  if (types.some((type) => !["f", "d"].includes(type)))
    throw new Error("Only file and directory search is supported.");
  if (
    parameters.maxDepth !== undefined &&
    (!Number.isInteger(parameters.maxDepth) || parameters.maxDepth < 1)
  )
    throw new Error("Maximum search depth must be a positive integer.");
  const paths = [];
  for await (const entry of entriesIn(root, await ancestorRules(root), { ...parameters, root })) {
    if (!types.includes(entry.directory ? "d" : "f")) continue;
    const local = normalize(relative(root, entry.path));
    const candidate = parameters.fullPath ? local : basename(local);
    if (parameters.glob ? !minimatch(candidate, pattern, { dot: true }) : !expression.test(candidate))
      continue;
    if (paths.length === limit) return { paths, limitReached: true };
    paths.push(local + (entry.directory ? "/" : ""));
  }
  return { paths, limitReached: false };
}

/** Portable content search. Regex patterns use JavaScript regular expressions. */
export async function grepFiles(parameters, cwd = process.cwd()) {
  const pattern = assertPattern(parameters.pattern);
  const limit = resultLimit(parameters.limit, 100);
  const context = parameters.context ?? 0;
  if (!Number.isInteger(context) || context < 0 || context > 100)
    throw new Error("Search context must be an integer between 0 and 100.");
  if (parameters.glob !== undefined) assertPattern(parameters.glob);
  const expression = parameters.literal ? undefined : new RegExp(pattern, parameters.ignoreCase ? "iu" : "u");
  const literal = parameters.ignoreCase ? pattern.toLowerCase() : pattern;
  const matches = (line) =>
    expression
      ? expression.test(line)
      : (parameters.ignoreCase ? line.toLowerCase() : line).includes(literal);
  const { root, info } = await searchRoot(parameters.path, cwd);
  if (!info.isDirectory() && !info.isFile())
    throw new Error(`Search path must be a file or directory: ${root}`);
  const candidates = info.isDirectory() ? files(root, await ancestorRules(root)) : [root];
  const output = [];
  const outputLines = [];
  const matchedLines = [];
  const skippedFiles = [];
  let matchCount = 0;
  let outputBytes = 0;
  let limitReached = false;
  let outputLimitReached = false;
  let linesTruncated = false;
  for await (const path of candidates) {
    const local = info.isDirectory() ? normalize(relative(root, path)) : basename(root);
    if (parameters.glob && !globMatches(local, parameters.glob)) continue;
    if ((await stat(path)).size > MAX_FILE_BYTES) {
      skippedFiles.push(local);
      continue;
    }
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
    const matchedIndexes = new Set();
    const includedIndexes = new Set();
    for (let index = 0; index < lines.length; index++) {
      if (!matches(lines[index])) continue;
      if (matchCount === limit) {
        limitReached = true;
        break;
      }
      matchCount++;
      matchedLines.push({ path, lineNumber: index + 1, line: lines[index] });
      matchedIndexes.add(index);
      for (
        let line = Math.max(index - context, 0);
        line <= Math.min(index + context, lines.length - 1);
        line++
      )
        includedIndexes.add(line);
    }
    for (const line of [...includedIndexes].sort((left, right) => left - right)) {
      const delimiter = matchedIndexes.has(line) ? ":" : "-";
      const text = `${local}${delimiter}${line + 1}${delimiter} ${lines[line].slice(0, 1000)}`;
      if (lines[line].length > 1000) linesTruncated = true;
      const size = Buffer.byteLength(text) + 1;
      if (outputBytes + size > MAX_OUTPUT_BYTES) {
        outputLimitReached = true;
        break;
      }
      output.push(text);
      outputLines.push({
        path,
        lineNumber: line + 1,
        line: lines[line].slice(0, 1000),
        isMatch: matchedIndexes.has(line)
      });
      outputBytes += size;
    }
    if (limitReached || outputLimitReached) break;
  }
  return {
    text: output.join("\n"),
    matchCount,
    limitReached,
    outputLimitReached,
    linesTruncated,
    skippedFiles,
    matches: matchedLines,
    // Adapter JSON needs match and context rows in file order, not only matches.
    lines: outputLines
  };
}

/** Run regex and traversal off the main thread so cancellation and timeouts work. */
export function runFileSearch(
  operation,
  parameters,
  { cwd = process.cwd(), signal, timeoutMs = 30_000 } = {}
) {
  if (!["find", "grep", "autocomplete"].includes(operation))
    return Promise.reject(new Error("Unknown file search operation."));
  if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    return Promise.reject(new Error("Invalid file search timeout."));
  return new Promise((done, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { atriaFileSearch: true, operation, parameters, cwd }
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else done(result);
    };
    const abort = () => finish(new Error("Operation aborted"));
    const timer = setTimeout(
      () => finish(new Error("File search timed out; narrow the search path or pattern.")),
      timeoutMs
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", ({ result, error }) => finish(error ? new Error(error) : undefined, result));
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => finish(new Error("File search worker exited before returning a result.")));
    if (signal?.aborted) abort();
  });
}

if (!isMainThread && workerData?.atriaFileSearch) {
  try {
    const search =
      workerData.operation === "find"
        ? findFiles
        : workerData.operation === "autocomplete"
          ? autocompleteFiles
          : grepFiles;
    parentPort.postMessage({ result: await search(workerData.parameters, workerData.cwd) });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}
