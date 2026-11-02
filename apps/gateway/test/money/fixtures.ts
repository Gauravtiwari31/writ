// Money-path test fixtures: a fake PayPal over the fetch seam (unit tests only, §22 rule 41) that behaves
// like the real one where it matters: a repeated PayPal-Request-Id replays the stored answer and never
// repeats the action, and every action is counted, so a test can prove nothing was charged twice.
import {
  CART_SPEC,
  generateDeviceKeyEd25519,
  hashJcs,
  sha256,
  toHex,
  VERIFICATION_SPEC,
  verificationRecordHash,
  type Cart,
  type Verdict,
  type VerificationRecord,
} from "@writ/core";
import { makePayPalConfig, PayPalHttp, PayPalMultipartClient, PayPalTokenProvider, type FetchLike } from "@writ/paypal";
import type { Services } from "../../src/deps";
import type { AppDb } from "../../src/db/client";
import { newRowId } from "../../src/db/ids";
import { agents, carts, decisions, deviceKeys, paypalVaultTokens, users, writBudgets, writs } from "../../src/db/schema";
import { appendEvent } from "@writ/ledger";
import { fromHex } from "@writ/core";
import { ledgerEvents } from "../../src/db/schema";

export interface FakePayPal {
  readonly fetch: FetchLike;
  /** Non-OAuth requests that reached the fake, including replays. */
  readonly calls: { method: string; path: string; requestId: string | null; body: unknown }[];
  readonly effects: { orders: number; captures: number; voids: number; refunds: number };
  /** Make the next matching request do its work but lose the answer, like a network failure after PayPal acted. */
  loseAnswerOnce(pathPart: string): void;
  /** Answer the next matching request with this error. */
  failOnce(pathPart: string, status: number, name: string, issue?: string): void;
  authorizationStatus: string;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "paypal-debug-id": "dbg-fake" } });
}

export function createFakePayPal(): FakePayPal {
  const replies = new Map<string, { status: number; body: unknown }>();
  const lost: string[] = [];
  const failures: { part: string; status: number; name: string; issue: string | undefined }[] = [];
  const state: FakePayPal = {
    calls: [],
    effects: { orders: 0, captures: 0, voids: 0, refunds: 0 },
    authorizationStatus: "CREATED",
    loseAnswerOnce: (part) => void lost.push(part),
    failOnce: (part, status, name, issue) => void failures.push({ part, status, name, issue }),
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v1/oauth2/token") return json(200, { access_token: "fake-token", token_type: "Bearer", expires_in: 32400, scope: "x", app_id: "a", nonce: "n" });
      const headers = new Headers(init.headers);
      const requestId = headers.get("paypal-request-id");
      const body = typeof init.body === "string" && init.body !== "" ? (JSON.parse(init.body) as unknown) : undefined;
      const method = init.method ?? "GET";
      state.calls.push({ method, path, requestId, body });

      const failure = failures.findIndex((f) => path.includes(f.part));
      if (failure >= 0) {
        const [f] = failures.splice(failure, 1);
        if (f !== undefined) {
          return json(f.status, { name: f.name, message: f.name, debug_id: "dbg-fake", details: f.issue === undefined ? [] : [{ issue: f.issue }] });
        }
      }
      const replay = requestId === null ? undefined : replies.get(requestId);
      let reply = replay;
      if (reply === undefined) {
        reply = act(state, method, path, body);
        if (requestId !== null) replies.set(requestId, reply);
      }
      const losing = lost.findIndex((part) => path.includes(part));
      if (losing >= 0) {
        lost.splice(losing, 1);
        throw new TypeError("fetch failed: socket hang up after PayPal acted");
      }
      return json(reply.status, reply.body);
    },
  };
  return state;
}

// PayPal ids are globally unique; the test database enforces that across tests sharing it.
let globalIds = 0;

function act(state: FakePayPal, method: string, path: string, body: unknown): { status: number; body: unknown } {
  if (method === "POST" && path === "/v2/checkout/orders") {
    state.effects.orders += 1;
    const unit = (body as { purchase_units: { amount: { value: string; currency_code: string }; custom_id: string }[] }).purchase_units[0];
    globalIds += 1;
    const n = globalIds;
    return {
      status: 201,
      body: {
        id: `ORDER${n}`,
        status: "COMPLETED",
        purchase_units: [
          {
            custom_id: unit?.custom_id,
            amount: unit?.amount,
            payments: { authorizations: [{ id: `AUTH${n}`, status: state.authorizationStatus, amount: unit?.amount, custom_id: unit?.custom_id }] },
          },
        ],
      },
    };
  }
  const capture = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/);
  if (method === "POST" && capture !== null) {
    state.effects.captures += 1;
    const request = body as { amount: { value: string; currency_code: string }; invoice_id: string };
    return { status: 201, body: { id: `CAP${++globalIds}`, status: "COMPLETED", amount: request.amount, invoice_id: request.invoice_id } };
  }
  const voiding = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/);
  if (method === "POST" && voiding !== null) {
    state.effects.voids += 1;
    return { status: 204, body: undefined };
  }
  const refund = path.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/);
  if (method === "POST" && refund !== null) {
    state.effects.refunds += 1;
    return { status: 201, body: { id: `REF${++globalIds}`, status: "COMPLETED" } };
  }
  return { status: 404, body: { name: "RESOURCE_NOT_FOUND", message: `no fake for ${method} ${path}` } };
}

export function fakePayPalClients(fake: FakePayPal): NonNullable<Services["paypal"]> {
  const config = makePayPalConfig("fake-client", "fake-secret");
  const tokens = new PayPalTokenProvider({ config, fetch: fake.fetch });
  return {
    http: new PayPalHttp({ config, fetch: fake.fetch, tokens }),
    multipart: new PayPalMultipartClient({ config, fetch: fake.fetch, tokens }),
    clientId: "fake-client",
    webhookId: "WH-FAKE",
    buyerEmail: null,
  };
}

export interface Seeded {
  tenantId: string;
  userId: string;
  writId: string;
  agentId: string;
  deviceSecret: Uint8Array;
}

let sequence = 0;

export async function seedWrit(db: AppDb, options: { limitMinor?: bigint; maxOrders?: number; vault?: boolean; deviceKey?: boolean } = {}): Promise<Seeded> {
  sequence += 1;
  const tenantId = `tnt_money_${sequence}`;
  const userId = newRowId("user");
  const writId = newRowId("writ");
  const agentId = newRowId("agent");
  const limitMinor = options.limitMinor ?? 6000n;
  await db.insert(users).values({ id: userId, tenantId, displayName: "Ana" });
  await db.insert(agents).values({ id: agentId, tenantId, userId, name: "Atlas", kind: "sdk", apiKeyHash: sha256(agentId) });
  const body = { spec: "test", writ_id: writId };
  await db.insert(writs).values({
    id: writId,
    tenantId,
    userId,
    agentId,
    body,
    bodyHash: hashJcs(body),
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    signedAt: new Date(),
  });
  await db.insert(writBudgets).values({ writId, tenantId, limitMinor, maxPerOrderMinor: limitMinor, maxOrders: options.maxOrders ?? 5 });
  const genesis = appendEvent(null, { type: "WRIT_SIGNED", payload: { writ_id: writId, writ_hash: toHex(hashJcs(body)) }, ts: new Date(), purchase_id: null, writ_id: writId });
  await db.insert(ledgerEvents).values({
    tenantId,
    writId,
    purchaseId: null,
    type: genesis.type,
    payload: genesis.payload,
    prevHash: fromHex(genesis.prev_hash),
    hash: fromHex(genesis.hash),
    ts: genesis.ts,
  });
  if (options.vault !== false) {
    await db.insert(paypalVaultTokens).values({ id: newRowId("vaultToken"), tenantId, userId, vaultId: `VAULT-${writId}`, status: "ACTIVE" });
  }
  const device = generateDeviceKeyEd25519();
  if (options.deviceKey !== false) {
    await db.insert(deviceKeys).values({ id: newRowId("deviceKey"), tenantId, userId, publicKeyEd25519: device.publicKey, label: "test" });
  }
  return { tenantId, userId, writId, agentId, deviceSecret: device.secretKey };
}

export async function seedCart(db: AppDb, seeded: Seeded, amountMinor = 4400n): Promise<{ cartId: string; cart: Cart; hash: Uint8Array }> {
  const cartId = newRowId("cart");
  const cart: Cart = {
    spec: CART_SPEC,
    cart_id: cartId as Cart["cart_id"],
    writ_id: seeded.writId as Cart["writ_id"],
    agent_id: seeded.agentId as Cart["agent_id"],
    currency: "USD",
    items: [
      {
        product_ref: "ch3_pourover",
        title: "Hand-thrown ceramic pour-over set",
        merchant_id: "writ-market",
        category: "home_kitchen.coffee_tea",
        kind: "goods",
        unit_minor: amountMinor.toString(),
        qty: 1,
      },
    ],
    shipping_minor: "0",
    tax_minor: "0",
    total_minor: amountMinor.toString(),
    ship_to_ref: newRowId("address") as Cart["ship_to_ref"],
    eta: "2026-11-17",
  };
  const hash = hashJcs(cart);
  await db.insert(carts).values({ id: cartId, tenantId: seeded.tenantId, writId: seeded.writId, agentId: seeded.agentId, body: cart, bodyHash: hash });
  return { cartId, cart, hash };
}

/** The record the pipeline hands saga.execute, with its combiner decisions row stored the way the pipeline stores it. */
export async function storeVerification(
  db: AppDb,
  input: { tenantId: string; purchaseId: string; cartId: string; cartHash: Uint8Array; cPre: string; final: Verdict; contributionVerdict?: Verdict; code?: "POLICY_PASSED" | "REVIEW_THRESHOLD" | "VERIFIER_ITEM_MISFIT" },
): Promise<{ record: VerificationRecord; decisionId: string }> {
  const record: VerificationRecord = {
    spec: VERIFICATION_SPEC,
    purchase_id: input.purchaseId as VerificationRecord["purchase_id"],
    cart_hash: toHex(input.cartHash),
    c_pre: input.cPre,
    sentinel: [],
    verifier: { status: "missing", output: null, model: null },
    final: input.final,
    contributions: [
      {
        stage: "threshold",
        verdict: input.contributionVerdict ?? input.final,
        reason: { code: input.code ?? (input.final === "REVIEW" ? "REVIEW_THRESHOLD" : input.final === "BLOCK" ? "VERIFIER_ITEM_MISFIT" : "POLICY_PASSED"), message: "test" },
      },
    ],
    decided_at: new Date().toISOString(),
  };
  const decisionId = newRowId("decision");
  await db.insert(decisions).values({
    id: decisionId,
    tenantId: input.tenantId,
    cartId: input.cartId,
    purchaseId: input.purchaseId,
    stage: "combiner",
    verdict: input.final,
    output: record,
    outputHash: verificationRecordHash(record),
  });
  return { record, decisionId };
}

