import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  macPackagingArguments,
  macPackagingEnvironment,
  verifyMacApplication
} from "../scripts/mac-signing.mjs";

const version = "0.1.2-beta.1";
const noAudio = "<plist><dict></dict></plist>";

async function fixture(t, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atria-mac-signing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appPath = join(directory, "CoworkOS.app");
  const packaged = join(appPath, "Contents/Resources/app/package.json");
  await mkdir(join(appPath, "Contents/Resources/app"), { recursive: true });
  await writeFile(packaged, JSON.stringify({ version: changes.packageVersion || version }));
  const info = {
    CFBundleIdentifier: "org.atria.cowork",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: "14.0",
    ...changes.info
  };
  const calls = [];
  const mode = changes.mode || "adhoc";
  const commandRunner = async (command, args) => {
    calls.push({ command, args });
    const target = args.at(-1);
    if (args.includes("--verify")) {
      if (changes.invalidSignature) throw new Error("Fixture signature verification failed");
      return {};
    }
    if (command === "/usr/bin/plutil") return { stdout: JSON.stringify(info) };
    if (args.includes("--entitlements")) {
      return { stdout: changes.audio === undefined ? noAudio : changes.audio };
    }
    return {
      stderr: [
        `Identifier=${changes.identifier || "org.atria.cowork"}`,
        `CodeDirectory flags=0x10002(${changes.runtime === false ? "adhoc" : "adhoc,runtime"})`,
        changes.authority ||
          (mode === "developer-id" ? "Authority=Developer ID Application: Fixture Team" : "Signature=adhoc"),
        `TeamIdentifier=${changes.team === undefined ? "FIXTURETEAM" : changes.team}`,
        `CDHash=${changes.cdHash === undefined ? "a".repeat(40) : changes.cdHash}`
      ].join("\n")
    };
  };
  return { appPath, version, mode, commandRunner, calls };
}

test("ad-hoc packaging disables certificate discovery/import and notarization without changing caller env", () => {
  const source = {
    PATH: "/fixture/bin",
    CSC_NAME: " ",
    CSC_LINK: "fixture certificate path",
    CSC_KEY_PASSWORD: "fixture placeholder",
    CSC_KEYCHAIN: "fixture keychain",
    APPLE_ID: "fixture account",
    APPLE_API_KEY: "fixture key path"
  };
  const original = { ...source };
  const { mode, env } = macPackagingEnvironment(source);
  assert.equal(mode, "adhoc");
  assert.deepEqual(env, { PATH: "/fixture/bin", CSC_NAME: "", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  assert.deepEqual(source, original);
  const args = macPackagingArguments("/fixture/root", mode);
  assert.ok(args.includes("--config.mac.identity=-"));
  assert.ok(args.includes("--config.mac.notarize=false"));
  assert.deepEqual(args.slice(args.indexOf("--publish"), args.indexOf("--publish") + 2), [
    "--publish",
    "never"
  ]);
});

test("an explicit Developer ID name preserves its configured credentials and adds no ad-hoc override", () => {
  const source = { CSC_NAME: "Fixture Team", CSC_LINK: "fixture certificate", APPLE_ID: "fixture account" };
  const { mode, env } = macPackagingEnvironment(source);
  assert.equal(mode, "developer-id");
  assert.deepEqual(env, source);
  const args = macPackagingArguments("/fixture/root", mode);
  assert.equal(
    args.some((arg) => arg.includes("identity=") || arg.includes("notarize=")),
    false
  );
  assert.throws(() => macPackagingArguments("/fixture/root", "unknown"), /Unknown/);
});

test("ad-hoc report binds the parent signature and actual beta package version without audio entitlement", async (t) => {
  const f = await fixture(t);
  const report = await verifyMacApplication(f);
  assert.equal(report.mode, "adhoc");
  assert.equal(report.developerId, false);
  assert.equal(report.notarized, false);
  assert.equal(report.version, version);
  assert.equal(report.bundleVersion, version);
  assert.equal(report.minimumSystemVersion, "14.0");
  assert.equal(report.strictVerified, true);
  assert.equal(report.parent.identifier, "org.atria.cowork");
  assert.equal(report.parent.audioInput, false);
  assert.equal("speechHelper" in report, false);
  assert.deepEqual(f.calls[0], {
    command: "/usr/bin/codesign",
    args: ["--verify", "--deep", "--strict", f.appPath]
  });
  assert.equal(
    f.calls.some((call) => call.args.includes("--sign")),
    false,
    "verification never signs"
  );
});

test("Developer ID verification requires a valid team and cannot accept ad-hoc", async (t) => {
  const report = await verifyMacApplication(await fixture(t, { mode: "developer-id" }));
  assert.equal(report.developerId, true);
  assert.equal(report.notarized, null, "certificate verification does not prove notarization");
  await assert.rejects(
    verifyMacApplication(await fixture(t, { mode: "developer-id", authority: "Signature=adhoc" })),
    /must use developer-id/
  );
  await assert.rejects(
    verifyMacApplication(await fixture(t, { mode: "developer-id", team: "not set" })),
    /Developer ID team/
  );
  await assert.rejects(
    verifyMacApplication(await fixture(t, { authority: "Authority=Apple Development: Fixture" })),
    /must use adhoc/
  );
});

test("signature or metadata failures stop a candidate before it can become a DMG", async (t) => {
  for (const changes of [
    { invalidSignature: true },
    { identifier: "org.other.app" },
    { runtime: false },
    { audio: "<key>com.apple.security.device.audio-input</key><true/>" },
    { cdHash: "" },
    { info: { CFBundleShortVersionString: "0.1.2" } },
    { packageVersion: "0.1.1" },
    { info: { LSMinimumSystemVersion: "12.0" } },
    { info: { NSSpeechRecognitionUsageDescription: "Fixture speech purpose" } },
    { info: { NSMicrophoneUsageDescription: "Fixture microphone purpose" } }
  ])
    await assert.rejects(verifyMacApplication(await fixture(t, changes)));
});

test("modern codesign dictionary output rejects audio-input authorization", async (t) => {
  const f = await fixture(t, {
    audio: "[Dict]\n\t[Key] com.apple.security.device.audio-input\n\t[Value]\n\t\t[Bool] true\n"
  });
  await assert.rejects(verifyMacApplication(f), /audio-input/);
});
