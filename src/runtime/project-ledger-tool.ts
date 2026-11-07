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
  // The bridge is built on first call. Registration must not depend on this
  // run's credential: a delegated subprocess keeps the Dashboard URL while the
  // run credential is removed, and a missing credential must disable only this
  // tool rather than abort every later registration in the extension.
  let client: ReturnType<typeof createProjectLedgerClient> | undefined;
  const bridge = () => (client ??= createProjectLedgerClient(options));
  return {
    name: "project_ledger",
    label: "Project Ledger",
    description:
      "The current project's requirement ledger and board. Query the ledger before recording anything, so one need keeps one requirement. create records a new internal requirement; it does not create a board item. update appends a revision and must carry the revision you last read. decide records a settled decision; set_decision_effective retracts or restores one. board lists published demands; claim_board claims one as this Task, while pause_board/release_board/cancel_board act only on what this conversation owns. The current project and Task come from this conversation, so no project id or path is accepted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "query",
            "get",
            "create",
            "update",
            "decide",
            "set_decision_effective",
            "board",
            "claim_board",
            "pause_board",
            "release_board",
            "cancel_board"
          ]
        },
        q: { type: "string", description: "query: match requirement title or content." },
        status: { type: "string", enum: ["open", "delivered", "withdrawn"] },
        requirementId: { ...ID, description: "get/update/decide/set_decision_effective target." },
        decisionId: { ...ID, description: "set_decision_effective target." },
        boardId: { ...ID, description: "claim_board/pause_board/release_board/cancel_board target." },
        requestId: {
          type: "string",
          maxLength: 200,
          description: "Optional retry identity for a board write; a repeat returns the committed result."
        },
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
      const action = typeof input.action === "string" ? input.action : "";
      const client = bridge();
      const request = client.request;
      const source =
        input.sourceKind === undefined && input.sourceReference === undefined
          ? undefined
          : {
              kind: input.sourceKind ?? "internal",
              ...(input.sourceReference ? { reference: input.sourceReference } : {})
            };
      if (action === "query")
        return request({
          action,
          ...(input.q === undefined ? {} : { q: input.q }),
          ...(input.status === undefined ? {} : { status: input.status })
        });
      if (action === "get") return request({ action, requirementId: input.requirementId });
      if (action === "create")
        return request({
          action,
          title: input.title,
          content: input.content,
          ...(source ? { source } : {}),
          // The requirement remembers which conversation raised it.
          references: [{ kind: "task", value: options.taskId }]
        });
      if (action === "update")
        return request({
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
        return request({
          action,
          requirementId: input.requirementId,
          expectedRevision: input.expectedRevision,
          text: input.text,
          ...(input.effective === undefined ? {} : { effective: input.effective }),
          ...(source ? { source } : {})
        });
      if (action === "set_decision_effective")
        return request({
          action,
          requirementId: input.requirementId,
          decisionId: input.decisionId,
          expectedRevision: input.expectedRevision,
          effective: input.effective
        });
      if (action === "board") return client.board(undefined, "GET");
      if (
        action === "claim_board" ||
        action === "pause_board" ||
        action === "release_board" ||
        action === "cancel_board"
      )
        return client.board({
          action: action.slice(0, -"_board".length),
          boardId: input.boardId,
          expectedRevision: input.expectedRevision,
          requestId:
            input.requestId ??
            `board_${String(action)}_${String(input.boardId)}_${String(input.expectedRevision)}`
        });
      throw new Error(`未知的台账操作：${String(action)}`);
    }
  };
}
