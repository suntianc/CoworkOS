import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { launchMacApplication } from "../scripts/mac-application-launch.mjs";
import { restartDevelopment } from "../scripts/restart-development.mjs";
import { developmentExecutable, installDevelopmentApp } from "../scripts/desktop-dev.mjs";
import { startNativeApplicationMonitor } from "../scripts/native-application-monitor.mjs";
import { stopNativeBackend } from "./native-backend-fixture.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { backendExecutable } = require("../desktop/backend-executable.cjs");

test(
  "Mac launch gives the App and its helper their own permission responsibility while preserving profile and arguments",
  { skip: process.platform !== "darwin" || process.env.ATRIA_NATIVE_DESKTOP_TEST !== "1", timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "atria-launch-permissions-"));
    const bundle = join(directory, "Permission Probe.app");
    t.after(async () => {
      await run(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-u", bundle]
      ).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });
    const executable = join(bundle, "Contents/MacOS/probe");
    await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
    await writeFile(
      join(bundle, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>CFBundleExecutable</key><string>probe</string>
      <key>CFBundleIdentifier</key><string>org.atria.test.launch.${Date.now()}</string>
      <key>CFBundleName</key><string>Permission Probe</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>LSUIElement</key><true/></dict></plist>`
    );
    await run("/usr/bin/xcrun", ["swiftc", "test/fixtures/mac-launch-probe.swift", "-o", executable]);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
    const inherited = join(directory, "inherited.json");
    await run(executable, [inherited]);
    const control = JSON.parse(await readFile(inherited, "utf8"));
    assert.notEqual(
      control.responsiblePid,
      control.pid,
      "direct exec reproduces host permission inheritance"
    );
    assert.equal(control.child.responsiblePid, control.responsiblePid);
    for (const profile of ["first profile", "second profile"]) {
      const report = join(directory, `${profile}.json`);
      const data = join(directory, profile);
      const restarting = profile === "second profile";
      if (restarting) {
        const previous = {
          marker: process.env.ATRIA_LAUNCH_FIXTURE_MARKER,
          report: process.env.ATRIA_LAUNCH_FIXTURE_REPORT
        };
        try {
          process.env.ATRIA_LAUNCH_FIXTURE_MARKER = profile;
          process.env.ATRIA_LAUNCH_FIXTURE_REPORT = report;
          await restartDevelopment({
            root: directory,
            pid: control.pid,
            nodeExecutable: process.execPath,
            runtimeEnvironment: { COWORK_DESKTOP_DATA: data },
            developmentExecutableImpl: async () => executable
          });
        } finally {
          for (const [name, value] of [
            ["ATRIA_LAUNCH_FIXTURE_MARKER", previous.marker],
            ["ATRIA_LAUNCH_FIXTURE_REPORT", previous.report]
          ]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }
      } else {
        await launchMacApplication(executable, {
          args: [report, "argument with spaces", "中文"],
          cwd: directory,
          env: { ...process.env, ATRIA_LAUNCH_FIXTURE_MARKER: profile, COWORK_DESKTOP_DATA: data }
        });
      }
      let actual;
      for (let attempt = 0; attempt < 100; attempt++) {
        actual = await readFile(report, "utf8")
          .then(JSON.parse)
          .catch(() => undefined);
        if (actual) break;
        await delay(50);
      }
      assert.ok(actual, "launched App wrote its probe report");
      assert.equal(actual.responsiblePid, actual.pid, "App owns its macOS permission identity");
      assert.equal(actual.child.responsiblePid, actual.pid, "native helper belongs to the App");
      assert.equal(actual.marker, profile);
      assert.equal(actual.data, data);
      assert.deepEqual(actual.arguments, restarting ? [] : ["argument with spaces", "中文"]);
    }
  }
);

test("Mac application launch rejects entries outside an absolute App executable before launching", async () => {
  for (const executable of [
    "relative/App.app/Contents/MacOS/App",
    "/tmp/not-an-app",
    "/tmp/App.app/other/App"
  ])
    await assert.rejects(launchMacApplication(executable), /App 入口/);
});

test(
  "Mac development retains vendor identity and reuses a CoworkOS runtime with an accessory backend",
  { skip: process.platform !== "darwin" },
  async () => {
    const vendorPlist = resolve("node_modules/electron/dist/Electron.app/Contents/Info.plist");
    const original = await readFile(vendorPlist);
    const executable = await developmentExecutable();
    assert.equal(await developmentExecutable(), executable);
    assert.deepEqual(await readFile(vendorPlist), original);
    const helper = backendExecutable(executable, "darwin", resolve("."));
    const result = await run(
      helper,
      ["-e", "console.log(JSON.stringify({node:!!process.versions.node,helper:process.execPath}))"],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      }
    );
    assert.deepEqual(JSON.parse(result.stdout), { node: true, helper });
    const plist = join(executable, "../../Info.plist");
    assert.match(
      (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleDisplayName", plist])).stdout.trim(),
      /^CoworkOS Dev \([a-f0-9]{8}\)$/
    );
    for (const key of ["CFBundleName", "CFBundleExecutable"])
      assert.equal(
        (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).stdout.trim(),
        "CoworkOS Dev"
      );
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", resolve(executable, "../../..")]);
  }
);

test(
  "ad-hoc development runtimes isolate permission identities and preserve the signature in Finder copies",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "atria-dev-identities-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const prepare = async (name) => {
      const root = join(directory, name);
      await mkdir(join(root, "build"), { recursive: true });
      await mkdir(join(root, "desktop"));
      await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
      await copyFile("build/atria.icns", join(root, "build/atria.icns"));
      await copyFile("desktop/entitlements.mac.plist", join(root, "desktop/entitlements.mac.plist"));
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.1" }));
      return root;
    };
    const identity = async (executable) => {
      const bundle = resolve(executable, "../../..");
      const value = async (key) =>
        (
          await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(bundle, "Contents/Info.plist")])
        ).stdout.trim();
      const { stdout, stderr } = await run("/usr/bin/codesign", ["-d", "-r-", bundle]);
      const requirement = `${stdout}\n${stderr}`.match(/designated => (.+)/)?.[1];
      assert.ok(requirement, "real macOS designated requirement was read");
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
      return { id: await value("CFBundleIdentifier"), name: await value("CFBundleDisplayName"), requirement };
    };
    const firstRoot = await prepare("first-worktree");
    const secondRoot = await prepare("second-worktree");
    const firstEntry = await developmentExecutable({ root: firstRoot });
    const first = await identity(firstEntry);
    const second = await identity(await developmentExecutable({ root: secondRoot }));
    assert.notEqual(first.id, second.id, "two worktrees must not compete for the same TCC record");
    assert.notEqual(first.name, second.name, "the person granting access can distinguish the entries");
    assert.notEqual(first.requirement, second.requirement);
    assert.deepEqual(await identity(await developmentExecutable({ root: firstRoot })), first);
    const installed = await installDevelopmentApp({
      root: firstRoot,
      directory: join(directory, "Applications")
    });
    assert.deepEqual(await identity(installed), first, "Finder copy retains the exact signed identity");
    assert.equal(
      await installDevelopmentApp({ root: firstRoot, directory: join(directory, "Applications") }),
      installed
    );
    await writeFile(join(firstRoot, "package.json"), JSON.stringify({ version: "0.0.2" }));
    const rebuilt = await identity(await developmentExecutable({ root: firstRoot }));
    assert.notEqual(rebuilt.id, first.id, "a changed ad-hoc runtime needs its own permission record");
    assert.notEqual(rebuilt.name, first.name);
    assert.notEqual(rebuilt.requirement, first.requirement);
    assert.deepEqual(
      await identity(
        await installDevelopmentApp({ root: firstRoot, directory: join(directory, "Applications") })
      ),
      rebuilt
    );
  }
);

test(
  "Finder development entry preserves host settings and drafts across native relaunch",
  { skip: process.platform !== "darwin" || process.env.ATRIA_NATIVE_DESKTOP_TEST !== "1", timeout: 120_000 },
  async () => {
    const { _electron } = await import("@playwright/test");
    const directory = await mkdtemp(join(tmpdir(), "atria-dev-lifecycle-"));
    const executablePath = await installDevelopmentApp({ directory: join(directory, "Applications") });
    assert.equal(await installDevelopmentApp({ directory: join(directory, "Applications") }), executablePath);
    const env = {
      ...process.env,
      COWORK_DESKTOP_DATA: directory,
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      PI_OFFLINE: "1"
    };
    for (const name of [
      "ELECTRON_RUN_AS_NODE",
      "COWORK_WORKSPACE",
      "COWORK_CONFIG",
      "COWORK_API_KEY",
      "COWORK_API_BASE",
      "COWORK_MODEL"
    ])
      delete env[name];
    let desktop, monitor;
    const desktopPids = new Set();
    const launch = async () => {
      desktop = await _electron.launch({
        executablePath,
        // Temporary ad-hoc identities must not prompt for access to the real macOS keychain.
        args: ["--use-mock-keychain"],
        env
      });
      desktopPids.add(desktop.process().pid);
      await desktop.evaluate(({ dialog }) => {
        globalThis.__fixtureWarnings = [];
        dialog.showMessageBox = async (_window, options) => {
          globalThis.__fixtureWarnings.push(options.message);
          return { response: 1, checkboxChecked: false };
        };
        dialog.showErrorBox = (title) => globalThis.__fixtureWarnings.push(title);
      });
      const page = await desktop.firstWindow();
      await page.locator("#apps-nav").waitFor();
      assert.equal(
        await desktop.evaluate(({ app }) => process.env.COWORK_DESKTOP_SOURCE_ROOT || app.getAppPath()),
        resolve(".")
      );
      return page;
    };
    try {
      monitor = await startNativeApplicationMonitor(directory);
      let page = await launch();
      await page.waitForFunction(
        () => document.querySelector("[data-update-version]")?.textContent.includes("源码开发版"),
        undefined,
        { polling: 100, timeout: 15_000 }
      );
      assert.match(await page.locator("[data-update-version]").textContent(), /当前版本/);
      const modelDialog = page.getByRole("dialog", { name: "连接模型", exact: true });
      await modelDialog.waitFor({ state: "visible" });
      await modelDialog.locator('[name="baseUrl"]').fill("http://127.0.0.1:1/v1");
      await modelDialog.locator('[name="apiKey"]').fill("local-development-fixture");
      await modelDialog.locator('[name="model"]').fill("dev-fixture");
      await modelDialog.locator('[name="api"]').selectOption("openai-completions");
      await modelDialog.getByRole("button", { name: "保存连接", exact: true }).click();
      await modelDialog.waitFor({ state: "hidden" });
      await page.locator("#apps-nav").waitFor();
      await page.locator("#composer-input").fill("development relaunch draft");
      assert.deepEqual(await desktop.evaluate(() => globalThis.__fixtureWarnings), []);
      await desktop.close();
      desktop = undefined;
      page = await launch();
      await page.waitForFunction(
        async () =>
          (
            await fetch("/api/model-settings", {
              headers: window.bookmanDesktop?.transportNonce
                ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
                : {}
            })
          ).ok
      );
      const status = await page.evaluate(async () =>
        (
          await fetch("/api/model-settings", {
            headers: window.bookmanDesktop?.transportNonce
              ? { "x-cowork-desktop-nonce": window.bookmanDesktop.transportNonce }
              : {}
          })
        ).json()
      );
      assert.equal(status.configured, true);
      assert.equal(status.model, "dev-fixture");
      const applications = await monitor.snapshot();
      const own = applications.find((application) => application.pid === desktop.process().pid);
      assert.match(own?.name, /^CoworkOS Dev \([a-f0-9]{8}\)$/);
      assert.equal(own?.policy, 0);
      assert.deepEqual(
        monitor.registrations.filter(
          (application) =>
            !desktopPids.has(application.pid) && application.parents.some((pid) => desktopPids.has(pid))
        ),
        []
      );
      await page.waitForFunction(
        () => document.querySelector("#composer-input")?.value === "development relaunch draft",
        undefined,
        { polling: 100, timeout: 15_000 }
      );
      const config = await readFile(join(directory, "model-config.json"), "utf8");
      assert.equal(config.includes("local-development-fixture"), false);
    } finally {
      await desktop?.close();
      await stopNativeBackend(directory);
      await monitor?.stop();
      // Remove the Finder record before deleting the temporary app bundle.
      await run(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-u", resolve(executablePath, "../../..")]
      ).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }
);
