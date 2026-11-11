const fs = require("node:fs");
const path = require("node:path");

/** Node background processes use Electron's accessory bundle; only the main bundle belongs in Dock. */
function backendExecutable(executable, platform = process.platform, appRoot) {
  if (platform !== "darwin") return executable;
  const macOS = path.dirname(executable);
  const contents = path.dirname(macOS);
  if (
    path.basename(macOS) !== "MacOS" ||
    path.basename(contents) !== "Contents" ||
    !path.basename(path.dirname(contents)).endsWith(".app")
  )
    return executable;
  const name = `${path.basename(executable)} Helper`;
  const bundle = path.join(contents, "Frameworks", `${name}.app`, "Contents");
  const helper = path.join(bundle, "MacOS", name);
  try {
    fs.accessSync(helper, fs.constants.X_OK);
    const plist = fs.readFileSync(path.join(bundle, "Info.plist"), "utf8");
    if (!/<key>LSUIElement<\/key>\s*<true\s*\/>/.test(plist)) throw new Error("regular helper");
    return helper;
  } catch {
    // Development may use a partial Electron checkout; a distributed app must
    // contain its accessory runtime rather than silently reusing the GUI binary.
    if (appRoot) {
      const relative = path.relative(path.join(contents, "Resources"), path.resolve(appRoot));
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
        return executable;
    }
    throw new Error("未找到桌面后台运行时，请重新安装 Formicand");
  }
}

module.exports = { backendExecutable };
