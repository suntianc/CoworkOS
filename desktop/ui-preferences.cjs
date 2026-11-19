const fs = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

const currentVersion = 1;
const maximumBytes = 1024 * 1024;

/**
 * The page's own remembered choices: per-conversation model and reasoning
 * level, unread marks, collapsed projects, layout. Drafts have their own store
 * (composer-drafts.cjs) and are never kept here.
 */
function isPreferenceKey(key) {
  return (
    typeof key === "string" &&
    key.startsWith("atria.") &&
    key.length <= 256 &&
    !key.startsWith("atria.composer.v1:") &&
    !key.startsWith("atria.human.v1:")
  );
}

function validateEntries(entries, limit = maximumBytes) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries))
    throw new Error("界面偏好记录格式不正确");
  for (const [key, value] of Object.entries(entries))
    if (!isPreferenceKey(key) || typeof value !== "string") throw new Error("界面偏好记录格式不正确");
  if (Buffer.byteLength(JSON.stringify(entries), "utf8") > limit) throw new Error("界面偏好记录过大");
  return { ...entries };
}

/**
 * The page is served from `http://127.0.0.1:<port>`, and the backend picks a
 * free port on every start. Browser storage belongs to the origin, so each
 * restart began with an empty one: every conversation's model and level, and
 * every other remembered choice, went back to the default. The desktop profile
 * keeps the last copy and hands it to a page on a new origin.
 */
function createUiPreferenceStore(userData, { limit = maximumBytes } = {}) {
  const path = join(userData, "ui-preferences.json");
  let entries = {};
  let origin;
  let persisted = false;
  let pending = Promise.resolve();
  return {
    async load() {
      try {
        if ((await fs.stat(path)).size > limit + 1024) throw new Error("preference file too large");
        const saved = JSON.parse(await fs.readFile(path, "utf8"));
        if (saved?.version !== currentVersion) throw new Error("unknown preference version");
        entries = validateEntries(saved.entries, limit);
        origin = typeof saved.origin === "string" ? saved.origin : undefined;
        persisted = true;
      } catch (error) {
        if (error.code === "ENOENT") return;
        // Only remembered choices are lost; keep the file for inspection.
        // eslint-disable-next-line no-restricted-syntax -- 偏好文件改名失败时按没有记录启动，界面回到默认选择即可
        await fs.rename(path, `${path}.invalid-${randomUUID()}`).catch(() => {});
      }
    },
    snapshot() {
      return { entries: { ...entries }, origin, persisted };
    },
    save(next, sourceOrigin) {
      let validated;
      try {
        validated = validateEntries(next, limit);
      } catch (error) {
        return Promise.reject(error);
      }
      const operation = pending
        // eslint-disable-next-line no-restricted-syntax -- pending holds the previous save whose rejection was already returned to its own caller; the queue only orders writes
        .catch(() => {})
        .then(async () => {
          const temporary = `${path}.tmp-${randomUUID()}`;
          try {
            await fs.writeFile(
              temporary,
              JSON.stringify({ version: currentVersion, origin: sourceOrigin, entries: validated }),
              { mode: 0o600 }
            );
            await fs.rename(temporary, path);
          } catch (error) {
            // eslint-disable-next-line no-restricted-syntax -- the temporary file removal must not replace the save error that is already being reported
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw error;
          }
          entries = validated;
          origin = sourceOrigin;
          persisted = true;
        });
      pending = operation;
      return operation;
    }
  };
}

module.exports = { createUiPreferenceStore, isPreferenceKey };
