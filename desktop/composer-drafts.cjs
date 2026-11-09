const fs = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

const prefix = "atria.composer.v1:";
const humanPrefix = "atria.human.v1:";
const maximumBytes = 16 * 1024 * 1024;
const validAttachments = (files) =>
  Array.isArray(files) &&
  !files.some(
    (file) =>
      !file ||
      typeof file !== "object" ||
      typeof file.name !== "string" ||
      (typeof file.text !== "string" && !/^upload-[a-f0-9-]{36}$/.test(file.uploadId || "")) ||
      (file.size !== undefined &&
        (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0))
  );
/**
 * A backend-namespaced page writes `<prefix><backendId>:active` beside its
 * drafts. The trailing name is the session marker in every namespace, so it is
 * never a draft envelope and its value is always a JSON string.
 */
const isSessionMarker = (key) =>
  key === `${prefix}active` || (key.startsWith(prefix) && key.endsWith(":active"));
const hasEditing = (entries) =>
  Object.entries(entries).some(
    ([key, value]) => key.startsWith(prefix) && !isSessionMarker(key) && JSON.parse(value)?.editing
  );

function validateEntries(entries, limit = maximumBytes) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries))
    throw new Error("草稿记录格式不正确，请保留当前窗口");
  const values = Object.entries(entries);
  for (const [key, value] of values) {
    if (
      (!key.startsWith(prefix) && !key.startsWith(humanPrefix)) ||
      key.length > 512 ||
      typeof value !== "string"
    )
      throw new Error("草稿记录格式不正确，请保留当前窗口");
  }
  if (Buffer.byteLength(JSON.stringify(entries), "utf8") > limit)
    throw new Error("草稿和附件过大，暂时无法保存；请保留当前窗口并减少附件");
  for (const [key, value] of values) {
    let draft;
    try {
      draft = JSON.parse(value);
    } catch {
      throw new Error("草稿内容不是有效 JSON，请保留当前窗口");
    }
    if (key.startsWith(humanPrefix)) {
      if (
        !draft ||
        typeof draft !== "object" ||
        Array.isArray(draft) ||
        typeof draft.text !== "string" ||
        (draft.choice !== undefined && (!Number.isSafeInteger(draft.choice) || draft.choice < 0)) ||
        Object.keys(draft).some((field) => field !== "text" && field !== "choice")
      )
        throw new Error("人工回复草稿格式不正确，请保留当前窗口");
    } else if (isSessionMarker(key)) {
      if (typeof draft !== "string") throw new Error("草稿会话记录格式不正确，请保留当前窗口");
    } else if (draft !== null) {
      if (
        !draft ||
        typeof draft !== "object" ||
        Array.isArray(draft) ||
        typeof draft.text !== "string" ||
        !Array.isArray(draft.attachments) ||
        (draft.editing !== undefined &&
          (!draft.editing ||
            ![draft.editing.messageId, draft.editing.versionId, draft.editing.runId].every(
              (value) => typeof value === "string" && /^[a-zA-Z0-9._-]{1,160}$/.test(value)
            ) ||
            typeof draft.editing.editId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(draft.editing.editId) ||
            typeof draft.editing.original?.text !== "string" ||
            !validAttachments(draft.editing.original?.attachments))) ||
        draft.attachments.some(
          (file) =>
            !file ||
            typeof file !== "object" ||
            typeof file.name !== "string" ||
            (typeof file.text !== "string" && !/^upload-[a-f0-9-]{36}$/.test(file.uploadId || "")) ||
            (file.size !== undefined &&
              (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0))
        )
      )
        throw new Error("草稿或附件记录格式不正确，请保留当前窗口");
    }
  }
  return { ...entries };
}

/** The HTTP origin changes on restart; drafts belong to the private desktop profile. */
function createComposerDraftStore(userData, { limit = maximumBytes } = {}) {
  const path = join(userData, "composer-drafts.json");
  let entries = {};
  let origin;
  let persisted = false;
  let warning;
  let blocked;
  let pending = Promise.resolve();
  return {
    async load() {
      try {
        if ((await fs.stat(path)).size > limit + 1024) throw new Error("draft file too large");
        const saved = JSON.parse(await fs.readFile(path, "utf8"));
        if (saved?.version > 4) {
          blocked = "草稿由较新版本创建，请使用对应版本并保留当前窗口";
          warning = blocked;
          return;
        }
        if (saved?.version !== 1 && saved?.version !== 2 && saved?.version !== 3 && saved?.version !== 4)
          throw new Error("invalid draft version");
        if (
          saved.version === 1 &&
          Object.keys(saved.entries || {}).some((key) => key.startsWith(humanPrefix))
        )
          throw new Error("invalid draft version");
        entries = validateEntries(saved.entries, limit);
        if (saved.version < 4 && hasEditing(entries)) throw new Error("invalid edit draft version");
        origin = typeof saved.origin === "string" ? saved.origin : undefined;
        persisted = true;
      } catch (error) {
        if (error.code === "ENOENT") return;
        try {
          const backup = `${path}.invalid-${randomUUID()}`;
          await fs.rename(path, backup);
          await fs.chmod(backup, 0o600);
          warning = "本机草稿记录损坏，已保留恢复副本；可以重新输入草稿";
          // eslint-disable-next-line no-restricted-syntax -- a failed backup rename is surfaced as a blocked store and warning, and the fs detail adds nothing the user can act on
        } catch {
          blocked = "本机草稿记录无法读取或备份，请保留当前窗口并检查用户数据目录";
          warning = blocked;
        }
      }
    },
    snapshot() {
      return { entries: { ...entries }, origin, persisted, ...(warning ? { warning } : {}) };
    },
    save(next, sourceOrigin) {
      let validated;
      try {
        if (blocked) throw new Error(blocked);
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
              JSON.stringify({
                version: hasEditing(validated)
                  ? 4
                  : Object.entries(validated).some(
                        ([key, value]) =>
                          key.startsWith(prefix) &&
                          !isSessionMarker(key) &&
                          JSON.parse(value)?.attachments?.some((file) => file.uploadId)
                      )
                    ? 3
                    : Object.keys(validated).some((key) => key.startsWith(humanPrefix))
                      ? 2
                      : 1,
                origin: sourceOrigin,
                entries: validated
              }),
              { mode: 0o600 }
            );
            await fs.rename(temporary, path);
          } catch {
            // eslint-disable-next-line no-restricted-syntax -- the temporary file removal must not replace the save error that is already being reported
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw new Error("草稿暂时无法保存到本机，请保留当前窗口并稍后重试");
          }
          entries = validated;
          origin = sourceOrigin;
          persisted = true;
          warning = undefined;
        });
      pending = operation;
      return operation;
    }
  };
}

module.exports = { createComposerDraftStore };
