import { randomBytes } from "node:crypto";
import { HttpError, sameSecret } from "./http.js";

export interface ComputerApprovalIdentity {
  backendId: string;
  pid: number;
  startedAt: string;
}

export type ComputerApprovalAuthentication = (
  identity: ComputerApprovalIdentity,
  signal: AbortSignal
) => Promise<boolean>;

/** A backend owns one short-lived desktop approval, never a business credential. */
export class ComputerApproval {
  private current?: { token: string; expiresAt: number };
  private pending?: AbortController;
  private settled?: Promise<void>;
  private generation = 0;

  constructor(
    private readonly authenticate: ComputerApprovalAuthentication,
    private readonly clock = Date.now,
    private readonly ttlMs = 30 * 60_000
  ) {}

  async approve(identity: ComputerApprovalIdentity, signal: AbortSignal) {
    if (this.pending) throw new HttpError(409, "已有本机身份验证正在进行", "approval_pending");
    signal.throwIfAborted();
    const controller = new AbortController();
    this.pending = controller;
    let finish!: () => void;
    const settled = new Promise<void>((done) => {
      finish = done;
    });
    this.settled = settled;
    const version = this.generation;
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      let accepted: boolean;
      try {
        accepted = await this.authenticate(identity, combined);
      } catch {
        if (combined.aborted) throw new HttpError(409, "本机身份验证已取消", "approval_cancelled");
        throw new HttpError(503, "本机身份验证不可用", "approval_unavailable");
      }
      if (combined.aborted || version !== this.generation)
        throw new HttpError(409, "本机身份验证已取消", "approval_cancelled");
      if (!accepted) throw new HttpError(403, "本机身份验证未通过", "approval_denied");
      const approval = { token: randomBytes(32).toString("hex"), expiresAt: this.clock() + this.ttlMs };
      this.current = approval;
      return approval;
    } finally {
      clearTimeout(timeout);
      if (this.pending === controller) this.pending = undefined;
      finish();
      if (this.settled === settled) this.settled = undefined;
    }
  }

  valid(token: string | undefined): boolean {
    if (this.current && this.clock() >= this.current.expiresAt) this.current = undefined;
    return Boolean(this.current && sameSecret(token, this.current.token));
  }

  cancelPending(): void {
    this.generation++;
    this.pending?.abort();
  }

  revoke(): void {
    this.current = undefined;
    this.cancelPending();
  }

  revokeIfCurrent(token: string): void {
    if (this.current && sameSecret(token, this.current.token)) this.revoke();
  }

  async close(): Promise<void> {
    this.revoke();
    await this.settled;
  }
}
