import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { readHostCoworkConfig, type CoworkConfig } from "../runtime/config.js";
import { ExperimentProgramStore } from "../runtime/experiment-program-store.js";
import { resolveModelRole } from "../runtime/role-models.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { createSubagentBackend, type SubagentBackend } from "../dashboard/subagent-backend.js";
import { handleSubagentRequest } from "../dashboard/subagent-routes.js";
import { HttpError, sendJson } from "../dashboard/http.js";
import type { TaskLocation } from "../dashboard/workspace-directory.js";

/**
 * The backend a CLI host serves for its own Main.
 *
 * A run with no Dashboard still delegates through a backend: this host claims
 * the workspace root, registers work items and launches them as real Pi
 * processes, and answers Main over a loopback endpoint scoped to one Task.
 * Main never starts a Subagent itself, so the model loop and the delegation
 * rules are the same code the Dashboard runs.
 */
export interface SubagentHostOptions {
  workspaceRoot: string;
  /** Install root the shared launcher and extension are read from. */
  projectRoot: string;
  config?: CoworkConfig;
  configPath?: string;
  piAgentDir?: string;
  pollMs?: number;
  leaseMs?: number;
}

export interface SubagentHost {
  /** Loopback origin Main addresses; never a public interface. */
  url: string;
  /** Per-process credential Main presents; unrelated to the host API token. */
  token: string;
  close(): Promise<void>;
}

export async function openSubagentHost(options: SubagentHostOptions): Promise<SubagentHost | undefined> {
  // A role binding is read when a work item actually starts, so the host
  // re-reads the saved configuration instead of freezing it at startup.
  const initialConfig = options.config ?? readHostCoworkConfig(options.projectRoot);
  let config = initialConfig;
  const currentConfig = (): CoworkConfig => {
    if (options.config) return options.config;
    config = readHostCoworkConfig(options.projectRoot);
    return config;
  };
  const store = new LocalWorkspaceStore(options.workspaceRoot);
  const locateTask = async (taskId: string): Promise<TaskLocation> => {
    const task = await store.readTask(taskId);
    return {
      workspaceRoot: options.workspaceRoot,
      store,
      task,
      projectId: task.projectId ?? "",
      projectName: "",
      projectDirectory: task.projectDirectory ?? options.workspaceRoot
    };
  };
  const backend = createSubagentBackend({
    projectRoot: options.projectRoot,
    // A CLI host has no Dashboard origin; the subagent route below is the one
    // endpoint Main uses and it never proxies anywhere else.
    dashboardUrl: "",
    ownerKind: "worker",
    locateTask,
    workspaceRoots: async () => [options.workspaceRoot],
    config: currentConfig,
    resolveMainModel: (request) => resolveModelRole(currentConfig(), request),
    // Requirements and uploads are Dashboard features; a CLI run exposes
    // neither, so a request that names one is refused instead of half-served.
    // The experiment ledger is runtime bookkeeping, so it works the same here.
    development: async () => undefined,
    frozenCandidate: async () => undefined,
    experiment: async ({ taskId, callId, agentId, objective }) =>
      await new ExperimentProgramStore(options.workspaceRoot).openRun({
        taskId,
        callId,
        agentId,
        objective
      }),
    grants: async () => {
      throw new Error("本次运行没有可用的上传服务；CLI 运行不能按附件授予能力");
    },
    ...(options.configPath ? { configPath: () => options.configPath } : {}),
    ...(options.piAgentDir ? { piAgentDir: () => options.piAgentDir } : {}),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs })
  });
  await backend.start();
  if (!backend.ownership(options.workspaceRoot)?.owned) {
    await backend.stop();
    return undefined;
  }
  const token = randomBytes(32).toString("hex");
  let server: Server | undefined;
  try {
    server = createServer((request, response) => {
      void answer(request, response, backend, token).catch((error) => {
        // A connection the client already abandoned cannot take a response;
        // anything else is answered with the status the failure carries.
        if (response.headersSent) response.destroy();
        else fail(response, error);
      });
    });
    await listen(server);
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      token,
      close: async () => {
        // Main keeps its HTTP connection alive between turns; closing the
        // listener alone would wait for that socket, not for this host.
        await new Promise<void>((done) => {
          server!.close(() => done());
          server!.closeAllConnections();
        });
        await backend.stop();
      }
    };
  } catch (error) {
    server?.close();
    await backend.stop();
    throw error;
  }
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  backend: SubagentBackend,
  token: string
): Promise<void> {
  if (request.headers["x-atria-token"] !== token) throw new HttpError(401, "unauthorized");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (await handleSubagentRequest(request, response, url, { backend })) return;
  throw new HttpError(404, "not found");
}

function fail(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  sendJson(response, status, {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof HttpError && error.code ? { code: error.code } : {})
  });
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
}
