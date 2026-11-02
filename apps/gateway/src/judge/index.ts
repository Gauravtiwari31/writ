// Judge mode (P0-13, plan §18): limits backed by rate_counters (they survive restarts), and an isolated
// tenant per visitor with a seeded Ana, her address, a Writ signed by a clearly labeled demo device key and,
// when DEMO_PAYPAL_VAULT_ID is set, the labeled pre-vaulted sandbox token. The demo key's secret is minted
// per visitor and discarded: it signs that one Writ and can approve nothing else.
import { draftToWritBody, generateDeviceKeyEd25519, signDeviceEd25519, writHash, type JsonValue, type WritDraft } from "@writ/core";
import { and, eq, sql } from "drizzle-orm";
import type { RateLimits } from "../contracts/index";
import type { Db } from "../db/client";
import { SYSTEM_TENANT } from "../db/enums";
import { addressBook, deviceKeys, paypalVaultTokens, rateCounters, writs } from "../db/schema";
import type { CoreServices } from "../deps";
import { createWalletRows } from "../identity/index";
import { activateSigned } from "../writs/index";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function windowStart(now: Date, sizeMs: number): Date {
  return new Date(Math.floor(now.getTime() / sizeMs) * sizeMs);
}

async function bump(db: Db, tenantId: string, bucket: string, window: Date, limit: number): Promise<number | null> {
  const [row] = await db
    .insert(rateCounters)
    .values({ tenantId, bucket, windowStart: window, count: 1 })
    .onConflictDoUpdate({
      target: [rateCounters.tenantId, rateCounters.bucket, rateCounters.windowStart],
      set: { count: sql`${rateCounters.count} + 1` },
      where: sql`${rateCounters.count} < ${limit}`,
    })
    .returning({ count: rateCounters.count });
  return row?.count ?? null;
}

async function current(db: Db, tenantId: string, bucket: string, window: Date): Promise<number> {
  const [row] = await db
    .select({ count: rateCounters.count })
    .from(rateCounters)
    .where(and(eq(rateCounters.tenantId, tenantId), eq(rateCounters.bucket, bucket), eq(rateCounters.windowStart, window)));
  return row?.count ?? 0;
}

export function createRateLimits(deps: Pick<CoreServices, "config" | "db" | "clock" | "log">): RateLimits {
  const perHour = deps.config.judge.heroRunsPerHour;
  const perDay = deps.config.judge.llmCallsPerDay;
  return {
    async tryConsumeHeroRun(tenantId) {
      if (deps.db === null) return { allowed: false, remaining: 0 };
      const count = await bump(deps.db, tenantId, "hero_run", windowStart(deps.clock(), HOUR_MS), perHour);
      return count === null ? { allowed: false, remaining: 0 } : { allowed: true, remaining: Math.max(0, perHour - count) };
    },
    async heroRunsRemaining(tenantId) {
      if (deps.db === null) return 0;
      return Math.max(0, perHour - (await current(deps.db, tenantId, "hero_run", windowStart(deps.clock(), HOUR_MS))));
    },
    async tryConsumeLlmCall() {
      if (deps.db === null) return false;
      return (await bump(deps.db, SYSTEM_TENANT, "llm_call", windowStart(deps.clock(), DAY_MS), perDay)) !== null;
    },
    async llmCallsRemaining() {
      if (deps.db === null) return 0;
      return Math.max(0, perDay - (await current(deps.db, SYSTEM_TENANT, "llm_call", windowStart(deps.clock(), DAY_MS))));
    },
  };
}

const HERO_DRAFT: WritDraft = {
  purpose: "A pottery-themed gift for my sister",
  constraints: {
    total_minor: "6000",
    require_human_above_minor: "4000",
    categories: ["home_kitchen", "arts_crafts"],
    deny_kinds: ["gift_card", "protection_plan", "subscription", "digital_goods", "money_transfer", "crypto"],
    ship_to_locked: true,
  },
  clarifying_questions: [],
  assumptions: [],
};

export interface SeededJudge {
  tenantId: string;
  userId: string;
  writId: string;
  atlasId: string;
  addressId: string;
}

/** One visitor's isolated wallet, all in one transaction. */
export async function seedJudgeTenant(deps: CoreServices): Promise<SeededJudge> {
  const tenantId = deps.ids("tenant");
  const userId = deps.ids("user");
  return deps.uow.run(tenantId, async (ctx) => {
    const wallet = await createWalletRows(deps, ctx, { userId, displayName: "Ana (demo)", demo: true });
    const addressId = deps.ids("address");
    await ctx.db.insert(addressBook).values({ id: addressId, tenantId, userId, label: "Home (Austin)", line1: "100 Demo St", city: "Austin", region: "TX", postal: "78701", country: "US", createdAt: ctx.now });
    const key = generateDeviceKeyEd25519();
    await ctx.db.insert(deviceKeys).values({ id: deps.ids("deviceKey"), tenantId, userId, publicKeyEd25519: key.publicKey, label: "Demo device key", demo: true, createdAt: ctx.now });
    const demoVaultId = deps.config.judge.demoVaultId;
    if (demoVaultId !== null) {
      await ctx.db.insert(paypalVaultTokens).values({ id: deps.ids("vaultToken"), tenantId, userId, vaultId: demoVaultId, status: "ACTIVE", payerHint: "demo sandbox buyer", demo: true, createdAt: ctx.now, updatedAt: ctx.now });
    }
    const writId = deps.ids("writ");
    const body = draftToWritBody(HERO_DRAFT, { writ_id: writId, user_id: userId, agent_id: wallet.atlasId, ship_to: { ref: addressId, label: "Home (Austin)" }, now: ctx.now });
    const hash = writHash(body);
    await ctx.db.insert(writs).values({ id: writId, tenantId, userId, agentId: wallet.atlasId, body: body as unknown as JsonValue, bodyHash: hash, status: "DRAFT", expiresAt: new Date(body.expires_at), createdAt: ctx.now });
    await activateSigned(ctx, { writId, signature: signDeviceEd25519(hash, key.secretKey) });
    return { tenantId, userId, writId, atlasId: wallet.atlasId, addressId };
  });
}
