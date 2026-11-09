import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { atriaRoleIdentity } from "../domain/agent-identity.js";
import { dirname, join, resolve } from "node:path";
import {
  id,
  now,
  type CompletionPolicy,
  type Event,
  type TaskCompletion,
  type TaskStatus
} from "../domain/types.js";
import { JsonlEventStore } from "../storage/event-store.js";
import { TraceRecorder } from "../storage/trace-recorder.js";
import { LocalWorkspaceStore, type Artifact } from "../workspace/workspace-store.js";
import type { RuntimeTool } from "./tool.js";
import type { ModelSampling } from "./model-profile.js";
import type { ContextCompactionSettings } from "./context-compaction.js";
import { PiSession, type PiSessionResult, type PiThinkingLevel } from "./pi-session.js";
import { createUserMemoryTool } from "./user-memory-tools.js";
import { UserMemoryStore, userMemoryContext } from "./user-memory-store.js";
import { ProjectExperienceStore, projectExperienceIdentity } from "./project-experience-store.js";
import { projectExperienceContext } from "./project-experience-context.js";
import { enqueueProjectExperienceRun } from "./project-experience-learning.js";
import { createLoadSkillTool, discoverSkills } from "./skill-registry.js";
import { createUserMemoryLearningService } from "./user-memory-learning.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CheckpointStore } from "./scheduler.js";
import { parkBackgroundWatchGoal } from "./watch-main-lifecycle.js";
import { emptyCompaction, readAgentCheckpoint, type PersistedAgentState } from "./agent-checkpoint.js";
import { createSubagentStatusTool } from "./progress.js";
import { ensureMainContext, mainContextPaths, persistMainContext, readMainMemory } from "./main-context.js";
import { listTaskArtifacts } from "../workspace/artifact-store.js";
import {
  configuredModelApi,
  configuredThinkingFormat,
  type CoworkModelApi,
  type CoworkThinkingFormat,
  configuredReasoningEffort,
  configuredSupportsReasoningEffort,
  configuredSupportsPromptCacheKey,
  configuredSupportsImages,
  normalizeReasoningEffort
} from "./runtime-settings.js";

export interface PiRunInput {
  taskId: string;
  runId: string;
  agentId?: string;
  prompt: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  thinkingLevel?: PiThinkingLevel;
  api?: CoworkModelApi;
  thinkingFormat?: CoworkThinkingFormat;
  supportsReasoningEffort?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsImages?: boolean;
  maxTurns?: number;
  maxTokens?: number;
  contextWindow?: number;
  sampling?: ModelSampling;
  compaction?: Partial<ContextCompactionSettings>;
  maxToolResponseChars?: number;
  /** Bound provider stream retries independently of completed model turns. */
  maxErrorRetries?: number;
  maxLengthContinuations?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Legacy metadata; a completed model response no longer requires finish_task. */
  completionPolicy?: CompletionPolicy;
  /** Resume a running checkpoint instead of appending the prompt again. */
  resume?: boolean;
  tools: (
    workingDirectory: string,
    workspaceDirectory?: string,
    artifactDirectory?: string
  ) => ReadonlyMap<string, RuntimeTool>;
  prepare?: (workingDirectory: string) => Promise<void>;
  systemPrompt?: string;
  agentTools?: AgentTool[];
  toolExecution?: "sequential" | "parallel";
  /** Project-scoped memories are omitted unless the caller identifies the project. */
  projectDirectory?: string;
}

export interface PiRunResult extends PiSessionResult {
  taskId: string;
  runId: string;
  workingDirectory: string;
  artifacts: Artifact[];
  diagnostics?: { tracePath: string; resultPath: string };
  taskStatus: TaskStatus;
  completion: TaskCompletion;
}

/** Owns the formal Task/Run boundary around a native Pi session. */
export class RunService {
  private readonly workspace: LocalWorkspaceStore;

  constructor(private readonly workspaceRoot: string) {
    this.workspace = new LocalWorkspaceStore(workspaceRoot);
  }

  async runPi(input: PiRunInput): Promise<PiRunResult> {
    const userMemory = new UserMemoryStore();
    const isMain = (input.agentId ?? "main") === "main";
    try {
      // eslint-disable-next-line no-restricted-syntax -- 前台租约只是用户记忆调度的提示，登记失败不能让本次 Run 无法开始
      if (isMain) await userMemory.taskForegroundActive(input.taskId, input.runId).catch(() => {});
      return await this.runPiSession(input, userMemory);
    } finally {
      // Initialization and prepare can fail before a Pi session exists. Release
      // only this Run's foreground lease, leaving any newer Run's lease intact.
      // eslint-disable-next-line no-restricted-syntax -- 释放租约失败不能覆盖本次 Run 的返回值或异常；租约按 Run 归属，下一次 Run 会重新登记
      if (isMain) await userMemory.taskForegroundIdle(input.taskId, input.runId).catch(() => {});
    }
  }

  private async runPiSession(input: PiRunInput, userMemory: UserMemoryStore): Promise<PiRunResult> {
    const thinkingLevel = normalizeReasoningEffort(input.thinkingLevel ?? configuredReasoningEffort());
    const api = input.api ?? configuredModelApi();
    const thinkingFormat = input.thinkingFormat ?? configuredThinkingFormat();
    const supportsReasoningEffort = input.supportsReasoningEffort ?? configuredSupportsReasoningEffort();
    const supportsPromptCacheKey = input.supportsPromptCacheKey ?? configuredSupportsPromptCacheKey();
    const supportsImages = input.supportsImages ?? configuredSupportsImages();
    const agentId = input.agentId ?? "main";
    await this.workspace.createTask(input.taskId, {
      ...(agentId === "main" && input.projectDirectory
        ? { projectDirectory: resolve(input.projectDirectory) }
        : {}),
      goal: input.prompt,
      completion: { policy: input.completionPolicy ?? "natural", signal: "none" }
    });
    if (input.completionPolicy) {
      await this.workspace.updateTask(input.taskId, { completion: { policy: input.completionPolicy } });
    }
    const projectIdentity =
      agentId === "main"
        ? projectExperienceIdentity(await this.workspace.readTask(input.taskId), input.projectDirectory)
        : undefined;
    const projectExperience = projectIdentity ? new ProjectExperienceStore(projectIdentity) : undefined;
    const runPath = await this.workspace.createRun(input.taskId, input.runId);
    const workingDirectory = await this.workspace.prepareAgentWorkDir(input.taskId, input.runId, agentId);
    const mainContext = agentId === "main" ? mainContextPaths(this.workspaceRoot, input.taskId) : undefined;
    if (mainContext) await ensureMainContext(mainContext);
    const durableMemory = mainContext ? await readMainMemory(mainContext) : "";
    const events = new JsonlEventStore(join(runPath, "run_events.jsonl"));
    const checkpointStore = new CheckpointStore(join(runPath, "checkpoint.json"));
    const previous = await checkpointStore.load(input.runId);
    const restored = readAgentCheckpoint(previous?.state);
    if (restored?.status === "succeeded" && input.resume !== false) {
      throw new Error(`run ${input.runId} is already completed; choose a new run id`);
    }
    const shouldResume = input.resume ?? Boolean(restored && restored.status === "running");
    if (agentId === "main" && !shouldResume) {
      await userMemory
        .enqueueForegroundLearning({
          taskId: input.taskId,
          runId: input.runId,
          text: input.prompt,
          projectDirectory: input.projectDirectory
        })
        // eslint-disable-next-line no-restricted-syntax -- 前台记忆入队是后台整理的可选步骤，失败只影响这一轮记忆学习，Run 的会话与事件已落盘
        .catch(() => {});
    }
    let checkpointSequence = previous?.sequence ?? 0;
    const saveCheckpoint = async (state: PersistedAgentState): Promise<void> => {
      checkpointSequence += 1;
      await checkpointStore.save({ runId: input.runId, sequence: checkpointSequence, state, savedAt: now() });
      if (mainContext) await persistMainContext(mainContext, state.messages);
    };
    await this.appendEvent(events, input, agentId, "run.started", {
      model: input.model ?? "glm-5.3",
      thinkingLevel,
      api,
      thinkingFormat,
      supportsReasoningEffort,
      supportsPromptCacheKey,
      supportsImages,
      resumed: shouldResume
    });
    if (shouldResume) {
      await this.appendEvent(events, input, agentId, "run.resumed", {
        checkpointSequence: previous?.sequence ?? 0,
        restoredStatus: restored?.status
      });
    }
    if (!shouldResume) {
      await saveCheckpoint({
        version: 1,
        status: "running",
        prompt: input.prompt,
        messages: [],
        compaction: emptyCompaction()
      });
      await input.prepare?.(workingDirectory);
    }
    const tracePath = this.workspace.sessionPath(input.taskId, input.runId, agentId);
    const trace = new TraceRecorder(tracePath);
    const diagnostics = {
      tracePath: `sessions/${agentId}/${input.runId}.jsonl`,
      resultPath: `runs/${input.runId}/agents/${agentId === "main" || agentId === "coordinator" ? agentId : `subagents/${agentId}`}/result.json`
    };
    const resultPath = join(this.workspaceRoot, input.taskId, diagnostics.resultPath);
    const artifactDirectory =
      agentId === "main" ? resolve(this.workspaceRoot, input.taskId, "artifacts") : undefined;
    let session: PiSession | undefined;
    let recoverableInterruption = false;
    const memoryLearning =
      agentId === "main"
        ? createUserMemoryLearningService({
            store: userMemory,
            connection: () => ({
              baseUrl: input.baseUrl,
              apiKey: input.apiKey,
              model: input.model,
              api,
              thinkingFormat,
              thinkingLevel,
              supportsReasoningEffort,
              maxTokens: input.maxTokens,
              contextWindow: input.contextWindow
            }),
            isTaskActive: (id) => id === input.taskId,
            // This service lives only while its Main Run owns the foreground.
            isForegroundActive: () => true
          })
        : undefined;
    try {
      memoryLearning?.start();
      const agentTools = input.agentTools ?? [];
      const hasStatusTool = agentTools.some((tool) => tool.name === "get_subagent_status");
      const tools = new Map(
        input.tools(workingDirectory, join(this.workspaceRoot, input.taskId), artifactDirectory)
      );
      if (agentId === "main") {
        if (tools.has("manage_user_memory") || agentTools.some((tool) => tool.name === "manage_user_memory"))
          throw new Error("manage_user_memory is reserved for the Main user memory service");
        tools.set(
          "manage_user_memory",
          createUserMemoryTool({
            taskId: input.taskId,
            runId: input.runId,
            projectDirectory: input.projectDirectory,
            userText: () => (shouldResume ? "" : input.prompt)
          })
        );
      }
      let projectSkillToolAvailable = tools.has("load_skill");
      try {
        projectSkillToolAvailable ||= Boolean((await projectExperience?.readProfile())?.skills.length);
        // eslint-disable-next-line no-restricted-syntax -- 经验库是可选的，读取失败按没有学到技能处理，load_skill 仍按普通技能可用
      } catch {
        /* Optional knowledge never adds a broken tool. */
      }
      if (projectExperience && projectSkillToolAvailable) {
        const originalLoad = tools.get("load_skill");
        const learned = createLoadSkillTool([]);
        tools.set("load_skill", {
          ...(originalLoad ?? learned),
          async execute(params) {
            const name =
              params && typeof params === "object" ? (params as { name?: unknown }).name : undefined;
            if (typeof name !== "string" || !/^learned-[a-f0-9-]{36}$/.test(name)) {
              return originalLoad ? originalLoad.execute(params) : learned.execute(params);
            }
            try {
              const profile = await projectExperience.readProfile();
              const skills = await discoverSkills(profile.skills.map((skill) => skill.path));
              if (skills.some((skill) => skill.name === name))
                return await createLoadSkillTool(skills).execute(params);
              // eslint-disable-next-line no-restricted-syntax -- 可选经验库读取失败时回退到内置技能，随后的 unknown skill 错误仍会把失败告知模型
            } catch {
              /* Failed optional knowledge never changes normal skills. */
            }
            throw new Error(`unknown skill: ${name}`);
          }
        });
      }
      session = new PiSession({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        thinkingLevel,
        api,
        thinkingFormat,
        supportsReasoningEffort,
        supportsPromptCacheKey,
        supportsImages,
        systemPrompt:
          agentId === "main"
            ? withMainMemoryInstructions(input.systemPrompt, durableMemory, artifactDirectory!)
            : input.systemPrompt,
        tools,
        ...(agentId === "main"
          ? {
              prepareProjectExperience: async () => {
                try {
                  return projectExperience
                    ? await projectExperienceContext(projectExperience, projectSkillToolAvailable)
                    : "";
                  // eslint-disable-next-line no-restricted-syntax -- 项目经验是可选上下文，读取失败时该段落留空，模型仍按原有系统提示继续
                } catch {
                  return "";
                }
              },
              prepareUserMemory: async () => {
                try {
                  return await userMemoryContext(new UserMemoryStore(), input.projectDirectory);
                  // eslint-disable-next-line no-restricted-syntax -- 用户记忆是可选上下文，读取失败时该段落留空，本次 Run 仍要正常进行
                } catch {
                  return "";
                }
              }
            }
          : {}),
        agentTools: hasStatusTool
          ? agentTools
          : [
              createSubagentStatusTool({
                workspaceRoot: this.workspaceRoot,
                taskId: input.taskId,
                runId: input.runId
              }),
              ...agentTools
            ],
        toolExecution: input.toolExecution,
        maxTurns: input.maxTurns,
        maxTokens: input.maxTokens,
        contextWindow: input.contextWindow,
        sampling: input.sampling,
        compaction: input.compaction,
        maxToolResponseChars: input.maxToolResponseChars,
        maxErrorRetries: input.maxErrorRetries,
        maxLengthContinuations: input.maxLengthContinuations,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        initialMessages: restored?.messages,
        initialCompaction: restored?.compaction,
        onCheckpoint: async (checkpoint) =>
          saveCheckpoint({
            version: 1,
            status: checkpoint.status,
            prompt: restored?.prompt ?? input.prompt,
            messages: checkpoint.messages,
            compaction: checkpoint.compaction
          }),
        trace: { recorder: trace, taskId: input.taskId, runId: input.runId, agentId }
      });
      const result = await session.run(input.prompt, { resume: shouldResume });
      await this.saveSessionResult(resultPath, result);
      const artifacts = await listTaskArtifacts({
        workspaceRoot: this.workspaceRoot,
        taskId: input.taskId,
        runId: input.runId
      });
      if (result.termination !== "completed") {
        // Keep the checkpoint resumable and retain diagnostics even when
        // the wall-clock deadline or provider abort fires after useful work.
        // The caller still receives a non-zero error, but the Task remains in
        // `waiting` instead of being converted into an unrecoverable failure.
        recoverableInterruption = true;
        await saveCheckpoint({
          version: 1,
          status: "running",
          prompt: restored?.prompt ?? input.prompt,
          messages: result.messages,
          compaction: result.compaction
        });
        await this.appendEvent(events, input, agentId, "run.interrupted", {
          termination: result.termination,
          error: result.error,
          artifacts: artifacts.map((artifact) => artifact.artifactId),
          diagnostics,
          resumable: true
        });
        if (agentId === "main") {
          try {
            await this.workspace.transitionTask(input.taskId, "waiting", {
              runId: input.runId,
              reason: `main_run_${result.termination}_resumable`,
              completion: { signal: "interrupted" }
            });
            // eslint-disable-next-line no-restricted-syntax -- 紧接着要抛出携带终止原因的 interruption 错误，任务状态写入失败不能替换它
          } catch {
            /* preserve the original interruption */
          }
        }
        throw new Error(
          `main agent ${result.termination} before completing the run${result.error ? `: ${result.error}` : ""}; checkpoint retained for --resume (diagnostics: ${diagnostics.tracePath}, ${diagnostics.resultPath}; artifacts: ${artifacts.map((artifact) => artifact.relativePath).join(", ")})`
        );
      }
      const task = await this.workspace.readTask(input.taskId);
      const completion = task.completion ?? { policy: input.completionPolicy ?? "natural", signal: "none" };
      const monitoring =
        agentId === "main" && (await parkBackgroundWatchGoal(this.workspaceRoot, input.taskId, input.runId));
      const completedTask =
        agentId === "main"
          ? await this.workspace.transitionTask(input.taskId, monitoring ? "waiting" : "completed", {
              runId: input.runId,
              reason: monitoring
                ? "parked_for_wake"
                : completion.signal === "finish_task"
                  ? "finish_task"
                  : "main_run_completed",
              completion: {
                signal: completion.signal === "finish_task" ? "finish_task" : "natural_stop",
                verifiedAt:
                  completion.signal === "finish_task"
                    ? (completion.verifiedAt ?? now())
                    : completion.verifiedAt
              }
            })
          : task;
      await saveCheckpoint({
        version: 1,
        status: "succeeded",
        prompt: restored?.prompt ?? input.prompt,
        messages: result.messages,
        compaction: result.compaction
      });
      await this.appendEvent(events, input, agentId, "run.completed", {
        artifacts: artifacts.map((artifact) => artifact.artifactId),
        stopReason: result.assistant?.stopReason,
        diagnostics,
        completionSignal: completedTask.completion?.signal
      });
      if (projectExperience && completedTask.status === "completed") {
        await enqueueProjectExperienceRun({
          store: projectExperience,
          identity: projectExperience.identity,
          workspaceRoot: this.workspaceRoot,
          taskId: input.taskId,
          runId: input.runId
          // eslint-disable-next-line no-restricted-syntax -- Run 已提交完成，经验入队是后台整理，失败时只是少一条待学习记录
        }).catch(() => {});
      }
      return {
        ...result,
        taskId: input.taskId,
        runId: input.runId,
        workingDirectory,
        artifacts,
        diagnostics,
        taskStatus: completedTask.status,
        completion: completedTask.completion!
      };
    } catch (error) {
      if (recoverableInterruption) throw error;
      await this.saveSessionResult(resultPath, {
        termination: "failed",
        messages: session?.agent.state.messages ?? [],
        error: error instanceof Error ? error.message : String(error)
        // eslint-disable-next-line no-restricted-syntax -- 正在上抛原始执行失败，诊断结果写不进去不能替换或吞掉这个错误
      }).catch(() => {
        /* Preserve the original execution failure if diagnostics cannot be written. */
      });
      if (session) {
        await saveCheckpoint({
          version: 1,
          status: "failed",
          prompt: restored?.prompt ?? input.prompt,
          messages: session.agent.state.messages,
          compaction: session.compactionState
        });
      }
      await this.appendEvent(events, input, agentId, "run.failed", {
        error: error instanceof Error ? error.message : String(error),
        diagnostics
      });
      if (agentId === "main") {
        try {
          await this.workspace.transitionTask(input.taskId, "failed", {
            runId: input.runId,
            error: error instanceof Error ? error.message : String(error),
            reason: "main_run_failed"
          });
          // eslint-disable-next-line no-restricted-syntax -- 正在上抛原始 Run 失败，任务状态写入失败不能替换它
        } catch {
          /* preserve the original run failure */
        }
      }
      throw error;
    } finally {
      await memoryLearning?.stop();
    }
  }

  private async saveSessionResult(
    path: string,
    result: {
      messages: unknown[];
      assistant?: { stopReason?: unknown };
      termination?: string;
      lastStopReason?: PiSessionResult["lastStopReason"];
      continuations?: PiSessionResult["continuations"];
      error?: string;
    }
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${id("tmp")}`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ termination: result.termination, stopReason: result.lastStopReason ?? result.assistant?.stopReason, continuations: result.continuations, error: result.error, messages: result.messages }, null, 2)}\n`,
        "utf8"
      );
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async appendEvent(
    events: JsonlEventStore,
    input: PiRunInput,
    agentId: string,
    type: string,
    payload: unknown
  ): Promise<void> {
    const event: Event = {
      eventId: id("event"),
      type,
      taskId: input.taskId,
      runId: input.runId,
      agentId,
      occurredAt: now(),
      payload
    };
    await events.append(event);
  }
}

function withMainMemoryInstructions(
  systemPrompt: string | undefined,
  memory: string,
  artifactDirectory: string
): string {
  const durableState = memory.trim()
    ? memory.slice(0, 32_000)
    : "(empty — initialize it when this task has durable state worth carrying forward)";
  return [
    systemPrompt ??
      `${atriaRoleIdentity("Main")} Inspect the workspace, make minimal changes, and run tests.`,
    "",
    "Final deliverables (Main only):",
    "- Only files in the Task artifacts/ directory are user-facing deliverables. Put accepted final files there using the normal file tools with artifacts/<filename> and a clear human-readable filename.",
    `- The absolute Task artifacts directory is ${artifactDirectory}. Command tools run in your private working directory; use this absolute destination when copying or generating final files with commands.`,
    "- Subagent outputFiles are candidate files in their private deliverables/ directories, accessible through browse_workspace. Review or integrate them, then copy accepted final files into Task artifacts/ with existing file/command tools.",
    "- Keep briefs, drafts, scripts, renders, intermediate logs and other working files in your private work/, deliverables/ or logs/ directories unless the user requested them as deliverables. Runtime diagnostics are stored separately under sessions/ and runs/.",
    "",
    "Durable task state (Main only):",
    "- Maintain context/memory.md directly with the normal write_file or apply_patch tools.",
    "- Keep it concise: Goal, Completed, Next, and Important information/constraints.",
    "- Update it after a meaningful milestone, before handing off a multi-stage task, or before finishing work that may need to be resumed. Do not turn it into a verbose process log.",
    "- context/messages.json is the framework's complete transcript backup and context/state.json is framework bookkeeping; do not edit either file.",
    "- The current durable task state is below. Treat it as working notes, verify it against the workspace, and update it when it becomes stale:",
    "```markdown",
    durableState,
    "```"
  ].join("\n");
}
