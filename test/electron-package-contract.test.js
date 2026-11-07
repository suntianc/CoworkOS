import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createApplicationUpdateHost } = require("../desktop/update-host.cjs");

test("installed application requires a manual local upgrade without contacting an updater", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-package-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "CoworkOS.app", "Contents", "Resources", "app");
  const userData = join(root, "data");
  await mkdir(appRoot, { recursive: true });
  await mkdir(userData);
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ version: "0.1.3" }));
  await writeFile(join(userData, "model-config.json"), "retained settings");
  let contacts = 0;
  const host = await createApplicationUpdateHost({
    profile: { development: false, appRoot },
    userData,
    createUpdates() {
      contacts++;
      throw new Error("unexpected remote update");
    },
    isSigned() {
      contacts++;
      throw new Error("unexpected signature probe");
    }
  });
  assert.equal(host.status().currentVersion, "0.1.3");
  assert.equal(host.status().installMethod, "manual");
  assert.equal((await host.check({})).installMethod, "manual");
  await assert.rejects(host.check({ url: "https://invalid.example" }), /不接受配置参数/);
  await assert.rejects(host.apply(), /本地安装包/);
  assert.equal(host.status().phase, "manual");
  assert.equal(contacts, 0);
  assert.equal(await readFile(join(userData, "model-config.json"), "utf8"), "retained settings");
  await host.dispose();
});

test("upgrading an installed app retains backed up user files and rejects incompatible data until restored", async (t) => {
  const { cp } = await import("node:fs/promises");
  const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
  const root = await mkdtemp(join(tmpdir(), "cowork-package-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "user-data");
  const backup = join(root, "backup");
  const oldApp = join(root, "old", "CoworkOS.app", "Contents", "Resources", "app");
  const newApp = join(root, "new", "CoworkOS.app", "Contents", "Resources", "app");
  await mkdir(join(home, "workspace", "task"), { recursive: true });
  await mkdir(oldApp, { recursive: true });
  await mkdir(newApp, { recursive: true });
  await writeFile(join(home, "workspace", "task", "report.txt"), "retained task result");
  await writeFile(join(home, "model-config.json"), '{"model":"fixture"}');
  await writeFile(
    join(home, "data-version.json"),
    JSON.stringify({ formatVersion: 1, createdWith: "0.1.0", lastOpenedWith: "0.1.0" })
  );
  await writeFile(join(oldApp, "package.json"), "old app");
  await writeFile(join(newApp, "package.json"), "new app");
  await cp(home, backup, { recursive: true });
  const paths = desktopPaths(newApp, home, {});
  await prepareDesktopData(paths, "0.1.3");
  assert.deepEqual(JSON.parse(await readFile(join(home, "data-version.json"), "utf8")), {
    formatVersion: 1,
    createdWith: "0.1.0",
    lastOpenedWith: "0.1.3"
  });
  for (const file of ["workspace/task/report.txt", "model-config.json"]) {
    assert.equal(await readFile(join(home, file), "utf8"), await readFile(join(backup, file), "utf8"));
  }
  assert.equal(await readFile(join(oldApp, "package.json"), "utf8"), "old app");
  assert.equal(await readFile(join(newApp, "package.json"), "utf8"), "new app");

  await writeFile(join(home, "data-version.json"), '{"formatVersion":99}');
  await assert.rejects(prepareDesktopData(paths, "0.1.3"), /不兼容/);
  assert.equal(await readFile(join(home, "workspace", "task", "report.txt"), "utf8"), "retained task result");
  await cp(join(backup, "data-version.json"), join(home, "data-version.json"));
  await prepareDesktopData(paths, "0.1.3");
  assert.equal(JSON.parse(await readFile(join(home, "data-version.json"), "utf8")).lastOpenedWith, "0.1.3");
});

test("legacy data migration preserves the source after a failed attempt and a successful retry", async (t) => {
  const { migrateLegacyDesktopData } = require("../scripts/data-migration.cjs");
  const root = await mkdtemp(join(tmpdir(), "cowork-package-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "legacy");
  const home = join(root, "new-data");
  await mkdir(join(source, "workspace", "task"), { recursive: true });
  await mkdir(join(source, "runtime"));
  await writeFile(join(source, "workspace", "task", "result.txt"), "original result");
  await writeFile(join(source, "model-config.json"), '{"model":"legacy"}');
  const catalog = join(source, "runtime", "workspaces.json");
  await writeFile(catalog, '{"version":99}');
  await assert.rejects(migrateLegacyDesktopData({ source, home }), /不兼容/);
  assert.equal(await readFile(join(source, "workspace", "task", "result.txt"), "utf8"), "original result");
  await writeFile(catalog, '{"version":1,"workspaces":[]}');
  assert.equal((await migrateLegacyDesktopData({ source, home })).status, "migrated");
  assert.equal(await readFile(join(home, "workspace", "task", "result.txt"), "utf8"), "original result");
  assert.equal(await readFile(join(home, "model-config.json"), "utf8"), '{"model":"legacy"}');
  assert.equal(await readFile(join(source, "workspace", "task", "result.txt"), "utf8"), "original result");
  assert.equal((await migrateLegacyDesktopData({ source, home })).status, "completed");
});

test("packaged backend selects the accessory runtime and refuses a missing helper until restored", async (t) => {
  const { chmod, unlink } = await import("node:fs/promises");
  const { backendExecutable } = require("../desktop/backend-executable.cjs");
  const root = await mkdtemp(join(tmpdir(), "cowork-package-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, "CoworkOS.app", "Contents");
  const executable = join(contents, "MacOS", "CoworkOS");
  const appRoot = join(contents, "Resources", "app");
  const helperContents = join(contents, "Frameworks", "CoworkOS Helper.app", "Contents");
  const helper = join(helperContents, "MacOS", "CoworkOS Helper");
  await mkdir(join(helperContents, "MacOS"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(helperContents, "Info.plist"), "<plist><key>LSUIElement</key><true/></plist>");
  await writeFile(helper, "fixture executable");
  await chmod(helper, 0o700);
  assert.equal(backendExecutable(executable, "darwin", appRoot), helper);
  await unlink(helper);
  assert.throws(() => backendExecutable(executable, "darwin", appRoot), /后台运行时/);
  await writeFile(helper, "restored fixture executable");
  await chmod(helper, 0o700);
  assert.equal(backendExecutable(executable, "darwin", appRoot), helper);
});
