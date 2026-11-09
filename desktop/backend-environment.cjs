const { statSync } = require("node:fs");
const { homedir } = require("node:os");
const { isAbsolute, join } = require("node:path");

const macSystemDirectories = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Finder supplies only system tools; discover common installs without executing user profiles. */
function desktopBackendEnvironment(source = process.env, platform = process.platform) {
  const environment = { ...source };
  if (platform !== "darwin") return environment;

  const home = source.HOME && isAbsolute(source.HOME) ? source.HOME : homedir();
  const currentPath = source.PATH || macSystemDirectories.join(":");
  const inherited = currentPath.split(":");
  const existing = new Set(inherited);
  const additions = [
    join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/homebrew/sbin",
    "/usr/local/sbin",
    join(home, "Applications/LibreOffice.app/Contents/MacOS"),
    "/Applications/LibreOffice.app/Contents/MacOS"
  ].filter((directory) => {
    if (existing.has(directory)) return false;
    try {
      return statSync(directory).isDirectory();
      // eslint-disable-next-line no-restricted-syntax -- statSync throws ENOENT for the optional install directories that are absent on this machine
    } catch {
      return false;
    }
  });

  // Local Python must precede Apple's system Python for a bare Finder environment.
  // A caller-supplied PATH keeps its complete ordering, including intentional system precedence.
  const finderPath = inherited.every((directory) => macSystemDirectories.includes(directory));
  environment.PATH = finderPath
    ? [...additions, currentPath].join(":")
    : [currentPath, ...additions].join(":");
  return environment;
}

module.exports = { desktopBackendEnvironment };
