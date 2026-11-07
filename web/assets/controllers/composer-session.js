/** Conversation drafts stay separate from saved application documents. */
export function createComposerSession({
  input,
  getAttachments,
  setAttachments,
  storage,
  onError,
  onPersist
}) {
  const legacyPrefix = "atria.composer.v1:";
  const NAMESPACES_KEY = "atria.composer.namespaces.v1";
  const legacyOwnerKey = `${legacyPrefix}legacy-owner:active`;
  /**
   * Drafts belong to one backend. The prefix keeps a conversation started
   * against backend A out of backend B's composer, and a switch back restores
   * exactly the draft that backend had. Empty until the first backend is known,
   * which is the historical key shape and the source of the migration below.
   */
  let namespace = "";
  const prefix = () => (namespace ? `${legacyPrefix}${namespace}:` : legacyPrefix);
  const memory = new Map();
  const pendingStorage = new Set();
  const retainedDrafts = new Map();
  const draftOwners = new Map();
  const draftIdentities = new Map();
  const pendingMigrations = new Map();
  let current;
  let editing;
  let editDraft;
  let token = 0;
  let nextDraftIdentity = 0;
  let warned = false;
  const projectDraft = (key) => typeof key === "string" && key.startsWith("new:");
  const read = (key) => {
    const storageKey = prefix() + key;
    if (memory.has(storageKey)) return memory.get(storageKey);
    try {
      return JSON.parse(storage?.getItem(storageKey) || "null");
    } catch {
      return null;
    }
  };
  const writeRecord = (key, value) => {
    memory.set(key, value);
    try {
      if (!storage) throw new Error("storage unavailable");
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
      onPersist?.();
      pendingStorage.delete(key);
      if (!pendingStorage.size) warned = false;
      return true;
    } catch {
      pendingStorage.add(key);
      if (!warned) onError?.("草稿暂时无法保存到本机，请保留当前窗口");
      warned = true;
      return false;
    }
  };
  const write = (key, value) => writeRecord(prefix() + key, value);
  const finishMigrations = () => {
    for (const [key, source] of pendingMigrations) {
      if (pendingStorage.has(prefix() + key)) continue;
      pendingMigrations.delete(key);
      // Another window can update storage after this session cached the source.
      // Only remove a source that still matches in both memory and storage.
      try {
        const stored = JSON.parse(storage?.getItem(prefix() + "new") || "null");
        if (JSON.stringify(read("new")) !== JSON.stringify(source)) continue;
        if (JSON.stringify(stored) === JSON.stringify(source)) write("new", null);
        else memory.set(prefix() + "new", stored);
      } catch {
        // Keep the recovery copy when its durable identity cannot be verified.
      }
    }
  };
  const save = () => {
    if (current === undefined) return;
    const attachments = getAttachments();
    const draft = { text: input.value, attachments: [...attachments] };
    // Preserve the existing on-disk edit envelope while keeping the visible
    // composer independent. Its backup follows new typing in the composer.
    if (editing) editing = { ...editing, original: draft };
    write(
      current,
      input.value || attachments.length || editing ? (editing ? { ...editDraft, editing } : draft) : null
    );
    draftOwners.set(current, token);
    write("active", current);
  };
  input.addEventListener("input", save);
  return {
    get editing() {
      return editing;
    },
    beginEdit(target) {
      if (!current || editing) return false;
      const original = { text: input.value, attachments: [...getAttachments()] };
      editing = { ...target, editId: crypto.randomUUID(), original };
      editDraft = { text: target.body, attachments: [...target.attachments] };
      save();
      return true;
    },
    editSnapshot() {
      return editing ? { text: editDraft.text, attachments: [...editDraft.attachments] } : undefined;
    },
    updateEdit({ text = editDraft?.text, attachments = editDraft?.attachments }) {
      if (!editing) return false;
      editDraft = { text, attachments: [...attachments] };
      save();
      return true;
    },
    finishEdit(key = current, editId = editing?.editId, submittedDraft) {
      if (key === current) save();
      const saved = read(key);
      if (!editId || saved?.editing?.editId !== editId) return;
      if (
        submittedDraft &&
        (saved.text !== submittedDraft.text ||
          JSON.stringify(saved.attachments) !== JSON.stringify(submittedDraft.attachments))
      )
        return false;
      const original = saved.editing.original;
      write(key, original.text || original.attachments.length ? original : null);
      if (key === current) {
        editing = undefined;
        editDraft = undefined;
      }
      return true;
    },
    get currentKey() {
      return current;
    },
    get currentToken() {
      return token;
    },
    get currentDraftIdentity() {
      return draftIdentities.get(current);
    },
    snapshot() {
      const draft = { text: input.value, attachments: [...getAttachments()] };
      retainedDrafts.set(token, draft);
      return draft;
    },
    release(sourceToken) {
      retainedDrafts.delete(sourceToken);
    },
    get activeTask() {
      const key = read("active");
      return typeof key === "string" && key !== "new" && !projectDraft(key) ? key : null;
    },
    get activeProject() {
      const key = read("active");
      return projectDraft(key) ? decodeURIComponent(key.slice(4)) : null;
    },
    get hasNewDraft() {
      const key = read("active");
      return projectDraft(key) || (key === "new" && Boolean(read("new")));
    },
    save,
    /** Persist the visible draft and leave it to its backend without showing it here. */
    detach() {
      save();
      current = undefined;
      editing = undefined;
      editDraft = undefined;
      token += 1;
      input.value = "";
      setAttachments([]);
    },
    prepareClose() {
      save();
      // Retry every failed conversation, including drafts that are no longer
      // selected. A disk mirror of stale localStorage cannot protect memory.
      for (const key of [...pendingStorage]) writeRecord(key, memory.get(key));
      finishMigrations();
      return pendingStorage.size === 0;
    },
    /**
     * Bind drafts to one backend.
     *
     * The composer exists before the first connection, so its historical keys
     * carry no backend. The first bind copies those keys into the backend's
     * namespace once; later binds only change which namespace is read, and the
     * draft of the backend being left stays on disk exactly as it was.
     */
    setBackend(backendId) {
      const next = typeof backendId === "string" ? backendId : "";
      if (next === namespace) return;
      save();
      const previous = namespace;
      if (!previous && next) {
        const from = legacyPrefix;
        const to = `${legacyPrefix}${next}:`;
        try {
          const known = new Set(JSON.parse(storage?.getItem(NAMESPACES_KEY) || "[]"));
          known.add(next);
          const candidates = new Set(memory.keys());
          for (let index = 0; index < (storage?.length || 0); index += 1) {
            const key = storage.key(index);
            if (typeof key !== "string" || !key.startsWith(from)) continue;
            candidates.add(key);
            if (key.endsWith(":active")) known.add(key.slice(from.length, -":active".length));
          }
          const keys = [];
          for (const key of candidates) {
            if (typeof key !== "string" || !key.startsWith(from) || key.startsWith(to)) continue;
            if (key === legacyOwnerKey) continue;
            if (known.has(key.slice(from.length).split(":")[0])) continue;
            keys.push(key);
          }
          let owner = memory.get(legacyOwnerKey) ?? JSON.parse(storage?.getItem(legacyOwnerKey) || "null");
          if (keys.length && !owner) {
            owner = next;
            writeRecord(legacyOwnerKey, owner);
          }
          if (owner === next) {
            let complete = true;
            for (const key of keys) {
              const value = memory.has(key) ? memory.get(key) : JSON.parse(storage?.getItem(key) || "null");
              const destination = to + key.slice(from.length);
              const existing = memory.has(destination)
                ? memory.get(destination)
                : JSON.parse(storage?.getItem(destination) || "null");
              // Keep a conflicting legacy record as a recovery copy. Only its
              // original owner may retry the migration on a later launch.
              if (existing !== null && JSON.stringify(existing) !== JSON.stringify(value)) {
                complete = false;
                continue;
              }
              if (existing === null && value !== null && !writeRecord(destination, value)) {
                complete = false;
                continue;
              }
              if (pendingStorage.has(destination) || !writeRecord(key, null)) complete = false;
            }
            if (complete) writeRecord(legacyOwnerKey, null);
          }
        } catch {
          /* Keep the original records when their migration cannot be read. */
        }
      }
      namespace = next;
      // The visible composer must not keep the backend being left's text; the
      // caller activates a conversation to load this backend's own draft.
      input.value = "";
      setAttachments([]);
      for (const key of memory.keys()) if (!pendingStorage.has(key)) memory.delete(key);
      retainedDrafts.clear();
      draftOwners.clear();
      draftIdentities.clear();
      pendingMigrations.clear();
      editing = undefined;
      editDraft = undefined;
      current = undefined;
      token += 1;
    },
    activate(taskId, { fresh = false, projectId } = {}) {
      const key = taskId || (projectId ? `new:${encodeURIComponent(projectId)}` : "new");
      if (key === current && !fresh) return;
      save();
      if (retainedDrafts.has(token))
        retainedDrafts.set(token, { text: input.value, attachments: [...getAttachments()] });
      // An existing installation can have one global new-conversation draft.
      // Give it to the first selected project without losing its attachments.
      if (
        !fresh &&
        projectDraft(key) &&
        (current === "new" || current === undefined) &&
        !pendingMigrations.size &&
        !read(key) &&
        read("new")
      ) {
        const source = read("new");
        pendingMigrations.set(key, source);
        write(key, source);
        finishMigrations();
      }
      current = key;
      token += 1;
      if (fresh || !draftIdentities.has(key)) draftIdentities.set(key, ++nextDraftIdentity);
      if (fresh) write(key, null);
      const draft = fresh ? null : read(key);
      editing =
        draft?.editing &&
        typeof draft.editing.messageId === "string" &&
        typeof draft.editing.editId === "string" &&
        typeof draft.editing.original?.text === "string" &&
        Array.isArray(draft.editing.original?.attachments)
          ? draft.editing
          : undefined;
      draftOwners.set(key, token);
      const validAttachments = (files) =>
        Array.isArray(files)
          ? files.filter(
              (file) =>
                typeof file?.name === "string" &&
                (typeof file?.text === "string" || /^upload-[a-f0-9-]{36}$/.test(file?.uploadId || ""))
            )
          : [];
      editDraft = editing
        ? {
            text: typeof draft.text === "string" ? draft.text : "",
            attachments: validAttachments(draft.attachments)
          }
        : undefined;
      const composerDraft = editing ? editing.original : draft;
      input.value = typeof composerDraft?.text === "string" ? composerDraft.text : "";
      setAttachments(validAttachments(composerDraft?.attachments));
      write("active", key);
    },
    transfer(
      taskId,
      sourceKey = current,
      sourceToken = token,
      sourceDraft = null,
      { background = false } = {}
    ) {
      if (background || sourceKey !== current || sourceToken !== token) {
        // Creation can finish after navigation. Move only that draft, keeping
        // the current conversation and its unsent input exactly where they are.
        // A catalog can expose the new Task before its creation response.
        // Preserve drafts saved there meanwhile, including an explicit null
        // from clearing the composer; only an untouched target inherits it.
        if (!background || (!memory.has(prefix() + taskId) && read(taskId) === null))
          write(
            taskId,
            (background && sourceDraft) || retainedDrafts.get(sourceToken) || sourceDraft || read(sourceKey)
          );
        if (!background && sourceKey !== current && draftOwners.get(sourceKey) === sourceToken) {
          write(sourceKey, null);
          draftOwners.delete(sourceKey);
        }
        retainedDrafts.delete(sourceToken);
        return;
      }
      save();
      write(current, null);
      draftIdentities.set(taskId, draftIdentities.get(current));
      // The submitted draft now belongs to the task. Returning to its empty
      // new-conversation slot starts an independent draft and send gate.
      draftIdentities.delete(current);
      current = taskId;
      save();
      retainedDrafts.delete(sourceToken);
    }
  };
}
