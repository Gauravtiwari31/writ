// Hash chain over ledger events (plan §6.7). One chain per Writ, rooted at its WRIT_SIGNED event,
// so an evidence pack carries everything needed to re-check it.
//
//   hash_i = sha256( prev_hash_i                 32 raw bytes (genesis: 32 zero bytes)
//                  ‖ u32be(len) ‖ utf8(type)
//                  ‖ u32be(len) ‖ utf8(JCS(payload))
//                  ‖ u32be(len) ‖ utf8(ts) )     ts = ISO 8601 UTC with ms
//
// Length prefixes make the concatenation unambiguous: no split of bytes between adjacent fields
// yields the same preimage. seq, writ_id and purchase_id are not in the preimage; writ_id is bound
// through the genesis payload and purchase_id through payload.purchase_id (both checked below).
import { concatBytes, fromHex, HASH_BYTES, jcs, lengthPrefixed, sha256, toHex, utf8 } from "@writ/core";
import { z } from "zod";
import {
  Hex32Schema,
  LedgerEventSchema,
  LedgerEventTypeSchema,
  LedgerTimestampSchema,
  payloadSchemaFor,
  type LedgerEvent,
  type LedgerEventType,
} from "./events";
import { isJsonObject, type JsonObject } from "./json";

export const GENESIS_PREV_HASH: string = "00".repeat(HASH_BYTES);

export interface EventHashInput {
  prev_hash: string;
  type: LedgerEventType;
  payload: JsonObject;
  ts: string;
}

function check<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError(`${what}: ${z.prettifyError(result.error)}`);
  return result.data;
}

/** The exact bytes that are hashed for one event. Exposed for writ-verify and the spec. */
export function eventHashPreimage(input: EventHashInput): Uint8Array {
  const prev = fromHex(check(Hex32Schema, input.prev_hash, "prev_hash"));
  const type = check(LedgerEventTypeSchema, input.type, "type");
  const ts = check(LedgerTimestampSchema, input.ts, "ts");
  if (!isJsonObject(input.payload)) throw new TypeError("payload must be a JSON object");
  return concatBytes(prev, lengthPrefixed(utf8(type)), lengthPrefixed(utf8(jcs(input.payload))), lengthPrefixed(utf8(ts)));
}

/** Lowercase hex of the event hash. */
export function computeEventHash(input: EventHashInput): string {
  return toHex(sha256(eventHashPreimage(input)));
}

export interface AppendEventInput {
  type: LedgerEventType;
  /** Copied; purchase_id (and writ_id on WRIT_SIGNED) are filled in when absent. */
  payload: JsonObject;
  ts: string | Date;
  purchase_id?: string | null;
  /** Required for the genesis event; otherwise inherited from the tail. */
  writ_id?: string;
  /** Defaults to tail.seq + 1 (1 for genesis). A BIGSERIAL may assign larger gaps; it must only increase. */
  seq?: number;
}

function bindField(payload: JsonObject, key: string, value: string): void {
  if (!Object.hasOwn(payload, key)) {
    payload[key] = value;
  } else if (payload[key] !== value) {
    throw new TypeError(`payload.${key} disagrees with the event's ${key}`);
  }
}

/** Builds the next event of a Writ chain. Pure: the caller persists it (with the tail locked). */
export function appendEvent(tail: LedgerEvent | null, input: AppendEventInput): LedgerEvent {
  const type = check(LedgerEventTypeSchema, input.type, "type");
  const ts = check(LedgerTimestampSchema, typeof input.ts === "string" ? input.ts : input.ts.toISOString(), "ts");
  const purchaseId = input.purchase_id ?? null;
  if (!isJsonObject(input.payload)) throw new TypeError("payload must be a JSON object");
  // Deep copy through the canonical form, so the stored payload re-serializes to exactly the hashed bytes
  // and later mutation of the caller's object cannot desynchronize it.
  const payload = JSON.parse(jcs(input.payload)) as JsonObject;

  let writId: string;
  let seq: number;
  let prevHash: string;
  if (tail === null) {
    if (type !== "WRIT_SIGNED") throw new TypeError("a Writ chain must start with WRIT_SIGNED");
    if (input.writ_id === undefined) throw new TypeError("writ_id is required for the genesis event");
    if (purchaseId !== null) throw new TypeError("WRIT_SIGNED is not purchase-scoped");
    writId = input.writ_id;
    seq = input.seq ?? 1;
    prevHash = GENESIS_PREV_HASH;
    bindField(payload, "writ_id", writId);
  } else {
    if (type === "WRIT_SIGNED") throw new TypeError("WRIT_SIGNED may only be the genesis event");
    if (input.writ_id !== undefined && input.writ_id !== tail.writ_id) {
      throw new TypeError("one chain per Writ: writ_id differs from the tail's");
    }
    writId = tail.writ_id;
    seq = input.seq ?? tail.seq + 1;
    if (seq <= tail.seq) throw new RangeError(`seq ${seq} must be greater than the tail's ${tail.seq}`);
    prevHash = tail.hash;
  }

  if (purchaseId !== null) {
    bindField(payload, "purchase_id", purchaseId);
  } else if (Object.hasOwn(payload, "purchase_id")) {
    throw new TypeError("payload.purchase_id is set but the event has no purchase_id");
  }

  const contract = payloadSchemaFor(type);
  if (contract !== undefined) check(contract, payload, `${type} payload`);

  const hash = computeEventHash({ prev_hash: prevHash, type, payload, ts });
  return check(
    LedgerEventSchema,
    { seq, writ_id: writId, purchase_id: purchaseId, type, payload, ts, prev_hash: prevHash, hash },
    "event",
  );
}

export type ChainFailureReason =
  | "EMPTY_CHAIN"
  | "MALFORMED_EVENT"
  | "GENESIS_NOT_WRIT_SIGNED"
  | "BAD_GENESIS_PREV_HASH"
  | "WRIT_SIGNED_NOT_GENESIS"
  | "SEQ_NOT_INCREASING"
  | "WRIT_ID_MISMATCH"
  | "PURCHASE_ID_MISMATCH"
  | "PREV_HASH_MISMATCH"
  | "HASH_MISMATCH";

export type ChainVerification =
  | { ok: true }
  | { ok: false; index: number; reason: ChainFailureReason; detail: string };

function fail(index: number, reason: ChainFailureReason, detail: string): ChainVerification {
  return { ok: false, index, reason, detail };
}

/**
 * Integrity check of one Writ chain, in order. Detects edits, reordering, deletion or insertion
 * before the tail, forged hashes and mixed chains. Truncation or extension at the tail, and a chain
 * rebuilt from scratch, are not detectable here: those rely on the PayPal anchors and signatures
 * the evidence pack checks against. Events are untrusted input and are schema-checked one by one.
 */
export function verifyChain(events: readonly unknown[]): ChainVerification {
  if (events.length === 0) return fail(0, "EMPTY_CHAIN", "a Writ chain has at least its WRIT_SIGNED event");

  let prev: LedgerEvent | null = null;
  for (let index = 0; index < events.length; index++) {
    const parsed = LedgerEventSchema.safeParse(events[index]);
    if (!parsed.success) return fail(index, "MALFORMED_EVENT", z.prettifyError(parsed.error));
    const event = parsed.data;

    if (prev === null) {
      if (event.type !== "WRIT_SIGNED") return fail(index, "GENESIS_NOT_WRIT_SIGNED", `first event is ${event.type}`);
      if (event.prev_hash !== GENESIS_PREV_HASH) {
        return fail(index, "BAD_GENESIS_PREV_HASH", "genesis prev_hash must be 32 zero bytes");
      }
      if (event.payload["writ_id"] !== event.writ_id) {
        return fail(index, "WRIT_ID_MISMATCH", "genesis payload.writ_id must equal the event's writ_id");
      }
    } else {
      if (event.type === "WRIT_SIGNED") return fail(index, "WRIT_SIGNED_NOT_GENESIS", "second WRIT_SIGNED in one chain");
      if (event.seq <= prev.seq) return fail(index, "SEQ_NOT_INCREASING", `seq ${event.seq} after ${prev.seq}`);
      if (event.writ_id !== prev.writ_id) {
        return fail(index, "WRIT_ID_MISMATCH", `writ_id ${event.writ_id} in the chain of ${prev.writ_id}`);
      }
      if (event.prev_hash !== prev.hash) {
        return fail(index, "PREV_HASH_MISMATCH", "prev_hash does not equal the previous event's hash");
      }
    }

    const payloadPurchaseId = Object.hasOwn(event.payload, "purchase_id") ? event.payload["purchase_id"] : null;
    if (payloadPurchaseId !== event.purchase_id) {
      return fail(index, "PURCHASE_ID_MISMATCH", "payload.purchase_id must equal the event's purchase_id");
    }
    if (event.type === "WRIT_SIGNED" && event.purchase_id !== null) {
      return fail(index, "PURCHASE_ID_MISMATCH", "WRIT_SIGNED is not purchase-scoped");
    }

    const expected = computeEventHash(event);
    if (expected !== event.hash) return fail(index, "HASH_MISMATCH", `recomputed ${expected}, stored ${event.hash}`);
    prev = event;
  }
  return { ok: true };
}
