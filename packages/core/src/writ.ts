// The Writ: the spending mandate a user signs once (plan §0, §6.2, §8.2). WritBody is exactly what
// gets canonicalized (RFC 8785), hashed and signed, so every key is always present (explicit null,
// never optional) and status lives in the DB, never in the body.
import { z } from "zod";
import { hashJcs, hashJcsHex } from "./hash";
import { idSchema, MerchantIdSchema } from "./ids";
import { CurrencySchema, MinorAmountSchema, minorToString, parseMinor } from "./money";
import { CategorySelectorSchema, DENIABLE_KINDS, DeniableKindSchema } from "./taxonomy";

export const WRIT_SPEC = "writ/0.1";
export const MAX_WRIT_LIFETIME_DAYS = 90;
const DAY_MS = 86_400_000;

/** "YYYY-MM-DD", a real calendar date. */
export const IsoDateSchema = z.iso.date();
/** UTC with exactly 3 fractional digits and "Z" (what Date#toISOString emits): one instant, one spelling, one hash. */
export const IsoTimestampSchema = z.iso.datetime({ precision: 3 });

const CONTROL_CHAR_RE = /\p{Cc}/u;
const LONE_SURROGATE_RE = /\p{Cs}/u;

/**
 * Non-blank, at most `max` UTF-16 units, no control characters (no newlines to fake prompt
 * structure), no lone surrogates (jcs refuses to hash them, so they must fail validation first).
 */
export function singleLineText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !CONTROL_CHAR_RE.test(text), "control characters are not allowed")
    .refine((text) => !LONE_SURROGATE_RE.test(text), "lone surrogates are not allowed")
    .refine((text) => text.trim().length > 0, "must not be blank");
}

function uniqueList<T extends z.ZodType<string>>(item: T, min: number, max: number) {
  return z
    .array(item)
    .min(min)
    .max(max)
    .refine((list) => new Set(list).size === list.length, "entries must be unique");
}

function minorOrNull(value: unknown): bigint | null {
  return MinorAmountSchema.safeParse(value).success ? BigInt(value as string) : null;
}

export const WritLimitsSchema = z.strictObject({
  total_minor: MinorAmountSchema,
  max_per_order_minor: MinorAmountSchema,
  /** Orders strictly above this need a human passkey approval (REVIEW). "0" = always ask. */
  require_human_above_minor: MinorAmountSchema,
  max_orders: z.int().min(1).max(100),
  max_checkouts_per_hour: z.int().min(1).max(60),
});
export type WritLimits = z.infer<typeof WritLimitsSchema>;

export const MerchantScopeSchema = z
  .strictObject({
    /** null = any merchant; otherwise only these. */
    allow: uniqueList(MerchantIdSchema, 1, 50).nullable(),
    deny: uniqueList(MerchantIdSchema, 0, 50),
  })
  .refine((m) => m.allow === null || !m.allow.some((id) => m.deny.includes(id)), {
    message: "a merchant cannot be both allowed and denied",
    path: ["deny"],
  });
export type MerchantScope = z.infer<typeof MerchantScopeSchema>;

export const WritScopeSchema = z.strictObject({
  categories: uniqueList(CategorySelectorSchema, 1, 64),
  deny_kinds: uniqueList(DeniableKindSchema, 0, DENIABLE_KINDS.length),
  merchants: MerchantScopeSchema,
});
export type WritScope = z.infer<typeof WritScopeSchema>;

export const WritShipToSchema = z.strictObject({
  /** Address-book id. Agents only ever see this ref and the label, never the address (threat T2/T6). */
  ref: idSchema("adr"),
  label: singleLineText(40),
  locked: z.boolean(),
});
export type WritShipTo = z.infer<typeof WritShipToSchema>;

export const WritBodySchema = z
  .strictObject({
    spec: z.literal(WRIT_SPEC),
    writ_id: idSchema("wr"),
    principal: z.strictObject({ user_id: idSchema("usr") }),
    /** The one agent bound to this Writ (plan §6.5 writs.agent_id). */
    agent_id: idSchema("agt"),
    purpose: singleLineText(140),
    currency: CurrencySchema,
    limits: WritLimitsSchema,
    scope: WritScopeSchema,
    /** Semantic constraints for the Verifier only; policy never parses them. */
    item_constraints: z.array(singleLineText(120)).max(3),
    ship_to: WritShipToSchema,
    deliver_by: IsoDateSchema.nullable(),
    issued_at: IsoTimestampSchema,
    expires_at: IsoTimestampSchema,
  })
  .superRefine((body, ctx) => {
    // Field-level issues may already exist, so every value is re-checked before comparing.
    const total = minorOrNull(body.limits.total_minor);
    const perOrder = minorOrNull(body.limits.max_per_order_minor);
    const human = minorOrNull(body.limits.require_human_above_minor);
    if (total !== null && total <= 0n) {
      ctx.addIssue({ code: "custom", path: ["limits", "total_minor"], message: "total must be positive" });
    }
    if (perOrder !== null && perOrder <= 0n) {
      ctx.addIssue({ code: "custom", path: ["limits", "max_per_order_minor"], message: "max per order must be positive" });
    }
    if (total !== null && perOrder !== null && perOrder > total) {
      ctx.addIssue({ code: "custom", path: ["limits", "max_per_order_minor"], message: "max per order cannot exceed the total" });
    }
    if (perOrder !== null && human !== null && human > perOrder) {
      ctx.addIssue({
        code: "custom",
        path: ["limits", "require_human_above_minor"],
        message: "approval threshold cannot exceed max per order",
      });
    }
    const issued = Date.parse(body.issued_at);
    const expires = Date.parse(body.expires_at);
    if (Number.isFinite(issued) && Number.isFinite(expires)) {
      if (expires <= issued) {
        ctx.addIssue({ code: "custom", path: ["expires_at"], message: "expires_at must be after issued_at" });
      } else if (expires - issued > MAX_WRIT_LIFETIME_DAYS * DAY_MS) {
        ctx.addIssue({
          code: "custom",
          path: ["expires_at"],
          message: `a Writ may last at most ${MAX_WRIT_LIFETIME_DAYS} days`,
        });
      }
    }
  });
export type WritBody = z.infer<typeof WritBodySchema>;

/** Lifecycle state. Stored in the DB only: changing it must never change the signed hash. */
export const WRIT_STATUSES = ["DRAFT", "ACTIVE", "REVOKED", "EXPIRED"] as const;
export const WritStatusSchema = z.enum(WRIT_STATUSES);
export type WritStatus = z.infer<typeof WritStatusSchema>;

/** H_w = sha256(JCS(body)) (plan §6.7). Also the WebAuthn challenge the user signs. */
export function writHash(body: WritBody): Uint8Array {
  return hashJcs(body);
}

export function writHashHex(body: WritBody): string {
  return hashJcsHex(body);
}

// ---------------------------------------------------------------------------------------------
// Intent Compiler output (plan §8.2) and its conversion into a signable body.

/**
 * What the Intent Compiler returns. Every constraint may be null or absent ("not stated"); the
 * defaults in `draftToWritBody` fill the gaps. Strict, so stray model fields force a repair retry.
 */
export const WritDraftSchema = z.strictObject({
  purpose: singleLineText(140),
  constraints: z.strictObject({
    total_minor: MinorAmountSchema.nullish(),
    max_per_order_minor: MinorAmountSchema.nullish(),
    require_human_above_minor: MinorAmountSchema.nullish(),
    max_orders: z.int().min(1).max(100).nullish(),
    max_checkouts_per_hour: z.int().min(1).max(60).nullish(),
    categories: z.array(CategorySelectorSchema).max(64).nullish(),
    deny_kinds: z.array(DeniableKindSchema).max(DENIABLE_KINDS.length).nullish(),
    /** null, absent or [] = any merchant. */
    merchants_allow: z.array(MerchantIdSchema).max(50).nullish(),
    merchants_deny: z.array(MerchantIdSchema).max(50).nullish(),
    item_constraints: z.array(singleLineText(120)).max(3).nullish(),
    ship_to_ref: idSchema("adr").nullish(),
    ship_to_locked: z.boolean().nullish(),
    deliver_by: IsoDateSchema.nullish(),
    expires_in_days: z.int().min(1).max(MAX_WRIT_LIFETIME_DAYS).nullish(),
  }),
  clarifying_questions: z.array(singleLineText(200)).max(2),
  assumptions: z.array(singleLineText(200)).max(5),
});
export type WritDraft = z.infer<typeof WritDraftSchema>;

/** Plan §8.2 defaults (shown to the user, editable before signing). */
export const WRIT_DEFAULTS = {
  /** require_human_above = min(50% of total, $50, max_per_order). */
  humanThresholdCapMinor: 5000n,
  expiresInDays: 7,
  maxOrders: 1,
  /** Not fixed by §8.2: 3/hour allows a re-plan after a BLOCK while capping runaway retry loops. */
  maxCheckoutsPerHour: 3,
  shipToLocked: true,
} as const;

export type WritDraftRequiredField = "total_minor" | "categories";
export type WritDraftErrorCode = "invalid_draft" | "missing_fields" | "ship_to_mismatch" | "invalid_body";

export class WritDraftError extends Error {
  readonly code: WritDraftErrorCode;
  /** For "missing_fields": what the compiler must ask about instead of guessing. */
  readonly missing: readonly WritDraftRequiredField[];
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(
    code: WritDraftErrorCode,
    message: string,
    details: { missing?: readonly WritDraftRequiredField[]; issues?: readonly z.core.$ZodIssue[] } = {},
  ) {
    super(message);
    this.name = "WritDraftError";
    this.code = code;
    this.missing = details.missing ?? [];
    this.issues = details.issues ?? [];
  }
}

export interface DraftToWritContext {
  writ_id: string;
  user_id: string;
  agent_id: string;
  /** Resolved by the gateway from the user's address book; the compiler only ever saw labels. */
  ship_to: { ref: string; label: string };
  now: Date;
}

function dedupe<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

function minBigint(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((min, value) => (value < min ? value : min), first);
}

/**
 * Applies the §8.2 defaults and returns a body that passes WritBodySchema, or throws
 * WritDraftError. Budget and categories are never defaulted: the compiler must ask.
 */
export function draftToWritBody(draft: WritDraft, ctx: DraftToWritContext): WritBody {
  const parsedDraft = WritDraftSchema.safeParse(draft);
  if (!parsedDraft.success) {
    throw new WritDraftError("invalid_draft", "draft does not match WritDraftSchema", { issues: parsedDraft.error.issues });
  }
  const c = parsedDraft.data.constraints;
  const totalText = c.total_minor;
  const categories = c.categories;
  if (totalText == null || categories == null || categories.length === 0) {
    const missing: WritDraftRequiredField[] = [];
    if (totalText == null) missing.push("total_minor");
    if (categories == null || categories.length === 0) missing.push("categories");
    throw new WritDraftError("missing_fields", `draft is missing ${missing.join(" and ")}; ask the user`, { missing });
  }
  if (c.ship_to_ref != null && c.ship_to_ref !== ctx.ship_to.ref) {
    throw new WritDraftError("ship_to_mismatch", "draft ship_to_ref differs from the resolved address");
  }
  const issuedMs = ctx.now.getTime();
  if (!Number.isFinite(issuedMs)) throw new WritDraftError("invalid_draft", "now is not a valid date");

  const total = parseMinor(totalText);
  const perOrder = c.max_per_order_minor != null ? parseMinor(c.max_per_order_minor) : total;
  const human =
    c.require_human_above_minor != null
      ? parseMinor(c.require_human_above_minor)
      : minBigint(total / 2n, WRIT_DEFAULTS.humanThresholdCapMinor, perOrder);
  const denyKinds = c.deny_kinds;
  const allow = c.merchants_allow != null && c.merchants_allow.length > 0 ? dedupe(c.merchants_allow) : null;
  const expiresInDays = c.expires_in_days ?? WRIT_DEFAULTS.expiresInDays;

  const body = {
    spec: WRIT_SPEC,
    writ_id: ctx.writ_id,
    principal: { user_id: ctx.user_id },
    agent_id: ctx.agent_id,
    purpose: parsedDraft.data.purpose,
    currency: "USD",
    limits: {
      total_minor: minorToString(total),
      max_per_order_minor: minorToString(perOrder),
      require_human_above_minor: minorToString(human),
      max_orders: c.max_orders ?? WRIT_DEFAULTS.maxOrders,
      max_checkouts_per_hour: c.max_checkouts_per_hour ?? WRIT_DEFAULTS.maxCheckoutsPerHour,
    },
    scope: {
      categories: dedupe(categories),
      // Canonical order (DENIABLE_KINDS) so the same choice always hashes the same.
      deny_kinds: denyKinds == null ? [...DENIABLE_KINDS] : DENIABLE_KINDS.filter((kind) => denyKinds.includes(kind)),
      merchants: { allow, deny: dedupe(c.merchants_deny ?? []) },
    },
    item_constraints: c.item_constraints ?? [],
    ship_to: { ref: ctx.ship_to.ref, label: ctx.ship_to.label, locked: c.ship_to_locked ?? WRIT_DEFAULTS.shipToLocked },
    deliver_by: c.deliver_by ?? null,
    issued_at: new Date(issuedMs).toISOString(),
    expires_at: new Date(issuedMs + expiresInDays * DAY_MS).toISOString(),
  };
  const parsed = WritBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new WritDraftError("invalid_body", "draft produces an invalid Writ body", { issues: parsed.error.issues });
  }
  return parsed.data;
}
