import {
  APPROVAL_DECISIONS as CORE_APPROVAL_DECISIONS,
  APPROVAL_STATUSES as CORE_APPROVAL_STATUSES,
  CATALOG_SOURCES as CORE_CATALOG_SOURCES,
  CurrencySchema,
  DECISION_RECORD_STAGES as CORE_DECISION_RECORD_STAGES,
  fromHex,
  PURCHASE_STATE_REASONS as CORE_PURCHASE_STATE_REASONS,
  PURCHASE_STATES as CORE_PURCHASE_STATES,
  idSchema,
  idTimestamp,
  sha256,
  toHex,
  utf8,
  WRIT_STATUSES as CORE_WRIT_STATUSES,
  writShort,
} from "@writ/core";
import {
  AGENT_KINDS as CORE_AGENT_KINDS,
  BUILTIN_AGENT_KINDS as CORE_BUILTIN_AGENT_KINDS,
  RUN_MODES as CORE_RUN_MODES,
  RUN_STATUSES as CORE_RUN_STATUSES,
  VAULT_TOKEN_STATUSES as CORE_VAULT_TOKEN_STATUSES,
} from "@writ/core/api";
import { appendEvent, type LedgerEvent, verifyChain } from "@writ/ledger";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_KINDS,
  type AppDb,
  agents,
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  approvals,
  BUILTIN_AGENT_KINDS,
  CATALOG_SOURCES,
  carts,
  DECISION_RECORD_STAGES,
  decisions,
  paypalVaultTokens,
  RUN_MODES,
  RUN_STATUSES,
  VAULT_TOKEN_STATUSES,
  closeDb,
  createPgDb,
  createPgliteDb,
  CURRENCIES,
  type Db,
  disputes,
  executeRows,
  isCheckViolation,
  isRowId,
  isUniqueViolation,
  ledgerEvents,
  newRowId,
  ROW_ID_PREFIXES,
  passkeys,
  PURCHASE_STATE_REASONS,
  PURCHASE_STATES,
  purchases,
  runMigrations,
  users,
  webhookEvents,
  writBudgets,
  WRIT_STATUSES,
  writs,
} from "../src/db/index";

// Every table in plan §6.5 (the last six arrived with migration 0002 for the parallel build).
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
  "agent_run_events",
  "agent_runs",
  "auth_challenges",
  "catalog_items",
  "evidence_links",
  "rate_counters",
];

const TENANT = "tn_dbtest";
const TS = "2026-11-03T14:02:00.000Z";
const PG_URL = process.env.TEST_DATABASE_URL ?? "";

interface Fixture {
  userId: string;
  agentId: string;
  writId: string;
  cartId: string;
}

async function seed(db: Db): Promise<Fixture> {
  const userId = newRowId("user");
  const agentId = newRowId("agent");
  const writId = newRowId("writ");
  const cartId = newRowId("cart");
  await db.insert(users).values({ id: userId, tenantId: TENANT, displayName: "Ana" });
  await db.insert(agents).values({
    id: agentId,
    tenantId: TENANT,
    userId,
    name: "Atlas",
    kind: "builtin",
    builtinKind: "atlas",
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
    id: newRowId("purchase"),
    tenantId: TENANT,
    writId: f.writId,
    cartId: f.cartId,
    agentId: f.agentId,
    state: "PROPOSED",
    amountMinor: 4400n,
    currency: "USD",
    idempotencyKey: newRowId("purchase"),
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
            values (${newRowId("purchase")}, ${TENANT}, ${f.writId}, ${f.cartId}, ${f.agentId}, 'SHIPPED', 100, 'USD', ${newRowId("purchase")})`,
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
            values (${newRowId("purchase")}, ${TENANT}, ${f.writId}, ${f.cartId}, ${f.agentId}, 'PROPOSED', 100, 'EUR', ${newRowId("purchase")})`,
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
      const ts = TS;
      await db.insert(ledgerEvents).values({
        tenantId: TENANT,
        writId: f.writId,
        type: "WRIT_SIGNED",
        payload: { n: 1 },
        prevHash: genesis,
        hash: first,
        ts,
      });
      const fork = db.insert(ledgerEvents).values({
        tenantId: TENANT,
        writId: f.writId,
        type: "WRIT_REVOKED",
        payload: { n: 2 },
        prevHash: genesis,
        hash: sha256(utf8(`${f.writId}:fork`)),
        ts,
      });
      await expect(fork).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "ledger_events_writ_prev_hash_unique"));

      const duplicateHash = db.insert(ledgerEvents).values({
        tenantId: TENANT,
        writId: f.writId,
        type: "CART_PROPOSED",
        payload: { n: 2 },
        prevHash: first,
        hash: first,
        ts,
      });
      await expect(duplicateHash).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "ledger_events_hash_unique"));

      // The hashed timestamp must be exactly Date#toISOString form; anything else could not be re-verified.
      for (const badTs of ["2026-11-03T14:02:00Z", "2026-11-03 14:02:00.000+00", "2026-11-03T14:02:00.000000Z"]) {
        const malformed = db.insert(ledgerEvents).values({
          tenantId: TENANT,
          writId: f.writId,
          type: "CART_PROPOSED",
          payload: { n: 2 },
          prevHash: first,
          hash: sha256(utf8(`${f.writId}:${badTs}`)),
          ts: badTs,
        });
        await expect(malformed, badTs).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "ledger_events_ts_check"));
      }

      const [second] = await db
        .insert(ledgerEvents)
        .values({
          tenantId: TENANT,
          writId: f.writId,
          type: "CART_PROPOSED",
          payload: { n: 2 },
          prevHash: first,
          hash: sha256(utf8(`${f.writId}:2`)),
          ts,
        })
        .returning();
      expect(second?.seq).toEqual(expect.any(Number));
    });

    it("stores a @writ/ledger chain that re-verifies after the round trip", async () => {
      const f = await seed(db);
      const purchaseId = newRowId("purchase");
      await db.insert(purchases).values(purchaseRow(f, { id: purchaseId }));

      // What the saga does: build the next event from the persisted tail, insert it, keep the DB seq.
      let tail: LedgerEvent | null = null;
      const steps = [
        { type: "WRIT_SIGNED", payload: { writ_hash: toHex(sha256(f.writId)) }, writ_id: f.writId },
        { type: "CART_PROPOSED", payload: { cart_id: f.cartId, total_minor: "4400" } },
        { type: "BUDGET_RESERVED", payload: { amount_minor: "4400" }, purchase_id: purchaseId },
      ] as const;
      for (const [i, step] of steps.entries()) {
        const event: LedgerEvent = appendEvent(tail, { ...step, ts: new Date(Date.parse(TS) + i * 1001) });
        const [row] = await db
          .insert(ledgerEvents)
          .values({
            tenantId: TENANT,
            writId: event.writ_id,
            purchaseId: event.purchase_id,
            type: event.type,
            payload: event.payload,
            prevHash: fromHex(event.prev_hash),
            hash: fromHex(event.hash),
            ts: event.ts,
          })
          .returning();
        if (!row) throw new Error("insert returned no row");
        tail = { ...event, seq: row.seq };
      }

      const rows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.writId, f.writId)).orderBy(asc(ledgerEvents.seq));
      const chain = rows.map((r) => ({
        seq: r.seq,
        writ_id: r.writId,
        purchase_id: r.purchaseId,
        type: r.type,
        payload: r.payload,
        ts: r.ts,
        prev_hash: toHex(r.prevHash),
        hash: toHex(r.hash),
      }));
      expect(chain).toHaveLength(steps.length);
      expect(verifyChain(chain)).toEqual({ ok: true });

      // jsonb normalizes key order and whitespace, which JCS ignores; a changed value does not survive.
      const tampered = chain.map((e, i) => (i === 1 ? { ...e, payload: { ...asObject(e.payload), total_minor: "1" } } : e));
      expect(verifyChain(tampered)).toMatchObject({ ok: false, index: 1 });
    });

    it("rejects a Writ status outside the @writ/core lifecycle", async () => {
      const f = await seed(db);
      await db.update(writs).set({ status: "REVOKED" }).where(eq(writs.id, f.writId));
      const bad = db.execute(sql`update writs set status = 'PAUSED' where id = ${f.writId}`);
      await expect(bad).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "writs_status_check"));
    });

    it("enforces unique passkey credential ids, PayPal dispute ids and webhook event ids", async () => {
      const f = await seed(db);
      const credentialId = newRowId("passkey");
      const passkey = { tenantId: TENANT, userId: f.userId, credentialId, publicKeyCose: utf8("cose") };
      await db.insert(passkeys).values({ id: newRowId("passkey"), ...passkey });
      await expect(db.insert(passkeys).values({ id: newRowId("passkey"), ...passkey })).rejects.toSatisfy((e: unknown) =>
        isUniqueViolation(e, "passkeys_credential_id_unique"),
      );
      const [stored] = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId));
      expect(stored).toMatchObject({ counter: 0, transports: [] });

      const paypalDisputeId = `PP-D-${newRowId("dispute")}`;
      await db.insert(disputes).values({ id: newRowId("dispute"), tenantId: TENANT, paypalDisputeId, status: "OPEN" });
      await expect(
        db.insert(disputes).values({ id: newRowId("dispute"), tenantId: TENANT, paypalDisputeId, status: "OPEN" }),
      ).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "disputes_live_paypal_id_idx"));

      // Webhook dedupe (plan §6.8): the redelivery inserts nothing.
      const event = { paypalEventId: `WH-${newRowId("outbox")}`, tenantId: TENANT, type: "PAYMENT.CAPTURE.COMPLETED", payload: {} };
      const firstInsert = await db.insert(webhookEvents).values(event).onConflictDoNothing().returning();
      const redelivery = await db.insert(webhookEvents).values(event).onConflictDoNothing().returning();
      expect(firstInsert).toHaveLength(1);
      expect(redelivery).toHaveLength(0);
    });

    it("enforces the contract constraints added for the parallel build", async () => {
      const f = await seed(db);
      // A built-in agent names its reference agent; any other kind must not.
      const builtin = { tenantId: TENANT, userId: f.userId, name: "Atlas", kind: "builtin" as const, apiKeyHash: sha256(newRowId("agent")) };
      await expect(db.insert(agents).values({ id: newRowId("agent"), ...builtin })).rejects.toSatisfy((e: unknown) =>
        isCheckViolation(e, "agents_builtin_kind_presence_check"),
      );
      await expect(db.insert(agents).values({ id: newRowId("agent"), ...builtin, builtinKind: "atlas" })).resolves.toBeDefined();
      await expect(
        db.insert(agents).values({ id: newRowId("agent"), ...builtin, kind: "sdk", builtinKind: "scout", apiKeyHash: sha256(newRowId("agent")) }),
      ).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "agents_builtin_kind_presence_check"));

      // An ACTIVE vault token always has a vault id; a PENDING one may not yet.
      const vault = { tenantId: TENANT, userId: f.userId };
      await expect(db.insert(paypalVaultTokens).values({ id: newRowId("vaultToken"), ...vault, status: "ACTIVE" })).rejects.toSatisfy(
        (e: unknown) => isCheckViolation(e, "paypal_vault_tokens_active_vault_check"),
      );
      await expect(
        db.insert(paypalVaultTokens).values({ id: newRowId("vaultToken"), ...vault, status: "PENDING", setupTokenId: newRowId("vaultToken") }),
      ).resolves.toBeDefined();

      // Decision stages are a closed list; one approval per purchase.
      const bogusStage = db.execute(
        sql`insert into decisions (id, tenant_id, cart_id, stage, verdict) values (${newRowId("decision")}, ${TENANT}, ${f.cartId}, 'vibes', 'APPROVE')`,
      );
      await expect(bogusStage).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "decisions_stage_check"));
      await expect(db.insert(decisions).values({ id: newRowId("decision"), tenantId: TENANT, cartId: f.cartId, stage: "preview", verdict: "BLOCK" })).resolves.toBeDefined();
      const purchaseId = newRowId("purchase");
      await db.insert(purchases).values(purchaseRow(f, { id: purchaseId, state: "AWAITING_HUMAN" }));
      const approval = { tenantId: TENANT, purchaseId, status: "PENDING" as const, request: {}, expiresAt: new Date(Date.now() + 86_400_000) };
      await db.insert(approvals).values({ id: newRowId("approval"), ...approval });
      await expect(db.insert(approvals).values({ id: newRowId("approval"), ...approval })).rejects.toSatisfy((e: unknown) =>
        isUniqueViolation(e, "approvals_purchase_unique"),
      );
    });

    it("rejects an agent kind outside ('builtin','mcp','sdk')", async () => {
      const f = await seed(db);
      const bad = db.execute(
        sql`insert into agents (id, tenant_id, user_id, name, kind, api_key_hash)
            values (${newRowId("agent")}, ${TENANT}, ${f.userId}, 'x', 'browser', ${sha256("k")})`,
      );
      await expect(bad).rejects.toSatisfy((e: unknown) => isCheckViolation(e, "agents_kind_check"));
    });
  });
}

describe("schema constants", () => {
  it("keeps the CHECK lists in sync with @writ/core", () => {
    expect([...CURRENCIES]).toEqual(CurrencySchema.options);
    expect([...WRIT_STATUSES]).toEqual([...CORE_WRIT_STATUSES]);
    expect([...PURCHASE_STATES]).toEqual([...CORE_PURCHASE_STATES]);
    expect([...PURCHASE_STATE_REASONS]).toEqual([...CORE_PURCHASE_STATE_REASONS]);
    expect([...DECISION_RECORD_STAGES]).toEqual([...CORE_DECISION_RECORD_STAGES]);
    expect([...APPROVAL_STATUSES]).toEqual([...CORE_APPROVAL_STATUSES]);
    expect([...APPROVAL_DECISIONS]).toEqual([...CORE_APPROVAL_DECISIONS]);
    expect([...CATALOG_SOURCES]).toEqual([...CORE_CATALOG_SOURCES]);
    expect([...AGENT_KINDS]).toEqual([...CORE_AGENT_KINDS]);
    expect([...BUILTIN_AGENT_KINDS]).toEqual([...CORE_BUILTIN_AGENT_KINDS]);
    expect([...RUN_STATUSES]).toEqual([...CORE_RUN_STATUSES]);
    expect([...RUN_MODES]).toEqual([...CORE_RUN_MODES]);
    expect([...VAULT_TOKEN_STATUSES]).toEqual([...CORE_VAULT_TOKEN_STATUSES]);
  });

  it("mints ids that @writ/core contracts accept for every row a signed document references", () => {
    const now = Date.parse(TS);
    const clock = () => now;
    const coreKinds = { user: "usr", address: "adr", agent: "agt", writ: "wr", cart: "crt", purchase: "pur", approval: "apr" } as const;
    for (const [kind, prefix] of Object.entries(coreKinds) as [keyof typeof coreKinds, (typeof coreKinds)[keyof typeof coreKinds]][]) {
      const id = newRowId(kind, clock);
      expect(ROW_ID_PREFIXES[kind]).toBe(prefix);
      expect(idSchema(prefix).safeParse(id).success, id).toBe(true);
      expect(idTimestamp(id)).toBe(now);
    }
    // writ_short for the PayPal custom_id (plan §6.7) works on gateway-minted Writ ids.
    expect(writShort(newRowId("writ"))).toMatch(/^[0-9a-z]{12}$/);
  });

  it("gives every row kind a distinct prefix and a unique, time-ordered ULID body", () => {
    const kinds = Object.keys(ROW_ID_PREFIXES) as (keyof typeof ROW_ID_PREFIXES)[];
    expect(new Set(Object.values(ROW_ID_PREFIXES)).size).toBe(kinds.length);
    // Every check runs on every id, but mismatches are collected and asserted once: one expect()
    // per check is kinds × 200 × kinds calls (~76 000 with 19 kinds), seconds on a busy machine.
    const perKind = 200;
    const problems: string[] = [];
    let crossChecks = 0;
    for (const kind of kinds) {
      const shape = new RegExp(`^${ROW_ID_PREFIXES[kind]}_[0-7][0-9a-hjkmnp-tv-z]{25}$`);
      const ids = new Set(Array.from({ length: perKind }, () => newRowId(kind)));
      if (ids.size !== perKind) problems.push(`${kind}: ${perKind - ids.size} duplicate id(s) in ${perKind}`);
      for (const id of ids) {
        if (!shape.test(id)) problems.push(`${id} does not match ${shape.source}`);
        if (!isRowId(kind, id)) problems.push(`${id} is not accepted as ${kind}`);
        for (const other of kinds) {
          if (other === kind) continue;
          crossChecks += 1;
          if (isRowId(other, id)) problems.push(`${id} is also accepted as ${other}`);
        }
      }
    }
    expect(problems).toEqual([]);
    // Every id was checked against every other kind.
    expect(crossChecks).toBe(kinds.length * perKind * (kinds.length - 1));
    const early = newRowId("outbox", () => Date.parse("2026-11-01T00:00:00.000Z"));
    const late = newRowId("outbox", () => Date.parse("2026-11-02T00:00:00.000Z"));
    expect(early < late).toBe(true);
  });

  it("refuses malformed ids", () => {
    for (const bad of ["wr_../../etc", "wr_", "", "psk_0123456789", `dec_${"u".repeat(26)}`, `wr_${"8".repeat(26)}`]) {
      expect(isRowId("writ", bad), bad).toBe(false);
      expect(isRowId("passkey", bad), bad).toBe(false);
      expect(isRowId("decision", bad), bad).toBe(false);
    }
  });
});

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected an object");
  return value as Record<string, unknown>;
}
