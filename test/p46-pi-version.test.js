import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PI_PACKAGES = ["pi-coding-agent", "pi-ai", "pi-agent-core"];
const packagePath = new URL("../package.json", import.meta.url);
const lockPath = new URL("../package-lock.json", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("the three Pi packages resolve to the same reviewed 1.5.x release", async () => {
  const packageJson = await readJson(packagePath);
  const versions = PI_PACKAGES.map((name) => packageJson.dependencies[`@earendil-works/${name}`]);
  assert.deepEqual(new Set(versions).size, 1, `pinned versions differ: ${JSON.stringify(versions)}`);
  const [version] = versions;
  assert.match(version, /^1\.5\.\d+$/, "the upgrade targets the reviewed 1.5.x line");
  for (const name of PI_PACKAGES) {
    const metadata = await readJson(
      new URL(`../node_modules/@earendil-works/${name}/package.json`, import.meta.url)
    );
    assert.equal(metadata.version, version, `${name} installed ${metadata.version}, pinned ${version}`);
  }
});

test("package-lock.json pins the same release for the root entry and every Pi dependency", async () => {
  const lock = await readJson(lockPath);
  const packageJson = await readJson(packagePath);
  const version = packageJson.dependencies["@earendil-works/pi-coding-agent"];
  for (const name of PI_PACKAGES) {
    const specifier = `@earendil-works/${name}`;
    assert.equal(lock.packages[""].dependencies[specifier], version, `root lock entry for ${specifier}`);
    assert.equal(
      lock.packages[`node_modules/${specifier}`]?.version,
      version,
      `locked version for ${specifier}`
    );
  }
  // Pi's own packages depend on each other; a stale nested copy would load two
  // SDK runtimes in one process.
  for (const [path, entry] of Object.entries(lock.packages)) {
    for (const name of PI_PACKAGES) {
      const specifier = `@earendil-works/${name}`;
      const required = entry.dependencies?.[specifier];
      if (required === undefined) continue;
      assert.equal(required, version, `${path} requires ${specifier}@${required}`);
    }
  }
  const nested = Object.keys(lock.packages).filter((path) =>
    PI_PACKAGES.some((name) => path.endsWith(`node_modules/@earendil-works/${name}`))
  );
  for (const path of nested) assert.equal(lock.packages[path].version, version, `nested copy at ${path}`);
});

test("the runtime resolves the locked Pi packages from this checkout", async () => {
  const packageJson = await readJson(packagePath);
  const version = packageJson.dependencies["@earendil-works/pi-coding-agent"];
  for (const name of PI_PACKAGES) {
    const resolved = import.meta.resolve(`@earendil-works/${name}`);
    const marker = `/node_modules/@earendil-works/${name}/`;
    const index = resolved.indexOf(marker);
    assert.ok(index > 0, `${name} resolved outside node_modules: ${resolved}`);
    const root = fileURLToPath(`${resolved.slice(0, index + marker.length)}package.json`);
    assert.equal((await readJson(new URL(`file://${root}`))).version, version, `${name} at ${root}`);
  }
});
