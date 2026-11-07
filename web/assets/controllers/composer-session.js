// Fallback for synchronous consumers without Web Locks. Browser contexts use
// Web Locks, whose ownership ends automatically when a renderer exits.
const localClaims = new WeakMap();

/** Conversation drafts stay separate from saved application documents. */
export function createComposerSession({
  input,
  getAttachments,
  setAttachments,
  storage,
  onError,
  onPersist,
  locks = globalThis.navigator?.locks
}) {
  const legacyPrefix = "atria.composer.v1:";
  const NAMESPACES_KEY = "atria.composer.namespaces.v1";
  const legacyOwnerKey = `${legacyPrefix}legacy-owner:active`;
  // Keep preconnection edits from different launches separate, including when
  // an earlier connection left a conflicting recovery copy behind.
  const randomId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
  const prebindRoot = `${legacyPrefix}__prebind__:`;
  const prebindId = randomId();
  let prebindPrefix = `${prebindRoot}${prebindId}:`;
  let adoptedMarker;
  const lockManager = locks;
  const unknownOccupancy = !lockManager && typeof window !== "undefined";
  const claims = storage && !lockManager ? localClaims.get(storage) || new Map() : null;
  if (claims && !localClaims.has(storage)) localClaims.set(storage, claims);
  let releaseLease;
  let disposed = false;
  const lockName = (prefix) => `cowork-composer:${prefix}`;
  const acquireLease = (prefix) => {
    if (!lockManager) {
      if (claims?.has(prefix) && claims.get(prefix) !== prebindId) return Promise.resolve(null);
      claims?.set(prefix, prebindId);
      return Promise.resolve(() => {
        if (claims?.get(prefix) === prebindId) claims.delete(prefix);
      });
    }
    return new Promise((resolve) => {
      let release;
      const held = new Promise((done) => {
        release = done;
      });
      const request = Promise.resolve().then(() =>
        lockManager.request(lockName(prefix), { ifAvailable: true }, async (lock) => {
          if (!lock) return resolve(null);
          resolve(async () => {
            release();
            await request;
          });
          await held;
        })
      );
      request.catch(() => resolve(null));
    });
  };
  let pendingStageBind;
  const journalKey = `${legacyPrefix}migration-journal:active`;
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
  const deferredSources = new Set();
  const migrationConflicts = new Map();
  const protectedDestinations = new Set();
  const retainedNulls = new Set();
  const legacySources = new Set();
  let trackingLegacyOwner = false;
  let journalPresent = false;
  let invalidJournal = false;
  let current;
  let editing;
  let editDraft;
  let token = 0;
  let nextDraftIdentity = 0;
  let warned = false;
  const projectDraft = (key) => typeof key === "string" && key.startsWith("new:");
  const hasContent = (draft) =>
    Boolean(draft && typeof draft === "object" && (draft.text || draft.attachments?.length || draft.editing));
  const readRecord = (storageKey) => {
    if (memory.has(storageKey)) return memory.get(storageKey);
    try {
      return JSON.parse(storage?.getItem(storageKey) || "null");
    } catch {
      return null;
    }
  };
  const keyFor = (key) =>
    !namespace && (projectDraft(key) || (key === "new" && readRecord(legacyOwnerKey)))
      ? prebindPrefix + key
      : prefix() + key;
  const read = (key) => readRecord(keyFor(key));
  const hasRecord = (key) => {
    if (memory.has(key)) return memory.get(key) !== null || retainedNulls.has(key);
    return storage?.getItem(key) != null;
  };
  const writeRecord = (key, value) => {
    memory.set(key, value);
    try {
      if (!storage) throw new Error("storage unavailable");
      if (value === null && !retainedNulls.has(key)) storage.removeItem(key);
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
  const write = (key, value) => {
    let destination = keyFor(key);
    if (destination.startsWith(prebindPrefix)) {
      if (!claimPrebind()) {
        destination = keyFor(key);
        memory.set(destination, value);
        pendingStorage.add(destination);
        return false;
      }
      destination = keyFor(key);
    }
    const migration = pendingMigrations.get(destination);
    if (migration) migration.expectedDestination = value;
    if (value === null && (protectedDestinations.has(destination) || pendingMigrations.has(destination)))
      retainedNulls.add(destination);
    else retainedNulls.delete(destination);
    if (pendingMigrations.has(destination) && (invalidJournal || pendingStorage.has(journalKey))) {
      memory.set(destination, value);
      pendingStorage.add(destination);
      return false;
    }
    return writeRecord(destination, value);
  };
  const persistJournal = () => {
    if (invalidJournal) return false;
    const entries = [
      ...[...pendingMigrations].map(([destination, { sourceKey, legacy }]) => ({
        sourceKey,
        destination,
        ...(legacy ? { legacy: true } : {})
      })),
      ...[...migrationConflicts].map(([destination, { sourceKey, legacy }]) => ({
        sourceKey,
        destination,
        conflict: true,
        ...(legacy ? { legacy: true } : {})
      }))
    ];
    if (!entries.length && !journalPresent && !pendingStorage.has(journalKey)) return true;
    const value = entries.length ? JSON.stringify(entries) : null;
    const saved = writeRecord(journalKey, value);
    journalPresent = Boolean(entries.length) || !saved;
    return saved;
  };
  const registerMigration = (destination, entry, needsWrite = true) => {
    pendingMigrations.set(destination, { ...entry, expectedDestination: entry.source });
    if (!persistJournal()) {
      if (needsWrite) {
        memory.set(destination, entry.source);
        pendingStorage.add(destination);
      }
      return;
    }
    if (needsWrite) writeRecord(destination, entry.source);
  };
  const finishMigrations = () => {
    if (pendingStorage.has(journalKey) || invalidJournal) return;
    let journalChanged = false;
    for (const [destination, { sourceKey, source, legacy, expectedDestination }] of pendingMigrations) {
      if (deferredSources.has(sourceKey)) continue;
      if (pendingStorage.has(destination) || pendingStorage.has(sourceKey)) continue;
      // Another window can update storage after this session cached the source.
      // Only remove a source that still matches in both memory and storage.
      try {
        if (!storage) throw new Error("storage unavailable");
        const stored = JSON.parse(storage.getItem(sourceKey) || "null");
        const storedDestination = JSON.parse(storage.getItem(destination) || "null");
        if (JSON.stringify(storedDestination) !== JSON.stringify(expectedDestination)) {
          migrationConflicts.set(destination, { sourceKey, legacy });
          protectedDestinations.add(destination);
          pendingMigrations.delete(destination);
          journalChanged = true;
          continue;
        }
        if (JSON.stringify(readRecord(sourceKey)) !== JSON.stringify(source)) {
          migrationConflicts.set(destination, { sourceKey, legacy });
          protectedDestinations.add(destination);
          pendingMigrations.delete(destination);
          journalChanged = true;
          continue;
        }
        if (JSON.stringify(stored) !== JSON.stringify(source)) {
          memory.set(sourceKey, stored);
          if (legacy && stored === null) legacySources.delete(sourceKey);
          if (stored !== null) {
            migrationConflicts.set(destination, { sourceKey, legacy });
            protectedDestinations.add(destination);
          }
          pendingMigrations.delete(destination);
          journalChanged = true;
          continue;
        }
        storage.removeItem(sourceKey);
        onPersist?.();
        memory.set(sourceKey, null);
        retainedNulls.delete(sourceKey);
        if (legacy) legacySources.delete(sourceKey);
        pendingMigrations.delete(destination);
        journalChanged = true;
      } catch {
        if (!warned) onError?.("草稿暂时无法保存到本机，请保留当前窗口");
        warned = true;
      }
    }
    for (const [destination, { sourceKey, legacy }] of migrationConflicts) {
      if (pendingStorage.has(sourceKey) || pendingStorage.has(destination)) continue;
      try {
        if (
          !storage ||
          storage.getItem(sourceKey) !== null ||
          (memory.has(sourceKey) && readRecord(sourceKey) !== null)
        )
          continue;
        migrationConflicts.delete(destination);
        protectedDestinations.delete(destination);
        if (legacy) legacySources.delete(sourceKey);
        if (storage.getItem(destination) === "null") {
          retainedNulls.delete(destination);
          writeRecord(destination, null);
        }
        journalChanged = true;
      } catch {
        if (!warned) onError?.("草稿暂时无法保存到本机，请保留当前窗口");
        warned = true;
      }
    }
    if (journalChanged) persistJournal();
    if (
      trackingLegacyOwner &&
      !legacySources.size &&
      ![...pendingMigrations.values()].some((entry) => entry.legacy)
    ) {
      trackingLegacyOwner = false;
      retainedNulls.delete(legacyOwnerKey);
      writeRecord(legacyOwnerKey, null);
    }
  };
  const prebindEntries = (prefix) => {
    const keys = new Set(memory.keys());
    for (let index = 0; index < (storage?.length || 0); index += 1) keys.add(storage.key(index));
    return [...keys].filter((key) => {
      if (typeof key !== "string" || !key.startsWith(prefix)) return false;
      const slot = key.slice(prefix.length);
      return (slot === "new" || projectDraft(slot)) && hasContent(readRecord(key));
    });
  };
  const claimPrebind = () => {
    if (lockManager && !releaseLease) return false;
    const marker = prebindPrefix + "active";
    if (pendingStorage.has(marker) && memory.get(marker) === `live:${prebindId}`) return false;
    let owner;
    try {
      owner = JSON.parse(storage?.getItem(marker) || "null");
    } catch {
      owner = null;
    }
    const claimedByOther = claims?.has(prebindPrefix) && claims.get(prebindPrefix) !== prebindId;
    if (
      claimedByOther ||
      (owner && owner !== `live:${prebindId}` && owner !== `ready:${prebindId}` && owner !== adoptedMarker)
    ) {
      // A successor adopted this session after close preparation. Keep the
      // continuing session's cached work under a fresh identity.
      const oldPrefix = prebindPrefix;
      const cached = [...memory].filter(([key, draft]) => key.startsWith(oldPrefix) && hasContent(draft));
      prebindPrefix = `${prebindRoot}${randomId()}:`;
      adoptedMarker = undefined;
      if (claims) claims.set(prebindPrefix, prebindId);
      for (const [key, draft] of cached) {
        const target = prebindPrefix + key.slice(oldPrefix.length);
        memory.set(target, draft);
        pendingStorage.add(target);
      }
      if (!writeRecord(prebindPrefix + "active", `live:${prebindId}`)) return false;
      for (const [key, draft] of cached) writeRecord(prebindPrefix + key.slice(oldPrefix.length), draft);
      return true;
    }
    if (claims) claims.set(prebindPrefix, prebindId);
    // A successfully closed draft stays recoverable even if this process
    // exits after taking the transient lease and before binding a backend.
    if (typeof owner === "string" && owner.startsWith("ready:")) return true;
    return owner === `live:${prebindId}` || writeRecord(marker, `live:${prebindId}`);
  };
  const prebindGroups = (includeReferenced = false) => {
    if (!storage) return;
    const groups = new Map();
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const match =
        typeof key === "string" && key.match(/^atria\.composer\.v1:__prebind__:([a-f0-9]{32}):(.*)$/);
      if (!match) continue;
      const prefix = `${prebindRoot}${match[1]}:`;
      if (!groups.has(prefix)) groups.set(prefix, { marker: null, content: false });
      const group = groups.get(prefix);
      if (match[2] === "active") group.marker = readRecord(key);
      else if ((match[2] === "new" || projectDraft(match[2])) && hasContent(readRecord(key)))
        group.content = true;
    }
    const referenced = [...pendingMigrations.values(), ...migrationConflicts.values()].map(
      (item) => item.sourceKey
    );
    const candidates = [...groups].filter(
      ([prefix, group]) =>
        group.content && (includeReferenced || !referenced.some((key) => key.startsWith(prefix)))
    );
    return candidates;
  };
  const adoptPrebind = (chosen) => {
    prebindPrefix = chosen[0];
    adoptedMarker = chosen[1].marker;
    claims?.set(prebindPrefix, prebindId);
  };
  const choosePrebind = () => {
    const candidates = prebindGroups() || [];
    const ready = candidates.filter(
      ([, group]) => typeof group.marker === "string" && group.marker.startsWith("ready:")
    );
    const orphans = candidates.filter(([, group]) => group.marker === null);
    const chosen =
      ready.length === 1 && orphans.length === 0
        ? ready[0]
        : ready.length === 0 && candidates.length === 1 && orphans.length === 1
          ? orphans[0]
          : null;
    return chosen;
  };
  const cleanupEmptyPrebind = () => {
    const marker = prebindPrefix + "active";
    if (pendingStorage.has(marker) || prebindEntries(prebindPrefix).length) return;
    const owner = JSON.parse(storage?.getItem(marker) || "null");
    if (owner === `live:${prebindId}` || owner === `ready:${prebindId}` || owner === adoptedMarker)
      writeRecord(marker, null);
  };
  const migratePrebind = (backendId) => {
    const marker = prebindPrefix + "active";
    if (pendingStorage.has(marker) || (prebindEntries(prebindPrefix).length && !claimPrebind())) {
      pendingStageBind ??= backendId;
      return;
    }
    pendingStageBind = undefined;
    const sources = prebindEntries(prebindPrefix);
    const writes = [];
    for (const sourceKey of sources) {
      const slot = sourceKey.slice(prebindPrefix.length);
      const staged = readRecord(sourceKey);
      const destination = `${legacyPrefix}${backendId}:${slot}`;
      const existing = readRecord(destination);
      if (
        !hasRecord(destination) ||
        existing === null ||
        JSON.stringify(existing) === JSON.stringify(staged)
      ) {
        retainedNulls.delete(destination);
        pendingMigrations.set(destination, { sourceKey, source: staged, expectedDestination: staged });
        if (JSON.stringify(existing) !== JSON.stringify(staged)) writes.push([destination, staged]);
      } else {
        migrationConflicts.set(destination, { sourceKey });
        protectedDestinations.add(destination);
      }
    }
    // Journal the whole session before consuming any source. A crash between
    // projects must not leave the remaining entries with an unknown backend.
    if (sources.length && !persistJournal()) {
      for (const [destination, staged] of writes) {
        memory.set(destination, staged);
        pendingStorage.add(destination);
      }
      return;
    }
    for (const [destination, staged] of writes) writeRecord(destination, staged);
    finishMigrations();
    cleanupEmptyPrebind();
  };
  const restoreMigrations = () => {
    try {
      if (!storage) return;
      const raw = storage.getItem(journalKey);
      if (raw == null) return;
      const saved = JSON.parse(raw);
      if (typeof saved !== "string") throw new Error("invalid migration journal");
      const entries = JSON.parse(saved);
      if (
        !Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !entry ||
            typeof entry.sourceKey !== "string" ||
            typeof entry.destination !== "string" ||
            !entry.sourceKey.startsWith(legacyPrefix) ||
            !entry.destination.startsWith(legacyPrefix) ||
            entry.sourceKey === entry.destination ||
            entry.sourceKey === journalKey ||
            entry.destination === journalKey ||
            entry.destination.endsWith(":active")
        )
      )
        throw new Error("invalid migration journal");
      journalPresent = true;
      let changed = false;
      for (const { sourceKey, destination, legacy, conflict } of entries) {
        const source = JSON.parse(storage.getItem(sourceKey) || "null");
        const rawDestination = storage.getItem(destination);
        const target = JSON.parse(rawDestination || "null");
        if (source === null) {
          changed = true;
          continue;
        }
        if (lockManager && sourceKey.startsWith(prebindRoot) && !conflict) deferredSources.add(sourceKey);
        if (rawDestination === null && !conflict) {
          pendingMigrations.set(destination, { sourceKey, source, legacy, expectedDestination: source });
          memory.set(destination, source);
          pendingStorage.add(destination);
          if (legacy) {
            legacySources.add(sourceKey);
            trackingLegacyOwner = true;
          }
          continue;
        }
        if (conflict || JSON.stringify(source) !== JSON.stringify(target)) {
          migrationConflicts.set(destination, { sourceKey, legacy });
          protectedDestinations.add(destination);
          if (!conflict) changed = true;
        } else {
          pendingMigrations.set(destination, { sourceKey, source, legacy, expectedDestination: source });
          if (legacy) {
            legacySources.add(sourceKey);
            trackingLegacyOwner = true;
          }
        }
      }
      if (changed) persistJournal();
      if (!pendingStorage.has(journalKey)) {
        for (const destination of pendingMigrations.keys()) {
          if (pendingStorage.has(destination)) writeRecord(destination, memory.get(destination));
        }
      }
      finishMigrations();
    } catch {
      invalidJournal = true;
      onError?.("草稿迁移记录无法读取，请保留当前窗口并检查本机存储");
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
  const showDraft = (draft) => {
    editing =
      draft?.editing &&
      typeof draft.editing.messageId === "string" &&
      typeof draft.editing.editId === "string" &&
      typeof draft.editing.original?.text === "string" &&
      Array.isArray(draft.editing.original?.attachments)
        ? draft.editing
        : undefined;
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
  };
  restoreMigrations();
  const deferredGroups = new Set(
    [...deferredSources]
      .map((key) => key.match(/^(atria\.composer\.v1:__prebind__:[a-f0-9]{32}:)/)?.[1])
      .filter(Boolean)
  );
  const finishDeferredGroup = (group) => {
    for (const [destination, { sourceKey }] of pendingMigrations) {
      if (!sourceKey.startsWith(group)) continue;
      deferredSources.delete(sourceKey);
      if (pendingStorage.has(destination)) writeRecord(destination, memory.get(destination));
    }
    finishMigrations();
  };
  const chosen = choosePrebind();
  let ready;
  if (lockManager) {
    ready = (async () => {
      for (const group of deferredGroups) {
        const acquired = await acquireLease(group);
        if (acquired) {
          finishDeferredGroup(group);
          await acquired();
        } else {
          // A live owner retains the source until its context exits. The
          // queued lock resumes journal cleanup once that ownership ends.
          void lockManager
            .request(lockName(group), {}, (lock) => {
              if (lock && !disposed) finishDeferredGroup(group);
            })
            .catch(() => {});
        }
      }
      releaseLease = await acquireLease(prebindPrefix);
      if (!releaseLease) {
        onError?.("草稿暂时无法保存到本机，请保留当前窗口");
        return;
      }
      if (!chosen) return;
      const acquired = await acquireLease(chosen[0]);
      if (!acquired) return;
      const fresh = choosePrebind();
      if (!fresh || fresh[0] !== chosen[0] || fresh[1].marker !== chosen[1].marker) {
        await acquired();
        return;
      }
      await releaseLease();
      releaseLease = acquired;
      adoptPrebind(chosen);
    })();
  } else {
    if (chosen && !unknownOccupancy && (!claims?.has(chosen[0]) || claims.get(chosen[0]) === prebindId))
      adoptPrebind(chosen);
    else claims?.set(prebindPrefix, prebindId);
    ready = Promise.resolve();
  }
  input.addEventListener("input", save);
  return {
    ready,
    dispose() {
      disposed = true;
      const released = releaseLease?.();
      if (claims?.get(prebindPrefix) === prebindId) claims.delete(prebindPrefix);
      return released;
    },
    async listRecoverableDrafts() {
      await ready;
      const referenced = new Set([...pendingMigrations.values()].map(({ sourceKey }) => sourceKey));
      const drafts = [];
      for (const [group, { marker }] of prebindGroups(true) || []) {
        if (group === prebindPrefix && !namespace) continue;
        const release = group === prebindPrefix ? () => {} : await acquireLease(group);
        if (!release) continue;
        for (const key of prebindEntries(group)) {
          if (referenced.has(key)) continue;
          const draft = readRecord(key);
          const slot = key.slice(group.length);
          drafts.push({
            id: key,
            projectId: projectDraft(slot) ? decodeURIComponent(slot.slice(4)) : null,
            text: draft.text || "",
            attachments: draft.attachments || [],
            marker
          });
        }
        await release();
      }
      return drafts;
    },
    async recoverDraft(id, { projectId } = {}) {
      await ready;
      const backend = namespace;
      if (!backend) return { ok: false, reason: "backend" };
      const candidates = await this.listRecoverableDrafts();
      const selected = candidates.find((candidate) => candidate.id === id);
      if (!selected) return { ok: false, reason: "unavailable" };
      const group = id.slice(0, id.lastIndexOf(":new") + 1);
      const release = group === prebindPrefix ? () => {} : await acquireLease(group);
      if (!release) return { ok: false, reason: "unavailable" };
      try {
        if (namespace !== backend) return { ok: false, reason: "backend" };
        save();
        const slot = projectId ? `new:${encodeURIComponent(projectId)}` : "new";
        const destination = `${legacyPrefix}${backend}:${slot}`;
        if (hasRecord(destination)) return { ok: false, reason: "conflict" };
        const source = JSON.parse(storage?.getItem(id) || "null");
        if (!hasContent(source)) return { ok: false, reason: "unavailable" };
        const marker = JSON.parse(storage?.getItem(group + "active") || "null");
        if (typeof marker === "string" && marker.startsWith("ready:") && !unknownOccupancy) {
          registerMigration(destination, { sourceKey: id, source });
          finishMigrations();
        } else {
          // Old unmarked/live writers did not take a lease. Retain their
          // source and protect deletion of the recovered destination.
          migrationConflicts.set(destination, { sourceKey: id });
          protectedDestinations.add(destination);
          if (persistJournal()) writeRecord(destination, source);
          else {
            memory.set(destination, source);
            pendingStorage.add(destination);
          }
        }
        if (
          pendingStorage.has(destination) ||
          pendingStorage.has(journalKey) ||
          pendingMigrations.has(destination)
        )
          return { ok: false, reason: "save" };
        if (current === slot) showDraft(read(slot));
        return { ok: true };
      } finally {
        await release();
      }
    },
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
      if (pendingStorage.has(journalKey)) writeRecord(journalKey, memory.get(journalKey));
      for (const key of [...pendingStorage]) {
        if (lockManager && !releaseLease && key.startsWith(prebindPrefix)) continue;
        if ((invalidJournal || pendingStorage.has(journalKey)) && pendingMigrations.has(key)) continue;
        if (
          key.startsWith(prebindPrefix) &&
          key !== prebindPrefix + "active" &&
          pendingStorage.has(prebindPrefix + "active")
        )
          continue;
        writeRecord(key, memory.get(key));
      }
      finishMigrations();
      if (namespace && pendingStageBind) {
        const target = pendingStageBind;
        const wasEmpty =
          namespace === target &&
          current !== undefined &&
          !input.value &&
          !getAttachments().length &&
          !editing &&
          !read(current);
        migratePrebind(target);
        if (wasEmpty && read(current)) showDraft(read(current));
      }
      if (namespace && !pendingStageBind) cleanupEmptyPrebind();
      if (!namespace && !pendingStorage.size && !pendingMigrations.size && !invalidJournal) {
        const marker = prebindPrefix + "active";
        if (prebindEntries(prebindPrefix).length) {
          if (claimPrebind()) writeRecord(prebindPrefix + "active", `ready:${prebindId}`);
        } else {
          const owner = JSON.parse(storage?.getItem(marker) || "null");
          if (owner === `live:${prebindId}` || owner === `ready:${prebindId}`) writeRecord(marker, null);
        }
      }
      if (!lockManager && claims?.get(prebindPrefix) === prebindId) claims.delete(prebindPrefix);
      return !invalidJournal && pendingStorage.size === 0 && pendingMigrations.size === 0;
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
            if (key === legacyOwnerKey || key === journalKey) continue;
            const slot = key.slice(from.length);
            if (known.has(slot.split(":")[0])) continue;
            // A colon can identify an existing backend even when its marker
            // failed. Unbound project edits use separate prebind keys.
            if (slot.includes(":")) continue;
            keys.push(key);
          }
          const contentKeys = keys.filter((key) => key !== from + "active" && hasContent(readRecord(key)));
          const ambiguousContent = [...candidates].some(
            (key) =>
              typeof key === "string" &&
              key.startsWith(from + "new:") &&
              !keys.includes(key) &&
              hasContent(readRecord(key))
          );
          let owner = readRecord(legacyOwnerKey);
          if (contentKeys.length && !owner) {
            owner = next;
            writeRecord(legacyOwnerKey, owner);
          }
          if (owner === next) {
            trackingLegacyOwner = true;
            for (const key of contentKeys) {
              const value = readRecord(key);
              const destination = to + key.slice(from.length);
              legacySources.add(key);
              const existing = readRecord(destination);
              // Keep a conflicting legacy record as a recovery copy. Only its
              // original owner may retry the migration on a later launch.
              if (hasRecord(destination) && JSON.stringify(existing) !== JSON.stringify(value)) {
                migrationConflicts.set(destination, { sourceKey: key, legacy: true });
                protectedDestinations.add(destination);
                persistJournal();
                continue;
              }
              registerMigration(
                destination,
                { sourceKey: key, source: value, legacy: true },
                !hasRecord(destination)
              );
            }
            finishMigrations();
          } else if (owner && !contentKeys.length && !ambiguousContent) {
            // An old version could retain an owner for an `active` conflict.
            // Navigation alone cannot claim text typed for a later backend.
            writeRecord(legacyOwnerKey, null);
          }
          const active = from + "active";
          if (keys.includes(active) && (!contentKeys.length || owner === next)) {
            const destination = to + "active";
            const value = readRecord(active);
            if (!hasRecord(destination) && typeof value === "string") writeRecord(destination, value);
            writeRecord(active, null);
          }
          migratePrebind(next);
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
        ![...pendingMigrations.values()].some(({ sourceKey }) => sourceKey === keyFor("new")) &&
        !hasRecord(keyFor(key)) &&
        read("new")
      ) {
        const source = read("new");
        registerMigration(keyFor(key), { sourceKey: keyFor("new"), source });
        finishMigrations();
      }
      current = key;
      token += 1;
      if (fresh || !draftIdentities.has(key)) draftIdentities.set(key, ++nextDraftIdentity);
      if (fresh) write(key, null);
      const draft = fresh ? null : read(key);
      draftOwners.set(key, token);
      showDraft(draft);
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
