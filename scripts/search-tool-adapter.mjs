import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runFileSearch } from "./file-search.mjs";

const MARKER = "# CoworkOS Pi search adapter v1";
const OWNED_MARKERS = [MARKER, "# Atria Pi search adapter v1"];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** These adapters implement Pi's search/autocomplete arguments, not the fd/rg CLI. */
export function parseSearchToolArguments(tool, args, cwd = process.cwd()) {
  if (!["fd", "rg"].includes(tool)) throw new Error("Unknown Pi search adapter.");
  const parameters = { path: cwd, limit: 20_000 };
  const positionals = [];
  let endOptions = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--" && !endOptions) {
      endOptions = true;
      continue;
    }
    if (endOptions || !flag.startsWith("-")) {
      positionals.push(flag);
      continue;
    }
    const value = () => {
      const next = args[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value.`);
      return next;
    };
    if (["--hidden", "--color=never"].includes(flag)) continue;
    if (tool === "fd") {
      if (flag === "--no-require-git") continue;
      else if (flag === "--glob") parameters.glob = true;
      else if (flag === "--full-path") parameters.fullPath = true;
      else if (flag === "--follow") parameters.follow = true;
      else if (flag === "--base-directory") parameters.path = resolve(cwd, value());
      else if (flag === "--max-results") parameters.limit = Number(value());
      else if (flag === "--max-depth") parameters.maxDepth = Number(value());
      else if (flag === "--type") (parameters.types ??= []).push(value());
      else if (flag === "--exclude") (parameters.exclude ??= []).push(value());
      else
        throw new Error(
          `CoworkOS Pi fd adapter does not support ${flag}; use the find tool for file searches.`
        );
    } else {
      if (["--no-config", "--line-number", "--json"].includes(flag)) continue;
      else if (flag === "--ignore-case") parameters.ignoreCase = true;
      else if (flag === "--fixed-strings") parameters.literal = true;
      else if (flag === "--glob") parameters.glob = value();
      else if (flag === "--context") parameters.context = Number(value());
      else
        throw new Error(
          `CoworkOS Pi rg adapter does not support ${flag}; use the grep tool for content searches.`
        );
    }
  }
  if (positionals.length > 2) throw new Error("Pi search adapters accept one pattern and one search path.");
  if (tool === "rg" && positionals.length === 0) throw new Error("A search pattern is required.");
  parameters.pattern = positionals[0] ?? "";
  if (positionals[1]) parameters.path = resolve(cwd, positionals[1]);
  return parameters;
}

export async function runSearchToolAdapter(
  tool,
  args,
  { cwd = process.cwd(), write = (text) => process.stdout.write(text) } = {}
) {
  if (args.length === 1 && args[0] === "--version") {
    write(`CoworkOS Pi ${tool} adapter 1 (Node.js portable search)\n`);
    return 0;
  }
  const parameters = parseSearchToolArguments(tool, args, cwd);
  const result = await runFileSearch(tool === "fd" ? "autocomplete" : "grep", parameters, { cwd });
  if (tool === "fd") {
    for (const path of result.paths) write(`${path}\n`);
    return 0;
  }
  // Pi's grep stream distinguishes hits from --context rows; both carry a path,
  // line number and the line text.
  for (const entry of result.lines) {
    write(
      `${JSON.stringify({ type: entry.isMatch ? "match" : "context", data: { path: { text: entry.path }, lines: { text: `${entry.line}\n` }, line_number: entry.lineNumber } })}\n`
    );
  }
  return result.matchCount ? 0 : 1;
}

/** Install only CoworkOS-owned adapters, preserving any user-installed native tools. */
export async function installSearchToolAdapters(
  agentDir,
  { platform = process.platform, node = process.execPath } = {}
) {
  // Windows search tools work through the native JS extension override. Pi's
  // optional fd autocomplete expects a PE executable; Windows is not a tested
  // CLI distribution target yet, so do not disguise a script as an .exe.
  if (!["darwin", "linux"].includes(platform)) return { supported: false, installed: [] };
  const bin = join(resolve(agentDir), "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const entry = fileURLToPath(import.meta.url);
  const installed = [];
  for (const tool of ["fd", "rg"]) {
    const target = join(bin, tool);
    let existing;
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      existing = await readFile(target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      existing !== undefined &&
      !OWNED_MARKERS.some((marker) => existing.startsWith(`#!/bin/sh\n${marker}\n`))
    )
      continue;
    const content = `#!/bin/sh\n${MARKER}\nexec ${shellQuote(node)} ${shellQuote(entry)} ${shellQuote(tool)} "$@"\n`;
    if (content === existing) {
      await chmod(target, 0o755);
      continue;
    }
    const temporary = join(dirname(target), `.atria-${tool}-${randomUUID()}`);
    try {
      await writeFile(temporary, content, { mode: 0o755, flag: "wx" });
      if (existing === undefined) {
        try {
          await link(temporary, target);
        } catch (error) {
          if (error.code === "EEXIST") continue;
          throw error;
        }
      } else await rename(temporary, target);
      installed.push(tool);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { supported: true, installed };
}

/** Verify the same portable tools and adapters that a CLI launch will use. */
export async function verifySearchToolInstallation(agentDir) {
  // Keep the synthetic search corpus outside project-level ignore rules.
  const probe = await mkdtemp(join(tmpdir(), "atria-search-doctor-"));
  try {
    await mkdir(join(probe, ".git"));
    await writeFile(join(probe, "visible.txt"), "atria-search-probe\n", { mode: 0o600 });
    await writeFile(join(probe, "ignored.txt"), "atria-search-probe\n", { mode: 0o600 });
    await writeFile(join(probe, ".gitignore"), "ignored.txt\n", { mode: 0o600 });
    const found = await runFileSearch("find", { pattern: "*.txt" }, { cwd: probe });
    const searched = await runFileSearch(
      "grep",
      { pattern: "atria-search-probe", literal: true },
      { cwd: probe }
    );
    if (
      found.paths.join("\n") !== "visible.txt" ||
      searched.matchCount !== 1 ||
      !searched.text.startsWith("visible.txt:1:")
    )
      throw new Error("文件搜索验证失败；请重新安装完整 CLI 包。");
    const adapters = await installSearchToolAdapters(agentDir);
    if (adapters.supported) {
      const execute = promisify(execFile);
      const options = { cwd: probe, timeout: 10_000, maxBuffer: 64 * 1024 };
      const fd = await execute(
        join(agentDir, "bin/fd"),
        [
          "--glob",
          "--hidden",
          "--color=never",
          "--no-require-git",
          "--max-results",
          "10",
          "--",
          "*.txt",
          probe
        ],
        options
      );
      const paths = fd.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((path) => basename(path));
      const rg = await execute(
        join(agentDir, "bin/rg"),
        [
          "--json",
          "--hidden",
          "--line-number",
          "--color=never",
          "--fixed-strings",
          "--",
          "atria-search-probe",
          probe
        ],
        options
      );
      const matches = rg.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "match");
      if (
        paths.join("\n") !== "visible.txt" ||
        matches.length !== 1 ||
        basename(matches[0].data?.path?.text || "") !== "visible.txt"
      )
        throw new Error("终端文件补全与搜索适配器验证失败；请重新安装完整 CLI 包。");
    }
    return "可离线使用，无需安装 fd 或 rg";
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runSearchToolAdapter(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
