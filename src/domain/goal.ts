import { z } from "zod";

const brief = z.string().trim().min(1).max(4000);
const note = z.string().trim().min(1).max(1000);
const timestamp = z.string().datetime({ offset: true });
const timeZone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
      // eslint-disable-next-line no-restricted-syntax -- 无效时区使 Intl.DateTimeFormat 抛 RangeError，返回 false 正是这条 zod 校验要的结果
    } catch {
      return false;
    }
  }, "invalid time zone");

export const goalPlanStepSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    description: note,
    status: z.enum(["pending", "active", "completed", "blocked"]),
    evidence: z.string().trim().max(2000).optional()
  })
  .strict();

export const weeklyDigestSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    timeZone
  })
  .strict();

export const goalBriefSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    objective: brief,
    completionCriteria: z.array(note).max(20).default([]),
    preferences: z.array(note).max(30).default([]),
    notificationPolicy: z.enum(["important_only", "digest", "all"]).default("important_only"),
    digest: weeklyDigestSchema.optional()
  })
  .strict()
  .refine((value) => value.notificationPolicy !== "digest" || Boolean(value.digest), {
    message: "digest policy requires a weekly schedule",
    path: ["digest"]
  });

export const goalProgressSchema = z
  .object({
    summary: note,
    nextAction: z.string().trim().max(1000).optional(),
    waitingFor: z.string().trim().max(1000).optional(),
    steps: z.array(goalPlanStepSchema).max(30).optional(),
    facts: z.array(note).max(50).optional(),
    nextReviewAt: timestamp.nullable().optional(),
    disposition: z.enum(["continue", "wait", "needs_input", "complete"])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.nextReviewAt && Date.parse(value.nextReviewAt) < Date.now() + 60_000)
      context.addIssue({
        code: "custom",
        path: ["nextReviewAt"],
        message: "next review must be at least one minute in the future"
      });
    if (value.disposition === "continue" && !value.nextAction)
      context.addIssue({
        code: "custom",
        path: ["nextAction"],
        message: "continuing work requires a next action"
      });
    if (value.disposition === "needs_input" && !value.waitingFor)
      context.addIssue({
        code: "custom",
        path: ["waitingFor"],
        message: "a decision requires a concrete question"
      });
    if (value.steps && new Set(value.steps.map((step) => step.id)).size !== value.steps.length)
      context.addIssue({ code: "custom", path: ["steps"], message: "plan step ids must be unique" });
  });

export const goalUpdateSchema = z
  .object({
    topicKey: z.string().trim().min(1).max(240),
    kind: z.enum(["internal", "routine", "important", "decision"]),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(4000),
    sources: z
      .array(
        z
          .object({
            title: z.string().max(160),
            url: z
              .string()
              .url()
              .max(2000)
              .refine((value) => {
                const url = new URL(value);
                return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
              }, "sources must be credential-free HTTP links")
          })
          .strict()
      )
      .max(20)
      .default([])
  })
  .strict();

export type GoalBrief = z.infer<typeof goalBriefSchema>;
export type GoalProgressInput = z.infer<typeof goalProgressSchema>;
export type GoalUpdateInput = z.infer<typeof goalUpdateSchema>;
export type GoalPlanStep = z.infer<typeof goalPlanStepSchema>;
export type WeeklyDigest = z.infer<typeof weeklyDigestSchema>;
export type GoalDisposition = GoalProgressInput["disposition"];

/** Optional on a WatchProgram: old monitor programs remain readable. */
export interface LongTermGoal {
  version: 1;
  revision: number;
  creationHash?: string;
  brief: GoalBrief;
  steps: GoalPlanStep[];
  facts: string[];
  summary: string;
  nextAction?: string;
  waitingFor?: string;
  disposition: GoalDisposition;
  nextReviewAt?: string;
  lastReviewAt?: string;
  nextDigestAt?: string;
  lastDigestLocalDate?: string;
  decisionRequestId?: string;
  progressAt?: string;
  progressPending?: boolean;
  stopRequested?: boolean;
  /** Pending steering survives a crash between goal persistence and Inbox enqueue. */
  pendingCommand?: { id: string; reason: "created" | "edited" | "resumed" };
}

export interface GoalUpdate extends GoalUpdateInput {
  updateId: string;
  createdAt: string;
  updatedAt: string;
  goalRevision: number;
}

export interface GoalNotification {
  notificationId: string;
  kind: "important" | "decision" | "routine" | "digest";
  title: string;
  summary: string;
  updateIds: string[];
  createdAt: string;
  readAt?: string;
}

export class GoalConflictError extends Error {
  constructor() {
    super("目标已更新，请重新读取后再提交；旧运行不能覆盖新的要求");
    this.name = "GoalConflictError";
  }
}

/** Schedule by local wall time; choosing after a completed local date avoids DST duplicates. */
export function nextWeeklyDigest(
  schedule: WeeklyDigest,
  after: number = Date.now(),
  excludeLocalDate?: string
): string {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const start = Math.floor(after / 60_000) * 60_000 + 60_000;
  // A nonexistent DST wall time is skipped; the following week is still considered.
  for (let at = start; at <= start + 15 * 86_400_000; at += 60_000) {
    const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
    if (Number(parts.hour) !== schedule.hour || Number(parts.minute) !== schedule.minute) continue;
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (date === excludeLocalDate) continue;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === schedule.dayOfWeek) return new Date(at).toISOString();
  }
  throw new Error("cannot resolve weekly digest schedule");
}

export function localGoalDate(at: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(at));
}
