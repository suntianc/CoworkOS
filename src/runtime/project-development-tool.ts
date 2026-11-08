import { createProjectDevelopmentClient } from "./project-development-client.js";

export interface ProjectDevelopmentToolOptions {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}

const ID = { type: "string", minLength: 1, maxLength: 300 };

/**
 * The Main tool over requirement development records.
 *
 * Kept out of the Pi extension so the production path — this executor and its
 * real HTTP bridge — can be exercised without a model. The extension only
 * registers it.
 */
export function createProjectDevelopmentTool(options: ProjectDevelopmentToolOptions) {
  // The bridge is built on first call. Registration must not depend on this
  // run's credential: a delegated subprocess keeps the Dashboard URL while the
  // run credential is removed, and a missing credential must disable only this
  // tool rather than abort every later registration in the extension.
  let client: ReturnType<typeof createProjectDevelopmentClient> | undefined;
  const bridge = () => (client ??= createProjectDevelopmentClient(options));
  return {
    name: "project_development",
    label: "Project Development",
    description:
      "The current project's requirement development records. create records the goal, completion criteria, suggested route and the code baseline, then prepares this backend's isolated Git checkout for the requirement; one record exists per requirement, so read it before creating. get/query read records back, find_by_requirement looks one up for a requirement, update appends a new revision (carry the revision you last read), and ensure_workspace continues or repairs the existing checkout at its recorded baseline. The current project and Task come from this conversation, so no project id or path is accepted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "get", "query", "find_by_requirement", "update", "ensure_workspace"]
        },
        requirementId: { ...ID, description: "create/find_by_requirement target requirement." },
        developmentId: { ...ID, description: "get/update/ensure_workspace target." },
        goal: {
          type: "string",
          maxLength: 4000,
          description: "create/update: what this development must achieve."
        },
        completionCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 1000 },
          description: "create/update: observable conditions that make the requirement done."
        },
        route: {
          type: "string",
          enum: ["quick", "direct", "full"],
          description: "The suggested path: quick, direct or full. A suggestion, not a quota."
        },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "update: the revision returned by the last read; a stale value is refused."
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const action = typeof input.action === "string" ? input.action : "";
      const request = bridge();
      if (action === "create")
        return request({
          action,
          requirementId: input.requirementId,
          goal: input.goal,
          completionCriteria: input.completionCriteria,
          route: input.route
        });
      if (action === "get") return request({ action, developmentId: input.developmentId });
      if (action === "query") return request({ action });
      if (action === "find_by_requirement") return request({ action, requirementId: input.requirementId });
      if (action === "update")
        return request({
          action,
          developmentId: input.developmentId,
          expectedRevision: input.expectedRevision,
          ...(input.goal === undefined ? {} : { goal: input.goal }),
          ...(input.completionCriteria === undefined ? {} : { completionCriteria: input.completionCriteria }),
          ...(input.route === undefined ? {} : { route: input.route })
        });
      if (action === "ensure_workspace") return request({ action, developmentId: input.developmentId });
      throw new Error(`未知的开发记录操作：${String(action)}`);
    }
  };
}
