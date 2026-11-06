import { execFileSync } from "node:child_process";
import { access, mkdtemp, cp, mkdir, readFile, writeFile, rm, chmod, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  cliDependencies,
  cliShrinkwrap,
  productionPackages,
  assertArchiveIntegrity
} from "./cli-package-lock.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || arguments_.some((argument) => argument !== "--npm"))
  throw new Error("Usage: node scripts/package-cli.mjs [--npm]");
const npmDistribution = arguments_.includes("--npm");
const stage = await mkdtemp(join(tmpdir(), "atria-cli-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const optionalSourceFiles = new Set(["licenses", "ROADMAP.md", "ROADMAP.en.md"]);
try {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const dependencies = cliDependencies(pkg, lock);
  const files = [
    "dist/src",
    "dist/cli-ui-manifest.json",
    "dist/scripts/data-home.cjs",
    "dist/web/assets/agent-names.js",
    ".pi/extensions",
    ".pi/runtime",
    ".pi/prompts",
    ".pi/skills",
    "scripts/atria.mjs",
    "scripts/science.mjs",
    "scripts/data-home.cjs",
    "scripts/data-migration.cjs",
    "scripts/file-search.mjs",
    "scripts/file-search.d.mts",
    "scripts/search-tool-adapter.mjs",
    "scripts/cli-branding.mjs",
    "scripts/cli-information.mjs",
    "scripts/cli-startup-error.mjs",
    "scripts/cli-ui-compatibility.mjs",
    "scripts/cli-ui-policy.json",
    "scripts/cli-ui-boot.mjs",
    "scripts/cli-shell-policy.json",
    "scripts/cli-shell-compatibility.mjs",
    "scripts/cli-shell-boot.mjs",
    "scripts/cli-session.mjs",
    "scripts/cli-session-export.mjs",
    "scripts/cli-session.d.mts",
    "scripts/cli-session-picker.mjs",
    "scripts/update.mjs",
    "scripts/update-source.mjs",
    "scripts/update-release.mjs",
    "scripts/update-npm-desktop.mjs",
    "scripts/desktop.mjs",
    "desktop/update-install.cjs",
    "scripts/start-pi.mjs",
    "scripts/start-pi-runtime.mjs",
    "scripts/cli-runtime-host.mjs",
    "scripts/main-session.mjs",
    "scripts/main-worker.mjs",
    "scripts/read-attachment.py",
    "README.md",
    "README.zh-CN.md",
    "AGENTS.md",
    "AGENTS.en.md",
    "CLAUDE.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses",
    "vendor/sciagentgym",
    "docs",
    "ROADMAP.md",
    "ROADMAP.en.md",
    "CONTRIBUTING.md",
    "CONTRIBUTING.en.md",
    "config.example.json"
  ];
  for (const file of files) {
    try {
      await access(file);
    } catch (error) {
      if (error.code === "ENOENT" && optionalSourceFiles.has(file)) continue;
      throw error;
    }
    await mkdir(join(stage, file, ".."), { recursive: true });
    await cp(file, join(stage, file), {
      recursive: true,
      filter: (path) =>
        !relative(process.cwd(), path).split(sep).includes("node_modules") &&
        !path.endsWith(".map") &&
        !path.endsWith(".DS_Store") &&
        !path.endsWith("atria-computer-use") &&
        !path.endsWith("atria-computer-use.sha256") &&
        !path.endsWith("atria-speech-input") &&
        !path.endsWith("atria-speech-input.sha256") &&
        !path.endsWith("atria-icon.png")
    });
  }
  await chmod(join(stage, "scripts/atria.mjs"), 0o755);
  // Local tgz consumers do not consistently honor registry shrinkwrap metadata.
  // Bundle the portable tested tree. esbuild's pristine JS installer downloads
  // its exact, hash-checked native runtime for the consumer's OS/CPU.
  // Nested production packages are copied from their own lock entries.
  for (const path of productionPackages(lock)) {
    const source = resolve(path);
    await mkdir(join(stage, path, ".."), { recursive: true });
    if (path === "node_modules/esbuild") {
      // npm postinstall replaces bin/esbuild with the build host's binary. Never
      // distribute that mutated directory: recover the original locked archive.
      const entry = lock.packages[path];
      const [runtime] = JSON.parse(
        execFileSync(
          npm,
          [
            "pack",
            `esbuild@${entry.version}`,
            "--json",
            "--ignore-scripts",
            "--prefer-offline",
            "--pack-destination",
            stage
          ],
          { cwd: stage, encoding: "utf8", maxBuffer: 1024 * 1024 }
        )
      );
      const archive = join(stage, runtime.filename);
      assertArchiveIntegrity(await readFile(archive), entry.integrity);
      await mkdir(join(stage, path), { recursive: true });
      execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", join(stage, path)]);
      await rm(archive);
      continue;
    }
    await cp(source, join(stage, path), {
      recursive: true,
      filter: (file) => !relative(source, file).split(sep).includes("node_modules")
    });
  }
  const manifest = {
    // Keep npm ownership of the legacy global bin while exposing the new command.
    name: npmDistribution ? "coworkos-app" : "atria-cowork-cli",
    version: pkg.version,
    type: "module",
    description: "CoworkOS local multi-agent CLI harness",
    license: "MIT",
    repository: pkg.repository,
    bugs: pkg.bugs,
    homepage: pkg.homepage,
    engines: pkg.engines,
    bin: {
      coworkos: "scripts/atria.mjs",
      ...(!npmDistribution ? { atria: "scripts/atria.mjs" } : {})
    },
    ...(npmDistribution
      ? {
          publishConfig: {
            registry: "https://registry.npmjs.org",
            access: "public",
            tag: pkg.version.split("+")[0].includes("-") ? "beta" : "latest"
          }
        }
      : {}),
    dependencies,
    overrides: pkg.overrides,
    bundleDependencies: Object.keys(dependencies),
    files: [
      "dist",
      ".pi",
      "scripts",
      "desktop/update-install.cjs",
      "docs",
      "README.md",
      "README.zh-CN.md",
      "AGENTS.md",
      "AGENTS.en.md",
      "CLAUDE.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "licenses",
      "vendor/sciagentgym",
      "config.example.json",
      "npm-shrinkwrap.json",
      "build-info.json",
      "ROADMAP.md",
      "ROADMAP.en.md",
      "CONTRIBUTING.md",
      "CONTRIBUTING.en.md"
    ]
  };
  await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const shrinkwrap = cliShrinkwrap(manifest, lock);
  if (npmDistribution) {
    // Consumer installs must not depend on the build machine's registry mirror.
    // Keep the locked version and integrity while replacing only known mirror URLs.
    for (const entry of Object.values(shrinkwrap.packages)) {
      if (typeof entry.resolved !== "string") continue;
      const mirror = /^https:\/\/ms-feed-[^/]+\.pkgs\.visualstudio\.com\/[^?#]+\/npm\/registry\/(.+)$/.exec(
        entry.resolved
      );
      const proxy = /^https:\/\/packagefeedproxy\.microsoft\.io\/npm\/(.+)$/.exec(entry.resolved);
      if (mirror || proxy) entry.resolved = `https://registry.npmjs.org/${(mirror || proxy)[1]}`;
    }
  }
  await writeFile(join(stage, "npm-shrinkwrap.json"), JSON.stringify(shrinkwrap, null, 2) + "\n");
  let commit = "unknown",
    dirty = true;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
  } catch {
    /* Archives may not contain Git metadata. */
  }
  await writeFile(
    join(stage, "build-info.json"),
    JSON.stringify(
      {
        version: pkg.version,
        commit,
        dirty,
        distribution: npmDistribution ? "npm" : "release",
        builtAt: new Date().toISOString()
      },
      null,
      2
    )
  );
  const destination = resolve(process.env.ATRIA_PACKAGE_DIR ?? "release");
  await mkdir(destination, { recursive: true });
  const [result] = JSON.parse(
    execFileSync(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
      cwd: stage,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    })
  );
  if (
    result.files.some(
      ({ path }) =>
        /^(\.cowork|\.tools|desktop|task-[^/]+)\//.test(path) && path !== "desktop/update-install.cjs"
    )
  )
    throw new Error("CLI 包中发现禁止分发的目录");
  const filename = `${npmDistribution ? "coworkos-app" : "coworkos-cli"}-${pkg.version}.tgz`;
  const path = join(destination, filename);
  await rename(join(destination, result.filename), path);
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  await writeFile(`${path}.sha256`, `${digest}  ${filename}\n`);
  console.log(
    `CLI package ready: ${path}\nSource commit: ${commit}${dirty ? " (working tree has changes; verify before distributing)" : ""}`
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
