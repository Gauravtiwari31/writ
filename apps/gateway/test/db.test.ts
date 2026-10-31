import { CurrencySchema, sha256, utf8 } from "@writ/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppDb,
  agents,
  carts,
  closeDb,
  createPgDb,
  createPgliteDb,
  CURRENCIES,
  type Db,
  disputes,
  executeRows,
  ID_PREFIXES,
  isCheckViolation,
  isId,
  isUniqueViolation,
  ledgerEvents,
  newId,
  passkeys,
  PURCHASE_STATES,
  purchases,
  runMigrations,
  users,
  webhookEvents,
  writBudgets,
  writs,
} from "../src/db/index";

// Every table in plan §6.5.
const PLAN_TABLES = [
  "address_book",
  "agents",
  "approvals",
  "attacks",
  "carts",
  "decisions",
  "device_keys",
  "disputes",
  "ledger_events",
  "outbox",
  "passkeys",
  "paypal_vault_tokens",
  "purchases",
  "users",
  "webhook_events",
  "writ_budgets",
  "writs",
];

const TENANT = "tn_dbtest";
const PG_URL = process.env.TEST_DATABASE_URL ?? "";

interface Fixture {
  userId: string;
  agentId: string;
  writId: string;
  cartId: string;
}

async function seed(db: Db): Promise<Fixture> {
  const userId = newId("user");
  const agentId = newId("agent");
  const writId = newId("writ");
  const cartId = newId("cart");
  await db.insert(users).values({ id: userId, tenantId: TENANT, displayName: "Ana" });
  await db.insert(agents).values({
    id: agentId,
    tenantId: TENANT,
    userId,
    name: "Atlas",
    kind: "builtin",
    apiKeyHash: sha256(agentId),
  });
  await db.insert(writs).values({
    id: writId,
    tenantId: TENANT,
    userId,
    agentId,
    body: { purpose: "pottery gift" },
    bodyHash: sha256(writId),
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });
  await db.insert(carts).values({
    id: cartId,
    tenantId: TENANT,
    writId,
    agentId,
    body: { items: [] },
    bodyHash: sha256(cartId),
  });
  return { userId, agentId, writId, cartId };
}

function purchaseRow(f: Fixture, overrides: Partial<typeof purchases.$inferInsert> = {}): typeof purchases.$inferInsert {
  return {
    id: newId("purchase"),
    tenantId: TENANT,
    writId: f.writId,
    cartId: f.cartId,
    agentId: f.agentId,
    state: "PROPOSED",
    amountMinor: 4400n,
    currency: "USD",
    idempotencyKey: newId("purchase"),
    ...overrides,
  };
}

const drivers = [
  { name: "PGlite", skip: false, open: () => createPgliteDb() },
  { name: "Postgres (TEST_DATABASE_URL)", skip: PG_URL === "", open: async () => createPgDb(PG_URL) },
];

for (const driver of drivers) {
  describe.skipIf(driver.skip)(`schema and migrations on ${driver.name}`, () => {
    let app: AppDb;
    let db: Db;

    beforeAll(async () => {
      app = await driver.open();
      await runMigrations(app);
      db = app;
    });

    afterAll(async () => {
      if (app) await closeDb(app);
    });

    it("creates every plan §6.5 table", async () => {
      const rows = await executeRows<{ table_name: string }>(
        db,
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      );
      const tables = rows.map((r) => r.table_name);
      expect(tables).toEqual(expect.arrayContaining(PLAN_TABLES));
      if (driver.name === "PGlite") expect([...tables].sort()).toEqual([...PLAN_TABLES].sort());
    });

    it("is idempotent: re-running migrations is a no-op", async () => {
      await expect(runMigrations(app)).resolves.toBeUndefined();
    });

    it("gives every table tenant_id text not null and created_at timestamptz not null default now()", async () => {
      const rows = await executeRows<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        db,
        sql`select table_name, column_name, data_type, is_nullable, column_default
            from information_schema.columns
            where table_schema = 'public' and column_name in ('tenant_id', 'created_at')`,
      );
      for (const table of PLAN_TABLES) {
        const tenant = rows.find((r) => r.table_name === table && r.column_name === "tenant_id");
        const created = rows.find((r) => r.table_name === table && r.column_name === "created_at");
        expect(tenant, `${table}.tenant_id`).toMatchObject({ data_type: "text", is_nullable: "NO" });
        expect(created, `${table}.created_at`).toMatchObject({
          data_type: "timestamp with time zone",
          is_nullable: "NO",
          column_default: "now()",
        });
      }
    });

    it("round-trips bytea as Uint8Array and money as exact bigint beyond 2^53", async () => {
      const f = await seed(db);
      const [writ] = await db.select().from(writs).where(eq(writs.id, f.writId));
      expect(writ?.bodyHash).toBeInstanceOf(Uint8Array);
      expect(writ?.bodyHash).toEqual(sha256(f.writId));
      expect(writ?.body).toEqual({ purpose: "pottery gift" });

      const huge = 2n ** 62n + 1n; // not representable as a JS number
      await db.insert(writBudgets).values({
        writId: f.writId,
        tenantId: TENANT,
        limitMinor: huge,
        maxPerOrderMinor: huge,
        maxOrders: 1,
      });
      const [budget] = await db.select().from(writBudgets).where(eq(writBudgets.writId, f.writId));
      expect(budget).toMatchObject({ limitMinor: huge, reservedMinor: 0n, spentMinor: 0n, ordersCount: 0, version: 0 });
    });

    it("rejects a replayed Idempotency-Key from the same agent (threat T7)", async () => {
      const f = await seed(db);
      await db.insert(purchases).values(purchaseRow(f, { idempotencyKey: "idem-1" }));
      const replay = db.insert(purchases).values(purchaseRow(f, { idempotencyKey: "idem-1" }));
      await expect(replay).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "purchases_agent_idempotency_unique"));

      // The same key from a different agent is a different request.
      const other = await seed(db);
      await expect(
        db.insert(purchases).values(purchaseRow({ ...f, agentId: other.agentId }, { idempotencyKey: "idem-1" })),
      ).resolves.toBeDefined();
    });

    it("accepts every §6.3 purchase state and rejects anything else", async () => {
      const f = await seed(db);
      await db.insert(purchases).values(PURCHASE_STATES.map((state) => purchaseRow(f, { state })));
      const bogus = db.execute(
        sql`insert into purchases (id, tenant_id, writ_id, cart_id, agent_id, state, amount_minor, currency, idempotency_key)
            values (${newId("purchase")}, ${TENANT}, ${f.writId}, ${f.cartId}, ${f.agentId}, 'SHIPPED', 100, 'USD', ${newId("purchase")})`,
      );
      await expect(bogus).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "purchases_state_check"));
    });

    it("rejects non-positive amounts, unknown currencies and malformed commitments", async () => {
      const f = await seed(db);
      await expect(db.insert(purchases).values(purchaseRow(f, { amountMinor: 0n }))).rejects.toSatisfy((e: unknown) =>
        isCheckViolation(e, "purchases_amount_check"),
      );
      const eur = db.execute(
        sql`insert into purchases (id, tenant_id, writ_id, cart_id, agent_id, state, amount_minor, currency, idempotency_key)
            values (${newId("purchase")}, ${TENANT}, ${f.writId}, ${f.cartId}, ${f.agentId}, 'PROPOSED', 100, 'EUR', ${newId("purchase")})`,
      );
      await expect(eur).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "purchases_currency_check"));
      await expect(db.insert(purchases).values(purchaseRow(f, { cPre: new Uint8Array(20) }))).rejects.toSatisfy(
        (e: unknown) => isCheckViolation(e, "purchases_c_pre_check"),
      );
      await expect(db.insert(purchases).values(purchaseRow(f, { cPre: sha256("c_pre") }))).resolves.toBeDefined();
    });

    it("makes a ledger chain fork impossible: one successor per (writ_id, prev_hash), unique hash", async () => {
      const f = await seed(db);
      const genesis = new Uint8Array(32);
      const first = sha256(utf8(`${f.writId}:1`));
      await db.insert(ledgerEvents).values({
        tenantId: TENANT,
        writId: f.writId,
        type: "WRIT_SIGNED",
        payload: { n: 1 },
        prevHash: genesis,
        hash: first,
      });
      const fork = db.insert(ledgerEvents).values({
        tenantId: TENANT,
        writId: f.writId,
        type: "WRIT_REVOKED",
        payload: { n: 2 },
        prevHash: genesis,
        hash: sha256(utf8(`${f.writId}:fork`)),
      });
      await expect(fork).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "ledger_events_writ_prev_hash_unique"));

      const duplicateHash = db.insert(ledgerEvents).values({
        tenantId: TENANT,
        writId: f.writId,
        type: "CART_PROPOSED",
        payload: { n: 2 },
        prevHash: first,
        hash: first,
      });
      await expect(duplicateHash).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "ledger_events_hash_unique"));

      const [second] = await db
        .insert(ledgerEvents)
        .values({
          tenantId: TENANT,
          writId: f.writId,
          type: "CART_PROPOSED",
          payload: { n: 2 },
          prevHash: first,
          hash: sha256(utf8(`${f.writId}:2`)),
        })
        .returning();
      expect(typeof second?.seq).toBe("bigint");
    });

    it("enforces unique passkey credential ids, PayPal dispute ids and webhook event ids", async () => {
      const f = await seed(db);
      const credentialId = newId("passkey");
      const passkey = { tenantId: TENANT, userId: f.userId, credentialId, publicKeyCose: utf8("cose") };
      await db.insert(passkeys).values({ id: newId("passkey"), ...passkey });
      await expect(db.insert(passkeys).values({ id: newId("passkey"), ...passkey })).rejects.toSatisfy((e: unknown) =>
        isUniqueViolation(e, "passkeys_credential_id_unique"),
      );
      const [stored] = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId));
      expect(stored).toMatchObject({ counter: 0, transports: [] });

      const paypalDisputeId = `PP-D-${newId("dispute")}`;
      await db.insert(disputes).values({ id: newId("dispute"), tenantId: TENANT, paypalDisputeId, status: "OPEN" });
      await expect(
        db.insert(disputes).values({ id: newId("dispute"), tenantId: TENANT, paypalDisputeId, status: "OPEN" }),
      ).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "disputes_paypal_dispute_id_unique"));

      // Webhook dedupe (plan §6.8): the redelivery inserts nothing.
      const event = { paypalEventId: `WH-${newId("outbox")}`, tenantId: TENANT, type: "PAYMENT.CAPTURE.COMPLETED", payload: {} };
      const firstInsert = await db.insert(webhookEvents).values(event).onConflictDoNothing().returning();
      const redelivery = await db.insert(webhookEvents).values(event).onConflictDoNothing().returning();
      expect(firstInsert).toHaveLength(1);
      expect(redelivery).toHaveLength(0);
    });

    it("rejects an agent kind outside ('builtin','mcp','sdk')", async () => {
      const f = await seed(db);
      const bad = db.execute(
        sql`insert into agents (id, tenant_id, user_id, name, kind, api_key_hash)
            values (${newId("agent")}, ${TENANT}, ${f.userId}, 'x', 'browser', ${sha256("k")})`,
      );
      await expect(bad).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "agents_kind_check"));
    });
  });
}

describe("schema constants", () => {
  it("keeps the currency CHECK list in sync with @writ/core", () => {
    expect([...CURRENCIES]).toEqual(CurrencySchema.options);
  });

  it("generates prefixed, unique, writ_short-compatible ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("writ")));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(/^wr_[a-z2-7]{26}$/);
      expect(isId("writ", id)).toBe(true);
      expect(isId("purchase", id)).toBe(false);
    }
    expect(new Set(Object.values(ID_PREFIXES)).size).toBe(Object.keys(ID_PREFIXES).length);
    expect(isId("writ", "wr_../../etc")).toBe(false);
  });
});
