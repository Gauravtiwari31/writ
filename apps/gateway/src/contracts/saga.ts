// The purchase saga API (plan §6.2 steps 4-5 and 9, §6.3, §6.8). Implemented by the money stream
// in src/saga; called by the decision pipeline (api stream), the Writ revoke and kill-switch routes
// (api stream), the approval routes (money) and the dispute engine (evidence stream).
//
// Rules every implementation keeps: only the saga writes purchases.state, and only along
// PURCHASE_TRANSITIONS (@writ/core); each transition is one UnitOfWork transaction with its ledger
// event and outbox row; PayPal is called only by job handlers after COMMIT, with
// PayPal-Request-Id = <purchase_id>:<step>; capture is exactly amount_minor with final_capture and
// invoice_id = C_post; LLMs never reach this module (§22 rule 8).
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import type { Currency, PolicyDecision, PurchaseState, PurchaseStateReason, Verdict, VerificationRecord } from "@writ/core";
import type { TxContext } from "../tx/unit-of-work";

/** Read model of one purchase (what the pipeline and the routes need; hashes as lowercase hex). */
export interface PurchaseSnapshot {
  readonly purchaseId: string;
  readonly tenantId: string;
  readonly writId: string;
  readonly cartId: string;
  readonly agentId: string;
  readonly state: PurchaseState;
  readonly stateReason: PurchaseStateReason | null;
  readonly finalVerdict: Verdict | null;
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly paypal: {
    readonly orderId: string | null;
    readonly authorizationId: string | null;
    readonly captureId: string | null;
    readonly refundId: string | null;
  };
  /** C_pre (hex) once the purchase reached AUTHORIZING. */
  readonly cPre: string | null;
  readonly cPost: string | null;
  readonly approvalId: string | null;
  readonly approvalExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenPurchaseInput {
  tenantId: string;
  writId: string;
  cartId: string;
  /** From the agent key (agentOf), never from the request body. */
  agentId: string;
  idempotencyKey: string;
  /** The computed cart total (computeCartTotal), minor units. */
  amountMinor: bigint;
  currency: Currency;
}

export type BlockReason = Extract<PurchaseStateReason, "policy_blocked" | "budget_exhausted">;
export type VoidRequestReason = Extract<PurchaseStateReason, "kill_switch" | "writ_revoked" | "writ_expired">;

export interface PurchaseSaga {
  /**
   * Creates the purchase in PROPOSED, or returns the existing one when (agent_id, idempotency_key)
   * was seen before (threat T7: `replayed` = true and nothing else happens).
   */
  open(input: OpenPurchaseInput): Promise<{ purchase: PurchaseSnapshot; replayed: boolean }>;

  /** A deterministic BLOCK (stages 1-3): PROPOSED → BLOCKED with PURCHASE_BLOCKED. Final; no PayPal call. */
  block(input: { tenantId: string; purchaseId: string; reason: BlockReason; detail: string; policy: PolicyDecision | null }): Promise<PurchaseSnapshot>;

  /**
   * Stages 4-5 after a policy pass (APPROVE, or REVIEW for the threshold): reserve the budget
   * (0 rows → BLOCKED budget_exhausted), compute C_pre = sha256(H_w ‖ H_c ‖ H_p), go AUTHORIZING and
   * enqueue purchase.authorize; the job calls PayPal after COMMIT. PayPal unconfigured or no vaulted
   * wallet → FAILED (paypal_unconfigured / paypal_not_connected) with the reservation released.
   * Resolves when the purchase is AUTHORIZED, FAILED or BLOCKED, or after `waitMs` (default 20 s)
   * with whatever state it has reached (the job and the recovery task finish it).
   */
  reserveAndAuthorize(input: { tenantId: string; purchaseId: string; policy: PolicyDecision; waitMs?: number }): Promise<PurchaseSnapshot>;

  /** AUTHORIZED → VERIFYING, before the pipeline runs the Sentinel and the Verifier. */
  beginVerification(input: { tenantId: string; purchaseId: string }): Promise<PurchaseSnapshot>;

  /**
   * Stage 9 with the combined decision (record.final): APPROVE → CAPTURING (settle, then capture
   * with invoice_id = C_post); REVIEW → AWAITING_HUMAN with an approval (24 h, approval.expire
   * scheduled); BLOCK → VOIDING (release, then void). The record is stored on the "combiner"
   * decisions row and hashed as H_verifier. Resolves like reserveAndAuthorize.
   */
  execute(input: { tenantId: string; purchaseId: string; verification: VerificationRecord; decisionId: string; waitMs?: number }): Promise<PurchaseSnapshot>;

  /**
   * Inside the caller's transaction (Writ revoke, kill switch, expiry sweep): every voidable
   * purchase (AUTHORIZED, VERIFYING, AWAITING_HUMAN) of these Writs → VOIDING + purchase.void.
   * Purchases still AUTHORIZING are voided by the saga when their authorization lands (it re-checks
   * the Writ status before every forward step). Returns the purchase ids moved to VOIDING.
   */
  requestVoids(ctx: TxContext, input: { writIds: readonly string[]; reason: VoidRequestReason }): Promise<string[]>;

  /** Inside the dispute engine's transaction: CAPTURED → DISPUTED (+ DISPUTE_OPENED). */
  markDisputed(ctx: TxContext, input: { purchaseId: string; paypalDisputeId: string }): Promise<void>;

  /** Inside the dispute engine's transaction: DISPUTED → DISPUTE_WON | DISPUTE_LOST (+ DISPUTE_RESOLVED). */
  resolveDispute(ctx: TxContext, input: { purchaseId: string; paypalDisputeId: string; outcome: "WON" | "LOST" }): Promise<void>;

  get(input: { tenantId: string; purchaseId: string }): Promise<PurchaseSnapshot | null>;
}
