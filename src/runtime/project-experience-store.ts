import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atriaDataPaths } from "../../scripts/data-home.cjs";
import {
  PROJECT_EXPERIENCE_CANDIDATE_TTL_MS,
  PROJECT_EXPERIENCE_MAX_ITEMS,
  PROJECT_SKILL_MAX_ITEMS,
  projectExperienceDocumentSchema,
  projectExperienceIdentitySchema,
  projectExperienceOptionsSchema,
  projectExperienceProposalSchema,
  projectExperienceEntrySchema,
  type ProjectExperienceCandidate,
  type ProjectExperienceDocument,
  type ProjectExperienceEntry,
  type ProjectExperienceIdentity,
  type ProjectExperienceOptions,
  type ProjectExperiencePending,
  type ProjectExperienceProfile,
  type ProjectExperienceProposal
} from "../domain/project-experience.js";
import { withFileLock } from "../storage/file-lock.js";
import { writeMemoryJson } from "./user-memory-foreground.js";
import { sensitiveMemoryText } from "./user-memory-store.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identityKey = (identity: ProjectExperienceIdentity) =>
  digest(
    JSON.stringify([
      identity.projectCatalogPath ? resolve(identity.projectCatalogPath) : "",
      identity.projectId
    ])
  );
const proposalKey = (
  item: Pick<ProjectExperienceProposal, "id" | "kind" | "title" | "description" | "content">
) => digest(JSON.stringify([item.id ?? "", item.kind, item.title, item.description, item.content]));
export function projectExperienceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(atriaDataPaths(env).home, "project-experience");
}
/** Stable catalog identity survives a directory move; legacy projects remain directory-scoped. */
export function projectExperienceIdentity(
  task: {
    projectId?: string;
    projectDirectory?: string;
    projectCatalogPath?: string;
    temporaryWorkspaceRoot?: string;
    kind?: string;
  },
  directory?: string
): ProjectExperienceIdentity | undefined {
  if (task.temporaryWorkspaceRoot || task.kind === "workspace") return undefined;
  const projectDirectory = task.projectDirectory ?? directory;
  if (!projectDirectory) return undefined;
  return projectExperienceIdentitySchema.parse({
    projectId: task.projectId ?? `directory:${digest(resolve(projectDirectory))}`,
    projectDirectory: resolve(projectDirectory),
    ...(task.projectCatalogPath ? { projectCatalogPath: resolve(task.projectCatalogPath) } : {})
  });
}
export async function listProjectExperienceIdentities(
  root = projectExperienceRoot()
): Promise<ProjectExperienceIdentity[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const identities: ProjectExperienceIdentity[] = [];
  for (const name of names.filter((item) => /^[a-f0-9]{64}$/.test(item))) {
    try {
      const identity = projectExperienceIdentitySchema.parse(
        JSON.parse(await readFile(join(root, name, "identity.json"), "utf8"))
      );
      if (identityKey(identity) === name) identities.push(identity);
      // eslint-disable-next-line no-restricted-syntax -- 单个身份目录可能损坏或来自其它版本，跳过它，其它项目的经验仍要可列
    } catch {
      /* A broken private store cannot enable learning or block other projects. */
    }
  }
  return identities;
}
export class ProjectExperienceConflictError extends Error {}
export class ProjectExperienceCapacityError extends Error {}
const saveSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    kind: z.enum(["experience", "skill"]),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).default(""),
    content: z.string().trim().min(1).max(6000)
  })
  .strict();
const profileSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    enabled: z.boolean(),
    learningEnabled: z.boolean(),
    autoActivate: z.boolean(),
    experiences: z
      .array(
        projectExperienceEntrySchema.pick({
          id: true,
          revision: true,
          title: true,
          description: true,
          content: true
        })
      )
      .max(40),
    skills: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            revision: z.number().int().positive(),
            title: z.string(),
            description: z.string(),
            path: z.string()
          })
          .strict()
      )
      .max(20)
  })
  .strict();
async function stamp(path: string): Promise<string> {
  try {
    const value = await stat(path, { bigint: true });
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Private project knowledge; candidates and provenance never enter a foreground context. */
export class ProjectExperienceStore {
  readonly identity: ProjectExperienceIdentity;
  readonly directory: string;
  readonly path: string;
  private cache?: { source: string; profile: ProjectExperienceProfile };
  constructor(identity: ProjectExperienceIdentity, root = projectExperienceRoot()) {
    this.identity = projectExperienceIdentitySchema.parse({
      ...identity,
      projectDirectory: resolve(identity.projectDirectory),
      ...(identity.projectCatalogPath ? { projectCatalogPath: resolve(identity.projectCatalogPath) } : {})
    });
    this.directory = join(root, identityKey(this.identity));
    this.path = join(this.directory, "experience.json");
  }
  private empty(): ProjectExperienceDocument {
    return {
      version: 1,
      revision: 0,
      generation: 0,
      identity: this.identity,
      enabled: false,
      learningEnabled: false,
      autoActivate: false,
      learningOptions: { maxTokens: 2048, maxRequestsPerHour: 6 },
      learningRequests: [],
      entries: [],
      candidates: [],
      pending: [],
      processed: [],
      blocked: []
    };
  }
  async read(): Promise<ProjectExperienceDocument> {
    let document: ProjectExperienceDocument;
    try {
      document = projectExperienceDocumentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw new Error("Project experience data is invalid; no learned context or skills were loaded.", {
        cause: error
      });
    }
    if (identityKey(document.identity) !== identityKey(this.identity))
      throw new Error("Project experience identity mismatch");
    this.assertBudget(document);
    return document;
  }
  private skillPath(id: string): string {
    return join(this.directory, "skills", id, "SKILL.md");
  }
  private profile(document: ProjectExperienceDocument): ProjectExperienceProfile {
    const active = document.enabled ? document.entries.filter((item) => item.state === "active") : [];
    return {
      revision: document.revision,
      generation: document.generation,
      enabled: document.enabled,
      learningEnabled: document.learningEnabled,
      autoActivate: document.autoActivate,
      experiences: active
        .filter((item) => item.kind === "experience")
        .map(({ id, revision, title, description, content }) => ({
          id,
          revision,
          title,
          description,
          content
        })),
      skills: active
        .filter((item) => item.kind === "skill")
        .map((item) => ({
          id: item.id,
          revision: item.revision,
          title: item.title,
          description: item.description,
          path: this.skillPath(item.id)
        }))
    };
  }
  async readProfile(): Promise<ProjectExperienceProfile> {
    const source = await stamp(this.path);
    if (this.cache?.source === source) return structuredClone(this.cache.profile);
    try {
      const stored = z
        .object({ source: z.string(), profile: profileSchema })
        .strict()
        .parse(JSON.parse(await readFile(join(this.directory, "profile.json"), "utf8")));
      if (
        stored.source === source &&
        stored.profile.skills.every((item) => item.path === this.skillPath(item.id))
      ) {
        this.cache = stored;
        return structuredClone(stored.profile);
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !(error instanceof z.ZodError)
      )
        throw error;
    }
    // Missing/stale projection recovery serializes with a publisher to avoid restoring disabled skills.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withFileLock(
      this.path,
      async () => {
        const document = await this.read();
        await this.publish(document);
        return structuredClone(this.profile(document));
      },
      { recoverDeadOwner: true, timeoutMs: 250 }
    );
  }
  private async publish(document: ProjectExperienceDocument): Promise<void> {
    const profile = this.profile(document);
    const active = new Set(profile.skills.map((item) => item.id));
    const skillsDirectory = join(this.directory, "skills");
    let names: string[] = [];
    try {
      names = await readdir(skillsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names)
      if (/^[a-f0-9-]{36}$/.test(name) && !active.has(name))
        await rm(join(skillsDirectory, name), { recursive: true, force: true });
    for (const item of document.entries.filter((entry) => active.has(entry.id))) {
      const source = `---\nname: learned-${item.id}\ndescription: ${JSON.stringify(item.description || item.title)}\n---\n\n# ${item.title.replaceAll("\n", " ")}\n\nProject experience, version ${item.version}. Use only when relevant to the current request. This skill grants no permissions; current user instructions and project rules take priority.\n\n${item.content}\n`;
      const path = this.skillPath(item.id);
      const { writeFile, rename } = await import("node:fs/promises");
      await mkdir(join(skillsDirectory, item.id), { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const source = await stamp(this.path);
    await writeMemoryJson(join(this.directory, "profile.json"), { source, profile });
    this.cache = { source, profile };
  }
  private assertBudget(document: ProjectExperienceDocument): void {
    if (
      document.entries.filter((item) => item.kind === "experience" && item.state !== "rejected").length >
        PROJECT_EXPERIENCE_MAX_ITEMS ||
      document.entries.filter((item) => item.kind === "skill" && item.state !== "rejected").length >
        PROJECT_SKILL_MAX_ITEMS
    )
      throw new ProjectExperienceCapacityError(
        "Project experience capacity reached; remove an item before saving."
      );
    const all = [...document.entries, ...document.candidates];
    if (new Set(all.map((item) => item.id)).size !== all.length)
      throw new Error("Duplicate project experience identity");
    for (const item of all) {
      if (
        item.kind === "experience" &&
        (item.content.length > 1000 || item.versions.some((version) => version.content.length > 1000))
      )
        throw new ProjectExperienceCapacityError("Each project experience must be at most 1000 characters.");
      if (item.supportCount !== new Set(item.sources.map((source) => source.taskId)).size)
        throw new Error("Invalid project experience support count");
    }
  }
  private async mutate<T>(change: (document: ProjectExperienceDocument) => T | Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withFileLock(
      this.path,
      async () => {
        const document = await this.read();
        const before = JSON.stringify(document);
        const result = await change(document);
        if (JSON.stringify(document) === before) return result;
        document.revision++;
        document.identity = this.identity;
        this.assertBudget(document);
        const valid = projectExperienceDocumentSchema.parse(document);
        await writeMemoryJson(join(this.directory, "identity.json"), this.identity);
        await writeMemoryJson(this.path, valid);
        // A failed publication fails closed when consumers rebuild from the canonical stamp.
        this.cache = undefined;
        await this.publish(valid);
        return result;
      },
      { recoverDeadOwner: true, timeoutMs: 250 }
    );
  }
  private invalidate(document: ProjectExperienceDocument, preservePending = false): void {
    document.generation++;
    if (preservePending) {
      for (const item of document.pending) item.generation = document.generation;
    } else {
      document.processed = [...document.processed, ...document.pending.map((item) => item.id)].slice(-100);
      document.pending = [];
    }
  }
  async configure(
    options: Partial<ProjectExperienceOptions> & {
      enabled?: boolean;
      learningEnabled?: boolean;
      autoActivate?: boolean;
    },
    expectedRevision?: number
  ): Promise<ProjectExperienceDocument> {
    return this.mutate((document) => {
      if (expectedRevision !== undefined && document.revision !== expectedRevision)
        throw new ProjectExperienceConflictError("Project experience changed; reload before configuring.");
      const parsed = z
        .object({
          enabled: z.boolean().optional(),
          learningEnabled: z.boolean().optional(),
          autoActivate: z.boolean().optional(),
          model: z.string().optional(),
          maxTokens: z.number().optional(),
          maxRequestsPerHour: z.number().optional()
        })
        .strict()
        .parse(options);
      const { enabled, learningEnabled, autoActivate, ...learning } = parsed;
      const merged = { ...document.learningOptions, ...learning };
      if (learning.model !== undefined && !learning.model.trim()) delete merged.model;
      document.learningOptions = projectExperienceOptionsSchema.parse(merged);
      if (enabled !== undefined) document.enabled = enabled;
      if (learningEnabled !== undefined) document.learningEnabled = learningEnabled;
      if (autoActivate !== undefined) document.autoActivate = autoActivate;
      this.invalidate(document, true);
      return document;
    });
  }
  private find(
    document: ProjectExperienceDocument,
    id: string,
    revision: number
  ): ProjectExperienceEntry | ProjectExperienceCandidate {
    const entry = [...document.entries, ...document.candidates].find((item) => item.id === id);
    if (!entry || entry.revision !== revision)
      throw new ProjectExperienceConflictError("Project experience changed; reload before editing.");
    return entry;
  }
  private version(
    entry: ProjectExperienceEntry | ProjectExperienceCandidate,
    fields: { title: string; description: string; content: string },
    now: string
  ): void {
    const clean = { title: fields.title, description: fields.description, content: fields.content };
    entry.version++;
    Object.assign(entry, clean);
    entry.revision++;
    entry.updatedAt = now;
    entry.versions = [...entry.versions, { version: entry.version, ...clean, createdAt: now }].slice(-8);
  }
  private asEntry(
    candidate: ProjectExperienceCandidate,
    state: ProjectExperienceEntry["state"]
  ): ProjectExperienceEntry {
    const {
      key: ignoredKey,
      targetId: ignoredId,
      targetRevision: ignoredRevision,
      verified: ignoredVerified,
      ...fields
    } = candidate;
    void ignoredKey;
    void ignoredId;
    void ignoredRevision;
    void ignoredVerified;
    return { ...fields, state };
  }
  async save(
    input: z.input<typeof saveSchema>,
    expectedSnapshotRevision?: number
  ): Promise<ProjectExperienceEntry> {
    const parsed = saveSchema.parse(input);
    if (Boolean(parsed.id) !== Boolean(parsed.revision))
      throw new ProjectExperienceConflictError("Editing requires identity and revision.");
    return this.mutate((document) => {
      if (expectedSnapshotRevision !== undefined && document.revision !== expectedSnapshotRevision)
        throw new ProjectExperienceConflictError("Project experience changed; reload before saving.");
      const now = new Date().toISOString();
      const { id, revision, ...fields } = parsed;
      let entry: ProjectExperienceEntry;
      if (id) {
        const old = this.find(document, id, revision!);
        entry = old.state === "candidate" ? this.asEntry(old, "active") : old;
        this.version(entry, fields, now);
        Object.assign(entry, { kind: fields.kind, state: "active", origin: "manual", pinned: true });
        document.candidates = document.candidates.filter((item) => item.id !== id);
        document.entries = document.entries.filter((item) => item.id !== id);
      } else
        entry = {
          id: randomUUID(),
          revision: 1,
          ...fields,
          state: "active",
          origin: "manual",
          pinned: true,
          version: 1,
          versions: [
            {
              version: 1,
              title: fields.title,
              description: fields.description,
              content: fields.content,
              createdAt: now
            }
          ],
          supportCount: 0,
          sources: [],
          createdAt: now,
          updatedAt: now
        };
      document.entries.push(entry);
      this.invalidate(document);
      return entry;
    });
  }
  async setState(
    id: string,
    revision: number,
    state: ProjectExperienceEntry["state"]
  ): Promise<ProjectExperienceEntry> {
    z.enum(["active", "disabled", "rejected"]).parse(state);
    return this.mutate((document) => {
      const old = this.find(document, id, revision);
      let entry: ProjectExperienceEntry;
      if (old.state === "candidate") {
        if (state === "active" && old.targetId) {
          const target = this.find(document, old.targetId, old.targetRevision!);
          if (target.state === "candidate")
            throw new ProjectExperienceConflictError("Invalid candidate target");
          entry = target;
          this.version(entry, old, new Date().toISOString());
          entry.sources = old.sources;
          entry.supportCount = old.supportCount;
          entry.pinned = true;
        } else {
          entry = this.asEntry(old, state);
          entry.pinned = state === "active";
          entry.revision++;
          document.entries.push(entry);
        }
        document.candidates = document.candidates.filter((item) => item.id !== id);
        if (state === "rejected") document.blocked = [...document.blocked, old.key].slice(-100);
      } else {
        entry = old;
        entry.state = state;
        entry.revision++;
        entry.updatedAt = new Date().toISOString();
      }
      this.invalidate(document);
      return entry;
    });
  }
  async pin(id: string, revision: number, pinned: boolean): Promise<ProjectExperienceEntry> {
    z.boolean().parse(pinned);
    return this.mutate((document) => {
      const entry = this.find(document, id, revision);
      if (entry.state === "candidate") throw new Error("Accept a candidate before pinning it.");
      entry.pinned = pinned;
      entry.revision++;
      entry.updatedAt = new Date().toISOString();
      this.invalidate(document);
      return entry;
    });
  }
  async rollback(id: string, revision: number, version: number): Promise<ProjectExperienceEntry> {
    return this.mutate((document) => {
      const entry = this.find(document, id, revision);
      if (entry.state === "candidate") throw new Error("A candidate has no published version to restore.");
      const snapshot = entry.versions.find((item) => item.version === version);
      if (!snapshot) throw new ProjectExperienceConflictError("That version is no longer available.");
      this.version(entry, snapshot, new Date().toISOString());
      entry.pinned = true;
      this.invalidate(document);
      return entry;
    });
  }
  async remove(id: string, revision: number): Promise<void> {
    await this.mutate((document) => {
      const entry = this.find(document, id, revision);
      const key = entry.state === "candidate" ? entry.key : proposalKey(entry);
      document.blocked = [...document.blocked, key, proposalKey({ ...entry, id: undefined })].slice(-100);
      document.entries = document.entries.filter((item) => item.id !== id);
      document.candidates = document.candidates.filter((item) => item.id !== id && item.targetId !== id);
      this.invalidate(document);
    });
  }
  async claimLearningRequest(now = Date.now(), expectedGeneration?: number): Promise<boolean> {
    return this.mutate((document) => {
      document.learningRequests = document.learningRequests.filter(
        (timestamp) => timestamp > now - 3_600_000
      );
      if (
        !document.enabled ||
        !document.learningEnabled ||
        (expectedGeneration !== undefined && expectedGeneration !== document.generation) ||
        document.learningRequests.length >= document.learningOptions.maxRequestsPerHour
      )
        return false;
      document.learningRequests.push(now);
      return true;
    });
  }
  async enqueueLearning(
    input: { taskId: string; runId: string; text: string },
    now = Date.now(),
    idleMs = 60_000,
    expectedGeneration?: number
  ): Promise<void> {
    const parsed = z
      .object({
        taskId: z.string().min(1).max(200),
        runId: z.string().min(1).max(200),
        text: z.string().min(1).max(12000)
      })
      .strict()
      .parse(input);
    await this.mutate((document) => {
      if (
        !document.enabled ||
        !document.learningEnabled ||
        (expectedGeneration !== undefined && document.generation !== expectedGeneration)
      )
        return;
      const id = digest(JSON.stringify([parsed.taskId, parsed.runId]));
      if (document.processed.includes(id) || document.pending.some((item) => item.id === id)) return;
      document.pending = [
        ...document.pending,
        { ...parsed, id, availableAt: now + idleMs, generation: document.generation, attempts: 0 }
      ].slice(-30);
    });
  }
  async failLearning(job: ProjectExperiencePending, now = Date.now()): Promise<void> {
    await this.mutate((document) => {
      if (document.generation !== job.generation) return;
      const pending = document.pending.find((item) => item.id === job.id && item.attempts === job.attempts);
      if (!pending) return;
      pending.attempts++;
      pending.availableAt = now + (pending.attempts < 2 ? 60_000 : 300_000);
    });
  }
  async completeLearning(jobId: string, expectedGeneration: number): Promise<void> {
    await this.mutate((document) => {
      if (document.generation !== expectedGeneration) return;
      document.pending = document.pending.filter((item) => item.id !== jobId);
      document.processed = [...document.processed.filter((item) => item !== jobId), jobId].slice(-100);
    });
  }
  async applyProposal(input: {
    taskId: string;
    runId: string;
    changes: ProjectExperienceProposal[];
    expectedGeneration: number;
    verified: boolean | boolean[];
    isCurrent?: () => Promise<boolean>;
    jobId?: string;
  }): Promise<number> {
    const changes = input.changes.slice(0, 5).map((change) => projectExperienceProposalSchema.parse(change));
    return this.mutate(async (document) => {
      if (
        !document.enabled ||
        !document.learningEnabled ||
        document.generation !== input.expectedGeneration ||
        (input.isCurrent && !(await input.isCurrent()))
      )
        return 0;
      if (
        input.jobId &&
        !document.pending.some(
          (item) => item.id === input.jobId && item.generation === input.expectedGeneration
        )
      )
        return 0;
      const now = new Date().toISOString();
      document.candidates = document.candidates.filter(
        (item) => Date.parse(item.updatedAt) > Date.now() - PROJECT_EXPERIENCE_CANDIDATE_TTL_MS
      );
      let activated = 0;
      for (const [changeIndex, change] of changes.entries()) {
        const sourceVerified = Array.isArray(input.verified)
          ? input.verified[changeIndex] === true
          : input.verified;
        if (sensitiveMemoryText(`${change.content}\n${change.quote}\n${change.validationQuote ?? ""}`))
          continue;
        const target = change.id ? document.entries.find((item) => item.id === change.id) : undefined;
        if (
          change.id &&
          (!target ||
            target.revision !== change.revision ||
            target.origin !== "automatic" ||
            target.pinned ||
            target.state !== "active" ||
            target.kind !== change.kind)
        )
          continue;
        if (
          !change.id &&
          document.entries.some((item) => item.kind === change.kind && item.content === change.content)
        )
          continue;
        const key = proposalKey(change);
        if (document.blocked.includes(key)) continue;
        let candidate = document.candidates.find((item) => item.key === key);
        const source = {
          taskId: input.taskId,
          runId: input.runId,
          quote: change.quote,
          ...(change.validationQuote ? { validationQuote: change.validationQuote } : {}),
          at: now,
          verified: sourceVerified
        };
        if (!candidate) {
          candidate = {
            id: randomUUID(),
            revision: 1,
            kind: change.kind,
            title: change.title,
            description: change.description,
            content: change.content,
            state: "candidate",
            origin: "automatic",
            pinned: false,
            version: 1,
            versions: [
              {
                version: 1,
                title: change.title,
                description: change.description,
                content: change.content,
                createdAt: now
              }
            ],
            supportCount: 0,
            sources: [],
            createdAt: now,
            updatedAt: now,
            key,
            ...(target ? { targetId: target.id, targetRevision: target.revision } : {}),
            verified: sourceVerified
          };
          document.candidates.push(candidate);
        }
        const previousSource = candidate.sources.find((item) => item.taskId === input.taskId);
        if (previousSource && (previousSource.verified || !sourceVerified)) continue;
        candidate.sources = [
          ...candidate.sources.filter((item) => item.taskId !== input.taskId),
          source
        ].slice(-8);
        candidate.supportCount = new Set(candidate.sources.map((item) => item.taskId)).size;
        candidate.updatedAt = now;
        candidate.verified = candidate.sources.filter((item) => item.verified).length >= 3;
        candidate.revision++;
        if (!document.autoActivate || candidate.supportCount < 3 || !candidate.verified) continue;
        const limit = change.kind === "experience" ? PROJECT_EXPERIENCE_MAX_ITEMS : PROJECT_SKILL_MAX_ITEMS;
        if (
          !target &&
          document.entries.filter((item) => item.kind === change.kind && item.state !== "rejected").length >=
            limit
        )
          continue;
        if (target) {
          this.version(target, change, now);
          target.sources = candidate.sources;
          target.supportCount = candidate.supportCount;
        } else {
          const entry = this.asEntry(candidate, "active");
          document.entries.push(entry);
        }
        document.candidates = document.candidates.filter((item) => item.id !== candidate.id);
        activated++;
      }
      document.candidates = document.candidates.slice(-30);
      if (input.jobId) {
        document.pending = document.pending.filter((item) => item.id !== input.jobId);
        document.processed = [
          ...document.processed.filter((item) => item !== input.jobId),
          input.jobId
        ].slice(-100);
      }
      this.assertBudget(document);
      return activated;
    });
  }
}
