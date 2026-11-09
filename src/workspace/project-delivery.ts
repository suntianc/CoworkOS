import {
  deliveryReceipt,
  deliveryState,
  type DeliveryReceipt,
  type DevelopmentDelivery
} from "../domain/development-delivery.js";
import {
  ProjectDataConflictError,
  ProjectDataNotFoundError,
  ledgerIdentifier,
  ledgerProjectId
} from "../domain/project-ledger.js";
import { id, now } from "../domain/types.js";
import type { SqlTransaction } from "../storage/project-data/database.js";
import type { ProjectDataRepository } from "./project-data-service.js";

interface DeliveryRow {
  project_id: string;
  delivery_id: string;
  development_id: string;
  requirement_id: string;
  merge_id: string;
  candidate_commit: string;
  merged_commit: string;
  target_branch: string;
  merged_at: string;
  board_id: string | null;
  state: string;
  attempts: number;
  error: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function deliveryOf(row: DeliveryRow): DevelopmentDelivery {
  return {
    projectId: row.project_id,
    deliveryId: row.delivery_id,
    developmentId: row.development_id,
    requirementId: row.requirement_id,
    mergeId: row.merge_id,
    candidateCommit: row.candidate_commit,
    mergedCommit: row.merged_commit,
    targetBranch: row.target_branch,
    mergedAt: row.merged_at,
    ...(row.board_id ? { boardId: row.board_id } : {}),
    state: deliveryState(row.state),
    attempts: Number(row.attempts),
    ...(row.error ? { lastError: row.error } : {}),
    ...(row.synced_at ? { syncedAt: row.synced_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface MergeReceiptRow {
  development_id: string;
  requirement_id: string;
  candidate_commit: string;
  merge_commit: string | null;
  target_branch: string;
  state: string;
  updated_at: string;
}

const ERROR_MAX = 2000;

/**
 * Delivery rows inside the ledger's transaction.
 *
 * The row is created by the merge receipt and only afterwards applied to the
 * requirement and its board projection. That two-step write is deliberate: a
 * failure between them leaves a readable `pending` delivery with its error,
 * while the target branch already contains the real merge commit. Applying the
 * same row again is the retry; it never inserts a second delivery for one merge.
 */
export class ProjectDeliveryRepository {
  constructor(
    private readonly transaction: SqlTransaction,
    private readonly ledger: ProjectDataRepository,
    private readonly lockRows = false
  ) {}

  async list(projectIdValue: unknown, developmentIdValue?: unknown): Promise<DevelopmentDelivery[]> {
    const projectId = ledgerProjectId(projectIdValue);
    await this.requireProject(projectId);
    const developmentId =
      developmentIdValue === undefined ? undefined : ledgerIdentifier(developmentIdValue, "开发记录 ID");
    const rows = await this.transaction.query<DeliveryRow>(
      `SELECT * FROM project_data_deliveries
        WHERE project_id = ?${developmentId ? " AND development_id = ?" : ""}
        ORDER BY created_at ASC, delivery_id ASC`,
      developmentId ? [projectId, developmentId] : [projectId]
    );
    return rows.map(deliveryOf);
  }

  async get(projectIdValue: unknown, deliveryIdValue: unknown): Promise<DevelopmentDelivery> {
    const projectId = ledgerProjectId(projectIdValue);
    const deliveryId = ledgerIdentifier(deliveryIdValue, "交付记录 ID");
    return deliveryOf(await this.requireDelivery(projectId, deliveryId));
  }

  /** Create the pending row for one merged operation, or return the existing one. */
  async record(projectIdValue: unknown, receiptValue: unknown): Promise<DevelopmentDelivery> {
    const projectId = ledgerProjectId(projectIdValue);
    const receipt: DeliveryReceipt = deliveryReceipt(receiptValue);
    await this.requireProject(projectId);
    if (this.lockRows)
      await this.transaction.query(
        "SELECT project_id FROM project_data_projects WHERE project_id = ? FOR UPDATE",
        [projectId]
      );
    await this.requireMergedReceipt(projectId, receipt);
    const existing = await this.transaction.query<DeliveryRow>(
      "SELECT * FROM project_data_deliveries WHERE project_id = ? AND merge_id = ?",
      [projectId, receipt.mergeId]
    );
    if (existing.length) return deliveryOf(existing[0]);
    const timestamp = now();
    const deliveryId = id("delivery");
    await this.transaction.execute(
      `INSERT INTO project_data_deliveries
         (project_id, delivery_id, development_id, requirement_id, merge_id, candidate_commit,
          merged_commit, target_branch, merged_at, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [
        projectId,
        deliveryId,
        receipt.developmentId,
        receipt.requirementId,
        receipt.mergeId,
        receipt.candidateCommit,
        receipt.mergedCommit,
        receipt.targetBranch,
        receipt.mergedAt,
        timestamp,
        timestamp
      ]
    );
    return this.get(projectId, deliveryId);
  }

  /**
   * Apply one pending delivery to the ledger and the board in this transaction.
   *
   * Both are written together with the `synced` row, so a reader never sees a
   * delivered requirement without its board projection (or the opposite). A
   * repeated application re-reads the row under its lock and is a no-op.
   */
  async apply(
    projectIdValue: unknown,
    deliveryIdValue: unknown,
    backendIdValue: unknown
  ): Promise<DevelopmentDelivery> {
    const projectId = ledgerProjectId(projectIdValue);
    const deliveryId = ledgerIdentifier(deliveryIdValue, "交付记录 ID");
    const backendId = ledgerIdentifier(backendIdValue, "交付执行后端");
    const row = await this.requireDelivery(projectId, deliveryId, true);
    if (row.state === "synced") return deliveryOf(row);
    const receipt: DeliveryReceipt = deliveryReceipt({
      mergeId: row.merge_id,
      developmentId: row.development_id,
      requirementId: row.requirement_id,
      candidateCommit: row.candidate_commit,
      mergedCommit: row.merged_commit,
      targetBranch: row.target_branch,
      mergedAt: row.merged_at
    });
    await this.requireMergedReceipt(projectId, receipt);
    const board = await this.ledger.board().markPendingRelease(projectId, receipt.requirementId, {
      mergeId: receipt.mergeId,
      mergedCommit: receipt.mergedCommit,
      mergedAt: receipt.mergedAt,
      backendId,
      actorId: `backend:${backendId}:host`
    });
    await this.ledger.markRequirementDelivered(projectId, receipt.requirementId, {
      mergeId: receipt.mergeId,
      mergedCommit: receipt.mergedCommit,
      targetBranch: receipt.targetBranch
    });
    const timestamp = now();
    await this.transaction.execute(
      `UPDATE project_data_deliveries
          SET state = 'synced', attempts = attempts + 1, error = NULL, synced_at = ?, board_id = ?, updated_at = ?
        WHERE project_id = ? AND delivery_id = ?`,
      [timestamp, board?.boardId ?? row.board_id ?? null, timestamp, projectId, deliveryId]
    );
    return this.get(projectId, deliveryId);
  }

  /** Keep the failure readable on the pending row; a later apply retries it. */
  async fail(
    projectIdValue: unknown,
    deliveryIdValue: unknown,
    message: string
  ): Promise<DevelopmentDelivery> {
    const projectId = ledgerProjectId(projectIdValue);
    const deliveryId = ledgerIdentifier(deliveryIdValue, "交付记录 ID");
    const row = await this.requireDelivery(projectId, deliveryId);
    if (row.state === "synced") return deliveryOf(row);
    const text = message.slice(0, ERROR_MAX);
    const timestamp = now();
    await this.transaction.execute(
      `UPDATE project_data_deliveries
          SET attempts = attempts + 1, error = ?, updated_at = ?
        WHERE project_id = ? AND delivery_id = ?`,
      [text, timestamp, projectId, deliveryId]
    );
    return this.get(projectId, deliveryId);
  }

  /**
   * The authority's own merged row is the only receipt source.
   *
   * Every field that identifies the delivery (development, requirement,
   * candidate, actual merge commit, target branch and the merged operation's
   * own timestamp) must agree. This re-check lives beside the row writes, so a
   * forged or stale receipt cannot create a pending row, and a pending row
   * that no longer agrees with the merged fact can never reach the ledger or
   * the board on retry.
   */
  private async requireMergedReceipt(projectId: string, receipt: DeliveryReceipt): Promise<void> {
    const rows = await this.transaction.query<MergeReceiptRow>(
      `SELECT development_id, requirement_id, candidate_commit, merge_commit, target_branch, state, updated_at
         FROM project_data_development_merges
        WHERE project_id = ? AND merge_id = ?`,
      [projectId, receipt.mergeId]
    );
    const merge = rows[0];
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 合入行查询可能返回 0 行，rows[0] 运行期是 undefined（未启用 noUncheckedIndexedAccess，类型看不出来），无行时必须按未合入拒绝
      !merge ||
      merge.state !== "merged" ||
      !merge.merge_commit ||
      merge.development_id !== receipt.developmentId ||
      merge.requirement_id !== receipt.requirementId ||
      merge.candidate_commit !== receipt.candidateCommit ||
      merge.merge_commit !== receipt.mergedCommit ||
      merge.target_branch !== receipt.targetBranch ||
      merge.updated_at !== receipt.mergedAt
    )
      throw new ProjectDataConflictError(
        "交付回执与已合入记录不一致，不能记录交付",
        undefined,
        "delivery_not_merged"
      );
  }

  private async requireDelivery(projectId: string, deliveryId: string, lock = false): Promise<DeliveryRow> {
    const rows = await this.transaction.query<DeliveryRow>(
      `SELECT * FROM project_data_deliveries
        WHERE project_id = ? AND delivery_id = ?${lock && this.lockRows ? " FOR UPDATE" : ""}`,
      [projectId, deliveryId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该交付记录");
    return rows[0];
  }

  private async requireProject(projectId: string): Promise<void> {
    const rows = await this.transaction.query<{ project_id: string }>(
      "SELECT project_id FROM project_data_projects WHERE project_id = ?",
      [projectId]
    );
    if (!rows.length) throw new ProjectDataNotFoundError("找不到该项目的共享记录");
  }
}
