import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  access,
  readFile,
  copyFile,
  symlink,
  realpath,
  rename
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocumentation, markdownAnchors } from "../scripts/check-docs.mjs";
import { cleanCompiled } from "../scripts/clean-compiled.mjs";
import { verify, verificationScripts, fullVerificationScripts } from "../scripts/verify.mjs";

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "atria-repository-check-"));
  const put = async (file, text = "") => {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  };
  try {
    await callback(root, put);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("docs gate resolves inline/reference links, unicode/duplicate anchors and excludes code/network", async () => {
  await fixture(async (root, put) => {
    await put("docs/target file.md", '# 配置与安装\n# Repeated\n# Repeated\n<a id="custom"></a>\n');
    await put(
      "docs/source.md",
      [
        "[Unicode](<target file.md#配置与安装>)",
        "[Second](target%20file.md#repeated-1)",
        "[Custom][target]",
        "[target]: <target file.md#custom>",
        "[External](https://example.invalid/dead)",
        "`[Example](missing.md)`",
        "```md",
        "[Example](missing.md)",
        "```"
      ].join("\n")
    );
    const result = await checkDocumentation(root, ["docs/source.md"]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.checkedLinks, 4);
    assert.ok(markdownAnchors("# A `code` heading\n").has("a-code-heading"));
  });
});

test("docs gate fails missing files/anchors, escaped paths, malformed encoding and unresolved references", async () => {
  await fixture(async (root, put) => {
    await put("docs/target.md", "# Present\n");
    await put(
      "docs/source.md",
      [
        "[Missing](missing.md)",
        "[Anchor](target.md#missing)",
        "[Outside](../../outside.md)",
        "[Encoding](bad%ZZ.md)",
        "[Reference][missing]"
      ].join("\n")
    );
    const result = await checkDocumentation(root, ["docs/source.md", "docs/absent.md"]);
    assert.equal(result.errors.length, 6);
    for (const reason of [
      "missing local target",
      "missing Markdown anchor",
      "escapes repository",
      "malformed URL encoding",
      "undefined reference",
      "cannot read"
    ])
      assert.ok(
        result.errors.some((error) => error.includes(reason)),
        reason
      );
  });
});

test("compiler cleanup removes moved source emissions and preserves native, Python and live outputs", async () => {
  await fixture(async (root, put) => {
    for (const extension of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
      await put(`dist/src/cli/moved${extension}`);
      await put(`dist/src/runtime/live${extension}`);
    }
    await put("src/runtime/live.ts");
    await put("dist/src/gui/atria-computer-use", "native");
    await put("dist/src/desktop/atria-icon.png", "image");
    await put("dist/src/software/blender/runner.py", "python");
    await put("dist/unrelated/custom.js", "outside compiler roots");
    const removed = await cleanCompiled(root);
    assert.equal(removed.length, 4);
    assert.ok(removed.every((file) => file.startsWith("dist/src/cli/moved")));
    for (const file of [
      "dist/src/runtime/live.js",
      "dist/src/gui/atria-computer-use",
      "dist/src/desktop/atria-icon.png",
      "dist/src/software/blender/runner.py",
      "dist/unrelated/custom.js"
    ])
      await access(join(root, file));
    assert.deepEqual(await cleanCompiled(root), []);
  });
});

test("formatter excludes retained staged deletions locally and against a commit base while checking live sources", async () => {
  await fixture(async (root, put) => {
    await put("empty-gitconfig");
    await mkdir(join(root, "empty-hooks"));
    await mkdir(join(root, "empty-template"));
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|^FORMAT_BASE$/.test(key))),
      GIT_CONFIG_GLOBAL: join(root, "empty-gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Formatter Fixture",
      GIT_AUTHOR_EMAIL: "formatter-fixture@example.invalid",
      GIT_COMMITTER_NAME: "Formatter Fixture",
      GIT_COMMITTER_EMAIL: "formatter-fixture@example.invalid",
      FORMAT_SELECTION_FILE: join(root, ".tmp/selection.json")
    };
    const git = (args) =>
      execFileSync(
        "git",
        ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, "-c", "commit.gpgsign=false", ...args],
        { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim();
    const retired = {
      "build/retired.js": "retained old preview sentinel\n",
      ".openai/hosting.json": "retained local hosting sentinel\n"
    };
    for (const [file, content] of Object.entries(retired)) await put(file, content);
    await put("src/live.js", "const live = 0;\n");
    git(["init", `--template=${join(root, "empty-template")}`]);
    git(["add", "build/retired.js", ".openai/hosting.json", "src/live.js"]);
    git(["commit", "-m", "Fixture sources"]);
    const base = git(["rev-parse", "HEAD"]);
    await put(".gitignore", "build/\n.openai/\nnode_modules/\n.tmp/\nempty-*\n");
    git(["rm", "--cached", "build/retired.js", ".openai/hosting.json"]);
    await put("src/live.js", "const live = 1;\n");
    await put("src/new.mjs", "export const newSource = true;\n");
    await put(
      "node_modules/prettier/bin/prettier.cjs",
      'const fs = require("node:fs"); fs.mkdirSync(require("node:path").dirname(process.env.FORMAT_SELECTION_FILE), { recursive: true }); fs.writeFileSync(process.env.FORMAT_SELECTION_FILE, JSON.stringify(process.argv.slice(2)));\n'
    );
    const format = async (extra = {}) => {
      await rm(env.FORMAT_SELECTION_FILE, { force: true });
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../scripts/format.mjs", import.meta.url)), "--write"],
        { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] }
      );
      const selected = JSON.parse(await readFile(env.FORMAT_SELECTION_FILE, "utf8"));
      assert.equal(selected[0], "--write");
      assert.deepEqual(selected.slice(1).sort(), ["src/live.js", "src/new.mjs"]);
      for (const [file, content] of Object.entries(retired))
        assert.equal(await readFile(join(root, file), "utf8"), content);
    };
    await format();
    git(["add", ".gitignore", "src/live.js", "src/new.mjs"]);
    git(["commit", "-m", "Retire preview and change sources"]);
    await format({ FORMAT_BASE: base });
  });
});

test("quick verify prepares real web assets from a clean checkout", async () => {
  await fixture(async (root, put) => {
    for (const name of [
      "verify.mjs",
      "test.mjs",
      "test-run-root.mjs",
      "build-math.mjs",
      "build-document-markdown.mjs"
    ]) {
      await mkdir(join(root, "scripts"), { recursive: true });
      await copyFile(
        fileURLToPath(new URL("../scripts/" + name, import.meta.url)),
        join(root, "scripts", name)
      );
    }
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const actual = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const noop = 'node -e "process.exit(0)"';
    const scripts = Object.fromEntries(
      [
        "build:cli",
        "lint",
        "check:workbench",
        "check:extensions",
        "format:check",
        "check:docs",
        "check:source"
      ].map((name) => [name, noop])
    );
    if (actual.scripts["build:web-assets"]) scripts["build:web-assets"] = actual.scripts["build:web-assets"];
    await put("package.json", JSON.stringify({ type: "module", scripts }));
    await assert.rejects(access(join(root, "web/assets/math/generated/katex.js")), { code: "ENOENT" });
    const realRoot = await realpath(root);
    execFileSync(process.execPath, [join(realRoot, "scripts/verify.mjs")], {
      cwd: realRoot,
      env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
      stdio: ["ignore", "pipe", "pipe"]
    });
    for (const path of [
      "web/assets/math/generated/katex.js",
      "web/assets/math/generated/katex.min.css",
      "web/assets/math/generated/LICENSE.txt",
      "web/assets/math/generated/fonts/KaTeX_Main-Regular.woff2",
      "web/assets/mermaid/generated/mermaid.min.js",
      "web/assets/mermaid/generated/LICENSE.txt",
      "web/assets/markdown/generated/dependencies.js"
    ])
      assert.ok((await readFile(join(root, path))).length > 0, path);
    await rename(join(root, "node_modules"), join(root, "node_modules-disabled"));
    const missing = spawnSync(process.execPath, [join(realRoot, "scripts/verify.mjs")], {
      cwd: realRoot,
      env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
      encoding: "utf8"
    });
    assert.notEqual(missing.status, 0, "missing web asset dependencies must fail verification");
    assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.doesNotMatch(missing.stdout, /Verify: npm run lint/);
  });
});

test("verify defaults to CLI and web asset builds with static checks, without the full regression", async () => {
  const calls = [];
  assert.equal(
    await verify([], async (_command, args) => {
      calls.push(args);
      return 0;
    }),
    0
  );
  assert.deepEqual(
    calls.map((args) => args[1]),
    verificationScripts
  );
  assert.equal(calls.filter((args) => args[1] === "build:cli").length, 1);
  assert.equal(calls.filter((args) => args[1] === "build:web-assets").length, 1);
  assert.ok(calls.every((args) => args[0] === "run"));
  assert.ok(!calls.some((args) => args[1] === "build:full" || args[1] === "test:release:runner"));
});

test("verify --full builds all assets once and retains runner and Node regression checks", async () => {
  const calls = [];
  assert.equal(
    await verify(["--full"], async (_command, args) => {
      calls.push(args);
      return 0;
    }),
    0
  );
  assert.deepEqual(
    calls.slice(0, -1).map((args) => args[1]),
    fullVerificationScripts
  );
  assert.equal(calls.filter((args) => args[1] === "build:full").length, 1);
  assert.equal(calls.filter((args) => args[1] === "build:web-assets").length, 0);
  assert.equal(calls.filter((args) => args[1] === "test:release:runner").length, 1);
  assert.deepEqual(calls.at(-1), ["scripts/test.mjs"]);
});

test("both verification modes stop on the first nonzero check", async () => {
  for (const mode of [[], ["--full"]]) {
    const stopped = [];
    assert.equal(
      await verify(mode, async (_command, args) => {
        stopped.push(args);
        return args[1] === "lint" ? 7 : 0;
      }),
      7
    );
    assert.deepEqual(
      stopped.map((args) => args[1]),
      mode.length ? ["build:full", "lint"] : ["build:cli", "build:web-assets", "lint"]
    );
  }
  await assert.rejects(() => verify(["--skip-build"]), /accepts --full, --list or --help/);
});

test("verify --list plans either mode without executing a child process", async () => {
  for (const mode of [["--list"], ["--full", "--list"]])
    assert.equal(
      await verify(mode, async () => {
        throw new Error("must not execute");
      }),
      0
    );
});
