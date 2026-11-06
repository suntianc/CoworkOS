import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import {
  assertArchiveIntegrity,
  cliDependencies,
  cliShrinkwrap,
  productionPackages
} from "../scripts/cli-package-lock.mjs";

const parentName = "atria-packaging-fixture-parent";
const childName = "atria-packaging-fixture-child";
const nestedName = "atria-packaging-fixture-nested";

function packageLock() {
  return {
    lockfileVersion: 2,
    packages: {
      "": { name: "source-project", devDependencies: { "dev-sentinel": "1.0.0" } },
      [`node_modules/${parentName}`]: {
        version: "1.0.0",
        dependencies: { [childName]: "^1.0.0", [nestedName]: "1.0.0", esbuild: "^0.28.0" }
      },
      [`node_modules/${childName}`]: {
        version: "2.0.4",
        resolved: "https://registry.invalid/child.tgz",
        integrity: "sha512-tested-override"
      },
      "node_modules/esbuild": { version: "0.28.2" },
      [`node_modules/${parentName}/node_modules/${nestedName}`]: { version: "1.0.0" },
      "node_modules/@esbuild/fake-platform": {
        version: "0.28.2",
        optional: true,
        os: ["fixture-os"],
        cpu: ["fixture-cpu"]
      },
      "node_modules/dev-sentinel": { version: "1.0.0", dev: true },
      [`node_modules/${parentName}/node_modules/dev-sentinel`]: { version: "1.0.0", dev: true }
    }
  };
}

test("CLI lock pins tested direct/platform versions and retains only production shrinkwrap topology", () => {
  const lock = packageLock();
  const source = { dependencies: { [parentName]: "^1.0.0" } };
  const dependencies = cliDependencies(source, lock);
  assert.deepEqual(dependencies, { [parentName]: "1.0.0", esbuild: "0.28.2" });
  const manifest = {
    name: "atria-packaging-fixture-cli",
    version: "1.0.0",
    license: "MIT",
    engines: { node: ">=22.19.0" },
    bin: { "atria-packaging-fixture": "cli.cjs" },
    dependencies
  };
  const shrinkwrap = cliShrinkwrap(manifest, lock);
  assert.equal(shrinkwrap.lockfileVersion, 3);
  assert.deepEqual(shrinkwrap.packages[""], manifest);
  assert.equal(shrinkwrap.packages[`node_modules/${childName}`].version, "2.0.4");
  assert.equal(shrinkwrap.packages[`node_modules/${childName}`].integrity, "sha512-tested-override");
  assert.ok(shrinkwrap.packages["node_modules/@esbuild/fake-platform"].optional);
  assert.ok(!Object.keys(shrinkwrap.packages).some((path) => path.includes("dev-sentinel")));
  assert.deepEqual(productionPackages(lock), [
    `node_modules/${parentName}`,
    `node_modules/${childName}`,
    "node_modules/esbuild",
    `node_modules/${parentName}/node_modules/${nestedName}`
  ]);
  const withoutPlatformRuntime = structuredClone(lock);
  withoutPlatformRuntime.packages["node_modules/esbuild"].dev = true;
  assert.deepEqual(cliDependencies(source, withoutPlatformRuntime), { [parentName]: "1.0.0" });
});

test("pristine runtime archives reject corruption, missing integrity and unsupported hashes", () => {
  const bytes = Buffer.from("locked runtime archive");
  for (const algorithm of ["sha1", "sha256", "sha384", "sha512"]) {
    const integrity = `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
    assert.doesNotThrow(() => assertArchiveIntegrity(bytes, integrity));
    assert.throws(() => assertArchiveIntegrity(Buffer.from("corrupted archive"), integrity), /integrity/);
  }
  for (const integrity of [undefined, "", "md5-unsupported", "sha512-malformed"])
    assert.throws(() => assertArchiveIntegrity(bytes, integrity), /integrity/);
});

test("CLI packaging rejects unsupported locks, missing direct dependencies and unsafe/platform bundle entries", () => {
  const source = { dependencies: { [parentName]: "^1.0.0" } };
  for (const lock of [{ lockfileVersion: 1 }, { lockfileVersion: 3 }]) {
    assert.throws(() => cliDependencies(source, lock), /v2\/v3/);
    assert.throws(() => productionPackages(lock), /v2\/v3/);
    assert.throws(() => cliShrinkwrap(source, lock), /v2\/v3/);
  }
  for (const entry of [undefined, {}, { version: "1.0.0", dev: true }]) {
    const lock = packageLock();
    lock.packages[`node_modules/${parentName}`] = entry;
    assert.throws(() => cliDependencies(source, lock), /Missing production lock entry/);
    assert.throws(() => cliShrinkwrap(source, lock), /Missing production lock entry/);
  }
  for (const [path, entry] of [
    ["outside", { version: "1.0.0" }],
    ["node_modules/../private", { version: "1.0.0" }],
    ["node_modules/linked", { version: "1.0.0", link: true }],
    ["node_modules/unknown-native", { version: "1.0.0", os: ["darwin"] }],
    ["node_modules/unknown-native", { version: "1.0.0", cpu: ["arm64"] }]
  ]) {
    const lock = packageLock();
    lock.packages[path] = entry;
    assert.throws(() => productionPackages(lock), /Cannot bundle|explicit portable packaging/);
  }
});

async function npmCliPath() {
  if (process.env.npm_execpath?.endsWith(".js")) return realpath(process.env.npm_execpath);
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const candidate = await realpath(join(folder, "npm"));
      if (candidate.endsWith(".js")) return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("Packaging regression requires the repository's npm installation on PATH");
}

async function put(root, file, content) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), typeof content === "string" ? content : JSON.stringify(content));
}

test("the actual CLI packer excludes retained Mac helpers and tolerates optional source resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-content-"));
  try {
    // Copy only public source directories used by the actual packer. No build,
    // installed production dependencies, model configuration or user data.
    for (const directory of [
      "scripts",
      ".pi/extensions",
      ".pi/runtime",
      ".pi/prompts",
      ".pi/skills",
      "docs",
      "vendor/sciagentgym"
    ])
      await cp(new URL(`../${directory}/`, import.meta.url), join(root, directory), { recursive: true });
    for (const file of [
      "README.md",
      "README.zh-CN.md",
      "AGENTS.md",
      "AGENTS.en.md",
      "CLAUDE.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "CONTRIBUTING.md",
      "CONTRIBUTING.en.md",
      "config.example.json",
      "vendor/sciagentgym/LICENSE"
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await cp(new URL(`../${file}`, import.meta.url), join(root, file));
    }
    await mkdir(join(root, "desktop"), { recursive: true });
    await cp(
      new URL("../desktop/update-install.cjs", import.meta.url),
      join(root, "desktop/update-install.cjs")
    );
    await put(root, "desktop/main.cjs", "// Desktop entrypoint must not enter the CLI package.\n");
    await put(
      root,
      "docs/site/node_modules/@esbuild/darwin-arm64/bin/esbuild",
      "Host-only documentation build dependency excluded from CLI archives"
    );
    const version = "0.0.0";
    await put(root, "package.json", {
      name: "cli-source-fixture",
      version,
      dependencies: {},
      engines: { node: ">=22.19.0" },
      license: "MIT"
    });
    await put(root, "package-lock.json", {
      name: "cli-source-fixture",
      version,
      lockfileVersion: 3,
      packages: { "": { name: "cli-source-fixture", version, dependencies: {} } }
    });
    for (const file of [
      "dist/src/gui/atria-computer-use",
      "dist/src/gui/atria-computer-use.sha256",
      "dist/src/gui/atria-speech-input",
      "dist/src/gui/atria-speech-input.sha256",
      "dist/src/gui/atria-icon.png",
      "dist/src/gui/driver.js.map"
    ])
      await put(root, file, "Mac/generated sentinel excluded from portable CLI");
    for (const file of [
      "dist/cli-ui-manifest.json",
      "dist/src/gui/driver.js",
      "dist/scripts/data-home.cjs",
      "dist/web/assets/agent-names.js"
    ])
      await put(root, file, "// portable source fixture\n");
    const scienceAssets = [
      "runner.py",
      "pilot.py",
      "analysis.py",
      "astronomy.py",
      "chemistry.py",
      "materials.py",
      "mass_spectrometry.py",
      "mass-chemistry.py",
      "statistics.py",
      "environment-probe.py",
      "requirements.txt",
      "requirements-chemistry.txt"
    ];
    await mkdir(join(root, "dist", "src", "tools", "science"), { recursive: true });
    for (const name of scienceAssets)
      await cp(
        new URL(`../src/tools/science/${name}`, import.meta.url),
        join(root, "dist", "src", "tools", "science", name)
      );
    for (const name of ["npmrc", "global-npmrc"]) await put(root, name, "");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:npm_config_|COWORK_|PI_|ATRIA_|SERPER_)/i.test(key))
    );
    Object.assign(env, {
      ATRIA_PACKAGE_DIR: join(root, "archives"),
      npm_config_userconfig: join(root, "npmrc"),
      npm_config_globalconfig: join(root, "global-npmrc"),
      npm_config_cache: join(root, "npm-cache"),
      npm_config_offline: "true",
      npm_config_registry: "https://registry.invalid",
      npm_config_update_notifier: "false"
    });
    execFileSync(process.execPath, [join(root, "scripts/package-cli.mjs")], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const archive = join(root, "archives", `coworkos-cli-${version}.tgz`);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })
    );
    assert.equal(manifest.name, "atria-cowork-cli", "the renamed archive retains npm upgrade ownership");
    assert.deepEqual(manifest.bin, { coworkos: "scripts/atria.mjs", atria: "scripts/atria.mjs" });
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    assert.ok(files.includes("package/scripts/desktop.mjs"));
    assert.ok(files.includes("package/desktop/update-install.cjs"));
    assert.ok(!files.includes("package/desktop/main.cjs"));
    assert.ok(!files.some((path) => path.startsWith("package/docs/site/node_modules/")));
    const fixtureDependency = {
      version: "1.0.0",
      resolved:
        "https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/" +
        `${parentName}/-/${parentName}-1.0.0.tgz`,
      integrity: "sha512-" + createHash("sha512").update("fixture archive").digest("base64")
    };
    const sourceManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    sourceManifest.dependencies[parentName] = "1.0.0";
    const sourceLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    sourceLock.packages[""].dependencies[parentName] = "1.0.0";
    sourceLock.packages[`node_modules/${parentName}`] = fixtureDependency;
    await put(root, "package.json", sourceManifest);
    await put(root, "package-lock.json", sourceLock);
    await put(root, `node_modules/${parentName}/package.json`, {
      name: parentName,
      version: "1.0.0"
    });
    execFileSync(process.execPath, [join(root, "scripts/package-cli.mjs"), "--npm"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const npmArchive = join(root, "archives", `coworkos-app-${version}.tgz`);
    const npmFiles = execFileSync("tar", ["-tzf", npmArchive], { encoding: "utf8" }).trim().split("\n");
    assert.ok(!npmFiles.some((path) => path.startsWith("package/docs/site/node_modules/")));
    assert.ok(npmFiles.includes(`package/node_modules/${parentName}/package.json`));
    const npmJson = (member) =>
      JSON.parse(execFileSync("tar", ["-xOf", npmArchive, `package/${member}`], { encoding: "utf8" }));
    const npmManifest = npmJson("package.json");
    assert.equal(npmManifest.name, "coworkos-app");
    assert.deepEqual(npmManifest.bin, { coworkos: "scripts/atria.mjs" });
    assert.deepEqual(npmManifest.publishConfig, {
      registry: "https://registry.npmjs.org",
      access: "public",
      tag: "latest"
    });
    assert.equal(npmJson("build-info.json").distribution, "npm");
    const npmLock = npmJson("npm-shrinkwrap.json");
    assert.equal(npmLock.name, "coworkos-app");
    assert.equal(npmLock.packages[""].name, "coworkos-app");
    assert.equal(
      npmLock.packages[`node_modules/${parentName}`].resolved,
      `https://registry.npmjs.org/${parentName}/-/${parentName}-1.0.0.tgz`
    );
    assert.equal(npmLock.packages[`node_modules/${parentName}`].integrity, fixtureDependency.integrity);
    assert.equal(
      JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")).packages[
        `node_modules/${parentName}`
      ].resolved,
      fixtureDependency.resolved
    );
    for (const name of ["cad", "blender", "pptist", "presentations", "make-a-deck", "office-harness"])
      assert.ok(
        !files.some((file) => file.startsWith(`package/.pi/skills/${name}/`)),
        `CLI archive includes retired ${name}`
      );
    assert.ok(
      !files.some((file) =>
        /(?:text-editor|text-runtime-adapter|text-outline|text-document-session|application-fixture|application-contract)/.test(
          file
        )
      ),
      "CLI archive excludes editor implementations and contract fixtures"
    );
    assert.ok(files.includes("package/dist/src/gui/driver.js"));
    assert.ok(files.includes("package/vendor/sciagentgym/LICENSE"));
    assert.ok(files.includes("package/vendor/sciagentgym/NOTICE"));
    for (const name of scienceAssets) assert.ok(files.includes(`package/dist/src/tools/science/${name}`));
    for (const name of [
      "creative-design",
      "frontend-design",
      "interactive-prototype",
      "hi-fi-design",
      "wireframe",
      "charts",
      "data-report",
      "visual-exposure",
      "animated-video"
    ])
      assert.ok(files.includes(`package/.pi/skills/${name}/SKILL.md`), `CLI archive excludes ${name}`);
    for (const file of ["frontend-design/references/design.md", "charts/references/chart-design.md"])
      assert.ok(files.includes(`package/.pi/skills/${file}`), `CLI archive excludes ${file}`);

    assert.equal(
      files.some((path) => /atria-(?:speech-input|computer-use)(?:\.sha256)?$/.test(path)),
      false
    );
    assert.equal(
      files.some((path) => /\.map$|atria-icon\.png$/.test(path)),
      false
    );
    const license = "licenses/pi-0.87.1-LICENSE.txt";
    assert.equal(files.includes(`package/${license}`), false);
    const unpacked = join(root, "unpacked");
    await mkdir(unpacked);
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      unpacked,
      ...scienceAssets.map((name) => `package/dist/src/tools/science/${name}`)
    ]);
    const packagedScience = join(unpacked, "package", "dist", "src", "tools", "science");
    for (const name of scienceAssets)
      assert.deepEqual(
        await readFile(join(packagedScience, name)),
        await readFile(new URL(`../src/tools/science/${name}`, import.meta.url))
      );
    await rm(join(root, "dist"), { recursive: true });
    const runPackaged = (executable, request, noSite = true) =>
      JSON.parse(
        execFileSync(
          executable,
          ["-I", "-B", ...(noSite ? ["-S"] : []), join(packagedScience, "runner.py")],
          {
            cwd: unpacked,
            input: JSON.stringify(request),
            encoding: "utf8",
            timeout: 30_000,
            env: {
              LANG: "C.UTF-8",
              OMP_NUM_THREADS: "1",
              OPENBLAS_NUM_THREADS: "1",
              ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {})
            }
          }
        )
      );
    const generalPython = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
    const general = runPackaged(generalPython, {
      version: "atria-rdkit-chemistry-v4",
      tool: "distance_from_modulus",
      arguments: { mu: 10 }
    });
    assert.equal(general.ok, true, JSON.stringify(general));
    assert.equal(general.result, 1000);
    const materials = runPackaged(generalPython, {
      version: "sciagentgym-e9dbbea-materials-v5",
      tool: "cubic_lattice_parameter",
      arguments: { d_spacing: 2, hkl: [1, 1, 1] }
    });
    assert.equal(materials.ok, true, JSON.stringify(materials));
    assert.ok(Math.abs(materials.result - Math.sqrt(12)) < 1e-12);
    assert.equal(materials.units, "angstrom");
    const massSpectrometry = runPackaged(generalPython, {
      version: "sciagentgym-e9dbbea-mass-spec-v6",
      tool: "calculate_theoretical_isotope_pattern",
      arguments: { num_chlorine: 2 }
    });
    assert.equal(massSpectrometry.ok, true, JSON.stringify(massSpectrometry));
    assert.ok(Math.abs(massSpectrometry.result.M_plus_2_ratio - 0.6399155227032735) < 1e-12);
    for (const version of [
      "sciagentgym-e9dbbea-pilot-v1",
      "sciagentgym-e9dbbea-analysis-v2",
      "sciagentgym-e9dbbea-astronomy-v3",
      "atria-rdkit-chemistry-v4",
      "sciagentgym-e9dbbea-materials-v5"
    ]) {
      for (const tool of [
        "parse_mass_spectrum_peaks",
        "calculate_theoretical_isotope_pattern",
        "find_isotope_cluster",
        "rdkit_exact_mass_and_formula"
      ]) {
        const rejected = runPackaged(generalPython, { version, tool, arguments: {} });
        assert.equal(rejected.error.code, "unknown_tool", "archived v1-v5 reject the new mass functions");
      }
    }
    const withoutRdkit = runPackaged(generalPython, {
      version: "atria-rdkit-chemistry-v4",
      tool: "rdkit_validate_smiles",
      arguments: { smiles: "CCO" }
    });
    assert.equal(withoutRdkit.error.code, "dependency_unavailable");
    const v5WithoutRdkit = runPackaged(generalPython, {
      version: "sciagentgym-e9dbbea-materials-v5",
      tool: "rdkit_validate_smiles",
      arguments: { smiles: "CCO" }
    });
    assert.equal(v5WithoutRdkit.error.code, "dependency_unavailable");
    const v6WithoutRdkit = runPackaged(generalPython, {
      version: "sciagentgym-e9dbbea-mass-spec-v6",
      tool: "rdkit_exact_mass_and_formula",
      arguments: { smiles: "CCO" }
    });
    assert.equal(v6WithoutRdkit.error.code, "dependency_unavailable");
    for (const version of [
      "atria-rdkit-chemistry-v4",
      "sciagentgym-e9dbbea-materials-v5",
      "sciagentgym-e9dbbea-mass-spec-v6"
    ]) {
      await t.test(
        `archived ${version} runs native chemistry without source or a bundled RDKit installation`,
        { skip: !process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON },
        () => {
          const chemistry = runPackaged(
            process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON,
            {
              version,
              tool: "rdkit_molecular_descriptors",
              arguments: { smiles: "CCO" }
            },
            false
          );
          assert.equal(chemistry.ok, true, JSON.stringify(chemistry));
          assert.equal(chemistry.result.canonical_smiles, "CCO");
          assert.ok(Math.abs(chemistry.result.molecular_weight - 46.069) < 1e-9);
          assert.equal(chemistry.result.rdkit_version, "2026.09.1");
        }
      );
    }
    await t.test(
      "archived v6 executes exact molecular mass in the separate RDKit environment",
      { skip: !process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON },
      () => {
        const value = runPackaged(
          process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON,
          {
            version: "sciagentgym-e9dbbea-mass-spec-v6",
            tool: "rdkit_exact_mass_and_formula",
            arguments: { smiles: "CCO" }
          },
          false
        );
        assert.equal(value.ok, true, JSON.stringify(value));
        assert.equal(value.result.canonical_smiles, "CCO");
        assert.equal(value.result.formula, "C2H6O");
        assert.ok(Math.abs(value.result.exact_mass_da - 46.041864812) < 1e-9);
        assert.equal(value.result.rdkit_version, "2026.09.1");
        assert.equal(value.units.exact_mass_da, "Da");
      }
    );
    await rm(join(packagedScience, "mass_spectrometry.py"));
    await rm(join(packagedScience, "mass-chemistry.py"));
    const retainedMaterials = runPackaged(generalPython, {
      version: "sciagentgym-e9dbbea-mass-spec-v6",
      tool: "cubic_lattice_parameter",
      arguments: { d_spacing: 2, hkl: [1, 1, 1] }
    });
    assert.equal(retainedMaterials.ok, true, "v6 retained functions do not load either mass module");
    assert.ok(Math.abs(retainedMaterials.result - Math.sqrt(12)) < 1e-12);
    await rm(join(packagedScience, "materials.py"));
    for (const version of ["atria-rdkit-chemistry-v4", "sciagentgym-e9dbbea-materials-v5"]) {
      const retained = runPackaged(generalPython, {
        version,
        tool: "distance_from_modulus",
        arguments: { mu: 10 }
      });
      assert.equal(retained.ok, true, JSON.stringify(retained));
      assert.equal(retained.result, 1000);
    }
    await rm(join(packagedScience, "chemistry.py"));
    for (const [version, tool, args, expected] of [
      ["sciagentgym-e9dbbea-pilot-v1", "eV_to_nm", { energy_eV: 2 }, 619.9209921660013],
      ["sciagentgym-e9dbbea-analysis-v2", "bragg_law_d_spacing", { two_theta: 60 }, 1.5406],
      ["sciagentgym-e9dbbea-astronomy-v3", "distance_from_modulus", { mu: 10 }, 1000]
    ]) {
      const retained = runPackaged(generalPython, { version, tool, arguments: args });
      assert.equal(retained.ok, true, JSON.stringify(retained));
      assert.ok(Math.abs(retained.result - expected) < 1e-9);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Seed the installed npm's own HTTP cache, so this resolver test uses neither a
// user's cache/configuration nor a mock server that requires network permissions.
async function cachePackage(npmCli, cache, manifest, bytes) {
  const npmRequire = createRequire(npmCli);
  const cacache = npmRequire("cacache");
  const registry = "https://registry.invalid";
  const tarball = `${registry}/${manifest.name}/-/${manifest.name.split("/").at(-1)}-${manifest.version}.tgz`;
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const packument = {
    name: manifest.name,
    "dist-tags": { latest: manifest.version },
    versions: {
      [manifest.version]: { ...manifest, dist: { tarball, integrity } }
    }
  };
  const cachePath = join(cache, "_cacache");
  await cacache.put(cachePath, `pacote:tarball:${tarball}`, bytes, { integrity });
  const url = `${registry}/${manifest.name.replace("/", "%2f")}`;
  for (const accept of [
    "application/json",
    "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
  ]) {
    await cacache.put(cachePath, `make-fetch-happen:request-cache:${url}`, JSON.stringify(packument), {
      metadata: {
        time: Date.now(),
        url,
        reqHeaders: { accept },
        resHeaders: {
          "content-type": "application/json",
          "cache-control": "public, max-age=31536000",
          date: new Date().toUTCString()
        },
        options: { compress: true }
      }
    });
  }
  return { resolved: tarball, integrity };
}

test(
  "portable CLI archive installs an overridden bundle and exact platform fallback locally/globally offline",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atria-packaging-regression-"));
    try {
      const npmCli = await npmCliPath();
      const cache = join(root, "cache");
      const source = join(root, "source");
      const stage = join(root, "stage");
      const archive = join(root, "archive");
      await mkdir(archive, { recursive: true });
      await put(root, "npmrc", "");
      await put(root, "global-npmrc", "");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key))
      );
      const npm = (cwd, args) =>
        execFileSync(
          process.execPath,
          [
            npmCli,
            ...args,
            "--offline",
            "--no-audit",
            "--no-fund",
            "--update-notifier=false",
            "--registry=https://registry.invalid",
            `--userconfig=${join(root, "npmrc")}`,
            `--globalconfig=${join(root, "global-npmrc")}`,
            `--cache=${cache}`
          ],
          { cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
        );

      const platform = {
        name: "@esbuild/fake-platform",
        version: "0.28.2",
        main: "index.cjs",
        os: [process.platform],
        cpu: [process.arch]
      };
      await put(root, "platform-runtime/package.json", platform);
      await put(root, "platform-runtime/index.cjs", 'module.exports = "portable-runtime-0.28.2";');
      const [runtimePack] = JSON.parse(
        npm(join(root, "platform-runtime"), [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          archive
        ])
      );
      const runtimeLock = await cachePackage(
        npmCli,
        cache,
        platform,
        await readFile(join(archive, runtimePack.filename))
      );

      const lock = packageLock();
      Object.assign(lock.packages["node_modules/@esbuild/fake-platform"], runtimeLock);
      await put(source, `node_modules/${parentName}/package.json`, {
        name: parentName,
        ...lock.packages[`node_modules/${parentName}`],
        main: "index.cjs"
      });
      await put(
        source,
        `node_modules/${parentName}/index.cjs`,
        `module.exports = { child: require("${childName}/package.json").version, nested: require("${nestedName}/package.json").version };`
      );
      await put(source, `node_modules/${childName}/package.json`, {
        name: childName,
        version: "2.0.4"
      });
      await put(source, `node_modules/${parentName}/node_modules/${nestedName}/package.json`, {
        name: nestedName,
        version: "1.0.0"
      });
      for (const path of [
        "node_modules/dev-sentinel",
        `node_modules/${parentName}/node_modules/dev-sentinel`,
        "node_modules/@esbuild/fake-platform"
      ]) {
        await put(source, `${path}/package.json`, { name: path.split("/").at(-1), version: "9.9.9" });
        await put(source, `${path}/forbidden-sentinel.txt`, "must not ship");
      }
      const esbuild = {
        name: "esbuild",
        version: "0.28.2",
        main: "index.cjs",
        optionalDependencies: { [platform.name]: "0.28.2" },
        scripts: { postinstall: "node install.cjs" }
      };
      const pristineRuntime = join(root, "pristine-runtime");
      await put(pristineRuntime, "package.json", esbuild);
      await put(pristineRuntime, "index.cjs", 'module.exports = require("./downloaded.cjs");');
      await put(pristineRuntime, "bin/esbuild", "#!/usr/bin/env node\n// portable registry stub\n");
      // Model esbuild's official missing optional binary fallback: an exact npm
      // install in a temporary child project, followed by a portable runtime copy.
      await put(
        pristineRuntime,
        "install.cjs",
        [
          'const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");',
          'const dir = path.join(__dirname, "npm-install"); fs.mkdirSync(dir);',
          'fs.writeFileSync(path.join(dir, "package.json"), "{}");',
          "const env = { ...process.env, npm_config_global: undefined };",
          `cp.execFileSync(process.execPath, [${JSON.stringify(npmCli)}, "install", "--prefer-offline", "--no-audit", "--no-fund", "${platform.name}@" + require("./package.json").version], { cwd: dir, env, stdio: "pipe" });`,
          `fs.copyFileSync(path.join(dir, "node_modules", "${platform.name}", "index.cjs"), path.join(__dirname, "downloaded.cjs"));`,
          "fs.rmSync(dir, { recursive: true, force: true });"
        ].join("\n")
      );
      const [pristinePack] = JSON.parse(
        npm(pristineRuntime, ["pack", "--ignore-scripts", "--json", "--pack-destination", archive])
      );
      assertArchiveIntegrity(await readFile(join(archive, pristinePack.filename)), pristinePack.integrity);
      await put(source, "node_modules/esbuild/package.json", esbuild);
      await put(source, "node_modules/esbuild/bin/esbuild", "builder-native-sentinel");
      for (const path of productionPackages(lock)) {
        if (path === "node_modules/esbuild") continue;
        const from = join(source, path);
        await mkdir(dirname(join(stage, path)), { recursive: true });
        await cp(from, join(stage, path), {
          recursive: true,
          filter: (file) => !relative(from, file).split(sep).includes("node_modules")
        });
      }
      await mkdir(join(stage, "node_modules/esbuild"), { recursive: true });
      execFileSync("tar", [
        "-xzf",
        join(archive, pristinePack.filename),
        "--strip-components=1",
        "-C",
        join(stage, "node_modules/esbuild")
      ]);
      const dependencies = cliDependencies({ dependencies: { [parentName]: "^1.0.0" } }, lock);
      const manifest = {
        name: "atria-packaging-fixture-cli",
        version: "1.0.0",
        bin: { "atria-packaging-fixture": "cli.cjs" },
        dependencies,
        bundleDependencies: Object.keys(dependencies),
        overrides: { [childName]: "2.0.4" },
        files: ["cli.cjs", "npm-shrinkwrap.json"]
      };
      await put(stage, "package.json", manifest);
      await put(stage, "npm-shrinkwrap.json", cliShrinkwrap(manifest, lock));
      await put(
        stage,
        "cli.cjs",
        `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ...require("${parentName}"), runtime: require("esbuild") }));\n`
      );
      await chmod(join(stage, "cli.cjs"), 0o755);
      const [packed] = JSON.parse(
        npm(stage, ["pack", "--ignore-scripts", "--json", "--pack-destination", archive])
      );
      const archivePaths = packed.files.map(({ path }) => path);
      assert.ok(archivePaths.includes(`node_modules/${childName}/package.json`));
      assert.ok(archivePaths.includes(`node_modules/${parentName}/node_modules/${nestedName}/package.json`));
      assert.ok(archivePaths.includes("npm-shrinkwrap.json"));
      assert.ok(!archivePaths.some((path) => /dev-sentinel|forbidden-sentinel|@esbuild/.test(path)));
      assert.ok(archivePaths.includes("node_modules/esbuild/install.cjs"));
      assert.ok(!archivePaths.includes("node_modules/esbuild/downloaded.cjs"));
      assert.ok(packed.bundled.includes("esbuild"));
      const tarball = join(archive, packed.filename);

      for (const mode of ["local", "global"]) {
        const consumer = join(root, mode);
        await put(consumer, "package.json", { name: `fixture-${mode}-consumer`, version: "1.0.0" });
        const prefix = join(root, "prefix");
        npm(consumer, ["install", tarball, ...(mode === "global" ? ["--global", "--prefix", prefix] : [])]);
        const installed =
          mode === "local"
            ? join(consumer, "node_modules", manifest.name)
            : join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", manifest.name);
        const launcher =
          mode === "local"
            ? join(consumer, "node_modules/.bin/atria-packaging-fixture")
            : join(
                prefix,
                process.platform === "win32" ? "atria-packaging-fixture" : "bin/atria-packaging-fixture"
              );
        await access(launcher);
        const output = execFileSync(
          process.platform === "win32" ? process.execPath : launcher,
          process.platform === "win32" ? [join(installed, "cli.cjs")] : [],
          {
            cwd: consumer,
            env,
            encoding: "utf8"
          }
        );
        assert.deepEqual(
          JSON.parse(output),
          { child: "2.0.4", nested: "1.0.0", runtime: "portable-runtime-0.28.2" },
          mode
        );
        assert.match(
          await readFile(join(installed, "node_modules/esbuild/bin/esbuild"), "utf8"),
          /^#!\/usr\/bin\/env node\n\/\/ portable registry stub/
        );
        await assert.rejects(access(join(installed, "node_modules/dev-sentinel")), { code: "ENOENT" });
        await assert.rejects(
          access(join(installed, `node_modules/${parentName}/node_modules/dev-sentinel`)),
          { code: "ENOENT" }
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
