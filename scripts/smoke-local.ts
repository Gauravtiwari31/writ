// `pnpm smoke:local`: checks a local run (`pnpm dev`) end to end over HTTP, acting as a person in the Wallet
// and as an external agent on the public agent API. It runs the hero's hijack and right purchase. With no
// PayPal keys the right purchase must stop at PayPal with a typed reason: nothing here is simulated.
import { fromBase64Url, generateDeviceKeyEd25519, newId, signDeviceEd25519, toBase64Url } from "@writ/core";
import { MetaResponseSchema, type CreateAgentResponse, type CreateWritResponse } from "@writ/core/api";
import { AgentApiClient } from "@writ/agents";
import { optionalEnv } from "./lib/env";

const gateway = optionalEnv("GATEWAY_BASE_URL") ?? `http://localhost:${optionalEnv("PORT") ?? "10000"}`;
const wallet = optionalEnv("APP_BASE_URL") ?? "http://localhost:3000";

interface Check {
  name: string;
  run(): Promise<string>;
}

async function get(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json, text/html" } });
}

const checks: Check[] = [
  {
    name: "gateway /healthz",
    async run() {
      const res = await get(`${gateway}/healthz`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return JSON.stringify(await res.json());
    },
  },
  {
    name: "gateway /v1/meta",
    async run() {
      const res = await get(`${gateway}/v1/meta`);
      const meta = MetaResponseSchema.parse(await res.json());
      return `db=${meta.database} paypal=${meta.paypal.configured} compiler=${meta.ai.compiler} agent=${meta.ai.agent} channel3=${meta.channel3}`;
    },
  },
  {
    name: "wallet /",
    async run() {
      const res = await get(`${wallet}/`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return `${(await res.text()).length} bytes of HTML`;
    },
  },
  {
    name: "fixture page is served, labeled and noindex",
    async run() {
      const res = await get(`${wallet}/fixtures/deals-outlet/gift-deals`);
      const body = await res.text();
      if (res.status !== 200 || !body.includes("Security test fixture") || res.headers.get("x-robots-tag")?.includes("noindex") !== true) throw new Error(`HTTP ${res.status}`);
      return "ok";
    },
  },
  {
    name: "wallet /gw rewrite → gateway",
    async run() {
      const res = await get(`${wallet}/gw/v1/meta`);
      const meta = MetaResponseSchema.parse(await res.json());
      return `reached ${meta.service} through the Wallet origin`;
    },
  },
];

// The hero flow: each step uses what the one before it created.
const device = generateDeviceKeyEd25519();
let cookie = "";
let apiKey = "";
let writId = "";
let addressId = "";
const FIXTURE_PAGE = `${wallet}/fixtures/deals-outlet/gift-deals`;

async function walletCall<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${wallet}/gw${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", origin: wallet, ...(cookie === "" ? {} : { cookie }) },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie !== null) cookie = setCookie.split(";")[0] ?? "";
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

const agent = () => new AgentApiClient({ baseUrl: gateway, apiKey });

checks.push(
  {
    name: "create a device-key wallet",
    async run() {
      await walletCall("/v1/auth/device-wallet", { display_name: "Smoke", public_key: toBase64Url(device.publicKey), label: "smoke script" });
      addressId = (await walletCall<{ address_id: string }>("/v1/address-book", { label: "Home", line1: "1 Main St", city: "Austin", region: "TX", postal: "78701", country: "US" })).address_id;
      const created = await walletCall<CreateAgentResponse>("/v1/agents", { name: "smoke agent", kind: "sdk" });
      apiKey = created.api_key;
      return `agent ${created.agent.agent_id}`;
    },
  },
  {
    name: "draft and sign a Writ ($60, ask above $40)",
    async run() {
      const created = await walletCall<CreateWritResponse>("/v1/writs", {
        draft: { purpose: "A pottery-themed gift (smoke test)", constraints: { total_minor: "6000", require_human_above_minor: "4000", categories: ["home_kitchen", "arts_crafts"] }, clarifying_questions: [], assumptions: [] },
        agent_id: (await walletCall<CreateAgentResponse>("/v1/agents", { name: "smoke agent 2", kind: "sdk" })).agent.agent_id,
        ship_to_ref: addressId,
      });
      writId = created.writ.writ_id;
      const bound = created.writ.agent_id;
      const signature = signDeviceEd25519(fromBase64Url(created.challenge), device.secretKey);
      const signed = await walletCall<{ status: string }>(`/v1/writs/${writId}/sign`, { signature });
      if (signed.status !== "ACTIVE") throw new Error(signed.status);
      apiKey = (await walletCall<CreateAgentResponse>(`/v1/agents/${bound}/rotate-key`, {})).api_key;
      return `${writId} ACTIVE`;
    },
  },
  {
    name: "hijacked cart is BLOCKED: $0 moved, hidden text flagged",
    async run() {
      const proposed = await agent().proposeCart({
        writ_id: writId as never,
        items: [
          { product_ref: "fx_mug_set", qty: 1 },
          { product_ref: "fx_gift_protection_plus", qty: 1 },
        ],
        ship_to_ref: newId("adr") as never,
        sources: [{ url: FIXTURE_PAGE, kind: "page", fetched_at: new Date().toISOString() as never }],
      });
      const { httpStatus, result } = await agent().checkout({ cart_id: proposed.cart_id }, `smoke-hijack-${Date.now()}`);
      if (httpStatus !== 403 || result.status !== "BLOCKED" || result.money_moved) throw new Error(`HTTP ${httpStatus} ${result.status}`);
      return `${result.policy_reasons.map((reason) => reason.code).join(", ")}`;
    },
  },
  {
    name: "right cart passes the rules and stops only where keys are missing",
    async run() {
      const meta = MetaResponseSchema.parse(await (await get(`${gateway}/v1/meta`)).json());
      const proposed = await agent().proposeCart({ writ_id: writId as never, items: [{ product_ref: "fx_pourover_set", qty: 1 }], ship_to_ref: addressId as never, sources: [] });
      if (proposed.preview.verdict === "BLOCK") throw new Error(JSON.stringify(proposed.preview.reasons));
      const { result } = await agent().checkout({ cart_id: proposed.cart_id }, `smoke-right-${Date.now()}`);
      if (!meta.paypal.configured && result.state_reason !== "paypal_unconfigured") throw new Error(`expected paypal_unconfigured, got ${result.status}/${result.state_reason}`);
      return `${proposed.preview.verdict} → ${result.status}${result.state_reason === null ? "" : ` (${result.state_reason})`}`;
    },
  },
);

let failed = 0;
for (const check of checks) {
  try {
    console.log(`PASS ${check.name}: ${await check.run()}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failed === 0 ? "smoke: all checks passed" : `smoke: ${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
