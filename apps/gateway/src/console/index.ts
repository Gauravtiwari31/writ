// Trust & Safety console data (P0-11): flat, tenant-scoped rows and a constrained query (filter, group,
// aggregate, sort) evaluated over those rows, so there is no SQL surface. Only columns of a dataset can be
// named. Attack spans are untrusted text and are left out: the ticker shows them, the AI harness never gets them.
import type { ConsoleDatasetName, ConsoleQueryRequest, ConsoleRow } from "@writ/core/api";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { attacks, decisions, disputes, purchases, writBudgets, writs } from "../db/schema";
import { HttpError } from "../http/errors";

const LIMIT = 10_000;

const toNumber = (minor: bigint | null): number | null => (minor === null ? null : Number(minor));

export async function datasetRows(db: Db, tenantId: string, name: ConsoleDatasetName): Promise<ConsoleRow[]> {
  switch (name) {
    case "purchases":
      return (await db.select().from(purchases).where(eq(purchases.tenantId, tenantId)).orderBy(desc(purchases.createdAt)).limit(LIMIT)).map((row) => ({
        purchase_id: row.id,
        writ_id: row.writId,
        agent_id: row.agentId,
        state: row.state,
        state_reason: row.stateReason,
        final_verdict: row.finalVerdict,
        amount_minor: toNumber(row.amountMinor),
        currency: row.currency,
        money_moved: row.captureId !== null,
        created_at: row.createdAt.toISOString(),
        is_synthetic: row.synthetic,
      }));
    case "decisions":
      return (await db.select().from(decisions).where(eq(decisions.tenantId, tenantId)).orderBy(desc(decisions.createdAt)).limit(LIMIT)).map((row) => ({
        decision_id: row.id,
        purchase_id: row.purchaseId,
        stage: row.stage,
        verdict: row.verdict,
        model: row.model,
        latency_ms: row.latencyMs,
        tokens: row.tokens,
        created_at: row.createdAt.toISOString(),
        is_synthetic: false,
      }));
    case "attacks":
      return (await db.select().from(attacks).where(eq(attacks.tenantId, tenantId)).orderBy(desc(attacks.createdAt)).limit(LIMIT)).map((row) => ({
        attack_id: row.id,
        source_host: URL.canParse(row.sourceUrl) ? new URL(row.sourceUrl).host : "unknown",
        category: row.category,
        score: row.score,
        detector: row.detector,
        purchase_id: row.purchaseId,
        created_at: row.createdAt.toISOString(),
        is_synthetic: row.synthetic,
      }));
    case "disputes":
      return (await db.select().from(disputes).where(eq(disputes.tenantId, tenantId)).orderBy(desc(disputes.createdAt)).limit(LIMIT)).map((row) => ({
        dispute_id: row.id,
        purchase_id: row.purchaseId,
        status: row.status,
        stage: row.stage,
        reason: row.reason,
        liability: row.liability,
        action: row.action,
        outcome: row.outcome,
        amount_minor: toNumber(row.amountMinor),
        created_at: row.createdAt.toISOString(),
        is_synthetic: row.synthetic,
      }));
    case "writs":
      return (await db.select().from(writs).where(eq(writs.tenantId, tenantId)).orderBy(desc(writs.createdAt)).limit(LIMIT)).map((row) => ({
        writ_id: row.id,
        status: row.status,
        signed_at: row.signedAt?.toISOString() ?? null,
        expires_at: row.expiresAt.toISOString(),
        is_synthetic: row.synthetic,
      }));
    case "budgets":
      return (await db.select().from(writBudgets).where(eq(writBudgets.tenantId, tenantId)).limit(LIMIT)).map((row) => ({
        writ_id: row.writId,
        limit_minor: toNumber(row.limitMinor),
        spent_minor: toNumber(row.spentMinor),
        reserved_minor: toNumber(row.reservedMinor),
        orders_count: row.ordersCount,
        max_orders: row.maxOrders,
        is_synthetic: false,
      }));
  }
}

type Cell = ConsoleRow[string];

function matches(cell: Cell | undefined, op: ConsoleQueryRequest["filters"][number]["op"], value: ConsoleQueryRequest["filters"][number]["value"]): boolean {
  const left = cell ?? null;
  if (op === "in") return Array.isArray(value) && value.includes(left);
  if (Array.isArray(value)) return false;
  if (op === "eq") return left === value;
  if (op === "neq") return left !== value;
  if (op === "contains") return typeof left === "string" && typeof value === "string" && left.toLowerCase().includes(value.toLowerCase());
  if (left === null || value === null) return false;
  if (op === "gt") return left > value;
  if (op === "gte") return left >= value;
  if (op === "lt") return left < value;
  return left <= value;
}

export function runQuery(rows: readonly ConsoleRow[], query: ConsoleQueryRequest): ConsoleRow[] {
  const known = new Set(rows.flatMap((row) => Object.keys(row)));
  const check = (field: string | undefined): void => {
    if (field !== undefined && rows.length > 0 && !known.has(field)) throw new HttpError(400, "unknown_field", `${query.dataset} has no column ${field}.`);
  };
  query.filters.forEach((filter) => check(filter.field));
  query.group_by?.forEach(check);
  check(query.aggregate?.field);
  // A grouped result is sorted by its own columns (the group fields and the computed "value").
  if (query.aggregate === undefined && query.group_by === undefined) check(query.order_by?.field);

  let out: ConsoleRow[] = rows.filter((row) => query.filters.every((filter) => matches(row[filter.field], filter.op, filter.value)));
  const aggregate = query.aggregate;
  if (aggregate !== undefined || query.group_by !== undefined) {
    const groups = new Map<string, ConsoleRow[]>();
    for (const row of out) {
      const key = JSON.stringify((query.group_by ?? []).map((field) => row[field] ?? null));
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    out = [...groups.values()].map((members) => {
      const head: ConsoleRow = {};
      for (const field of query.group_by ?? []) head[field] = members[0]?.[field] ?? null;
      const numbers = members.map((member) => (aggregate?.field === undefined ? null : member[aggregate.field])).filter((value): value is number => typeof value === "number");
      const op = aggregate?.op ?? "count";
      const total = numbers.reduce((sum, value) => sum + value, 0);
      head["value"] = op === "count" ? members.length : numbers.length === 0 ? null : op === "sum" ? total : op === "avg" ? total / numbers.length : op === "min" ? Math.min(...numbers) : Math.max(...numbers);
      return head;
    });
  }
  const order = query.order_by;
  if (order !== undefined) {
    const sign = order.dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const left = a[order.field] ?? null;
      const right = b[order.field] ?? null;
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return left < right ? -sign : sign;
    });
  }
  return out.slice(0, query.limit);
}
