const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

/** All hosts share a stable user home, independently of the installation. */
function atriaHome(env = process.env, home = homedir()) {
  return resolve(env.ATRIA_HOME || join(home, ".atria"));
}

/** @param {{workspaceRoot?: string}} config */
function atriaDataPaths(env = process.env, config = {}, cwd = process.cwd(), home = homedir()) {
  const root = atriaHome(env, home);
  const globalIndex = resolve(cwd, env.COWORK_GLOBAL_INDEX || join(root, "runtime", "workspaces.json"));
  return {
    home: root,
    workspaceRoot: resolve(cwd, env.COWORK_WORKSPACE || config.workspaceRoot || join(root, "workspace")),
    piAgentDir: resolve(cwd, env.PI_CODING_AGENT_DIR || join(root, "pi")),
    globalIndex,
    configPath: join(root, "config.json"),
    logs: join(root, "logs")
  };
}

module.exports = { atriaHome, atriaDataPaths };
