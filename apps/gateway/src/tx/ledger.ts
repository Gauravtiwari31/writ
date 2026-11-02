// ledger_events rows ↔ @writ/ledger events ↔ API views. Used by the unit of work (append), and by
// every stream that reads a chain (receipts, evidence packs, purchase detail, the console).
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import { toHex } from "@writ/core";
import type { LedgerEventView } from "@writ/core/api";
import { LedgerEventSchema, type LedgerEvent } from "@writ/ledger";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { ledgerEvents, type LedgerEvent as LedgerEventRow } from "../db/schema";

/** A stored row as the @writ/ledger event it was hashed as (validated: a row that does not parse is corrupt). */
export function ledgerEventFromRow(row: LedgerEventRow): LedgerEvent {
  return LedgerEventSchema.parse({
    seq: row.seq,
    writ_id: row.writId,
    purchase_id: row.purchaseId,
    type: row.type,
    payload: row.payload,
    ts: row.ts,
    prev_hash: toHex(row.prevHash),
    hash: toHex(row.hash),
  });
}

export function ledgerEventView(event: LedgerEvent): LedgerEventView {
  return {
    seq: event.seq,
    writ_id: event.writ_id,
    purchase_id: event.purchase_id,
    type: event.type,
    payload: event.payload,
    ts: event.ts,
    prev_hash: event.prev_hash,
    hash: event.hash,
  };
}

/** A Writ's whole chain, genesis first (tenant-scoped by the Writ id the caller already authorized). */
export async function loadChain(db: Db, writId: string): Promise<LedgerEvent[]> {
  const rows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.writId, writId)).orderBy(asc(ledgerEvents.seq));
  return rows.map(ledgerEventFromRow);
}
