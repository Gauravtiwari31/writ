// The HTTP API contract ("@writ/core/api"): representative requests and responses parse, strict
// shapes refuse extra fields, and the SSE union covers every event type.
import { describe, expect, it } from "vitest";
import {
  AgentPurchaseViewSchema,
  AgentSearchRequestSchema,
  ApiErrorSchema,
  CheckoutResponseSchema,
  CompileRequestSchema,
  ConsoleQueryRequestSchema,
  CreateAgentResponseSchema,
  IdempotencyKeySchema,
  localIdSchema,
  MetaResponseSchema,
  PayPalConfigResponseSchema,
  ProposeCartRequestSchema,
  RunEventSchema,
  STREAM_EVENT_TYPES,
  StreamMessageSchema,
  TenantIdSchema,
  WebAuthnRequestOptionsSchema,
} from "../src/api/index";
import { newId } from "../src/index";

const ULID = "01jbz3m4n5p6q7r8s9t0v1w2x3";

describe("common", () => {
  it("builds local id schemas for gateway-only rows", () => {
    expect(localIdSchema("run").safeParse(`run_${ULID}`).success).toBe(true);
    expect(localIdSchema("run").safeParse(`dec_${ULID}`).success).toBe(false);
    expect(localIdSchema("run").safeParse("run_../x").success).toBe(false);
    expect(() => localIdSchema("RUN")).toThrow(TypeError);
    expect(TenantIdSchema.safeParse(`tn_${ULID}`).success).toBe(true);
    expect(TenantIdSchema.safeParse("tn x").success).toBe(false);
  });

  it("accepts the error envelope and simplewebauthn request options", () => {
    expect(ApiErrorSchema.parse({ error: "not_implemented", message: "owner: money" })).toMatchObject({ error: "not_implemented" });
    const options = { challenge: "q83vEjRWeJA", rpId: "localhost", allowCredentials: [{ id: "AQID", type: "public-key", transports: ["internal"] }], userVerification: "required", hints: [] };
    expect(WebAuthnRequestOptionsSchema.parse(options)).toMatchObject({ rpId: "localhost" });
    expect(WebAuthnRequestOptionsSchema.safeParse({ ...options, challenge: "not b64!" }).success).toBe(false);
  });
});

describe("agent API", () => {
  it("requires a printable Idempotency-Key", () => {
    expect(IdempotencyKeySchema.safeParse("run-1:checkout:1").success).toBe(true);
    expect(IdempotencyKeySchema.safeParse("").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("has space").success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("x".repeat(256)).success).toBe(false);
  });

  it("lets an agent pick product refs, quantities and an address ref, nothing else", () => {
    const request = {
      writ_id: newId("wr"),
      items: [{ product_ref: "do-pour-over-set", qty: 1 }],
      ship_to_ref: newId("adr"),
      sources: [{ url: "https://writ.test/fixtures/deals-outlet/coupons", kind: "page", fetched_at: "2026-11-03T14:02:00.000Z" }],
    };
    expect(ProposeCartRequestSchema.parse(request).items).toHaveLength(1);
    expect(ProposeCartRequestSchema.safeParse({ ...request, payee: "attacker@example.com" }).success).toBe(false);
    expect(ProposeCartRequestSchema.safeParse({ ...request, items: [{ product_ref: "x", qty: 1, unit_minor: "1" }] }).success).toBe(false);
    expect(ProposeCartRequestSchema.safeParse({ ...request, ship_to_ref: "Newark NJ" }).success).toBe(false);
    expect(AgentSearchRequestSchema.safeParse({ query: "pottery gift", limit: 31 }).success).toBe(false);
  });

  it("returns typed checkout outcomes and marks replays", () => {
    const view = {
      purchase_id: newId("pur"),
      status: "BLOCKED",
      state_reason: "policy_blocked",
      verdict: "BLOCK",
      reasons: [{ stage: "policy", code: "KIND_DENIED", message: "Protection plans are not allowed." }],
      policy_reasons: [],
      amount_minor: "8500",
      paypal: { order_id: null, authorization_id: null, capture_id: null },
      approval: null,
      money_moved: false,
      receipt_path: "/receipts/pur_x",
    };
    expect(AgentPurchaseViewSchema.parse(view).money_moved).toBe(false);
    expect(CheckoutResponseSchema.parse({ ...view, replayed: true }).replayed).toBe(true);
    expect(CheckoutResponseSchema.safeParse(view).success).toBe(false);
    expect(CheckoutResponseSchema.safeParse({ ...view, replayed: false, extra: 1 }).success).toBe(false);
  });
});

describe("wallet API", () => {
  it("caps compile input and shows an agent key once", () => {
    expect(CompileRequestSchema.safeParse({ text: "" }).success).toBe(false);
    expect(CompileRequestSchema.safeParse({ text: "x".repeat(2001) }).success).toBe(false);
    const agent = {
      agent_id: newId("agt"),
      name: "My agent",
      kind: "sdk",
      builtin_kind: null,
      key_hint: "AbCd",
      created_at: "2026-11-03T14:02:00.000Z",
      last_used_at: null,
      revoked_at: null,
    };
    expect(CreateAgentResponseSchema.parse({ agent, api_key: `wak_${"A".repeat(43)}` }).api_key).toMatch(/^wak_/);
    expect(CreateAgentResponseSchema.safeParse({ agent, api_key: "sk-live-123" }).success).toBe(false);
  });

  it("describes PayPal and gateway capabilities", () => {
    expect(PayPalConfigResponseSchema.parse({ configured: false, env: "sandbox", client_id: null, sdk_url: "https://www.sandbox.paypal.com/web-sdk/v6/core" }).configured).toBe(false);
    expect(PayPalConfigResponseSchema.safeParse({ configured: true, env: "live", client_id: "x", sdk_url: "https://www.sandbox.paypal.com/web-sdk/v6/core" }).success).toBe(false);
    const meta = {
      service: "writ-gateway",
      env: "sandbox",
      app_env: "development",
      judge_mode: false,
      database: "pglite",
      paypal: { configured: false, webhook_configured: false },
      ai: { compiler: false, sentinel: false, verifier: false, reader: false, analyst: false, agent: false },
      channel3: false,
      webauthn: { rp_id: "localhost", rp_name: "Writ", origin: "http://localhost:3000" },
    };
    expect(MetaResponseSchema.parse(meta)).toEqual(meta);
  });

  it("applies console query defaults and refuses SQL-shaped field names", () => {
    expect(ConsoleQueryRequestSchema.parse({ dataset: "attacks" })).toEqual({ dataset: "attacks", filters: [], limit: 200 });
    expect(ConsoleQueryRequestSchema.safeParse({ dataset: "attacks", filters: [{ field: "1=1; drop", op: "eq", value: 1 }] }).success).toBe(false);
    expect(ConsoleQueryRequestSchema.safeParse({ dataset: "users" }).success).toBe(false);
  });
});

describe("SSE stream", () => {
  it("covers every event type with one schema", () => {
    expect(STREAM_EVENT_TYPES).toEqual([
      "purchase.updated",
      "decision.recorded",
      "attack.detected",
      "approval.updated",
      "writ.updated",
      "budget.updated",
      "ledger.appended",
      "run.updated",
      "run.event",
      "dispute.updated",
      "paypal.updated",
      "kill_switch.engaged",
    ]);
  });

  it("parses a message and rejects unknown types", () => {
    const message = {
      id: "k3x9q2-17",
      at: "2026-11-03T14:02:00.000Z",
      event: {
        type: "budget.updated",
        data: {
          writ_id: newId("wr"),
          limit_minor: "6000",
          max_per_order_minor: "6000",
          reserved_minor: "4400",
          spent_minor: "0",
          remaining_minor: "1600",
          orders_count: 0,
          held_orders: 1,
          max_orders: 1,
        },
      },
    };
    expect(StreamMessageSchema.parse(message).event.type).toBe("budget.updated");
    expect(StreamMessageSchema.safeParse({ ...message, event: { type: "debug.dump", data: {} } }).success).toBe(false);
    expect(StreamMessageSchema.safeParse({ ...message, id: "no dash" }).success).toBe(false);
  });

  it("types run timeline rows", () => {
    expect(RunEventSchema.parse({ type: "page.read", url: "https://writ.test/fixtures/deals-outlet/coupons", title: null, visible_chars: 900, hidden_chars: 210 }).type).toBe("page.read");
    expect(RunEventSchema.safeParse({ type: "tool.called", tool: "pay_vendor", input: {} }).success).toBe(false);
  });
});
