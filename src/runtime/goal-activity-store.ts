import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { goalDirectory } from "./goal-store.js";
import { now } from "../domain/types.js";
import type { GoalNotification, GoalUpdate, GoalUpdateInput, LongTermGoal } from "../domain/goal.js";

interface GoalActivityState {
  version: 1;
  /** Receipts retain topic identity even after it leaves the recent display. */
  topics: Record<string, GoalUpdate>;
  notifications: GoalNotification[];
  pendingDigest: string[];
  completedDigests: string[];
}
const empty = (): GoalActivityState => ({
  version: 1,
  topics: {},
  notifications: [],
  pendingDigest: [],
  completedDigests: []
});
const rank = { internal: 0, routine: 1, important: 2, decision: 3 };
const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/** One atomic snapshot commits report + dedupe receipt + notification together. */
export class GoalActivityStore {
  private readonly path: string;
  constructor(workspaceRoot: string, taskId: string, programId: string) {
    this.path = join(goalDirectory(workspaceRoot, taskId, programId), "goal-activity.json");
  }

  private async read(): Promise<GoalActivityState> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
  }
  private async mutate<T>(operation: (state: GoalActivityState) => T): Promise<T> {
    return withFileLock(this.path, async () => {
      const state = await this.read();
      const result = operation(state);
      await mkdir(join(this.path, ".."), { recursive: true });
      const temporary = `${this.path}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`);
      await rename(temporary, this.path);
      return result;
    });
  }

  async publish(
    goal: LongTermGoal,
    input: GoalUpdateInput
  ): Promise<{ update: GoalUpdate; notified: boolean; duplicate: boolean }> {
    return this.mutate((state) => {
      const updateId = `update-${key(input.topicKey)}`;
      const old = state.topics[updateId];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- topics 来自 goal-activity.json，首次发布同一 topicKey 时还没有旧条目
      const escalated = !old || rank[input.kind] > rank[old.kind];
      const update: GoalUpdate = {
        ...input,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧条目读自 goal-activity.json，只有它存在时才继承更高等级的标题
        ...(old && rank[old.kind] > rank[input.kind] ? { title: old.title, summary: old.summary } : {}),
        updateId,
        goalRevision: goal.revision,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 goal-activity.json 的条目没有 createdAt，缺失时用当前时间
        createdAt: old?.createdAt ?? now(),
        updatedAt: now(),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上，只有已保存的旧条目才沿用更高等级的 kind
        kind: old && rank[old.kind] > rank[input.kind] ? old.kind : input.kind,
        sources: [
          ...new Map(
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧版 goal-activity.json 的条目没有 sources，合并时按空数组起步
            [...(old?.sources ?? []), ...input.sources].map((source) => [source.url, source])
          ).values()
        ].slice(-40)
      };
      state.topics[updateId] = update;
      let notified = false;
      if (escalated && input.kind !== "internal") {
        if (
          input.kind === "decision" ||
          input.kind === "important" ||
          goal.brief.notificationPolicy === "all"
        ) {
          const notificationId = `notice-${key(`${updateId}:${input.kind}`)}`;
          if (!state.notifications.some((entry) => entry.notificationId === notificationId)) {
            state.notifications.push({
              notificationId,
              kind: input.kind,
              title: input.title,
              summary: input.summary,
              updateIds: [updateId],
              createdAt: now()
            });
            notified = true;
          }
          state.pendingDigest = state.pendingDigest.filter((id) => id !== updateId);
        } else if (goal.brief.notificationPolicy === "digest" && !state.pendingDigest.includes(updateId))
          state.pendingDigest.push(updateId);
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 新主题（old 不存在）不算重复，old 读自 goal-activity.json 时类型声明看不到缺失
      return { update, notified, duplicate: Boolean(old && !escalated) };
    });
  }

  async digest(occurrence: string, goal: LongTermGoal): Promise<boolean> {
    return this.mutate((state) => {
      if (state.completedDigests.includes(occurrence)) return false;
      const updates = state.pendingDigest.map((id) => state.topics[id]).filter(Boolean);
      if (updates.length) {
        const notificationId = `digest-${key(occurrence)}`;
        state.notifications.push({
          notificationId,
          kind: "digest",
          title: `${goal.brief.title} · 定期汇总`,
          summary:
            updates
              .slice(0, 20)
              .map((entry) => `${entry.title}：${entry.summary.slice(0, 300)}`)
              .join("\n\n") +
            (updates.length > 20 ? `\n\n另有 ${updates.length - 20} 项，打开目标查看。` : ""),
          updateIds: updates.map((entry) => entry.updateId),
          createdAt: now()
        });
      }
      state.pendingDigest = [];
      // Monotonic weekly timestamps need only recent receipts to recover a stopped tick.
      state.completedDigests = [...state.completedDigests.slice(-103), occurrence];
      return updates.length > 0;
    });
  }

  async hasTopic(topicKey: string): Promise<boolean> {
    return Boolean((await this.read()).topics[`update-${key(topicKey)}`]);
  }

  async readNotification(notificationId: string): Promise<void> {
    await this.mutate((state) => {
      const entry = state.notifications.find((notice) => notice.notificationId === notificationId);
      if (!entry) throw new Error("unknown notification");
      entry.readAt ??= now();
    });
  }

  async notificationPage(limit = 30, offset = 0, unreadOnly = false) {
    const state = await this.read();
    const entries = [...state.notifications].reverse().filter((entry) => !unreadOnly || !entry.readAt);
    return {
      notifications: entries.slice(offset, offset + limit).map((entry) => ({
        ...entry,
        sources: [
          ...new Map(
            entry.updateIds
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 通知的 updateIds 可能指向已不在 topics 里的历史条目，取不到时跳过
              .flatMap((id) => state.topics[id]?.sources ?? [])
              .map((source) => [source.url, source])
          ).values()
        ].slice(0, 12)
      })),
      total: entries.length,
      unreadCount: state.notifications.filter((entry) => !entry.readAt).length
    };
  }

  async view(limit = 100, offset = 0) {
    const state = await this.read();
    const count = Math.min(200, Math.max(1, limit));
    return {
      updates: Object.values(state.topics)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(offset, offset + count),
      notifications: [...state.notifications].reverse().slice(offset, offset + count),
      unreadCount: state.notifications.filter((notice) => !notice.readAt).length,
      pendingDigestCount: state.pendingDigest.length,
      totalUpdates: Object.keys(state.topics).length,
      totalNotifications: state.notifications.length,
      offset,
      limit: count
    };
  }
}
