import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, realpath, stat, copyFile, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";

const require = createRequire(import.meta.url);
const config = require("../electron-builder.config.cjs");
const source = resolve(".");
const exec = promisify(execFile);

async function stageRuntimeFiles(files, stage) {
  const filter = new FileMatcher(source, stage, (pattern) => pattern, config.files).createFilter();
  const queue = files.map((file) => join(source, file));
  const included = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (included.has(file)) continue;
    const metadata = await stat(file);
    assert.equal(
      filter(file, metadata),
      true,
      `Desktop package excludes runtime dependency: ${relative(source, file)}`
    );
    included.add(file);
    const target = join(stage, relative(source, file));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    queue.push(...localImports(file, await readFile(file, "utf8")));
  }
  const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await writeFile(join(stage, "package.json"), JSON.stringify({ ...metadata, ...config.extraMetadata }));
  return included;
}

function localImports(file, code) {
  const parsed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const modules = new Set();
  const visit = (node) => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith("."))
      modules.add(resolve(dirname(file), specifier.text));
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return modules;
}

test("desktop file selection includes the complete Pi runtime import closure and loads it outside the checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-desktop-runtime-package-"));
  const stage = join(root, "app");
  await mkdir(stage);
  t.after(() => rm(root, { recursive: true, force: true }));
  const included = await stageRuntimeFiles(
    ["scripts/start-pi.mjs", "scripts/main-worker.mjs", ".pi/extensions/cowork.ts"],
    stage
  );
  assert.ok(included.size > 20, "the test must traverse real extension and compiled runtime consumers");
  // Installed production dependencies are shared; all CoworkOS modules are copied
  // exclusively from electron-builder's file selection into an external stage.
  await symlink(
    join(source, "node_modules"),
    join(stage, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_)/.test(name))
  );
  const probe = `
    import {createRequire} from 'node:module';
    import {pathToFileURL} from 'node:url';
    await import('./scripts/cli-session.mjs');
    await import('./scripts/cli-session-picker.mjs');
    await import('./scripts/cli-branding.mjs');
    await import('./scripts/search-tool-adapter.mjs');
    const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const {createJiti} = require('jiti');
    const entry = ${JSON.stringify(join(stage, ".pi/extensions/cowork.ts"))};
    const jiti = createJiti(pathToFileURL(entry).href, {interopDefault:true});
    await jiti.import(entry, {default:true});
    console.log('desktop-runtime-closure-loaded');
  `;
  const result = await exec(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: stage,
    env: { ...env, PI_CODING_AGENT_DIR: join(root, "pi"), PI_OFFLINE: "1" },
    timeout: 15000
  });
  assert.match(result.stdout, /desktop-runtime-closure-loaded/);
});
