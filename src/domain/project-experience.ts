import { z } from "zod";

/**
 * Project experience is switched off as a whole (#33, 2026-11-11): nothing is
 * learned after a Run, nothing reaches Main's context or the skill tool, and
 * its routes and screens are gone. The code and any stored data stay until the
 * P9 cleanup removes them.
 */
export const PROJECT_EXPERIENCE_ENABLED = false as boolean;
export const PROJECT_EXPERIENCE_MAX_ITEMS = 40;
export const PROJECT_SKILL_MAX_ITEMS = 20;
export const PROJECT_EXPERIENCE_CANDIDATE_TTL_MS = 30 * 86_400_000;
export const projectExperienceIdentitySchema = z
  .object({
    projectId: z.string().min(1).max(1000),
    projectDirectory: z.string().min(1).max(4096),
    projectCatalogPath: z.string().min(1).max(4096).optional()
  })
  .strict();
export type ProjectExperienceIdentity = z.infer<typeof projectExperienceIdentitySchema>;
export const projectExperienceOptionsSchema = z
  .object({
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/)
      .optional(),
    maxTokens: z.number().int().min(256).max(4096).default(2048),
    maxRequestsPerHour: z.number().int().min(2).max(24).default(6)
  })
  .strict();
export type ProjectExperienceOptions = z.infer<typeof projectExperienceOptionsSchema>;
export const projectExperienceSourceSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    quote: z.string().trim().min(1).max(2000),
    validationQuote: z.string().trim().min(1).max(2000).optional(),
    at: z.string().datetime(),
    verified: z.boolean().default(false)
  })
  .strict();
export const projectExperienceVersionSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500),
    content: z.string().trim().min(1).max(6000),
    createdAt: z.string().datetime()
  })
  .strict();
const itemFields = {
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  kind: z.enum(["experience", "skill"]),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500),
  content: z.string().trim().min(1).max(6000),
  origin: z.enum(["manual", "automatic"]),
  pinned: z.boolean(),
  version: z.number().int().positive(),
  versions: z.array(projectExperienceVersionSchema).min(1).max(8),
  supportCount: z.number().int().nonnegative().max(8),
  sources: z.array(projectExperienceSourceSchema).max(8),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
};
export const projectExperienceEntrySchema = z
  .object({ ...itemFields, state: z.enum(["active", "disabled", "rejected"]) })
  .strict();
export type ProjectExperienceEntry = z.infer<typeof projectExperienceEntrySchema>;
export const projectExperienceCandidateSchema = z
  .object({
    ...itemFields,
    state: z.literal("candidate"),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    targetId: z.string().uuid().optional(),
    targetRevision: z.number().int().positive().optional(),
    verified: z.boolean()
  })
  .strict();
export type ProjectExperienceCandidate = z.infer<typeof projectExperienceCandidateSchema>;
export const projectExperienceProposalSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    kind: z.enum(["experience", "skill"]),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).default(""),
    content: z.string().trim().min(1).max(6000),
    quote: z.string().trim().min(1).max(2000),
    validationQuote: z.string().trim().min(1).max(2000).optional()
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.kind === "experience" && item.content.length > 1000)
      ctx.addIssue({ code: "custom", message: "Experience content exceeds 1000 characters" });
    if (Boolean(item.id) !== Boolean(item.revision))
      ctx.addIssue({ code: "custom", message: "An update requires both identity and revision" });
  });
export type ProjectExperienceProposal = z.infer<typeof projectExperienceProposalSchema>;
export const projectExperiencePendingSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    taskId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    text: z.string().min(1).max(12000),
    availableAt: z.number().finite(),
    generation: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative()
  })
  .strict();
export type ProjectExperiencePending = z.infer<typeof projectExperiencePendingSchema>;
export const projectExperienceDocumentSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    identity: projectExperienceIdentitySchema,
    enabled: z.boolean(),
    learningEnabled: z.boolean(),
    autoActivate: z.boolean(),
    learningOptions: projectExperienceOptionsSchema,
    learningRequests: z.array(z.number().finite().nonnegative()).max(24),
    entries: z.array(projectExperienceEntrySchema).max(90),
    candidates: z.array(projectExperienceCandidateSchema).max(30),
    pending: z.array(projectExperiencePendingSchema).max(30),
    processed: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
    blocked: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100)
  })
  .strict();
export type ProjectExperienceDocument = z.infer<typeof projectExperienceDocumentSchema>;
export interface ProjectExperienceProfile {
  revision: number;
  generation: number;
  enabled: boolean;
  learningEnabled: boolean;
  autoActivate: boolean;
  experiences: Array<Pick<ProjectExperienceEntry, "id" | "revision" | "title" | "description" | "content">>;
  skills: Array<{ id: string; revision: number; title: string; description: string; path: string }>;
}
