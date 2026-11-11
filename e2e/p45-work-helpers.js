import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Create a project that the sidebar must list independently of the default one. */
export async function createProject(page, dashboard, projectName, projectDirectory) {
  await mkdir(projectDirectory, { recursive: true });
  const response = await page.request.post(`${dashboard.base}/api/projects`, {
    data: { projectName, projectDirectory }
  });
  if (!response.ok()) throw new Error(`project creation failed: ${response.status()}`);
  return (await response.json()).project;
}

/** Create one Main session through the public Task contract. */
export async function createTask(page, dashboard, { taskId, goal, projectId }) {
  const response = await page.request.post(`${dashboard.base}/api/tasks`, {
    data: { taskId, goal, projectId }
  });
  if (!response.ok()) throw new Error(`task creation failed: ${response.status()}`);
  return (await response.json()).task;
}

/**
 * Give a real Task the durable files a running Main would have written.
 *
 * The catalog derives Subagents from the queue and their names from the same
 * reservation records the product uses, so the sidebar test reads the real
 * projection instead of a rewritten response.
 */
export async function markTaskRunning(dashboard, { taskId, runId, subagents = [] }) {
  const taskPath = join(dashboard.workspaceRoot, taskId, "task.json");
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  const timestamp = new Date().toISOString();
  await writeFile(
    taskPath,
    `${JSON.stringify({ ...task, status: "running", activeRunId: runId, updatedAt: timestamp }, null, 2)}\n`
  );
  const runRoot = join(dashboard.workspaceRoot, taskId, "runs", runId);
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, "run.json"), `${JSON.stringify({ createdAt: timestamp })}\n`);
  if (!subagents.length) return;
  await writeFile(
    join(runRoot, "queue.json"),
    `${JSON.stringify(
      subagents.map(({ agentId, role, state = "completed" }) => ({
        stepId: `call-${agentId}`,
        agentId,
        status: state,
        createdAt: timestamp,
        updatedAt: timestamp,
        payload: { delegation: { role } }
      })),
      null,
      2
    )}\n`
  );
}

/** Write a pending human question exactly where the Dashboard reads it. */
export async function writeHumanQuestion(
  dashboard,
  { taskId, runId, requestId = "question-1", question, options }
) {
  const directory = join(dashboard.workspaceRoot, taskId, "human", "requests");
  await mkdir(directory, { recursive: true });
  const request = {
    requestId,
    taskId,
    runId,
    question,
    ...(options ? { options } : {}),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  await writeFile(join(directory, `${requestId}.json`), `${JSON.stringify(request, null, 2)}\n`);
  return request;
}
