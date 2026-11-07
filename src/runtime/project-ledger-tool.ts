import { createProjectLedgerClient } from "./project-ledger-client.js";

export interface ProjectLedgerToolOptions {
  dashboardUrl: string;
  taskId: string;
  token?: string;
}

const ID = { type: "string", minLength: 1, maxLength: 300 };

/**
 * The Main tool over the project ledger.
 *
 * Kept out of the Pi extension so the production path — this executor and its
 * real HTTP bridge — can be exercised without a model. The extension only
 * registers it.
 */
export function createProjectLedgerTool(options: ProjectLedgerToolOptions) {
  const client = createProjectLedgerClient(options);
  return {
    name: "project_ledger",
    label: "Project Ledger",
    description:
      "The current project's requirement ledger. Query it before recording anything, so one need keeps one requirement. create records a new internal requirement; it does not create a board item. update appends a revision and must carry the revision you last read. decide records a settled decision; set_decision_effective retracts or restores one. The current project comes from this conversation, so no project id is accepted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "get", "create", "update", "decide", "set_decision_effective"]
        },
        q: { type: "string", description: "query: match requirement title or content." },
        status: { type: "string", enum: ["open", "delivered", "withdrawn"] },
        requirementId: { ...ID, description: "get/update/decide/set_decision_effective target." },
        decisionId: { ...ID, description: "set_decision_effective target." },
        expectedRevision: {
          type: "integer",
          minimum: 1,
          description: "The revision returned by the last read; a stale value is refused."
        },
        title: { type: "string", maxLength: 200 },
        content: { type: "string", maxLength: 20000 },
        note: { type: "string", maxLength: 2000, description: "Why this revision happened." },
        sourceKind: { type: "string", enum: ["internal", "external", "legacy"] },
        sourceReference: { type: "string", maxLength: 300, description: "Opaque external label." },
        text: { type: "string", maxLength: 4000, description: "decide: the decision itself." },
        effective: { type: "boolean", description: "decide defaults true; retract with false." }
      },
      required: ["action"],
      additionalProperties: false
    },
    async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const action = input.action;
      const source =
        input.sourceKind === undefined && input.sourceReference === undefined
          ? undefined
          : {
              kind: input.sourceKind ?? "internal",
              ...(input.sourceReference ? { reference: input.sourceReference } : {})
            };
      if (action === "query")
        return client.request({
          action,
          ...(input.q === undefined ? {} : { q: input.q }),
          ...(input.status === undefined ? {} : { status: input.status })
        });
      if (action === "get") return client.request({ action, requirementId: input.requirementId });
      if (action === "create")
        return client.request({
          action,
          title: input.title,
          content: input.content,
          ...(source ? { source } : {}),
          // The requirement remembers which conversation raised it.
          references: [{ kind: "task", value: options.taskId }]
        });
      if (action === "update")
        return client.request({
          action,
          requirementId: input.requirementId,
          expectedRevision: input.expectedRevision,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.content === undefined ? {} : { content: input.content }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.note === undefined ? {} : { note: input.note }),
          taskId: options.taskId
        });
      if (action === "decide")
        return client.request({
          action,
          requirementId: input.requirementId,
          expectedRevision: input.expectedRevision,
          text: input.text,
          ...(input.effective === undefined ? {} : { effective: input.effective }),
          ...(source ? { source } : {})
        });
      if (action === "set_decision_effective")
        return client.request({
          action,
          requirementId: input.requirementId,
          decisionId: input.decisionId,
          expectedRevision: input.expectedRevision,
          effective: input.effective
        });
      throw new Error(`未知的台账操作：${String(action)}`);
    }
  };
}
