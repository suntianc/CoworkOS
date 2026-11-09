import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../storage/file-lock.js";

/** A view points to a conversation or a stable application instance. Opening a
 * document in an empty instance does not change its tab identity. */
export interface WorkbenchTabRecord {
  tabId: string;
  kind: "conversation" | "application";
  /** Only conversation tabs have a task; legacy application values migrate on read. */
  taskId?: string;
  /** Legacy resource identity, resolved to an instance by the route layer. */
  resourceId?: string;
  /** Stable across empty and document states. */
  appInstanceId?: string;
  openedAt: string;
}

interface TabDocument {
  /** 2 since document tabs became resource-keyed; 1 files are migrated on read. */
  version: 2;
  tabs: WorkbenchTabRecord[];
  activeTabId?: string;
  /**
   * The user stepped away from every tab.
   *
   * Needed because "no tab recorded" and "no tab in front" must not behave the
   * same: the first should open something, the second is a decision to honour.
   * Without the distinction, `read()`'s fallback puts an editor back in front
   * of a person who just asked for a new conversation.
   */
  detached?: boolean;
  updatedAt: string;
}

const MAX_TABS = 40;

export interface TabTarget {
  kind: "conversation" | "application";
  taskId?: string;
  resourceId?: string;
  appInstanceId?: string;
}

function tabId(input: TabTarget): string {
  if (input.kind === "conversation") return `conversation:${input.taskId}`;
  // Resource-only targets are accepted for legacy migration.
  return input.appInstanceId ? `window:${input.appInstanceId}` : `resource:${input.resourceId}`;
}

/**
 * The global tab strip.
 *
 * Task files stay inside their own workspace; this index only remembers which
 * views are open and in what order, pointing at them by id. That is the same
 * arrangement `GlobalWorkspaceCatalog` uses for workspace roots, and it is what
 * lets one strip span several tasks without moving or duplicating task data.
 *
 * Kept server-side rather than in `localStorage` so the strip survives a reload
 * and is the same in the browser and in Electron.
 */
export class WorkbenchTabStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<TabDocument> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as
        (Partial<TabDocument> & { version?: number }) | null;
      if (!value || !Array.isArray(value.tabs)) return this.empty();
      // A version 1 file keyed document tabs by conversation and window, which
      // this store can no longer interpret: it cannot tell whether an instance
      // holds a resource. `migrateLegacyTabs` in the route layer does that
      // conversion, because it is the one place with a service to ask. Until
      // it runs, legacy tabs are kept verbatim so nothing is lost.
      const tabs = value.tabs.filter(
        (tab): tab is WorkbenchTabRecord =>
          Boolean(tab) &&
          typeof tab.tabId === "string" &&
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tabs.json 由 JSON.parse 读取，行里的 kind 可能是旧版或未知取值，必须只认这两种
          (tab.kind === "conversation" || tab.kind === "application") &&
          (tab.kind === "conversation"
            ? typeof tab.taskId === "string"
            : typeof tab.resourceId === "string" || typeof tab.appInstanceId === "string")
      );
      const detached = value.detached === true;
      return {
        version: 2,
        tabs,
        activeTabId: tabs.some((tab) => tab.tabId === value.activeTabId)
          ? value.activeTabId
          : detached
            ? undefined
            : tabs[0]?.tabId,
        ...(detached ? { detached: true } : {}),
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
      };
      // eslint-disable-next-line no-restricted-syntax -- tabs.json 首次打开时还不存在（ENOENT），读不出来就给空标签栏，不能因此让页面加载失败
    } catch {
      // No strip yet, or an unreadable one: an empty strip is the correct
      // starting state, not an error worth failing a page load over.
      return this.empty();
    }
  }

  /** Open a tab, or activate the existing one for the same view. */
  async open(input: TabTarget, options: { activate?: boolean } = {}): Promise<TabDocument> {
    const id = tabId(input);
    return this.update((document) => {
      const existing = document.tabs.find((tab) => tab.tabId === id);
      const focus =
        options.activate === false
          ? { activeTabId: document.activeTabId, detached: !document.activeTabId }
          : { activeTabId: id, detached: false };
      if (existing) return { ...document, ...focus };
      const tabs = [
        ...document.tabs,
        {
          tabId: id,
          kind: input.kind,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.resourceId ? { resourceId: input.resourceId } : {}),
          ...(input.appInstanceId ? { appInstanceId: input.appInstanceId } : {}),
          openedAt: new Date().toISOString()
        }
      ];
      // A bound strip: past the cap the oldest inactive tab is dropped rather
      // than letting the row grow until it is unusable.
      while (tabs.length > MAX_TABS) {
        const victim = tabs.findIndex((tab) => tab.tabId !== id && tab.tabId !== document.activeTabId);
        if (victim < 0) break;
        tabs.splice(victim, 1);
      }
      return { ...document, tabs, ...focus };
    });
  }

  /**
   * Re-point a tab at a new identity, keeping its place and its focus.
   *
   * An empty editor that is given a document changes identity: `window:app_1`
   * becomes `resource:res_1`. A close followed by an open would move it to the
   * end of the strip and could trip the `MAX_TABS` eviction, so the row is
   * rewritten where it sits.
   *
   * If the target id already exists the two rows merge, keeping the earlier
   * position. That is what collapses a migrated pair of legacy tabs on one
   * document into the single tab it should always have been.
   */
  async rekey(from: string, to: TabTarget): Promise<TabDocument> {
    const id = tabId(to);
    return this.update((document) => {
      const index = document.tabs.findIndex((tab) => tab.tabId === from);
      if (index < 0) return document;
      const source = document.tabs[index];
      const existing = document.tabs.findIndex((tab) => tab.tabId === id);
      const replacement: WorkbenchTabRecord = {
        tabId: id,
        kind: to.kind,
        ...(to.taskId ? { taskId: to.taskId } : {}),
        ...(to.resourceId ? { resourceId: to.resourceId } : {}),
        ...(to.appInstanceId ? { appInstanceId: to.appInstanceId } : {}),
        // The earlier of the two, so a merge keeps the strip's original order.
        openedAt:
          existing >= 0 && document.tabs[existing].openedAt < source.openedAt
            ? document.tabs[existing].openedAt
            : source.openedAt
      };
      const keepAt = existing >= 0 ? Math.min(index, existing) : index;
      const tabs = document.tabs.filter((tab) => tab.tabId !== from && tab.tabId !== id);
      tabs.splice(keepAt, 0, replacement);
      // Focus follows the identity: whichever of the two rows was in front,
      // the surviving row is. A rekey is also an act — a document was just put
      // into this window — so it ends the detached state the way `open` does.
      //
      // Without that, giving a document to an editor while nothing was in
      // front left `activeTabId` undefined and `detached` set, so the strip
      // kept reporting "the person stepped away from everything" and the new
      // document never came up. That is exactly what happens from a draft
      // conversation: opening the editor makes the draft reassert itself and
      // detach, and the document created a moment later had nothing to become.
      const wasActive = document.activeTabId === from || document.activeTabId === id;
      const focus = wasActive || document.activeTabId === undefined ? id : document.activeTabId;
      return { ...document, tabs, activeTabId: focus, detached: false };
    });
  }

  async close(id: string): Promise<TabDocument> {
    return this.update((document) => {
      const index = document.tabs.findIndex((tab) => tab.tabId === id);
      if (index < 0) return document;
      const tabs = document.tabs.filter((tab) => tab.tabId !== id);
      // Focus the neighbour, the way a browser does, rather than dropping the
      // user somewhere unrelated.
      const next =
        document.activeTabId === id
          ? (tabs.at(index) ?? tabs.at(index - 1) ?? tabs.at(0))?.tabId
          : document.activeTabId;
      return { ...document, tabs, activeTabId: next };
    });
  }

  async activate(id: string): Promise<TabDocument> {
    return this.update((document) =>
      document.tabs.some((tab) => tab.tabId === id)
        ? { ...document, activeTabId: id, detached: false }
        : document
    );
  }

  /**
   * Step away from every tab without closing any.
   *
   * Needed because "no tab is in front" is a real state, not the absence of
   * one: a person asking for a new conversation has stepped away from their
   * editor, and if the server keeps pointing at that editor the next poll puts
   * it straight back in front of them.
   */
  async clearActive(): Promise<TabDocument> {
    return this.update((document) => ({ ...document, activeTabId: undefined, detached: true }));
  }

  /** Drop only dead rows from the snapshot that was actually resolved. */
  async prune(
    exists: (tab: WorkbenchTabRecord) => boolean,
    observed: readonly WorkbenchTabRecord[]
  ): Promise<TabDocument> {
    // Resolution awaits resource/instance reads. A window may become a document
    // or another tab may open meanwhile; neither was checked by that snapshot.
    const dead = new Set(observed.filter((tab) => !exists(tab)).map((tab) => tab.tabId));
    if (!dead.size) return this.read();
    return this.update((document) => {
      const tabs = document.tabs.filter((tab) => !dead.has(tab.tabId));
      return {
        ...document,
        tabs,
        activeTabId: tabs.some((tab) => tab.tabId === document.activeTabId)
          ? document.activeTabId
          : document.detached
            ? undefined
            : tabs[0]?.tabId
      };
    });
  }

  private empty(): TabDocument {
    return { version: 2, tabs: [], updatedAt: new Date().toISOString() };
  }

  private async update(change: (document: TabDocument) => TabDocument): Promise<TabDocument> {
    await mkdir(dirname(resolve(this.filePath)), { recursive: true });
    return withFileLock(this.filePath, async () => {
      const next = { ...change(await this.read()), version: 2 as const, updatedAt: new Date().toISOString() };
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
      return next;
    });
  }
}

export { tabId as workbenchTabId };
