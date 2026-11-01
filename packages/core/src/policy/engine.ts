// The deterministic policy engine (plan §6.2 step 3). A pure function: no clock, no I/O, no
// randomness; the caller injects `now` and the budget/velocity snapshot. Any failed check is a
// BLOCK, which nothing downstream can lower (§22 rule 9). Every check runs on every cart, so one
// response tells the agent everything it must change (plan §4 scene 6 shows three at once).
import { z } from "zod";
import { CartItemSchema, CartSchema, computeCartTotal, type Cart } from "../cart";
import { idSchema } from "../ids";
import { minorToPayPalValue, parseMinor, type Currency } from "../money";
import {
  CATEGORY_LEAF_LABELS,
  categoryAllowed,
  isCategoryLeaf,
  ITEM_KIND_LABELS,
  ITEM_KINDS,
  kindDenied,
  type ItemKind,
} from "../taxonomy";
import { IsoTimestampSchema, WritBodySchema, WritStatusSchema, type WritBody, type WritStatus } from "../writ";
import {
  POLICY_CHECK_IDS,
  POLICY_VERSION,
  THRESHOLD_CHECK_ID,
  type PolicyCheck,
  type PolicyCheckId,
  type PolicyDecision,
  type PolicyReason,
  type PolicyReasonCode,
} from "./decision";

export interface PolicyBudget {
  /** Captured spend under this Writ. */
  spent_minor: bigint;
  /** Held by in-flight purchases; excludes the cart being evaluated (reservation comes after policy). */
  reserved_minor: bigint;
  /** Orders already captured or currently holding a reservation, so in-flight orders count too. */
  orders_count: number;
}

export interface PolicyInput {
  writ: WritBody;
  /** From the DB, never from the body: status is not signed, and the signature is verified upstream. */
  writ_state: { status: WritStatus; signature_verified: boolean };
  /** The authenticated caller (from its API key), not whatever the cart claims. */
  agent_id: string;
  cart: Cart;
  budget: PolicyBudget;
  /** Checkouts this agent made in the last hour, not counting this one. */
  velocity: { checkouts_last_hour: number };
  /** Address-book refs of the Writ's principal; only consulted when the Writ's ship-to is unlocked. */
  known_ship_to_refs: readonly string[];
  /** Injected clock (ISO timestamp, e.g. new Date().toISOString()). */
  now: string;
}

// Fields a check judges itself are loosened here (bounded to code-like text, since they can be
// echoed in reasons): an unknown currency, category or kind becomes a typed reason the agent can
// act on, and the checks already fail closed on unknown values. Everything the engine computes
// with keeps its strict schema.
const PolicyCartItemSchema = z.strictObject({
  ...CartItemSchema.shape,
  category: z.string().regex(/^[a-z][a-z_]{0,31}(\.[a-z][a-z_]{0,31})?$/),
  kind: z.string().regex(/^[a-z][a-z_]{0,31}$/),
});

// Rebuilding from `.shape` drops CartSchema's refinements. The total is judged by a check; the
// one-line-per-product rule is restored here, because the combiner binds Verifier findings to
// lines by product_ref.
const PolicyCartSchema = z
  .strictObject({
    ...CartSchema.shape,
    currency: z.string().regex(/^[A-Z]{3}$/),
    items: z.array(PolicyCartItemSchema).min(1).max(20),
  })
  .refine((cart) => new Set(cart.items.map((item) => item.product_ref)).size === cart.items.length, {
    message: "one line per product; use qty",
    path: ["items"],
  });

const PolicyInputSchema = z.object({
  writ: WritBodySchema,
  writ_state: z.object({ status: WritStatusSchema, signature_verified: z.boolean() }),
  agent_id: idSchema("agt"),
  cart: PolicyCartSchema,
  budget: z.object({
    spent_minor: z.bigint().nonnegative(),
    reserved_minor: z.bigint().nonnegative(),
    orders_count: z.int().nonnegative(),
  }),
  velocity: z.object({ checkouts_last_hour: z.int().nonnegative() }),
  known_ship_to_refs: z.array(z.string()),
  now: IsoTimestampSchema,
});
type ParsedInput = z.infer<typeof PolicyInputSchema>;

/**
 * Thrown only when the input itself is malformed (a programming error: the gateway has already
 * parsed the cart and loaded a valid Writ). Callers must treat it as BLOCK (§22 rule 10).
 */
export class PolicyInputError extends TypeError {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(`invalid policy input: ${issues.map((issue) => `${["$", ...issue.path.map(String)].join(".")}: ${issue.message}`).join("; ")}`);
    this.name = "PolicyInputError";
    this.issues = issues;
  }
}

type Finding = Omit<PolicyReason, "check">;

interface Context {
  input: ParsedInput;
  writ: ParsedInput["writ"];
  cart: ParsedInput["cart"];
  nowMs: number;
  /** Computed from the lines; the declared total is only compared against it. */
  total: bigint;
  declared: bigint;
  money: (minor: bigint) => string;
}

const CURRENCY_SYMBOLS: Readonly<Record<Currency, string>> = { USD: "$" };

function fail(
  code: PolicyReasonCode,
  message: string,
  field: string | null,
  expected: string | null,
  actual: string | null,
): Finding {
  return { code, message, field, expected, actual };
}

function isItemKind(kind: string): kind is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(kind);
}

function categoryName(code: string): string {
  return isCategoryLeaf(code) ? `"${CATEGORY_LEAF_LABELS[code]}" (${code})` : `an unknown category (${code})`;
}

function kindName(kind: string): string {
  return isItemKind(kind) ? `"${ITEM_KIND_LABELS[kind]}" (${kind})` : `an unknown kind (${kind})`;
}

const CHECKS: Readonly<Record<PolicyCheckId, (ctx: Context) => Finding[]>> = {
  "writ.active": ({ input }) => {
    const status = input.writ_state.status;
    if (status === "ACTIVE") return [];
    return [fail("WRIT_NOT_ACTIVE", `This Writ is ${status}, not ACTIVE, so it cannot authorize a purchase.`, null, "ACTIVE", status)];
  },

  "writ.signature": ({ input }) => {
    if (input.writ_state.signature_verified) return [];
    return [fail("WRIT_SIGNATURE_INVALID", "The Writ's signature did not verify, so it cannot authorize a purchase.", null, null, null)];
  },

  "writ.not_expired": ({ writ, input, nowMs }) => {
    if (nowMs < Date.parse(writ.expires_at)) return [];
    return [
      fail(
        "WRIT_EXPIRED",
        `This Writ expired at ${writ.expires_at}; the account holder must sign a new one.`,
        "writ.expires_at",
        writ.expires_at,
        input.now,
      ),
    ];
  },

  // The bound agent id is not echoed: a caller that is not bound has no business learning it.
  "writ.agent_bound": ({ writ, input }) => {
    if (input.agent_id === writ.agent_id) return [];
    return [fail("AGENT_NOT_BOUND", "This agent is not the one bound to this Writ.", "writ.agent_id", null, input.agent_id)];
  },

  "cart.writ_match": ({ writ, cart }) => {
    if (cart.writ_id === writ.writ_id) return [];
    return [
      fail("CART_WRIT_MISMATCH", "The cart names a different Writ than the one it is checked against.", "cart.writ_id", writ.writ_id, cart.writ_id),
    ];
  },

  "cart.agent_match": ({ cart, input }) => {
    if (cart.agent_id === input.agent_id) return [];
    return [
      fail("CART_AGENT_MISMATCH", "The cart names a different agent than the one submitting it.", "cart.agent_id", input.agent_id, cart.agent_id),
    ];
  },

  "cart.currency": ({ writ, cart }) => {
    if (cart.currency === writ.currency) return [];
    return [
      fail(
        "CURRENCY_MISMATCH",
        `The cart is in ${cart.currency}, but this Writ only spends ${writ.currency}.`,
        "cart.currency",
        writ.currency,
        cart.currency,
      ),
    ];
  },

  "cart.total_consistent": ({ total, declared, money }) => {
    if (declared === total) return [];
    return [
      fail(
        "CART_TOTAL_MISMATCH",
        `The cart declares a total of ${money(declared)}, but its items, shipping and tax add up to ${money(total)}.`,
        "cart.total_minor",
        total.toString(),
        declared.toString(),
      ),
    ];
  },

  "limits.per_order": ({ writ, total, money }) => {
    const perOrder = parseMinor(writ.limits.max_per_order_minor);
    if (total <= perOrder) return [];
    return [
      fail(
        "OVER_PER_ORDER_LIMIT",
        `This order totals ${money(total)}, above the ${money(perOrder)} per-order limit.`,
        "cart.total_minor",
        perOrder.toString(),
        total.toString(),
      ),
    ];
  },

  // Same inequality as the reservation statement (§6.8), so a policy pass predicts the reserve.
  "limits.budget": ({ writ, input, total, money }) => {
    const limit = parseMinor(writ.limits.total_minor);
    const committed = input.budget.spent_minor + input.budget.reserved_minor;
    if (committed + total <= limit) return [];
    const remaining = committed < limit ? limit - committed : 0n;
    return [
      fail(
        "OVER_BUDGET",
        `This order totals ${money(total)}, but only ${money(remaining)} of the ${money(limit)} budget remains.`,
        "cart.total_minor",
        remaining.toString(),
        total.toString(),
      ),
    ];
  },

  "limits.max_orders": ({ writ, input }) => {
    const max = writ.limits.max_orders;
    const count = input.budget.orders_count;
    if (count < max) return [];
    return [
      fail(
        "MAX_ORDERS_REACHED",
        `Order limit reached: ${count} of the ${max} orders this Writ allows are already placed or in progress.`,
        "writ.limits.max_orders",
        String(max),
        String(count),
      ),
    ];
  },

  "scope.categories": ({ writ, cart }) =>
    cart.items.flatMap((item, i) =>
      categoryAllowed(writ.scope.categories, item.category)
        ? []
        : [
            fail(
              "CATEGORY_NOT_ALLOWED",
              `Item ${i + 1} is in ${categoryName(item.category)}, which this Writ does not cover.`,
              `cart.items[${i}].category`,
              writ.scope.categories.join(","),
              item.category,
            ),
          ],
    ),

  "scope.deny_kinds": ({ writ, cart }) =>
    cart.items.flatMap((item, i) =>
      kindDenied(writ.scope.deny_kinds, item.kind)
        ? [
            fail(
              "KIND_DENIED",
              `Item ${i + 1} is ${kindName(item.kind)}, a kind this Writ does not allow.`,
              `cart.items[${i}].kind`,
              null,
              item.kind,
            ),
          ]
        : [],
    ),

  "scope.merchants": ({ writ, cart }) =>
    cart.items.flatMap((item, i) => {
      const { allow, deny } = writ.scope.merchants;
      const field = `cart.items[${i}].merchant_id`;
      if (deny.includes(item.merchant_id)) {
        return [fail("MERCHANT_DENIED", `Item ${i + 1} is sold by ${item.merchant_id}, a merchant this Writ blocks.`, field, null, item.merchant_id)];
      }
      if (allow !== null && !allow.includes(item.merchant_id)) {
        return [
          fail(
            "MERCHANT_NOT_ALLOWED",
            `Item ${i + 1} is sold by ${item.merchant_id}, which is not one of the merchants this Writ allows.`,
            field,
            allow.join(","),
            item.merchant_id,
          ),
        ];
      }
      return [];
    }),

  // Agents only ever hold address refs and labels (threats T2/T6), so the check compares refs.
  ship_to: ({ writ, cart, input }) => {
    if (writ.ship_to.locked) {
      if (cart.ship_to_ref === writ.ship_to.ref) return [];
      return [
        fail(
          "SHIP_TO_LOCKED",
          `Ship-to is locked to "${writ.ship_to.label}", and this cart ships to a different address.`,
          "cart.ship_to_ref",
          writ.ship_to.ref,
          cart.ship_to_ref,
        ),
      ];
    }
    if (input.known_ship_to_refs.includes(cart.ship_to_ref)) return [];
    return [
      fail("SHIP_TO_UNKNOWN", "The ship-to address is not in the account holder's address book.", "cart.ship_to_ref", null, cart.ship_to_ref),
    ];
  },

  // Both sides are validated "YYYY-MM-DD", so string order is date order.
  "delivery.deadline": ({ writ, cart }) => {
    const deadline = writ.deliver_by;
    if (deadline === null) return [];
    if (cart.eta === null) {
      return [
        fail("ETA_MISSING", `This Writ requires delivery by ${deadline}, but the cart has no delivery estimate.`, "cart.eta", deadline, null),
      ];
    }
    if (cart.eta <= deadline) return [];
    return [fail("ETA_AFTER_DEADLINE", `Estimated delivery ${cart.eta} is after the ${deadline} deadline.`, "cart.eta", deadline, cart.eta)];
  },

  velocity: ({ writ, input }) => {
    const max = writ.limits.max_checkouts_per_hour;
    const count = input.velocity.checkouts_last_hour;
    if (count < max) return [];
    return [
      fail(
        "VELOCITY_LIMIT",
        `This agent already made ${count} checkouts in the last hour; this Writ allows ${max} per hour.`,
        "writ.limits.max_checkouts_per_hour",
        String(max),
        String(count),
      ),
    ];
  },
};

/**
 * Runs every check in POLICY_CHECK_IDS order. Any failure → BLOCK with all failure reasons; else
 * an amount above require_human_above_minor → REVIEW (REVIEW_THRESHOLD); else APPROVE. Same input,
 * same decision, same H_p. Throws PolicyInputError only on malformed input.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const parsed = PolicyInputSchema.safeParse(input);
  if (!parsed.success) throw new PolicyInputError(parsed.error.issues);
  const data = parsed.data;
  const { writ, cart } = data;
  const total = computeCartTotal(cart);
  const ctx: Context = {
    input: data,
    writ,
    cart,
    nowMs: Date.parse(data.now),
    total,
    declared: parseMinor(cart.total_minor),
    money: (minor) => `${CURRENCY_SYMBOLS[writ.currency]}${minorToPayPalValue(minor, writ.currency)}`,
  };

  const checks: PolicyCheck[] = POLICY_CHECK_IDS.map((id) => {
    const reasons: PolicyReason[] = CHECKS[id](ctx).map((finding) => ({ check: id, ...finding }));
    return { id, passed: reasons.length === 0, reasons };
  });
  const failed = checks.flatMap((check) => check.reasons);
  const decision = (verdict: PolicyDecision["verdict"], reasons: PolicyReason[]): PolicyDecision => ({
    policy_version: POLICY_VERSION,
    verdict,
    amount_minor: total.toString(),
    checks,
    reasons,
  });

  if (failed.length > 0) return decision("BLOCK", failed);
  const threshold = parseMinor(writ.limits.require_human_above_minor);
  if (total <= threshold) return decision("APPROVE", []);
  return decision("REVIEW", [
    {
      check: THRESHOLD_CHECK_ID,
      code: "REVIEW_THRESHOLD",
      message: `This order totals ${ctx.money(total)}, above the ${ctx.money(threshold)} approval threshold, so the account holder must approve it with a passkey.`,
      field: "cart.total_minor",
      expected: threshold.toString(),
      actual: total.toString(),
    },
  ]);
}
