const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const codesign = "/usr/bin/codesign";
async function run({ command, args }) {
  return execute(command, args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
}

/** Native Mac updates require an intact Developer ID application, including the installed executable. */
async function isSignedMacApplication(executable, { platform = process.platform, commandRunner = run } = {}) {
  if (
    platform !== "darwin" ||
    typeof executable !== "string" ||
    !path.isAbsolute(executable) ||
    executable.includes("\0") ||
    typeof commandRunner !== "function"
  )
    return false;
  const macos = path.dirname(executable);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== "MacOS" || path.basename(contents) !== "Contents" || !bundle.endsWith(".app"))
    return false;
  try {
    const result = await commandRunner({
      command: codesign,
      args: ["--display", "--verbose=4", bundle]
    });
    const description = `${result?.stdout || ""}\n${result?.stderr || ""}`;
    if (!/^Authority=Developer ID Application: .+$/m.test(description)) return false;
    await commandRunner({ command: codesign, args: ["--verify", "--deep", "--strict", bundle] });
    return true;
    // eslint-disable-next-line no-restricted-syntax -- codesign exits non-zero for unsigned or tampered bundles, which is exactly the not-signed result this check reports
  } catch {
    return false;
  }
}

module.exports = { isSignedMacApplication };
