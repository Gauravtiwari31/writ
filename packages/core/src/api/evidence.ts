// Receipts and evidence packs (P0-7; owner: evidence stream; routes in apps/gateway/src/routes/evidence.ts).
// GET /v1/evidence/<token>.json | .pdf serves the pack to anyone holding the capability link; the
// token is random and only its sha256 is stored (evidence_links).
import { z } from "zod";
import { HashHexSchema } from "../hash";
import { idSchema } from "../ids";
import { localIdSchema, TimestampSchema } from "./common";
import { LedgerEventViewSchema, PurchaseViewSchema } from "./purchases";

// POST /v1/evidence-links
export const CreateEvidenceLinkRequestSchema = z.strictObject({ purchase_id: idSchema("pur") });
export type CreateEvidenceLinkRequest = z.infer<typeof CreateEvidenceLinkRequestSchema>;
export const EvidenceLinkViewSchema = z.strictObject({
  link_id: localIdSchema("evl"),
  purchase_id: idSchema("pur"),
  /** Wallet-relative paths (through the /gw rewrite), e.g. /gw/v1/evidence/<token>.json */
  json_path: z.string().startsWith("/"),
  pdf_path: z.string().startsWith("/"),
  expires_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
});
export type EvidenceLinkView = z.infer<typeof EvidenceLinkViewSchema>;

export const EVIDENCE_CHECK_STATUSES = ["PASS", "FAIL", "SKIP"] as const;

// GET /v1/receipts/:purchaseId (session): everything the Receipt screen and the in-browser
// re-verification need. The browser recomputes the chain hashes itself with @writ/ledger.
export const ReceiptViewSchema = z.strictObject({
  purchase: PurchaseViewSchema,
  writ: z.strictObject({
    writ_id: idSchema("wr"),
    purpose: z.string().min(1).max(140),
    hash: HashHexSchema,
    signature_kind: z.enum(["webauthn", "device-ed25519"]),
    signed_at: TimestampSchema,
  }),
  commitments: z.strictObject({
    h_w: HashHexSchema,
    h_c: HashHexSchema,
    h_p: HashHexSchema.nullable(),
    c_pre: HashHexSchema.nullable(),
    h_verifier: HashHexSchema.nullable(),
    h_approval: HashHexSchema.nullable(),
    c_post: HashHexSchema.nullable(),
    custom_id: z.string().max(127).nullable(),
    invoice_id: z.string().max(127).nullable(),
  }),
  /** The Writ's full chain, genesis first. */
  events: z.array(LedgerEventViewSchema).max(10_000),
  checks: z
    .array(z.strictObject({ name: z.string().min(1).max(64), status: z.enum(EVIDENCE_CHECK_STATUSES), detail: z.string().max(500) }))
    .max(100),
  /** False until the purchase has a PayPal authorization (a BLOCKED purchase has no pack). */
  pack_available: z.boolean(),
});
export type ReceiptView = z.infer<typeof ReceiptViewSchema>;
