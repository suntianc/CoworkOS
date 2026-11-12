import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { jobStatus, killJob, listJobs, startJob } from "../../../dist/src/tools/jobs.js";
import { LocalWorkspaceStore } from "../../../dist/src/workspace/workspace-store.js";
import type { CoworkToolContext } from "../extension.ts";
import type { RuntimeToolResult } from "../helpers.ts";

/** jobs tools depend only on explicit runtime ports. */
export function registerJobsTools(pi: ExtensionAPI, context: CoworkToolContext) {
  pi.registerTool({
    name: "grant_capabilities",
    label: "Record Granted Capabilities",
    description:
      "Record what the user has authorized for this Task after they answered. Agents write only their own directory by default; this records a wider grant so it takes effect, persists across restarts, and stays auditable. Call it only after the user has actually agreed — this records a decision, it does not make one.",
    promptSnippet: "Record the capabilities the user authorized for this Task",
    promptGuidelines: [
      "Ask first with askhuman, then record the answer here. Never call this on your own initiative.",
      "evalPaths is the part that protects the result: whatever produces the score must stay read-only, or a later round can raise the number by editing the measurement. Record every path the user named, even when project writes are declined.",
      "Set projectWrite only when the work is to change the user's code. Reading a project needs no grant.",
      "Set longRunning when jobs take minutes or hours; it enables start_job/check_job/kill_job so a long command is supervised instead of deadlined, and sets maxAttempts to 1 so an expensive failure is not silently repeated.",
      "Record the reason in the user's own terms. It is what a later reader sees when asking why an Agent was allowed to do this."
    ],
    parameters: Type.Object({
      projectWrite: Type.Optional(
        Type.Boolean({ description: "Agents may edit the user's project, not only their own directory." })
      ),
      evalPaths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Paths that must stay read-only, relative to the project: the scorer, its fixtures, the test data."
        })
      ),
      longRunning: Type.Optional(
        Type.Boolean({ description: "Jobs take minutes or hours; supervise them rather than deadline them." })
      ),
      reason: Type.Optional(
        Type.String({ description: "What the user authorized this for, in their terms." })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const store = new LocalWorkspaceStore(context.workspaceRoot);
      const current = (await store.readTask(context.taskId)).capabilities;
      const evalPaths = [
        ...new Set([
          ...(current?.evalPaths ?? []),
          ...(Array.isArray(params.evalPaths)
            ? params.evalPaths.filter(
                (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
              )
            : [])
        ])
      ];
      const longRunning = params.longRunning === true || current?.longRunning === true;
      const capabilities = {
        projectWrite: params.projectWrite === true || current?.projectWrite === true,
        // A shell is what makes project edits usable, so it follows that grant
        // rather than being a separate question for the user.
        shell: params.projectWrite === true || current?.projectWrite === true,
        longRunning,
        ...(evalPaths.length ? { evalPaths } : {}),
        // Expensive work should surface a failure rather than repeat it.
        ...(longRunning ? { maxAttempts: 1 } : {}),
        grantedBy: "user" as const,
        grantedAt: new Date().toISOString(),
        ...(typeof params.reason === "string" && params.reason.trim() ? { reason: params.reason.trim() } : {})
      };
      await store.updateTask(context.taskId, { capabilities });
      await context.refreshCapabilities();
      context.updateRuntime({
        runtimeLastEvent: {
          type: "capabilities_granted",
          summary:
            Object.entries(capabilities)
              .filter(([, value]) => value === true)
              .map(([key]) => key)
              .join(",") || "evalPaths only"
        }
      });
      const payload = {
        ok: true,
        capabilities,
        note: longRunning
          ? "Recorded. Supervised jobs (start_job/check_job/kill_job) are available to you immediately, and to Subagents dispatched from now on; delegations will not be retried automatically."
          : "Recorded. This takes effect for Subagents dispatched from now on."
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
    }
  });

  pi.registerTool({
    name: "start_job",
    label: "Start Job",
    description:
      "Run a long command in the background and return immediately. The job gets its own process group and its output is written to a log file, so it survives this turn, a context reset and a Main restart. Use this for work measured in minutes or hours — training, large synthesis, long evaluations — instead of waiting on bash.",
    promptSnippet: "Start a long command in the background",
    promptGuidelines: [
      "Use bash for short commands. Use this when waiting for the command would stop you from reading Subagent results or callbacks.",
      "You are told when the job exits, so do not poll check_job in a loop. Do other work, or use wait_for_subagents if nothing else is pending.",
      "A job keeps this Task from completing until it exits, which is why an abandoned job must be killed rather than forgotten."
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run in the background." }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory. Defaults to the project directory when project writes are granted, otherwise your own work directory."
        })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const refusal = await context.refuseWithoutLongRunning("start_job");
      if (refusal) return refusal;
      const command = String((params as { command?: unknown }).command ?? "").trim();
      if (!command) throw new Error("start_job requires command");
      const requested = (params as { cwd?: unknown }).cwd;
      const started = await startJob({
        command,
        cwd:
          typeof requested === "string" && requested.trim()
            ? resolve(await context.jobCwd(), requested)
            : await context.jobCwd(),
        directory: context.jobsDirectory,
        shell: true
      });
      // Record it as seen so the wake only fires for the exit, not for a job
      // this call has already reported back to Main.
      context.observedJobs.add(started.jobId);
      const payload = {
        ...started,
        note: "Running in the background. You will be told when it exits; read the log with check_job when you want progress before then."
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
    }
  });

  pi.registerTool({
    name: "check_job",
    label: "Check Job",
    description:
      "Report how long a job has run, how long its log has been quiet, and the tail of its output. Omit jobId to list every job on this Task. Whether a quiet job is working or wedged is your call: a training run that logs every thirty seconds and an install stuck on a prompt look identical to a clock.",
    promptSnippet: "Check a background job's progress",
    promptGuidelines: [
      "quietMs is evidence, not a verdict. Compare it with the job's own rhythm before concluding anything.",
      "You are told when a job exits, so use this to judge progress, not to wait for completion."
    ],
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({ description: "Job to inspect. Omit to list all jobs on this Task." })
      ),
      tailBytes: Type.Optional(
        Type.Number({ description: "How much of the log tail to return. Defaults to 4000." })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const refusal = await context.refuseWithoutLongRunning("check_job");
      if (refusal) return refusal;
      const value = params as { jobId?: unknown; tailBytes?: unknown };
      const payload =
        typeof value.jobId === "string" && value.jobId
          ? await jobStatus({
              directory: context.jobsDirectory,
              jobId: value.jobId,
              tailBytes: typeof value.tailBytes === "number" ? value.tailBytes : 4_000
            })
          : { jobs: await listJobs({ directory: context.jobsDirectory }) };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
    }
  });

  pi.registerTool({
    name: "kill_job",
    label: "Kill Job",
    description:
      "Stop a background job: SIGTERM so it can clean up, then SIGKILL if it ignores that. The whole process group goes, so a training run behind a wrapper script is not left orphaned.",
    promptSnippet: "Stop a background job",
    promptGuidelines: [
      "A job that failed is experiment data. Record what the log shows before killing it.",
      "Kill a job you no longer need rather than leaving it running: an outstanding job holds this Task open."
    ],
    parameters: Type.Object({ jobId: Type.String({ description: "Job to stop." }) }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const refusal = await context.refuseWithoutLongRunning("kill_job");
      if (refusal) return refusal;
      const jobId = (params as { jobId?: unknown }).jobId;
      if (typeof jobId !== "string" || !jobId) throw new Error("kill_job requires jobId");
      const payload = await killJob({ directory: context.jobsDirectory, jobId });
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
    }
  });
}
