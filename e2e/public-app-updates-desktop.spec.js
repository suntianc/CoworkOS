import { test, expect, _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { desktopSmokeEnvironment, prepareDesktopSmokeComponents } from "../scripts/desktop-smoke-env.mjs";
import {
  PUBLIC_RELEASE_REPOSITORY,
  PUBLIC_UPDATE_FEED_URL,
  publicReleaseArtifactNames,
  releaseAssetUrl,
  validatePublicReleaseFeed
} from "../scripts/update-release.mjs";

const execute = promisify(execFile);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const executable = (app) => join(app, "Contents/MacOS/CoworkOS");
const manifestPath = (app) => join(app, "Contents/Resources/app/package.json");
const hash = (body) => createHash("sha256").update(body).digest("hex");

async function fixtureCandidate(source, root, version) {
  const folder = join(root, "image");
  await mkdir(folder);
  const app = join(folder, "CoworkOS.app");
  await execute("/usr/bin/ditto", [source, app]);
  const manifest = await readJson(manifestPath(app));
  await writeFile(manifestPath(app), JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  const plist = join(app, "Contents/Info.plist");
  for (const key of ["CFBundleVersion", "CFBundleShortVersionString"])
    await execute("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${version}`, plist]);
  // Only the disposable candidate's version resources change. Nested framework signatures stay intact.
  await execute("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--entitlements",
    resolve("desktop/entitlements.mac.plist"),
    app
  ]);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const archive = join(root, `CoworkOS-${version}-mac-arm64.dmg`);
  await execute(
    "/usr/bin/hdiutil",
    [
      "create",
      "-volname",
      "CoworkOS update fixture",
      "-srcfolder",
      folder,
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      archive
    ],
    { timeout: 180_000, maxBuffer: 1024 * 1024 }
  );
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(archive)) digest.update(bytes);
  return { archive, sha256: digest.digest("hex"), size: (await stat(archive)).size };
}

async function updateFixture(candidate, version) {
  const names = publicReleaseArtifactNames(version);
  const contents = new Map();
  for (const name of names.filter((name) => !name.endsWith(".sha256"))) {
    if (name.endsWith(".dmg")) continue;
    contents.set(name, Buffer.from(JSON.stringify({ nativeUpdateFixture: true, version, name }) + "\n"));
  }
  const dmgName = `CoworkOS-${version}-mac-arm64.dmg`;
  contents.set(`${dmgName}.sha256`, Buffer.from(`${candidate.sha256}  ${dmgName}\n`));
  for (const [name, body] of [...contents])
    if (!name.endsWith(".sha256")) contents.set(`${name}.sha256`, Buffer.from(`${hash(body)}  ${name}\n`));
  const feed = validatePublicReleaseFeed({
    schemaVersion: 1,
    repository: PUBLIC_RELEASE_REPOSITORY,
    version,
    publishedAt: new Date().toISOString(),
    releaseUrl: `https://github.com/${PUBLIC_RELEASE_REPOSITORY}/releases/tag/v${version}`,
    artifacts: names.map((name) => ({
      name,
      size: name === dmgName ? candidate.size : contents.get(name).length,
      sha256: name === dmgName ? candidate.sha256 : hash(contents.get(name)),
      url: releaseAssetUrl(PUBLIC_RELEASE_REPOSITORY, `v${version}`, name)
    }))
  });
  const requests = [];
  const downloads = new Set();
  let releaseDownload;
  const initial = Buffer.alloc(Math.min(candidate.size, 64 * 1024));
  const handle = await open(candidate.archive, "r");
  try {
    await handle.read(initial, 0, initial.length, 0);
  } finally {
    await handle.close();
  }
  const source = createServer((request, response) => {
    requests.push({ path: request.url, authenticated: Boolean(request.headers.authorization) });
    if (request.url === "/latest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(feed));
      return;
    }
    const name = decodeURIComponent(request.url.slice(1));
    if (name === dmgName) {
      downloads.add(response);
      response.once("close", () => downloads.delete(response));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": candidate.size
      });
      response.write(initial);
      releaseDownload = () => {
        const stream = createReadStream(candidate.archive, { start: initial.length });
        response.once("close", () => stream.destroy());
        stream.pipe(response);
      };
      return;
    }
    const body = contents.get(name);
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    response.end(body);
  });
  await new Promise((done) => source.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${source.address().port}`;
  return {
    requests,
    downloads,
    routes: [
      [PUBLIC_UPDATE_FEED_URL, `${base}/latest.json`],
      ...feed.artifacts.map(({ url, name }) => [url, `${base}/${encodeURIComponent(name)}`])
    ],
    release: () => releaseDownload?.(),
    async close() {
      source.closeAllConnections();
      await new Promise((done) => source.close(done));
    }
  };
}

async function routeFixture(native, routes) {
  await native.evaluate((_electron, entries) => {
    const original = globalThis.fetch;
    const mappings = new Map(entries);
    // Test-process transport only: trusted public URLs and every production integrity check remain intact.
    globalThis.fetch = (input, options) => {
      const url = typeof input === "string" ? input : input.url || input.href;
      return original(mappings.get(url) || input, options);
    };
  }, routes);
}

async function terminateFixtureProcesses(root) {
  // The unique temporary bundle/profile path is the ownership boundary, including helper-relaunched processes.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="]);
    const pids = stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match && Number(match[1]) !== process.pid && match[2].includes(root + "/")
        ? [Number(match[1])]
        : [];
    });
    if (!pids.length) return;
    for (const pid of pids)
      try {
        process.kill(pid, attempt === 2 ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    await delay(300);
  }
}

async function cleanupFixtureRegistration(root, target) {
  const register =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  const registeredPaths = async () => {
    const { stdout } = await execute(register, ["-dump"], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.split("\n").flatMap((line) => {
      const path = /^path:\s+(.+?)\s+\(0x[\da-f]+\)\s*$/.exec(line)?.[1];
      return path?.startsWith(root + "/") ? [path] : [];
    });
  };
  // Include nested Electron helpers and stage candidates, always scoped to this unique fixture root.
  // Unregistering by bundle identifier could affect a real installation and is never allowed here.
  for (const path of new Set([target, ...(await registeredPaths())]))
    await execute(register, ["-u", path], { timeout: 30_000 });
  expect(await registeredPaths()).toEqual([]);
  const { stdout } = await execute("/usr/bin/hdiutil", ["info"]);
  const mounts = stdout.split("\n").flatMap((line) => {
    const mount = /^\/dev\/\S+\s+.*?\s+(\/.*)$/.exec(line)?.[1];
    return mount?.startsWith(root + "/") ? [mount] : [];
  });
  for (const mount of mounts) await execute("/usr/bin/hdiutil", ["detach", mount], { timeout: 30_000 });
}

test("a packaged App checks the public feed, downloads in the background and installs through the real managed helper while preserving drafts", async ({
  browserName
}, testInfo) => {
  test.skip(
    process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      process.env.ATRIA_PUBLIC_APP_UPDATES_SMOKE !== "1" ||
      !process.env.ATRIA_DESKTOP_APP,
    "An explicit packaged Apple Silicon App and ATRIA_PUBLIC_APP_UPDATES_SMOKE=1 are required"
  );
  test.setTimeout(360_000);
  const source = resolve(process.env.ATRIA_DESKTOP_APP);
  const original = await readJson(manifestPath(source));
  await access(join(source, "Contents/Resources/app/desktop/update-install.cjs"));
  const root = await realpath(await mkdtemp(join(tmpdir(), "atria-public-app-update-native-")));
  const parent = join(root, "Applications");
  const target = join(parent, "CoworkOS.app");
  const data = join(root, "profile");
  const nextVersion = original.version.replace(/-beta\.(\d+)$/, (_, number) => `-beta.${Number(number) + 1}`);
  let native, page, fixture, request, relaunchedPid;
  try {
    expect(nextVersion).not.toBe(original.version);
    await mkdir(parent);
    await mkdir(data);
    await mkdir(join(root, "project"));
    await execute("/usr/bin/ditto", [source, target]);
    await prepareDesktopSmokeComponents({ data, metadata: original });
    const candidate = await fixtureCandidate(source, root, nextVersion);
    fixture = await updateFixture(candidate, nextVersion);
    const env = desktopSmokeEnvironment({ data });
    native = await electron.launch({
      executablePath: executable(target),
      args: ["--use-mock-keychain"],
      env,
      timeout: 60_000
    });
    await routeFixture(native, fixture.routes);
    page = await native.firstWindow();
    const onboarding = page.getByRole("dialog", { name: "连接模型", exact: true });
    await expect(onboarding).toBeVisible();
    await onboarding.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.locator("#new-project").click();
    await page.locator("#add-project-name").fill("Native public update fixture");
    await page.locator("#add-project-directory").fill(join(root, "project"));
    await page.locator("#add-project-submit").click();
    await expect(page.locator("#add-project-modal")).toBeHidden();
    await page.locator("#new-conversation").click();
    await expect
      .poll(async () => (await page.evaluate(() => window.bookmanDesktop.updateStatus())).busy, {
        timeout: 45_000
      })
      .toBe(false);
    await page.locator("#user-menu-button").click();
    await expect(page.locator("[data-update-channel]")).toHaveCount(0);
    await expect(page.locator(".desktop-updates button")).toHaveCount(1);
    // An initial check may have started before the main-process transport was mapped.
    if (await page.getByRole("button", { name: "检查更新", exact: true }).isVisible())
      await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(page.locator("[data-update-message]")).toContainText(nextVersion);
    await expect(page.locator("[data-update-error]")).toBeHidden();
    await page.keyboard.press("Escape");
    const notice = page.locator("[data-update-notice]");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveCSS("background-color", "rgb(51, 133, 237)");
    await notice.click();
    await expect(page.getByRole("button", { name: "下载更新", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "下载更新", exact: true }).click();
    await expect.poll(() => fixture.downloads.size).toBe(1);
    await expect(page.locator("[data-update-progress]")).toBeVisible();
    await expect(page.locator("#profile-close")).toBeEnabled();
    expect(await page.locator(".app-shell").evaluate((element) => element.inert)).toBe(false);
    await page.keyboard.press("Escape");
    const draft = "NATIVE_MANAGED_UPDATE_DRAFT\n下载期间编辑，更新后仍保留";
    await page.locator("#composer-input").fill(draft);
    fixture.release();
    await expect(notice).toBeVisible({ timeout: 120_000 });
    await notice.click();
    await expect(page.getByRole("button", { name: "重启并安装", exact: true })).toBeEnabled();
    expect((await page.evaluate(() => window.bookmanDesktop.updateStatus())).installMethod).toBe("managed");
    await page
      .locator(".desktop-updates")
      .screenshot({ path: testInfo.outputPath("packaged-update-ready.png") });
    const stage = (await readdir(parent)).find((name) => /^\.atria-update-[A-Za-z0-9]+$/.test(name));
    expect(stage).toBeTruthy();
    request = await readJson(join(parent, stage, "request.json"));
    expect(request.target).toBe(target);
    expect(request.userData).toBe(data);
    expect(request.version).toBe(nextVersion);
    const closed = native.waitForEvent("close", { timeout: 60_000 });
    await page.getByRole("button", { name: "重启并安装", exact: true }).click();
    await closed;
    native = undefined;
    await expect
      .poll(
        async () => {
          const result = await readJson(join(data, "updates/install-result.json")).catch(() => undefined);
          return result?.phase;
        },
        { timeout: 150_000 }
      )
      .toBe("installed");
    const ready = await readJson(join(request.stage, "ready.json"));
    expect(ready).toMatchObject({ requestId: request.requestId, version: nextVersion });
    expect(Number.isInteger(ready.pid)).toBe(true);
    relaunchedPid = ready.pid;
    const command = (await execute("/bin/ps", ["-p", String(relaunchedPid), "-o", "comm="])).stdout.trim();
    expect(command).toBe(executable(target));
    expect((await readJson(manifestPath(target))).version).toBe(nextVersion);
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]);
    expect(JSON.stringify(await readJson(join(data, "composer-drafts.json")))).toContain(
      "NATIVE_MANAGED_UPDATE_DRAFT"
    );
    expect(fixture.requests.filter(({ path }) => path === "/latest.json").length).toBeGreaterThan(0);
    expect(fixture.requests.every(({ authenticated }) => !authenticated)).toBe(true);

    // The helper's first new process has no Playwright debug port. Confirm its ready receipt above,
    // then reopen only this verified temporary installation to inspect recovered renderer state.
    process.kill(relaunchedPid, "SIGTERM");
    await expect
      .poll(
        () => {
          try {
            process.kill(relaunchedPid, 0);
            return true;
          } catch (error) {
            if (error.code === "ESRCH") return false;
            throw error;
          }
        },
        { timeout: 30_000 }
      )
      .toBe(false);
    relaunchedPid = undefined;
    native = await electron.launch({
      executablePath: executable(target),
      args: ["--use-mock-keychain"],
      env,
      timeout: 60_000
    });
    await routeFixture(native, fixture.routes);
    page = await native.firstWindow();
    const reopenedOnboarding = page.getByRole("dialog", { name: "连接模型", exact: true });
    await expect(reopenedOnboarding).toBeVisible();
    await reopenedOnboarding.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue(draft, { timeout: 30_000 });
    await page.locator("#user-menu-button").click();
    await expect(page.locator("[data-update-version]")).toHaveText(`当前版本 ${nextVersion}`);
    await expect(page.locator("[data-update-channel]")).toHaveCount(0);
    await page
      .locator(".desktop-updates")
      .screenshot({ path: testInfo.outputPath("packaged-updated-version.png") });
    await writeFile(
      testInfo.outputPath("packaged-public-update-summary.json"),
      JSON.stringify(
        {
          originalVersion: original.version,
          installedVersion: nextVersion,
          transport: "test-main-process-fetch-map-to-local-http",
          realPublicNetwork: false,
          realDmgAndManagedHelper: true,
          integrity: { sha256: candidate.sha256, size: candidate.size },
          anonymousRequests: fixture.requests.every(({ authenticated }) => !authenticated),
          editedDuringDownload: true,
          firstRelaunchReadyReceipt: true,
          recoveredDraftOnIndependentReopen: true,
          requests: fixture.requests
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    await native?.close().catch(() => {});
    await terminateFixtureProcesses(root);
    if (request) {
      const result = await readJson(join(data, "updates/install-result.json")).catch(() => undefined);
      if (result)
        await testInfo.attach("managed-install-result.json", {
          body: JSON.stringify(result),
          contentType: "application/json"
        });
    }
    const log = await readFile(join(data, "logs/dashboard.log"), "utf8").catch(() => undefined);
    if (log) await testInfo.attach("dashboard.log", { body: log, contentType: "text/plain" });
    await fixture?.close();
    await cleanupFixtureRegistration(root, target);
    await rm(root, { recursive: true, force: true });
  }
});
