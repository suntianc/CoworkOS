import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const execute = promisify(execFile);

/** A certificate import/notary upload requires an explicitly selected signing name. */
export function macPackagingEnvironment(source = process.env) {
  const env = { ...source };
  const developerId = Boolean(source.CSC_NAME?.trim());
  if (!developerId) {
    for (const name of Object.keys(env)) if (/^(?:CSC_|APPLE_)/.test(name)) delete env[name];
    env.CSC_NAME = "";
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }
  return { env, mode: developerId ? "developer-id" : "adhoc" };
}

export function macPackagingArguments(root, mode) {
  if (!["adhoc", "developer-id"].includes(mode)) throw new Error("Unknown Mac signing mode");
  return [
    join(root, "node_modules/electron-builder/cli.js"),
    "--config",
    "electron-builder.config.cjs",
    "--mac",
    "--arm64",
    "--dir",
    "--publish",
    "never",
    ...(mode === "adhoc" ? ["--config.mac.identity=-", "--config.mac.notarize=false"] : [])
  ];
}

const outputOf = (result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const property = (output, name) => output.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
function hasAudioInput(output) {
  return (
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/.test(output) ||
    /\[Key\] com\.apple\.security\.device\.audio-input\s+\[Value\]\s+\[Bool\] true/.test(output)
  );
}

/** Inspect the actual packaged signatures, never infer them from environment settings. */
export async function verifyMacApplication({ appPath, version, mode, commandRunner = execute }) {
  if (!["adhoc", "developer-id"].includes(mode)) throw new Error("Unknown Mac signing mode");
  await commandRunner("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const inspect = async (target, identifier) => {
    const display = outputOf(await commandRunner("/usr/bin/codesign", ["--display", "--verbose=4", target]));
    if (property(display, "Identifier") !== identifier)
      throw new Error(`Mac signature identifier does not match ${identifier}`);
    const actualMode = /^Authority=Developer ID Application:/m.test(display)
      ? "developer-id"
      : /^Signature=adhoc$/m.test(display)
        ? "adhoc"
        : "unsupported";
    if (actualMode !== mode) throw new Error(`Mac signature must use ${mode}`);
    if (!/^CodeDirectory.*\bruntime\b/m.test(display))
      throw new Error("Mac signature must enable Hardened Runtime");
    const entitlements = outputOf(
      await commandRunner("/usr/bin/codesign", ["--display", "--entitlements", "-", target])
    );
    if (hasAudioInput(entitlements))
      throw new Error("Mac signature unexpectedly enables audio-input entitlement");
    const cdHash = property(display, "CDHash");
    if (!cdHash || !/^[a-f0-9]{40,64}$/.test(cdHash)) throw new Error("Mac signature has no valid CDHash");
    return {
      identifier,
      mode: actualMode,
      cdHash,
      teamIdentifier: property(display, "TeamIdentifier") || null,
      hardenedRuntime: true,
      audioInput: false
    };
  };
  const parent = await inspect(appPath, "org.atria.cowork");
  if (mode === "developer-id" && (!parent.teamIdentifier || parent.teamIdentifier === "not set"))
    throw new Error("Mac App must have a Developer ID team");
  const info = JSON.parse(
    (
      await commandRunner("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        join(appPath, "Contents/Info.plist")
      ])
    ).stdout
  );
  const packaged = JSON.parse(await readFile(join(appPath, "Contents/Resources/app/package.json"), "utf8"));
  if (
    info.CFBundleIdentifier !== parent.identifier ||
    info.CFBundleShortVersionString !== version ||
    packaged.version !== version
  )
    throw new Error("Mac package, Info.plist and release versions/identity disagree");
  if (info.LSMinimumSystemVersion !== "14.0") throw new Error("Mac beta requires minimum macOS 14.0");
  if ("NSMicrophoneUsageDescription" in info || "NSSpeechRecognitionUsageDescription" in info)
    throw new Error("Mac App unexpectedly declares microphone or speech recognition privacy descriptions");
  return {
    version,
    mode,
    developerId: mode === "developer-id",
    notarized: mode === "adhoc" ? false : null,
    strictVerified: true,
    minimumSystemVersion: info.LSMinimumSystemVersion,
    bundleVersion: info.CFBundleVersion,
    parent
  };
}
