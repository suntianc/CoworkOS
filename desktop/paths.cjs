const path = require("node:path");
const fs = require("node:fs/promises");
const { atriaDataPaths } = require("../scripts/data-home.cjs");

/** Install resources are immutable; user data has one stable home across releases. */
function desktopPaths(appRoot, userData, env = process.env) {
  const data = atriaDataPaths({ ...env, ATRIA_HOME: userData });
  return {
    appRoot,
    userData,
    workspaceRoot: data.workspaceRoot,
    globalIndex: data.globalIndex,
    piAgentDir: data.piAgentDir,
    configPath: path.join(userData, "model-config.json"),
    secretPath: path.join(userData, "model-secret.bin"),
    logs: path.join(userData, "logs")
  };
}
async function prepareDesktopData(paths, version) {
  await fs.mkdir(paths.userData, { recursive: true, mode: 0o700 });
  for (const directory of [paths.workspaceRoot, paths.logs, paths.piAgentDir])
    await fs.mkdir(directory, { recursive: true });
  const marker = path.join(paths.userData, "data-version.json");
  let state;
  try {
    state = JSON.parse(await fs.readFile(marker, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("用户数据版本记录损坏，请从备份恢复");
  }
  if (state && state.formatVersion !== 1) throw new Error("该数据由不兼容的版本创建，请使用对应版本打开");
  const next = { formatVersion: 1, createdWith: state?.createdWith || version, lastOpenedWith: version };
  const temporary = `${marker}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temporary, marker);
}

module.exports = { desktopPaths, prepareDesktopData };
