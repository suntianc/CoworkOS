import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { findFiles, grepFiles, runFileSearch } from "../scripts/file-search.mjs";
import { installSearchToolAdapters, parseSearchToolArguments } from "../scripts/search-tool-adapter.mjs";

const exec = promisify(execFile);
const cli = resolve("scripts/atria.mjs");
const portable = ["darwin", "linux"].includes(process.platform);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-file-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, text) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
  );
  Object.assign(env, {
    ATRIA_HOME: join(root, "user"),
    PI_OFFLINE: "1",
    COWORK_DISABLE_MAIN_GUARDIAN: "1"
  });
  return { root, put, env };
}

test("portable file search handles globs, hidden files, nested ignores, exclusions and result limits", async (t) => {
  const f = await fixture(t);
  await f.put(".gitignore", "ignored/\n*.tmp\n");
  await f.put("hello.txt", "hello\n");
  await f.put(".hidden.txt", "hidden\n");
  await f.put("ignored/secret.txt", "ignored\n");
  await f.put("node_modules/not-user-source.txt", "ignored\n");
  await f.put(".git/not-user-source.txt", "ignored\n");
  await f.put("src/.gitignore", "*.txt\n!included.txt\n");
  await f.put("src/included.txt", "included\n");
  await f.put("src/excluded.txt", "excluded\n");
  await f.put("src/item.tmp", "ignored\n");
  await f.put("src/code.js", "source\n");
  if (portable) await symlink(join(f.root, "hello.txt"), join(f.root, "shortcut.txt"));
  const found = await runFileSearch("find", { pattern: "*.txt" }, { cwd: f.root });
  assert.deepEqual(found, { paths: [".hidden.txt", "hello.txt", "src/included.txt"], limitReached: false });
  assert.deepEqual((await findFiles({ pattern: "src/**/*.js" }, f.root)).paths, ["src/code.js"]);
  assert.deepEqual(await findFiles({ pattern: "*.txt", limit: 1 }, f.root), {
    paths: [".hidden.txt"],
    limitReached: true
  });
  assert.equal((await findFiles({ pattern: "*.js", limit: 1 }, f.root)).limitReached, false);
});

test("search respects parent repository ignore rules and nested repository boundaries", async (t) => {
  const f = await fixture(t);
  await f.put(".git/marker", "fixture");
  await f.put(".gitignore", "*.txt\n");
  await f.put("project/parent-ignored.txt", "ignored");
  await f.put("project/source.js", "source");
  await f.put("project/nested/.git/marker", "fixture");
  await f.put("project/nested/visible.txt", "visible");
  assert.deepEqual((await findFiles({ pattern: "**/*" }, join(f.root, "project"))).paths, [
    "nested/visible.txt",
    "source.js"
  ]);
});

test("portable content search handles literal/regex matches, context, ignored/binary/large files and limits", async (t) => {
  const f = await fixture(t);
  await f.put(".gitignore", "ignored.txt\n");
  await f.put("hello.txt", "first\r\nHello [world]\r\nlast\r\nHELLO\r\n");
  await f.put("ignored.txt", "Hello\n");
  await f.put("binary.txt", Buffer.from("Hello\0binary"));
  await f.put("large.txt", Buffer.alloc(4 * 1024 * 1024 + 1, "a"));
  const literal = await runFileSearch(
    "grep",
    { pattern: "Hello [world]", literal: true, context: 1 },
    { cwd: f.root }
  );
  assert.equal(literal.matchCount, 1);
  assert.equal(literal.text, "hello.txt-1- first\nhello.txt:2: Hello [world]\nhello.txt-3- last");
  assert.deepEqual(literal.skippedFiles, ["large.txt"]);
  const insensitive = await grepFiles({ pattern: "^hello", ignoreCase: true, glob: "hello.txt" }, f.root);
  assert.equal(insensitive.matchCount, 2);
  assert.equal(insensitive.matches[1].lineNumber, 4);
  assert.equal((await grepFiles({ pattern: "Hello", path: "ignored.txt" }, f.root)).matchCount, 1);
  const limited = await grepFiles({ pattern: "Hello", ignoreCase: true, limit: 1 }, f.root);
  assert.equal(limited.matchCount, 1);
  assert.equal(limited.limitReached, true);
  assert.equal((await grepFiles({ pattern: "absent" }, f.root)).matchCount, 0);
  await f.put("overlap.txt", "Hello\nHello\nlast\n");
  const overlapping = await grepFiles({ pattern: "Hello", path: "overlap.txt", context: 1 }, f.root);
  assert.equal(overlapping.text, "overlap.txt:1: Hello\noverlap.txt:2: Hello\noverlap.txt-3- last");
  await f.put("long.txt", `${"Hello" + "x".repeat(2000)}\n`.repeat(100));
  const bounded = await grepFiles({ pattern: "Hello", path: "long.txt" }, f.root);
  assert.equal(bounded.outputLimitReached, true);
  assert.equal(bounded.limitReached, false);
  assert.equal(bounded.linesTruncated, true);
  assert.ok(Buffer.byteLength(bounded.text) <= 64 * 1024);
});

test("file search rejects invalid inputs and terminates aborted or stalled workers", async (t) => {
  const f = await fixture(t);
  await f.put("hello.txt", "a".repeat(100) + "!");
  await assert.rejects(
    runFileSearch("find", { pattern: "*", path: "missing" }, { cwd: f.root }),
    /Path not found/
  );
  await assert.rejects(findFiles({ pattern: "*", path: "hello.txt" }, f.root), /must be a directory/);
  for (const limit of [0, -1, 1.1, 20_001, "1"])
    await assert.rejects(findFiles({ pattern: "*", limit }, f.root), /Search limit/);
  await assert.rejects(runFileSearch("grep", { pattern: "[" }, { cwd: f.root }), /regular expression/);
  await assert.rejects(grepFiles({ pattern: "a", context: -1 }, f.root), /context/);
  await assert.rejects(runFileSearch("unknown", {}, { cwd: f.root }), /Unknown/);
  await assert.rejects(runFileSearch("find", { pattern: "*" }, { signal: AbortSignal.abort() }), /aborted/);
  await assert.rejects(
    runFileSearch("grep", { pattern: "(a+)+$" }, { cwd: f.root, timeoutMs: 200 }),
    /timed out/
  );
  const abort = new AbortController();
  const pending = runFileSearch("grep", { pattern: "(a+)+$" }, { cwd: f.root, signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /aborted/);
  assert.deepEqual((await runFileSearch("find", { pattern: "*.txt" }, { cwd: f.root })).paths, ["hello.txt"]);
});

test("Pi search adapters expose only supported arguments and preserve user-installed tools", async (t) => {
  const f = await fixture(t);
  for (const [tool, args] of [
    ["fd", ["--unknown"]],
    ["rg", ["--files"]],
    ["fd", ["--max-depth"]],
    ["rg", []]
  ])
    assert.throws(() => parseSearchToolArguments(tool, args), /does not support|requires|pattern/);
  assert.deepEqual(await installSearchToolAdapters(join(f.root, "windows"), { platform: "win32" }), {
    supported: false,
    installed: []
  });
  if (!portable) return;
  const agent = join(f.root, "agent's directory with spaces");
  await mkdir(join(agent, "bin"), { recursive: true });
  await writeFile(join(agent, "bin/fd"), "user-owned native fd sentinel");
  const installed = await installSearchToolAdapters(agent);
  assert.deepEqual(installed.installed, ["rg"]);
  assert.equal(await readFile(join(agent, "bin/fd"), "utf8"), "user-owned native fd sentinel");
  const repeated = await installSearchToolAdapters(agent);
  assert.deepEqual(repeated.installed, []);
  assert.equal((await stat(join(agent, "bin/rg"))).mode & 0o777, 0o755);
  assert.match(
    (await exec(join(agent, "bin/rg"), ["--version"], { env: f.env })).stdout,
    /Node.js portable search/
  );
  const linkedAgent = join(f.root, "linked-agent");
  await mkdir(join(linkedAgent, "bin"), { recursive: true });
  await writeFile(join(f.root, "owned-fd"), "#!/bin/sh\n# CoworkOS Pi search adapter v1\nold target\n");
  await symlink(join(f.root, "owned-fd"), join(linkedAgent, "bin/fd"));
  await installSearchToolAdapters(linkedAgent);
  assert.equal(
    await readFile(join(f.root, "owned-fd"), "utf8"),
    "#!/bin/sh\n# CoworkOS Pi search adapter v1\nold target\n"
  );
  const migratedAgent = join(f.root, "migrated-agent");
  await mkdir(join(migratedAgent, "bin"), { recursive: true });
  await writeFile(join(migratedAgent, "bin/fd"), "#!/bin/sh\n# CoworkOS Pi search adapter v1\nold target\n");
  assert.deepEqual((await installSearchToolAdapters(migratedAgent)).installed, ["fd", "rg"]);
  assert.match((await exec(join(migratedAgent, "bin/fd"), ["--version"])).stdout, /CoworkOS Pi fd adapter/);
});

test(
  "legacy branded adapters are rebound after the original runtime is removed",
  { skip: !portable },
  async (t) => {
    const f = await fixture(t);
    const agent = join(f.root, "legacy agent's profile");
    const runtime = join(f.root, "old-runtime.mjs");
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await mkdir(join(agent, "bin"), { recursive: true });
    await writeFile(runtime, 'console.log("legacy search runtime");\n');
    for (const tool of ["fd", "rg"]) {
      await writeFile(
        join(agent, "bin", tool),
        `#!/bin/sh\n# Atria Pi search adapter v1\nexec ${quote(process.execPath)} ${quote(runtime)} ${quote(tool)} "$@"\n`,
        { mode: 0o755 }
      );
      assert.match((await exec(join(agent, "bin", tool), ["--version"])).stdout, /legacy search runtime/);
    }
    await rm(runtime);
    await assert.rejects(exec(join(agent, "bin/fd"), ["--version"]), /MODULE_NOT_FOUND/);

    assert.deepEqual((await installSearchToolAdapters(agent)).installed, ["fd", "rg"]);
    await f.put("project/hello.txt", "search migration evidence\n");
    const project = join(f.root, "project");
    const fd = await exec(join(agent, "bin/fd"), ["--glob", "--", "*.txt", project]);
    assert.match(fd.stdout, /hello\.txt/);
    const rg = await exec(join(agent, "bin/rg"), ["--fixed-strings", "--", "migration evidence", project]);
    const match = JSON.parse(rg.stdout.trim());
    assert.match(match.data.path.text, /hello\.txt$/);
    assert.equal(match.data.lines.text, "search migration evidence\n");
    assert.deepEqual((await installSearchToolAdapters(agent)).installed, []);
  }
);

test(
  "installed adapters support actual Pi file autocomplete and find/grep arguments while offline",
  { skip: !portable },
  async (t) => {
    const f = await fixture(t);
    const agent = join(f.root, "agent");
    const project = join(f.root, "project");
    await f.put("project/hello.txt", "hello fixture\nsecond line\n");
    await f.put("project/nested/deep.txt", "deep fixture\n");
    await f.put("project/.git/hidden", "ignored");
    await symlink(project, join(project, "loop"));
    await installSearchToolAdapters(agent);
    const fd = join(agent, "bin/fd");
    const rg = join(agent, "bin/rg");
    const actualAutocomplete = [
      "--base-directory",
      project,
      "--max-results",
      "100",
      "--type",
      "f",
      "--type",
      "d",
      "--follow",
      "--hidden",
      "--exclude",
      ".git",
      "--exclude",
      ".git/*",
      "--exclude",
      ".git/**",
      "--max-depth",
      "1"
    ];
    const completed = await exec(fd, actualAutocomplete, { cwd: project, env: f.env });
    assert.deepEqual(completed.stdout.trim().split("\n"), ["hello.txt", "loop/", "nested/"]);
    const paths = await exec(
      fd,
      [
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--max-results",
        "10",
        "--full-path",
        "--",
        "**/nested/*.txt",
        project
      ],
      { cwd: project, env: f.env }
    );
    assert.equal(paths.stdout.trim(), "nested/deep.txt");
    const content = await exec(
      rg,
      [
        "--json",
        "--line-number",
        "--color=never",
        "--hidden",
        "--fixed-strings",
        "--glob",
        "hello.txt",
        "--",
        "fixture",
        project
      ],
      { env: f.env }
    );
    const event = JSON.parse(content.stdout);
    assert.equal(event.type, "match");
    assert.equal(event.data.path.text, join(project, "hello.txt"));
    assert.equal(event.data.line_number, 1);
    const pi = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";
      const root = process.env.ATRIA_SEARCH_FIXTURE_PROJECT;
      const found = await createFindTool(root).execute("find-fixture", {pattern:"*.txt"});
      const searched = await createGrepTool(root).execute("grep-fixture", {pattern:"fixture",glob:"hello.txt",literal:true});
      const contextual = await createGrepTool(root).execute("grep-context", {pattern:"fixture",glob:"hello.txt",literal:true,context:1});
      console.log(JSON.stringify({found,searched,contextual}));
    `
      ],
      {
        cwd: resolve("."),
        env: { ...f.env, PI_CODING_AGENT_DIR: agent, ATRIA_SEARCH_FIXTURE_PROJECT: project },
        timeout: 10_000
      }
    );
    const tools = JSON.parse(pi.stdout);
    assert.equal(tools.found.content[0].text, "hello.txt\nnested/deep.txt");
    assert.equal(tools.searched.content[0].text, "hello.txt:1: hello fixture");
    assert.equal(
      tools.contextual.content[0].text,
      "hello.txt:1: hello fixture\nhello.txt-2- second line",
      "context rows travel through the rg adapter's --context flag"
    );
    await assert.rejects(
      exec(rg, ["--", "absent", project], { env: f.env }),
      (error) => error.code === 1 && error.stdout === ""
    );
    await assert.rejects(
      exec(fd, ["--unknown"], { env: f.env }),
      (error) => error.code === 2 && /does not support/.test(error.stderr)
    );
  }
);

test("doctor exercises offline search and reports missing or failing search modules", async (t) => {
  const f = await fixture(t);
  await f.put(
    "user/config.json",
    JSON.stringify({
      baseUrl: "https://example.invalid/v1",
      model: "fixture",
      apiKey: "fixture-key",
      workspaceRoot: join(f.root, "workspace")
    })
  );
  const healthy = await exec(process.execPath, [cli, "doctor"], { cwd: f.root, env: f.env });
  assert.match(healthy.stdout, /OK.*离线文件查找与内容搜索/);
  assert.match(healthy.stdout, /无需安装 fd 或 rg/);
  assert.match(healthy.stdout, /未发送模型请求/);
  const packageRoot = join(f.root, "broken-package");
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await writeFile(join(packageRoot, "scripts/atria.mjs"), await readFile(cli));
  await writeFile(
    join(packageRoot, "scripts/cli-information.mjs"),
    await readFile(resolve("scripts/cli-information.mjs"))
  );
  await writeFile(
    join(packageRoot, "scripts/data-home.cjs"),
    await readFile(resolve("scripts/data-home.cjs"))
  );
  await symlink(
    resolve("dist"),
    join(packageRoot, "dist"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await symlink(
    resolve("node_modules"),
    join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const brokenCli = join(packageRoot, "scripts/atria.mjs");
  await assert.rejects(
    exec(process.execPath, [brokenCli, "doctor"], { cwd: f.root, env: f.env }),
    (error) => {
      assert.match(error.stderr, /FAIL.*离线文件查找与内容搜索/);
      assert.match(error.stdout, /OK.*模型配置/);
      return true;
    }
  );
  await writeFile(
    join(packageRoot, "scripts/file-search.mjs"),
    await readFile(resolve("scripts/file-search.mjs"))
  );
  await assert.rejects(
    exec(process.execPath, [brokenCli, "doctor"], { cwd: f.root, env: f.env }),
    (error) => {
      assert.match(error.stderr, /FAIL.*离线文件查找与内容搜索.*search-tool-adapter/);
      return true;
    }
  );
  await writeFile(
    join(packageRoot, "scripts/search-tool-adapter.mjs"),
    await readFile(resolve("scripts/search-tool-adapter.mjs"))
  );
  await writeFile(
    join(packageRoot, "scripts/file-search.mjs"),
    "export async function runFileSearch() { throw new Error('fixture search failed'); }\n"
  );
  await assert.rejects(exec(process.execPath, [brokenCli, "doctor"], { cwd: f.root, env: f.env }), (error) =>
    /FAIL.*离线文件查找与内容搜索.*fixture search failed/.test(error.stderr)
  );
});
