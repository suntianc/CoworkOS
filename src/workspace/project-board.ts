import {
  BoardAssignment,
  BoardEntry,
  BoardEvent,
  BoardHandler,
  BoardState,
  boardActorId,
  boardHandler,
  boardIdentifier,
  boardRequestId,
  boardSource,
  type BoardActionContext,
  type BoardActionInput,
  type BoardPublishInput
} from "../domain/project-board.js";
import {
  ProjectDataConflictError,
  ProjectDataError,
  ProjectDataInvalidError,
  ProjectDataNotFoundError,
  ledgerRevision,
  type LedgerSource
} from "../domain/project-ledger.js";
import { id, now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";
import type { ProjectDataRepository } from "./project-data-service.js";

interface BoardRow {
  project_id: string;
  board_id: string;
  requirement_id: string;
  entry_kind: string;
  state: string;
  revision: number;
  backend_id: string;
  publish_request_id: string;
  assignment_kind: string | null;
  assignee_id: string | null;
  handler_backend_id: string | null;
  handler_project_id: string | null;
  handler_task_id: string | null;
  assigned_at: string | null;
  delivery_merge_id: string | null;
  delivery_commit: string | null;
  delivery_merged_at: string | null;
  created_at: string;
  updated_at: string;
  title: string;
  content: string;
  source_kind: string;
  source_reference: string | null;
}

interface EventRow {
  project_id: string;
  board_id: string;
  event_id: string;
  kind: string;
  request_id: string;
  actor_id: string;
  handler_backend_id: string | null;
  handler_project_id: string | null;
  handler_task_id: string | null;
  from_state: string | null;
  to_state: string;
  revision: number;
  created_at: string;
}

type TransitionAction = "pause" | "release" | "cancel";

interface TransitionSpec {
  kind: "paused" | "released" | "cancelled";
  from: readonly BoardState[];
  to: BoardState;
  clearAssignment: boolean;
}

const TRANSITIONS: Record<TransitionAction, TransitionSpec> = {
  // Pausing keeps the owner; only an explicit release returns the entry to the
  // unclaimed pool, so a disconnected Main never loses its claim by accident.
  pause: { kind: "paused", from: ["claimed", "in_progress"], to: "paused", clearAssignment: false },
  release: {
    kind: "released",
    from: ["claimed", "in_progress", "paused"],
    to: "pending",
    clearAssignment: true
  },
  cancel: {
    kind: "cancelled",
    from: ["pending", "claimed", "in_progress", "paused"],
    to: "cancelled",
    clearAssignment: false
  }
};

function handlerOf(row: BoardRow | EventRow): BoardHandler | undefined {
  if (!row.handler_backend_id || !row.handler_project_id || !row.handler_task_id) return undefined;
  return {
    backendId: row.handler_backend_id,
    projectId: row.handler_project_id,
    taskId: row.handler_task_id
  };
}

function assignmentOf(row: BoardRow): BoardAssignment | undefined {
  if (!row.assignment_kind || !row.assignee_id || !row.assigned_at) return undefined;
  const handler = handlerOf(row);
  return {
    kind: row.assignment_kind as BoardAssignment["kind"],
    actorId: row.assignee_id,
    ...(handler ? { handler } : {}),
    assignedAt: row.assigned_at
  };
}

function sourceOf(row: BoardRow): LedgerSource {
  return {
    kind: row.source_kind as LedgerSource["kind"],
    ...(row.source_reference ? { reference: row.source_reference } : {})
  };
}

function entryOf(row: BoardRow): BoardEntry {
  const assignment = assignmentOf(row);
  const delivery =
    row.delivery_merge_id && row.delivery_commit && row.delivery_merged_at
      ? {
          mergeId: row.delivery_merge_id,
          mergedCommit: row.delivery_commit,
          mergedAt: row.delivery_merged_at
        }
      : undefined;
  return {
    projectId: row.project_id,
    boardId: row.board_id,
    requirementId: row.requirement_id,
    title: row.title,
    content: row.content,
    entryKind: row.entry_kind as BoardEntry["entryKind"],
    source: sourceOf(row),
    state: row.state as BoardState,
    revision: Number(row.revision),
    backendId: row.backend_id,
    ...(assignment ? { assignment } : {}),
    ...(delivery ? { delivery } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function eventOf(row: EventRow): BoardEvent {
  const handler = handlerOf(row);
  return {
    eventId: row.event_id,
    boardId: row.board_id,
    kind: row.kind as BoardEvent["kind"],
    requestId: row.request_id,
    actorId: row.actor_id,
    ...(handler ? { handler } : {}),
    ...(row.from_state ? { fromState: row.from_state as BoardState } : {}),
    toState: row.to_state as BoardState,
    revision: Number(row.revision),
    createdAt: row.created_at
  };
}

/**
 * Board writes inside the ledger's transaction.
 *
 * A claim is a conditional update on `state = 'pending'` with the revision the
 * caller read, so two backends racing for the same entry produce one winner on
 * both engines. Every accepted transition appends one event; a repeated request
 * id reads that event and returns the committed entry instead of appending.
 */
export class ProjectBoardRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly ledger: ProjectDataRepository,
    private readonly lockRows = false
  ) {}

  async list(projectId: string): Promise<BoardEntry[]> {
    await this.requireProject(projectId);
    const rows = await this.rows(
      `SELECT b.*, r.title, r.content, r.source_kind, r.source_reference
         FROM project_data_board_entries b
         JOIN project_data_requirements r
           ON r.project_id = b.project_id AND r.requirement_id = b.requirement_id
        WHERE b.project_id = ?
        ORDER BY b.updated_at DESC, b.board_id ASC`,
      [projectId]
    );
    return rows.map(entryOf);
  }

  async get(projectId: string, boardIdValue: unknown): Promise<BoardEntry> {
    return entryOf(await this.requireBoard(projectId, boardIdValue));
  }

  async events(projectId: string, boardIdValue: unknown): Promise<BoardEvent[]> {
    const boardId = boardIdentifier(boardIdValue, "看板需求 ID");
    await this.requireBoard(projectId, boardId, false);
    const rows = await this.transaction.query<EventRow>(
      "SELECT * FROM project_data_board_events WHERE project_id = ? AND board_id = ? ORDER BY revision ASC, event_id ASC",
      [projectId, boardId]
    );
    return rows.map(eventOf);
  }

  async publish(
    projectId: string,
    input: BoardPublishInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    const requestId = boardRequestId(input.requestId);
    const source = boardSource(input.source);
    const replay = await this.transaction.query<BoardRow>(
      `SELECT b.*, r.title, r.content, r.source_kind, r.source_reference
         FROM project_data_board_entries b
         JOIN project_data_requirements r
           ON r.project_id = b.project_id AND r.requirement_id = b.requirement_id
        WHERE b.project_id = ? AND b.publish_request_id = ?`,
      [projectId, requestId]
    );
    if (replay.length) return entryOf(replay[0]);
    const requirement = await this.ledger.createRequirement(projectId, {
      title: input.title,
      content: input.content,
      source
    });
    const timestamp = now();
    const boardId = id("board");
    await this.transaction.execute(
      `INSERT INTO project_data_board_entries
         (project_id, board_id, requirement_id, entry_kind, state, revision, backend_id,
          publish_request_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        boardId,
        requirement.requirementId,
        "external",
        "pending",
        1,
        context.backendId,
        requestId,
        timestamp,
        timestamp
      ]
    );
    await this.insertEvent({
      projectId,
      boardId,
      kind: "published",
      requestId,
      context,
      toState: "pending",
      revision: 1,
      createdAt: timestamp
    });
    return this.get(projectId, boardId);
  }

  async claim(
    projectId: string,
    boardIdValue: unknown,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    const boardId = boardIdentifier(boardIdValue, "看板需求 ID");
    const requestId = boardRequestId(input.requestId);
    const replayed = await this.replay(projectId, boardId, requestId, "claimed");
    if (replayed) return replayed;
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireBoard(projectId, boardId, true);
    if (Number(current.revision) !== expectedRevision) throw this.stale(current);
    if (current.state !== "pending")
      throw new ProjectDataConflictError(
        current.state === "cancelled" ? "看板需求已取消" : "看板需求已被认领或暂停，不能重复认领",
        Number(current.revision),
        "board_state_conflict"
      );
    const handler = input.handler === undefined ? undefined : boardHandler(input.handler);
    if (handler) {
      if (handler.backendId !== context.backendId)
        throw new ProjectDataError("处理者 backendId 与当前后端不一致", 403, "board_handler_mismatch");
      if (handler.projectId !== projectId)
        throw new ProjectDataConflictError(
          "处理者项目与看板项目不一致",
          Number(current.revision),
          "board_project_mismatch"
        );
    }
    const timestamp = now();
    const revision = expectedRevision + 1;
    const changed = await this.transaction.execute(
      `UPDATE project_data_board_entries
          SET state = 'claimed', revision = ?, assignment_kind = ?, assignee_id = ?,
              handler_backend_id = ?, handler_project_id = ?, handler_task_id = ?,
              assigned_at = ?, updated_at = ?
        WHERE project_id = ? AND board_id = ? AND revision = ? AND state = 'pending'`,
      [
        revision,
        handler ? "main" : "user",
        context.actor.id,
        handler?.backendId ?? null,
        handler?.projectId ?? null,
        handler?.taskId ?? null,
        timestamp,
        timestamp,
        projectId,
        boardId,
        expectedRevision
      ]
    );
    if (changed !== 1) throw this.stale(current);
    await this.insertEvent({
      projectId,
      boardId,
      kind: "claimed",
      requestId,
      context,
      ...(handler ? { handler } : {}),
      fromState: "pending",
      toState: "claimed",
      revision,
      createdAt: timestamp
    });
    return this.get(projectId, boardId);
  }

  /**
   * Mark the board projection of a delivered requirement as pending release.
   *
   * The owner and the handling Main are kept: a merge finishes the development,
   * it does not release the claim. The actual merge commit travels with the
   * state so a reader can tie the board item to the Git fact. Repeating the same
   * receipt is a no-op; a later merge of a new candidate advances the commit.
   */
  async markPendingRelease(
    projectId: string,
    requirementIdValue: unknown,
    input: {
      mergeId: string;
      mergedCommit: string;
      mergedAt: string;
      backendId: string;
      actorId: string;
    }
  ): Promise<BoardEntry | undefined> {
    const requirementId = boardIdentifier(requirementIdValue, "需求 ID");
    const current = await this.requireBoardByRequirement(projectId, requirementId, true);
    if (!current) return undefined;
    if (current.state === "cancelled") return entryOf(current);
    if (
      current.state === "pending_release" &&
      current.delivery_merge_id === input.mergeId &&
      current.delivery_commit === input.mergedCommit
    )
      return entryOf(current);
    const expectedRevision = Number(current.revision);
    const revision = expectedRevision + 1;
    const timestamp = now();
    const changed = await this.transaction.execute(
      `UPDATE project_data_board_entries
          SET state = 'pending_release', revision = ?, delivery_merge_id = ?, delivery_commit = ?,
              delivery_merged_at = ?, updated_at = ?
        WHERE project_id = ? AND board_id = ? AND revision = ? AND state = ?`,
      [
        revision,
        input.mergeId,
        input.mergedCommit,
        input.mergedAt,
        timestamp,
        projectId,
        current.board_id,
        expectedRevision,
        current.state
      ]
    );
    if (changed !== 1) throw this.stale(current);
    const handler = handlerOf(current);
    await this.insertEvent({
      projectId,
      boardId: current.board_id,
      kind: "delivered",
      requestId: `delivery-${input.mergeId}`,
      context: {
        backendId: input.backendId,
        actor: { id: boardActorId(input.actorId), host: true }
      },
      ...(handler ? { handler } : {}),
      fromState: current.state as BoardState,
      toState: "pending_release",
      revision,
      createdAt: timestamp
    });
    return this.get(projectId, current.board_id);
  }

  async pause(
    projectId: string,
    boardId: unknown,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    return this.transition("pause", projectId, boardId, input, context);
  }

  async release(
    projectId: string,
    boardId: unknown,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    return this.transition("release", projectId, boardId, input, context);
  }

  async cancel(
    projectId: string,
    boardId: unknown,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    return this.transition("cancel", projectId, boardId, input, context);
  }

  private async transition(
    action: TransitionAction,
    projectId: string,
    boardIdValue: unknown,
    input: BoardActionInput,
    context: BoardActionContext
  ): Promise<BoardEntry> {
    const boardId = boardIdentifier(boardIdValue, "看板需求 ID");
    const spec = TRANSITIONS[action];
    const requestId = boardRequestId(input.requestId);
    const replayed = await this.replay(projectId, boardId, requestId, spec.kind);
    if (replayed) return replayed;
    const expectedRevision = ledgerRevision(input.expectedRevision);
    const current = await this.requireBoard(projectId, boardId, true);
    if (Number(current.revision) !== expectedRevision) throw this.stale(current);
    if (!spec.from.includes(current.state as BoardState))
      throw new ProjectDataConflictError(
        `看板需求当前状态（${current.state}）不能${action === "pause" ? "暂停" : action === "release" ? "释放" : "取消"}`,
        Number(current.revision),
        "board_state_conflict"
      );
    // An authenticated owner may act on any entry; a session or delegated
    // backend may act only on what it owns. Disconnect or revocation never
    // transfers that ownership.
    if (!context.actor.host && current.assignee_id !== context.actor.id)
      throw new ProjectDataError(
        "只有当前归属者或本机用户可以执行该看板操作",
        403,
        "board_assignee_required"
      );
    const timestamp = now();
    const revision = expectedRevision + 1;
    const changed = await this.transaction.execute(
      `UPDATE project_data_board_entries
          SET state = ?, revision = ?,
              assignment_kind = ?, assignee_id = ?, handler_backend_id = ?,
              handler_project_id = ?, handler_task_id = ?, assigned_at = ?, updated_at = ?
        WHERE project_id = ? AND board_id = ? AND revision = ? AND state = ?`,
      spec.clearAssignment
        ? [
            spec.to,
            revision,
            null,
            null,
            null,
            null,
            null,
            null,
            timestamp,
            projectId,
            boardId,
            expectedRevision,
            current.state
          ]
        : [
            spec.to,
            revision,
            current.assignment_kind,
            current.assignee_id,
            current.handler_backend_id,
            current.handler_project_id,
            current.handler_task_id,
            current.assigned_at,
            timestamp,
            projectId,
            boardId,
            expectedRevision,
            current.state
          ]
    );
    if (changed !== 1) throw this.stale(current);
    const handler = handlerOf(current);
    await this.insertEvent({
      projectId,
      boardId,
      kind: spec.kind,
      requestId,
      context,
      ...(handler ? { handler } : {}),
      fromState: current.state as BoardState,
      toState: spec.to,
      revision,
      createdAt: timestamp
    });
    return this.get(projectId, boardId);
  }

  private async replay(
    projectId: string,
    boardId: string,
    requestId: string,
    kind: BoardEvent["kind"]
  ): Promise<BoardEntry | undefined> {
    const existing = await this.transaction.query<EventRow>(
      "SELECT * FROM project_data_board_events WHERE project_id = ? AND request_id = ?",
      [projectId, requestId]
    );
    if (!existing.length) return undefined;
    const event = existing[0];
    if (event.board_id !== boardId || event.kind !== kind)
      throw new ProjectDataConflictError(
        "requestId 已用于另一看板操作；请为新操作生成新的 requestId",
        undefined,
        "board_request_reused"
      );
    return this.get(projectId, boardId);
  }

  private stale(current: BoardRow): ProjectDataConflictError {
    return new ProjectDataConflictError(
      "看板需求已更新，请基于最新版本重试",
      Number(current.revision),
      "revision_conflict"
    );
  }

  private async insertEvent(input: {
    projectId: string;
    boardId: string;
    kind: BoardEvent["kind"];
    requestId: string;
    context: BoardActionContext;
    handler?: BoardHandler;
    fromState?: BoardState;
    toState: BoardState;
    revision: number;
    createdAt: string;
  }): Promise<void> {
    boardActorId(input.context.actor.id);
    await this.transaction.execute(
      `INSERT INTO project_data_board_events
         (project_id, board_id, event_id, kind, request_id, actor_id,
          handler_backend_id, handler_project_id, handler_task_id,
          from_state, to_state, revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        input.boardId,
        id("board_event"),
        input.kind,
        input.requestId,
        input.context.actor.id,
        input.handler?.backendId ?? null,
        input.handler?.projectId ?? null,
        input.handler?.taskId ?? null,
        input.fromState ?? null,
        input.toState,
        input.revision,
        input.createdAt
      ]
    );
  }

  private async requireProject(projectId: string): Promise<void> {
    const rows = await this.transaction.query<{ project_id: string }>(
      "SELECT project_id FROM project_data_projects WHERE project_id = ?",
      [projectId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该项目的共享记录");
  }

  private async requireBoardByRequirement(
    projectId: string,
    requirementId: string,
    lock: boolean
  ): Promise<BoardRow | undefined> {
    if (lock && this.lockRows)
      await this.transaction.query<{ board_id: string }>(
        "SELECT board_id FROM project_data_board_entries WHERE project_id = ? AND requirement_id = ? FOR UPDATE",
        [projectId, requirementId]
      );
    const rows = await this.rows(
      `SELECT b.*, r.title, r.content, r.source_kind, r.source_reference
         FROM project_data_board_entries b
         JOIN project_data_requirements r
           ON r.project_id = b.project_id AND r.requirement_id = b.requirement_id
        WHERE b.project_id = ? AND b.requirement_id = ?`,
      [projectId, requirementId]
    );
    return rows[0];
  }

  private async requireBoard(projectId: string, boardIdValue: unknown, lock?: boolean): Promise<BoardRow> {
    const boardId = boardIdentifier(boardIdValue, "看板需求 ID");
    if ((lock ?? this.lockRows) && this.lockRows)
      await this.transaction.query<{ board_id: string }>(
        "SELECT board_id FROM project_data_board_entries WHERE project_id = ? AND board_id = ? FOR UPDATE",
        [projectId, boardId]
      );
    const rows = await this.rows(
      `SELECT b.*, r.title, r.content, r.source_kind, r.source_reference
         FROM project_data_board_entries b
         JOIN project_data_requirements r
           ON r.project_id = b.project_id AND r.requirement_id = b.requirement_id
        WHERE b.project_id = ? AND b.board_id = ?`,
      [projectId, boardId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该看板需求");
    return rows[0];
  }

  private rows(sql: string, params: Array<string | number | null>): Promise<BoardRow[]> {
    return this.transaction.query<BoardRow>(sql, params);
  }
}
