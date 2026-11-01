import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  jcs,
  POLICY_CHECK_IDS,
  POLICY_VERSION,
  PolicyDecisionSchema,
  policyDecisionHash,
  policyDecisionHashHex,
  PolicyInputError,
  toHex,
  type Cart,
  type CartItem,
  type PolicyCheckId,
  type PolicyDecision,
  type PolicyInput,
  type PolicyReasonCode,
  type WritBody,
} from "../src/index";

const WRIT_ID = "wr_01m6gvezy0dr1r16bxj90g7evg";
const OTHER_WRIT = "wr_01m6gvezy0aaaaaaaaaaaaaaaa";
const USER_ID = "usr_01m4xbgky0sz7a9g9yq0gp0b0q";
const AGENT_ID = "agt_01m6bpnhy0gamhs3rbkgbgz6jz";
const OTHER_AGENT = "agt_01m6bpnhy0zzzzzzzzzzzzzzzz";
const HOME = "adr_01m4zxxay0px37k8h9k4b9zy5q";
const NEWARK = "adr_01m4zxxay0vkd6kyffwvg0gaxe";
/** Scene 6/7 happen on Nov 3, an hour after Ana signs. */
const NOW = "2026-11-03T15:10:00.000Z";

/** Plan §4 scene 3: the hero Writ (same golden vector as writ.test.ts). */
const HERO_WRIT: WritBody = {
  spec: "writ/0.1",
  writ_id: WRIT_ID,
  principal: { user_id: USER_ID },
  agent_id: AGENT_ID,
  purpose: "Pottery-themed gift for my sister",
  currency: "USD",
  limits: {
    total_minor: "6000",
    max_per_order_minor: "6000",
    require_human_above_minor: "4000",
    max_orders: 1,
    max_checkouts_per_hour: 3,
  },
  scope: {
    categories: [
      "arts_crafts.pottery_ceramics",
      "home_kitchen.drinkware",
      "home_kitchen.coffee_tea",
      "home_decor.vases_planters",
    ],
    deny_kinds: ["gift_card", "protection_plan", "subscription", "digital_goods", "money_transfer", "crypto"],
    merchants: { allow: null, deny: [] },
  },
  item_constraints: ["Pottery or ceramics themed", "Suitable as a gift for an adult"],
  ship_to: { ref: HOME, label: "Home (Austin)", locked: true },
  deliver_by: "2026-11-20",
  issued_at: "2026-11-03T14:02:00.000Z",
  expires_at: "2026-11-10T14:02:00.000Z",
};

const POUR_OVER: CartItem = {
  product_ref: "ch3_prod_7731pourover",
  title: "Hand-thrown ceramic pour-over set",
  merchant_id: "writ-market",
  category: "home_kitchen.coffee_tea",
  kind: "goods",
  unit_minor: "4400",
  qty: 1,
};

/** Plan §4 scene 7: the cart Atlas proposes after re-planning (cart.test.ts golden vector). */
const SCENE_7_CART: Cart = {
  spec: "writ-cart/0.1",
  cart_id: "crt_01m6gvezy0vqn00x67yvf9n9ap",
  writ_id: WRIT_ID,
  agent_id: AGENT_ID,
  currency: "USD",
  items: [POUR_OVER],
  shipping_minor: "0",
  tax_minor: "0",
  total_minor: "4400",
  ship_to_ref: HOME,
  eta: "2026-11-17",
};

/** Plan §4 scene 5: the hijacked cart (mug set $36 + "Gift Protection Plus" $49, ship to Newark). */
const SCENE_6_CART: Cart = {
  ...SCENE_7_CART,
  cart_id: "crt_01m6gvezy0vqn00x67yvf9n9aq",
  items: [
    {
      ...POUR_OVER,
      product_ref: "ch3_prod_2210mugset",
      title: "Stoneware mug set",
      category: "home_kitchen.drinkware",
      unit_minor: "3600",
    },
    {
      product_ref: "deals-outlet:gpp",
      title: "Gift Protection Plus",
      merchant_id: "deals-outlet.test",
      category: "services.protection_plans",
      kind: "protection_plan",
      unit_minor: "4900",
      qty: 1,
    },
  ],
  total_minor: "8500",
  ship_to_ref: NEWARK,
};

/** A $30 mug: under the $40 threshold, so every check passes and the verdict is APPROVE. */
const MUG: CartItem = {
  product_ref: "ch3_prod_5512mug",
  title: "Speckled stoneware mug",
  merchant_id: "writ-market",
  category: "home_kitchen.drinkware",
  kind: "goods",
  unit_minor: "2600",
  qty: 1,
};
const SMALL_CART: Cart = { ...SCENE_7_CART, items: [MUG], shipping_minor: "300", tax_minor: "100", total_minor: "3000" };

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    writ: HERO_WRIT,
    writ_state: { status: "ACTIVE", signature_verified: true },
    agent_id: AGENT_ID,
    cart: SMALL_CART,
    budget: { spent_minor: 0n, reserved_minor: 0n, orders_count: 0 },
    velocity: { checkouts_last_hour: 0 },
    known_ship_to_refs: [HOME],
    now: NOW,
    ...overrides,
  };
}

function writWith(patch: { limits?: Partial<WritBody["limits"]>; scope?: Partial<WritBody["scope"]> } & Partial<Omit<WritBody, "limits" | "scope">>): WritBody {
  const { limits, scope, ...rest } = patch;
  return { ...HERO_WRIT, ...rest, limits: { ...HERO_WRIT.limits, ...limits }, scope: { ...HERO_WRIT.scope, ...scope } };
}

function cartWith(patch: Partial<Cart>): Cart {
  return { ...SMALL_CART, ...patch };
}

function item(patch: Partial<CartItem>): CartItem {
  return { ...MUG, ...patch };
}

function failedChecks(decision: PolicyDecision): PolicyCheckId[] {
  return decision.checks.filter((check) => !check.passed).map((check) => check.id);
}

function codes(decision: PolicyDecision): PolicyReasonCode[] {
  return decision.reasons.map((reason) => reason.code);
}

/** Bypasses the TS types to model a value that skipped validation upstream. */
function unchecked<T>(value: unknown): T {
  return value as T;
}

describe("policy engine baseline", () => {
  it("approves an in-scope cart under the threshold with every check passed, in order", () => {
    const decision = evaluatePolicy(input());
    expect(decision.verdict).toBe("APPROVE");
    expect(decision.policy_version).toBe(POLICY_VERSION);
    expect(decision.amount_minor).toBe("3000");
    expect(decision.checks.map((check) => check.id)).toEqual([...POLICY_CHECK_IDS]);
    expect(decision.checks.every((check) => check.passed && check.reasons.length === 0)).toBe(true);
    expect(decision.reasons).toEqual([]);
  });
});

interface FailCase {
  name: string;
  input: PolicyInput;
  check: PolicyCheckId;
  code: PolicyReasonCode;
  field: string | null;
  expected: string | null;
  actual: string | null;
}

const FAIL_CASES: FailCase[] = [
  ...(["DRAFT", "REVOKED", "EXPIRED"] as const).map((status) => ({
    name: `writ status ${status}`,
    input: input({ writ_state: { status, signature_verified: true } }),
    check: "writ.active" as const,
    code: "WRIT_NOT_ACTIVE" as const,
    field: null,
    expected: "ACTIVE",
    actual: status,
  })),
  {
    name: "unverified signature",
    input: input({ writ_state: { status: "ACTIVE", signature_verified: false } }),
    check: "writ.signature",
    code: "WRIT_SIGNATURE_INVALID",
    field: null,
    expected: null,
    actual: null,
  },
  {
    name: "now exactly at expires_at",
    input: input({ now: HERO_WRIT.expires_at }),
    check: "writ.not_expired",
    code: "WRIT_EXPIRED",
    field: "writ.expires_at",
    expected: HERO_WRIT.expires_at,
    actual: HERO_WRIT.expires_at,
  },
  {
    name: "caller is not the bound agent (and the cart says so honestly)",
    input: input({ agent_id: OTHER_AGENT, cart: cartWith({ agent_id: OTHER_AGENT }) }),
    check: "writ.agent_bound",
    code: "AGENT_NOT_BOUND",
    field: "writ.agent_id",
    expected: null,
    actual: OTHER_AGENT,
  },
  {
    name: "cart for another Writ",
    input: input({ cart: cartWith({ writ_id: OTHER_WRIT }) }),
    check: "cart.writ_match",
    code: "CART_WRIT_MISMATCH",
    field: "cart.writ_id",
    expected: WRIT_ID,
    actual: OTHER_WRIT,
  },
  {
    name: "cart claims another agent",
    input: input({ cart: cartWith({ agent_id: OTHER_AGENT }) }),
    check: "cart.agent_match",
    code: "CART_AGENT_MISMATCH",
    field: "cart.agent_id",
    expected: AGENT_ID,
    actual: OTHER_AGENT,
  },
  {
    name: "cart in another currency",
    input: input({ cart: cartWith({ currency: unchecked<"USD">("EUR") }) }),
    check: "cart.currency",
    code: "CURRENCY_MISMATCH",
    field: "cart.currency",
    expected: "USD",
    actual: "EUR",
  },
  {
    name: "declared total below the computed total",
    input: input({ cart: cartWith({ total_minor: "2900" }) }),
    check: "cart.total_consistent",
    code: "CART_TOTAL_MISMATCH",
    field: "cart.total_minor",
    expected: "3000",
    actual: "2900",
  },
  {
    name: "total above max per order",
    input: input({
      writ: writWith({ limits: { max_per_order_minor: "2500", require_human_above_minor: "2500" } }),
    }),
    check: "limits.per_order",
    code: "OVER_PER_ORDER_LIMIT",
    field: "cart.total_minor",
    expected: "2500",
    actual: "3000",
  },
  {
    name: "spent + total above the budget",
    input: input({ budget: { spent_minor: 3500n, reserved_minor: 0n, orders_count: 0 } }),
    check: "limits.budget",
    code: "OVER_BUDGET",
    field: "cart.total_minor",
    expected: "2500",
    actual: "3000",
  },
  {
    name: "reserved + total above the budget",
    input: input({ budget: { spent_minor: 0n, reserved_minor: 3001n, orders_count: 0 } }),
    check: "limits.budget",
    code: "OVER_BUDGET",
    field: "cart.total_minor",
    expected: "2999",
    actual: "3000",
  },
  {
    name: "budget already exhausted (remaining shown as 0, never negative)",
    input: input({ budget: { spent_minor: 6000n, reserved_minor: 500n, orders_count: 0 } }),
    check: "limits.budget",
    code: "OVER_BUDGET",
    field: "cart.total_minor",
    expected: "0",
    actual: "3000",
  },
  {
    name: "max orders already used",
    input: input({ budget: { spent_minor: 0n, reserved_minor: 0n, orders_count: 1 } }),
    check: "limits.max_orders",
    code: "MAX_ORDERS_REACHED",
    field: "writ.limits.max_orders",
    expected: "1",
    actual: "1",
  },
  {
    name: "category outside the Writ (plain goods)",
    input: input({ cart: cartWith({ items: [item({ category: "electronics.audio", unit_minor: "2600" })] }) }),
    check: "scope.categories",
    code: "CATEGORY_NOT_ALLOWED",
    field: "cart.items[0].category",
    expected: HERO_WRIT.scope.categories.join(","),
    actual: "electronics.audio",
  },
  {
    name: "unknown category code",
    input: input({ cart: cartWith({ items: [item({ category: unchecked<CartItem["category"]>("made_up.leaf") })] }) }),
    check: "scope.categories",
    code: "CATEGORY_NOT_ALLOWED",
    field: "cart.items[0].category",
    expected: HERO_WRIT.scope.categories.join(","),
    actual: "made_up.leaf",
  },
  {
    name: "denied kind inside an allowed category",
    input: input({ cart: cartWith({ items: [item({ kind: "gift_card" })] }) }),
    check: "scope.deny_kinds",
    code: "KIND_DENIED",
    field: "cart.items[0].kind",
    expected: null,
    actual: "gift_card",
  },
  {
    name: "unknown kind",
    input: input({ cart: cartWith({ items: [item({ kind: unchecked<CartItem["kind"]>("nft") })] }) }),
    check: "scope.deny_kinds",
    code: "KIND_DENIED",
    field: "cart.items[0].kind",
    expected: null,
    actual: "nft",
  },
  {
    name: "merchant on the deny list",
    input: input({ writ: writWith({ scope: { merchants: { allow: null, deny: ["writ-market"] } } }) }),
    check: "scope.merchants",
    code: "MERCHANT_DENIED",
    field: "cart.items[0].merchant_id",
    expected: null,
    actual: "writ-market",
  },
  {
    name: "merchant missing from the allow list",
    input: input({ writ: writWith({ scope: { merchants: { allow: ["clay-studio", "kiln.example"], deny: [] } } }) }),
    check: "scope.merchants",
    code: "MERCHANT_NOT_ALLOWED",
    field: "cart.items[0].merchant_id",
    expected: "clay-studio,kiln.example",
    actual: "writ-market",
  },
  {
    name: "locked ship-to swapped",
    input: input({ cart: cartWith({ ship_to_ref: NEWARK }), known_ship_to_refs: [HOME, NEWARK] }),
    check: "ship_to",
    code: "SHIP_TO_LOCKED",
    field: "cart.ship_to_ref",
    expected: HOME,
    actual: NEWARK,
  },
  {
    name: "unlocked ship-to outside the address book",
    input: input({
      writ: writWith({ ship_to: { ...HERO_WRIT.ship_to, locked: false } }),
      cart: cartWith({ ship_to_ref: NEWARK }),
    }),
    check: "ship_to",
    code: "SHIP_TO_UNKNOWN",
    field: "cart.ship_to_ref",
    expected: null,
    actual: NEWARK,
  },
  {
    name: "eta after deliver_by",
    input: input({ cart: cartWith({ eta: "2026-11-21" }) }),
    check: "delivery.deadline",
    code: "ETA_AFTER_DEADLINE",
    field: "cart.eta",
    expected: "2026-11-20",
    actual: "2026-11-21",
  },
  {
    name: "no eta while a deadline is set (fail closed)",
    input: input({ cart: cartWith({ eta: null }) }),
    check: "delivery.deadline",
    code: "ETA_MISSING",
    field: "cart.eta",
    expected: "2026-11-20",
    actual: null,
  },
  {
    name: "checkouts per hour used up",
    input: input({ velocity: { checkouts_last_hour: 3 } }),
    check: "velocity",
    code: "VELOCITY_LIMIT",
    field: "writ.limits.max_checkouts_per_hour",
    expected: "3",
    actual: "3",
  },
];

describe("policy checks: each one fails on its own", () => {
  it("has a fail case for every check", () => {
    expect(new Set(FAIL_CASES.map((c) => c.check))).toEqual(new Set(POLICY_CHECK_IDS));
  });

  it.each(FAIL_CASES)("$check fails: $name", (c) => {
    const decision = evaluatePolicy(c.input);
    expect(decision.verdict).toBe("BLOCK");
    expect(failedChecks(decision)).toEqual([c.check]);
    expect(decision.reasons).toEqual([
      { check: c.check, code: c.code, message: expect.any(String), field: c.field, expected: c.expected, actual: c.actual },
    ]);
    const check = decision.checks.find((entry) => entry.id === c.check);
    expect(check?.reasons).toEqual(decision.reasons);
    expect(decision.reasons[0]?.message.length).toBeGreaterThan(10);
    expect(PolicyDecisionSchema.parse(decision)).toEqual(decision);
  });
});

describe("policy checks: boundaries and passing variants", () => {
  const PASS_CASES: [string, PolicyInput][] = [
    ["one millisecond before expiry", input({ now: "2026-11-10T14:01:59.999Z" })],
    ["spent + reserved + total exactly at the budget", input({ budget: { spent_minor: 2000n, reserved_minor: 1000n, orders_count: 0 } })],
    ["total exactly at max per order", input({ writ: writWith({ limits: { max_per_order_minor: "3000", require_human_above_minor: "3000" } }) })],
    ["orders below max", input({ writ: writWith({ limits: { max_orders: 2 } }), budget: { spent_minor: 0n, reserved_minor: 0n, orders_count: 1 } })],
    ["a parent selector allows its leaves", input({ writ: writWith({ scope: { categories: ["home_kitchen"] } }) })],
    ["a kind the Writ does not deny", input({ writ: writWith({ scope: { deny_kinds: ["crypto"] } }), cart: cartWith({ items: [item({ kind: "gift_card" })] }) })],
    ["merchant on the allow list", input({ writ: writWith({ scope: { merchants: { allow: ["writ-market"], deny: ["deals-outlet.test"] } } }) })],
    [
      "unlocked ship-to inside the address book",
      input({
        writ: writWith({ ship_to: { ...HERO_WRIT.ship_to, locked: false } }),
        cart: cartWith({ ship_to_ref: NEWARK }),
        known_ship_to_refs: [HOME, NEWARK],
      }),
    ],
    ["eta exactly on deliver_by", input({ cart: cartWith({ eta: "2026-11-20" }) })],
    ["no deadline and no eta", input({ writ: writWith({ deliver_by: null }), cart: cartWith({ eta: null }) })],
    ["one checkout left this hour", input({ velocity: { checkouts_last_hour: 2 } })],
    ["the bound agent with its own cart", input({ agent_id: AGENT_ID })],
  ];

  it.each(PASS_CASES)("passes: %s", (_name, value) => {
    const decision = evaluatePolicy(value);
    expect(failedChecks(decision)).toEqual([]);
    expect(decision.verdict).toBe("APPROVE");
  });

  it("asks a human exactly when the total is above require_human_above_minor", () => {
    const at = evaluatePolicy(input({ cart: cartWith({ shipping_minor: "1300", total_minor: "4000" }) }));
    expect(at.verdict).toBe("APPROVE");
    const above = evaluatePolicy(input({ cart: cartWith({ shipping_minor: "1301", total_minor: "4001" }) }));
    expect(above.verdict).toBe("REVIEW");
    expect(above.reasons).toEqual([
      {
        check: "threshold.human_review",
        code: "REVIEW_THRESHOLD",
        message: expect.stringContaining("$40.01"),
        field: "cart.total_minor",
        expected: "4000",
        actual: "4001",
      },
    ]);
    expect(above.checks.every((check) => check.passed)).toBe(true);
  });

  it("treats a threshold of 0 as always ask", () => {
    const decision = evaluatePolicy(input({ writ: writWith({ limits: { require_human_above_minor: "0" } }) }));
    expect(decision.verdict).toBe("REVIEW");
    expect(codes(decision)).toEqual(["REVIEW_THRESHOLD"]);
  });

  it("does not report the threshold once a check fails (BLOCK is final)", () => {
    const decision = evaluatePolicy(input({ cart: SCENE_7_CART, velocity: { checkouts_last_hour: 3 } }));
    expect(decision.verdict).toBe("BLOCK");
    expect(codes(decision)).toEqual(["VELOCITY_LIMIT"]);
  });

  it("reports every offending line of a per-item check, in line order", () => {
    const cart = cartWith({
      items: [
        item({ product_ref: "a", kind: "gift_card", category: "services.gift_cards", merchant_id: "bad-shop", unit_minor: "1000" }),
        item({ product_ref: "b", unit_minor: "1000" }),
        item({ product_ref: "c", kind: "subscription", category: "services.subscriptions", merchant_id: "bad-shop", unit_minor: "600" }),
      ],
    });
    const decision = evaluatePolicy(
      input({ cart, writ: writWith({ scope: { merchants: { allow: null, deny: ["bad-shop"] } } }) }),
    );
    expect(failedChecks(decision)).toEqual(["scope.categories", "scope.deny_kinds", "scope.merchants"]);
    expect(decision.reasons.map((reason) => `${reason.code}@${reason.field}`)).toEqual([
      "CATEGORY_NOT_ALLOWED@cart.items[0].category",
      "CATEGORY_NOT_ALLOWED@cart.items[2].category",
      "KIND_DENIED@cart.items[0].kind",
      "KIND_DENIED@cart.items[2].kind",
      "MERCHANT_DENIED@cart.items[0].merchant_id",
      "MERCHANT_DENIED@cart.items[2].merchant_id",
    ]);
    const kinds = decision.checks.find((check) => check.id === "scope.deny_kinds");
    expect(kinds?.reasons).toHaveLength(2);
  });

  it("evaluates every check even when the Writ itself is unusable", () => {
    const decision = evaluatePolicy(
      input({
        writ_state: { status: "REVOKED", signature_verified: false },
        agent_id: OTHER_AGENT,
        now: "2026-12-01T00:00:00.000Z",
        cart: SCENE_6_CART,
        velocity: { checkouts_last_hour: 9 },
      }),
    );
    expect(decision.checks.map((check) => check.id)).toEqual([...POLICY_CHECK_IDS]);
    expect(failedChecks(decision)).toEqual([
      "writ.active",
      "writ.signature",
      "writ.not_expired",
      "writ.agent_bound",
      "cart.agent_match",
      "limits.per_order",
      "limits.budget",
      "scope.categories",
      "scope.deny_kinds",
      "ship_to",
      "velocity",
    ]);
  });

  it("names categories and kinds in plain English without echoing item titles", () => {
    const decision = evaluatePolicy(input({ cart: SCENE_6_CART }));
    const messages = decision.reasons.map((reason) => reason.message).join("\n");
    expect(messages).toContain('"Protection plans & warranties" (services.protection_plans)');
    expect(messages).toContain('"Protection plans & warranties" (protection_plan)');
    expect(messages).toContain("$85.00");
    expect(messages).toContain('"Home (Austin)"');
    expect(messages).not.toContain("Gift Protection Plus");
    expect(messages).not.toContain("Stoneware mug set");
    const unknown = evaluatePolicy(
      input({ cart: cartWith({ items: [item({ category: unchecked<CartItem["category"]>("made_up.leaf"), kind: unchecked<CartItem["kind"]>("nft") })] }) }),
    );
    expect(unknown.reasons.map((reason) => reason.message)).toEqual([
      expect.stringContaining("an unknown category (made_up.leaf)"),
      expect.stringContaining("an unknown kind (nft)"),
    ]);
  });

  it("limits on the computed total, not the declared one", () => {
    const decision = evaluatePolicy(input({ cart: cartWith({ total_minor: "100" }), budget: { spent_minor: 3500n, reserved_minor: 0n, orders_count: 0 } }));
    expect(decision.amount_minor).toBe("3000");
    expect(codes(decision)).toEqual(["CART_TOTAL_MISMATCH", "OVER_BUDGET"]);
  });

  it("handles totals beyond the 16-digit input format without overflow or throw", () => {
    const huge = item({ unit_minor: "9999999999999999", qty: 99 });
    const items = Array.from({ length: 20 }, (_, i) => ({ ...huge, product_ref: `ref${i}` }));
    const decision = evaluatePolicy(input({ cart: cartWith({ items, total_minor: "9999999999999999" }) }));
    const expectedTotal = (9999999999999999n * 99n * 20n + 400n).toString();
    expect(decision.amount_minor).toBe(expectedTotal);
    expect(decision.verdict).toBe("BLOCK");
    expect(failedChecks(decision)).toEqual(["cart.total_consistent", "limits.per_order", "limits.budget"]);
    expect(PolicyDecisionSchema.parse(decision)).toEqual(decision);
  });
});

describe("hero scenes (plan §4)", () => {
  const scene6 = evaluatePolicy(input({ cart: SCENE_6_CART, velocity: { checkouts_last_hour: 0 } }));
  const scene7 = evaluatePolicy(input({ cart: SCENE_7_CART, velocity: { checkouts_last_hour: 1 } }));

  it("scene 6: the hijacked cart is blocked by budget, scope and ship-to, all reported at once", () => {
    expect(scene6.verdict).toBe("BLOCK");
    expect(scene6.amount_minor).toBe("8500");
    expect(failedChecks(scene6)).toEqual(["limits.per_order", "limits.budget", "scope.categories", "scope.deny_kinds", "ship_to"]);
    expect(codes(scene6)).toEqual(["OVER_PER_ORDER_LIMIT", "OVER_BUDGET", "CATEGORY_NOT_ALLOWED", "KIND_DENIED", "SHIP_TO_LOCKED"]);
    // The Wallet's "three red checks": amount, category/kind, ship-to.
    expect(new Set(failedChecks(scene6).map((id) => id.split(".")[0]))).toEqual(new Set(["limits", "scope", "ship_to"]));
    expect(scene6.reasons).toEqual([
      expect.objectContaining({ code: "OVER_PER_ORDER_LIMIT", expected: "6000", actual: "8500", field: "cart.total_minor" }),
      expect.objectContaining({ code: "OVER_BUDGET", expected: "6000", actual: "8500", field: "cart.total_minor" }),
      expect.objectContaining({ code: "CATEGORY_NOT_ALLOWED", actual: "services.protection_plans", field: "cart.items[1].category" }),
      expect.objectContaining({ code: "KIND_DENIED", actual: "protection_plan", field: "cart.items[1].kind" }),
      expect.objectContaining({ code: "SHIP_TO_LOCKED", expected: HOME, actual: NEWARK, field: "cart.ship_to_ref" }),
    ]);
  });

  it("scene 7: the $44 pour-over set passes every check and goes to human review (44 > 40)", () => {
    expect(scene7.verdict).toBe("REVIEW");
    expect(scene7.amount_minor).toBe("4400");
    expect(failedChecks(scene7)).toEqual([]);
    expect(scene7.reasons).toEqual([
      {
        check: "threshold.human_review",
        code: "REVIEW_THRESHOLD",
        message:
          "This order totals $44.00, above the $40.00 approval threshold, so the account holder must approve it with a passkey.",
        field: "cart.total_minor",
        expected: "4000",
        actual: "4400",
      },
    ]);
    const pottery = evaluatePolicy(
      input({ cart: { ...SCENE_7_CART, items: [{ ...POUR_OVER, category: "arts_crafts.pottery_ceramics" }] }, velocity: { checkouts_last_hour: 1 } }),
    );
    expect(pottery.verdict).toBe("REVIEW");
  });

  it("scene 7 decision hashes to a stable H_p (changing it means bumping POLICY_VERSION)", () => {
    const canonical = jcs(scene7);
    expect(policyDecisionHashHex(scene7)).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
    expect(toHex(policyDecisionHash(scene7))).toBe(policyDecisionHashHex(scene7));
    expect(policyDecisionHashHex(scene7)).toBe(SCENE_7_HP);
    expect(policyDecisionHashHex(scene6)).not.toBe(SCENE_7_HP);
  });
});

// Pinned: H_p feeds C_pre and the PayPal custom_id (plan §6.7).
const SCENE_7_HP = "b87f7559759baeaafaddb9847f6c429168c1dda7182a77d15bfa0233d9974c5c";

describe("policy decision is plain, hashable JSON", () => {
  it("round-trips through JSON and the decision schema unchanged", () => {
    for (const value of [input(), input({ cart: SCENE_6_CART }), input({ cart: SCENE_7_CART })]) {
      const decision = evaluatePolicy(value);
      expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
      expect(PolicyDecisionSchema.parse(decision)).toEqual(decision);
      expect(() => jcs(decision)).not.toThrow();
    }
  });

  it("is deterministic and does not touch its input", () => {
    const value = input({ cart: SCENE_6_CART });
    const frozen = deepFreeze(structuredClone(value));
    expect(evaluatePolicy(frozen)).toEqual(evaluatePolicy(value));
    expect(policyDecisionHashHex(evaluatePolicy(frozen))).toBe(policyDecisionHashHex(evaluatePolicy(value)));
  });

  it("rejects inconsistent or reshaped decisions", () => {
    const decision = evaluatePolicy(input({ cart: SCENE_6_CART }));
    const passedWithReasons = structuredClone(decision);
    const firstFailed = passedWithReasons.checks.find((check) => !check.passed);
    if (firstFailed) firstFailed.passed = true;
    expect(PolicyDecisionSchema.safeParse(passedWithReasons).success).toBe(false);

    const foreignReason = structuredClone(decision);
    const perOrder = foreignReason.checks.find((check) => check.id === "limits.per_order");
    if (perOrder?.reasons[0]) perOrder.reasons[0].check = "ship_to";
    expect(PolicyDecisionSchema.safeParse(foreignReason).success).toBe(false);

    expect(PolicyDecisionSchema.safeParse({ ...decision, amount_minor: "08500" }).success).toBe(false);
    expect(PolicyDecisionSchema.safeParse({ ...decision, policy_version: "policy/9" }).success).toBe(false);
    expect(PolicyDecisionSchema.safeParse({ ...decision, extra: true }).success).toBe(false);
  });
});

describe("malformed policy input", () => {
  const BAD: [string, unknown][] = [
    ["not an object", null],
    ["writ fails WritBodySchema", input({ writ: writWith({ limits: { total_minor: "0" } }) })],
    ["cart amount with a decimal point", input({ cart: cartWith({ total_minor: "30.00" }) })],
    ["cart with an unknown field (payee)", input({ cart: { ...SMALL_CART, payee: "attacker@example.com" } as Cart })],
    ["lowercase currency", input({ cart: cartWith({ currency: unchecked<"USD">("usd") }) })],
    ["category with free text", input({ cart: cartWith({ items: [item({ category: unchecked<CartItem["category"]>("Pottery gifts") })] }) })],
    ["no items", input({ cart: cartWith({ items: [] }) })],
    ["two lines for the same product", input({ cart: cartWith({ items: [MUG, { ...MUG, unit_minor: "0" }], total_minor: "3000" }) })],
    ["negative spend", input({ budget: { spent_minor: -1n, reserved_minor: 0n, orders_count: 0 } })],
    ["spend as a float number", input({ budget: { spent_minor: unchecked<bigint>(10.5), reserved_minor: 0n, orders_count: 0 } })],
    ["fractional order count", input({ budget: { spent_minor: 0n, reserved_minor: 0n, orders_count: 0.5 } })],
    ["negative velocity", input({ velocity: { checkouts_last_hour: -1 } })],
    ["caller id that is not an agent id", input({ agent_id: USER_ID })],
    ["date-only now", input({ now: "2026-11-03" })],
    ["unknown writ status", input({ writ_state: { status: unchecked<"ACTIVE">("PAUSED"), signature_verified: true } })],
  ];

  it.each(BAD)("throws PolicyInputError: %s", (_name, value) => {
    expect(() => evaluatePolicy(value as PolicyInput)).toThrow(PolicyInputError);
  });

  it("lists every issue with its path", () => {
    try {
      evaluatePolicy(input({ now: "yesterday", velocity: { checkouts_last_hour: -1 } }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyInputError);
      expect(error).toBeInstanceOf(TypeError);
      const policyError = error as PolicyInputError;
      expect(policyError.name).toBe("PolicyInputError");
      expect(policyError.issues.length).toBe(2);
      expect(policyError.message).toContain("$.now");
      expect(policyError.message).toContain("$.velocity.checkouts_last_hour");
    }
    expect(() => evaluatePolicy(null as unknown as PolicyInput)).toThrow(/invalid policy input: \$: /);
  });

  it("ignores extra fields on the snapshot objects (e.g. a whole DB row)", () => {
    const budgetRow = { spent_minor: 0n, reserved_minor: 0n, orders_count: 0, version: 7, writ_id: WRIT_ID };
    expect(evaluatePolicy(input({ budget: budgetRow })).verdict).toBe("APPROVE");
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
